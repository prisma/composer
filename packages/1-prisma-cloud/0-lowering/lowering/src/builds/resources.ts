/**
 * Which platform resources a deploy touched, reported as it touches them.
 *
 * The interception point is the state store rather than the deploy's report
 * hook, because the report hook cannot see this. A descriptor's
 * `DeployedEntity` vocabulary is three kinds wide (`postgres-database`,
 * `bucket`, `compute-service`) against the platform's eight resource types,
 * and the most valuable of those — `deployment`, which makes the platform
 * attach the deployment to the build and record the app it went into — is
 * not an entity at all. Every resource write passes through the state store
 * whichever provider performed it, so that is where the full set is visible.
 *
 * Reporting as the run goes also survives a crash: a deploy that dies partway
 * still leaves a record of what it had already created.
 */
import type { BuildResourceAction, BuildResourceType, BuildsApi } from './api.ts';

/** Names the build a run belongs to. Set by the CLI on the alchemy child, or by a CI runner that created the build itself. */
export const BUILD_ID_ENV = 'PRISMA_BUILD_ID';

interface PlatformResource {
  readonly type: BuildResourceType;
  /** The attribute holding the platform's own id — `Deployment` does not call it `id`. */
  readonly idField: string;
}

/**
 * Alchemy resource type → platform resource type, keyed by upstream
 * `alchemy/Prisma`'s type-ids and attribute names — the shapes the state
 * store actually writes since the upstream provider adoption.
 *
 * Two resources are deliberately absent. `Prisma.BucketAccessKey` has no
 * platform resource type to map onto. `PrismaCloud.ServiceKey` is a value
 * this deploy mints locally, not a platform resource at all — the platform's
 * `service_key` is what `Prisma.Connection` creates.
 *
 * Anything not listed — `PgWarm`, and every resource another extension
 * contributes — is not a Prisma Cloud resource and is not reported.
 */
const PLATFORM_RESOURCES: Readonly<Record<string, PlatformResource>> = {
  'Prisma.Project': { type: 'project', idField: 'projectId' },
  'Prisma.Database': { type: 'database', idField: 'databaseId' },
  'Prisma.Connection': { type: 'service_key', idField: 'connectionId' },
  'Prisma.Bucket': { type: 'bucket', idField: 'bucketId' },
  'Prisma.App': { type: 'app', idField: 'appId' },
  'Prisma.Deployment': { type: 'deployment', idField: 'deploymentId' },
  'Prisma.EnvironmentVariable': { type: 'config_variable', idField: 'environmentVariableId' },
};

/**
 * Terminal status → what the run did to the resource. The intermediate
 * statuses (`creating`, `updating`, `replacing`) are skipped: they say work
 * started, not that it landed, and the terminal write follows immediately.
 *
 * `updated` maps to `acted_on` rather than to nothing, because a reconcile
 * that changed no field is still this run acting on that resource — a
 * migration against an untouched database is an action on it.
 */
const ACTION_BY_STATUS: Readonly<Record<string, BuildResourceAction>> = {
  created: 'created',
  updated: 'acted_on',
  deleting: 'deleted',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export interface ReportableResource {
  readonly type: BuildResourceType;
  readonly id: string;
  readonly action: BuildResourceAction;
}

/**
 * What a persisted state record says this run did, or `undefined` when it
 * says nothing reportable. Reads defensively: the record crosses a wire and
 * carries resources from every extension, not only this one's.
 */
export function reportableResource(value: unknown): ReportableResource | undefined {
  if (!isRecord(value)) return undefined;
  // Tasks are persisted alongside resources under the same key space.
  if (value['kind'] === 'action') return undefined;

  // An adopted resource existed before this run and this run only resolved
  // it. Resolving is not acting, so it is not reported. Read off the record
  // rather than off the type: the flag is declared on the mid-adoption state
  // and persists until the first reconcile after it succeeds.
  if (value['adopting'] === true) return undefined;

  const resourceType = value['resourceType'];
  if (typeof resourceType !== 'string') return undefined;
  const mapping = PLATFORM_RESOURCES[resourceType];
  if (mapping === undefined) return undefined;

  const status = value['status'];
  const action = typeof status === 'string' ? ACTION_BY_STATUS[status] : undefined;
  if (action === undefined) return undefined;

  const attr = value['attr'];
  if (!isRecord(attr)) return undefined;
  const id = attr[mapping.idField];
  if (typeof id !== 'string' || id.length === 0) return undefined;

  return { type: mapping.type, id, action };
}

/**
 * Sends resource reports without making the deploy wait for them, and lets
 * the caller wait once at the end.
 *
 * Awaiting each report inline would add a round trip per resource to an
 * apply that already talks to the same API for the resource itself. Firing
 * without ever waiting would let the process exit with reports in flight.
 * So: fire immediately, keep the promises, and drain them from the state
 * layer's finalizer.
 */
export interface ResourceReporter {
  /** Called for every state write. Cheap and synchronous — it starts a request at most, never waits for one. */
  observe(value: unknown): void;
  /** Waits for every report already started. Never rejects. */
  drain(): Promise<void>;
}

/**
 * The most a drain will wait, total. Every real report already carries the
 * api layer's per-request deadline, so this never fires for the shipped
 * `BuildsApi`; it is the backstop that keeps the state layer's finalizer —
 * and therefore the deploy lease release — bounded against any implementation.
 */
const DRAIN_DEADLINE_MS = 15_000;

export function resourceReporter(
  api: BuildsApi,
  buildId: string,
  warn: (message: string) => void = (message) => console.warn(message),
  drainDeadlineMs: number = DRAIN_DEADLINE_MS,
): ResourceReporter {
  const inFlight = new Set<Promise<unknown>>();
  // A resource is written more than once per run (creating, then created).
  // The API's upsert makes a repeat harmless, but there is no reason to
  // spend the round trip.
  const reported = new Set<string>();

  return {
    observe(value) {
      const resource = reportableResource(value);
      if (resource === undefined) return;

      const key = `${resource.type}:${resource.id}:${resource.action}`;
      if (reported.has(key)) return;
      reported.add(key);

      const sent = api
        .reportResource(buildId, resource.type, resource.id, resource.action)
        .finally(() => inFlight.delete(sent));
      inFlight.add(sent);
    },

    async drain() {
      const deadline = Date.now() + drainDeadlineMs;
      // Reports started while draining join the same wait — a state write can
      // land between the snapshot and the await.
      while (inFlight.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          warn(
            `Abandoned ${inFlight.size} in-flight resource report(s) after ${drainDeadlineMs}ms.`,
          );
          return;
        }
        await Promise.race([
          Promise.allSettled([...inFlight]),
          new Promise((resolve) => setTimeout(resolve, remaining).unref?.()),
        ]);
        if (Date.now() >= deadline && inFlight.size > 0) {
          warn(
            `Abandoned ${inFlight.size} in-flight resource report(s) after ${drainDeadlineMs}ms.`,
          );
          return;
        }
      }
    },
  };
}
