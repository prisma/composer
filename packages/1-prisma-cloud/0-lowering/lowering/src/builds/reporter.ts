/**
 * Reports a deploy to Prisma Cloud as a `Build`, so the Console can show
 * deploy history for apps the platform never built.
 *
 * The session opens before the CLI resolves containers, which is deliberate:
 * creating them is the step that can leave a Project behind with nothing
 * recording why (composer#103), and a session opened afterwards would miss
 * the one failure it most needs to describe.
 *
 * Nothing here can fail a deploy. Every call goes through `BuildsApi`, which
 * warns and returns rather than throwing, and the one place that could still
 * throw — reading git — is wrapped. A deploy that converged is a deploy that
 * succeeded, whatever the Console was told.
 *
 * This module installs NO signal handlers: the CLI engine is the sole signal
 * owner (its detector test enforces it). Cancellation reaches this reporter
 * as `RunOutcome.cancelled` on the ordinary `finish` path.
 *
 * Lives here rather than beside the extension that registers it because the
 * extension package ships into runtime surfaces and may import no node
 * builtin and read no environment (its invariants 4 and 5). Reading git and
 * the deploy shell is exactly what this does, so it belongs on the lowering
 * side; the extension keeps only the one thing this cannot know, which is how
 * to read its own container.
 */
import type {
  ContainerInstance,
  DeployedEntity,
  ReportAttachInput,
  ReportBeginInput,
  ReporterDescriptor,
  RunOutcome,
  RunReporter,
} from '@internal/core/config';
import { createManagementApiClient } from '@prisma/management-api-sdk';
import * as Effect from 'effect/Effect';
import type { ManagementApiClient } from '../client.ts';
import { managementApiBaseUrl } from '../credentials.ts';
import { type BuildsApi, buildsApi, type UpdateBuildBody } from './api.ts';
import { BUILD_ID_ENV } from './resources.ts';
import { resolveRunIdentity } from './run-identity.ts';

/** An empty string is how a shell spells "unset", so it must not be mistaken for a build id. */
const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

/** The Build row's project and branch references, read out of the reporting extension's own container. */
export interface BuildContainerRefs {
  readonly projectId: string;
  readonly branchId: string | undefined;
}

export interface BuildReporterOptions {
  /** Narrows the extension's container to the project/branch references this build should carry. */
  readonly refsOf: (container: ContainerInstance) => BuildContainerRefs;
  readonly origin?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly warn?: (message: string) => void;
  /** Injected by tests; the real one talks to the Management API. */
  readonly api?: BuildsApi;
}

export function buildReporter(options: BuildReporterOptions): ReporterDescriptor {
  return {
    // Typed against this platform's client; assigns into the erased
    // `begin(ReportBeginInput<unknown>)` through method bivariance.
    //
    // `begin` is documented never to throw, and this catch is what makes the
    // claim true of THIS reporter rather than a favour the CLI does it: an
    // injected api that rejects, or any other defect here, costs the session
    // and one warning, never the deploy.
    begin: async (input: ReportBeginInput<ManagementApiClient>) => {
      try {
        return await beginSession(input, options);
      } catch (error) {
        const warn = options.warn ?? ((message: string) => console.warn(message));
        warn(
          `Could not start build reporting: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    },
  };
}

async function beginSession(
  input: ReportBeginInput<ManagementApiClient>,
  options: BuildReporterOptions,
): Promise<RunReporter | undefined> {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  // The caller's already-authenticated client, when the engine supplied one
  // — "present means the extension must not build its own from the
  // environment" (ContainerCredentials). The env token is the standalone
  // fallback, for hosts driving `@prisma/composer/control` without an engine.
  const injected = input.credentials?.client;
  const token = env['PRISMA_SERVICE_TOKEN'];
  if (
    options.api === undefined &&
    injected === undefined &&
    (token === undefined || token.length === 0)
  ) {
    // Not worth a line: a deploy without any credential fails immediately
    // afterwards for a reason the operator will see.
    return undefined;
  }

  const identity = resolveRunIdentity(input.cwd, env);
  if (identity === undefined) {
    warn(
      `\nNot recording this deploy in Prisma Cloud: ${input.cwd} has no commit and branch to ` +
        'report it under. Deploy from a git checkout to see it in the Console.',
    );
    return undefined;
  }

  // Its own client rather than the shared `ManagementClient` service: this
  // runs in the CLI process, before any Effect layer is built, and needs
  // nothing from one.
  const api =
    options.api ??
    buildsApi({
      client:
        injected ??
        createManagementApiClient({
          token: token ?? '',
          baseUrl: options.origin ?? Effect.runSync(managementApiBaseUrl(options.env)),
        }),
      warn,
    });

  // A build id from either channel means something upstream — the Prisma
  // GitHub Action, or a workflow driving the CLI directly — already created
  // the build and this run is one part of it. Joining means never re-creating
  // it, and never overwriting what the creator knows better: its source, and
  // the link to its own logs.
  //
  // `--build-id` beats PRISMA_BUILD_ID because it was passed deliberately: a
  // runner that exports the variable for a whole job, then names a different
  // build for one step, means the step.
  const joined = nonEmpty(input.reportId) ?? nonEmpty(env[BUILD_ID_ENV]);
  const buildId =
    joined !== undefined
      ? joined
      : await api.create({
          source: identity.source,
          commitSha: identity.commitSha,
          branchName: identity.branchName,
          ...(identity.runIdentity !== undefined ? { runIdentity: identity.runIdentity } : {}),
          ...(identity.externalLogUrl !== undefined
            ? { externalLogUrl: identity.externalLogUrl }
            : {}),
        });

  if (buildId === undefined) return undefined;

  // `deploy`, always. Composer does not build the user's code — ADR-0005
  // leaves that to them — so `build` names a phase this tool never runs.
  // Whoever did build reports that phase itself.
  await api.update(buildId, { phase: 'deploy', state: 'running' });

  return session(api, buildId, options.refsOf, warn);
}

/**
 * The app this run deployed and where it can be reached — but only when the
 * run deployed exactly one compute service.
 *
 * `Build.appId` and `Build.deployedUrl` are each one value, and an app with
 * several services has no single answer. Picking the first would put an
 * arbitrary service's address in the Console and quietly imply it was the
 * app's. Single-service apps are the common case and get a working link;
 * multi-service apps get neither, and their services are all reported through
 * the resources endpoint regardless.
 *
 * Both fields are fill-only, so this is safe to send on a build whose creator
 * already set them to the same values, and a genuine disagreement is a 409
 * the caller logs.
 */
function deployedApp(entities: readonly DeployedEntity[]): UpdateBuildBody {
  const services = entities.filter((entity) => entity.kind === 'compute-service');
  const only = services.length === 1 ? services[0] : undefined;
  if (only === undefined) return {};
  return {
    appId: only.id,
    ...(only.url !== undefined ? { deployedUrl: only.url } : {}),
  };
}

function session(
  api: BuildsApi,
  buildId: string,
  refsOf: (container: ContainerInstance) => BuildContainerRefs,
  warn: (message: string) => void,
): RunReporter {
  let finished = false;

  return {
    childEnv: () => ({ [BUILD_ID_ENV]: buildId }),

    /**
     * Attaches the build to the Project and Branch this deploy resolved.
     * Sent on its own rather than folded into the progress update above:
     * the fields are fill-only, so keeping them in their own call means a
     * 409 from a disagreeing creator costs these references alone.
     */
    async attach(input: ReportAttachInput): Promise<void> {
      if (input.container === undefined) return;
      const { projectId, branchId } = refsOf(input.container);
      await api.update(buildId, {
        projectId,
        ...(branchId !== undefined ? { branchId } : {}),
      });
    },

    async finish(outcome: RunOutcome): Promise<void> {
      if (finished) return;
      finished = true;
      // `cancelled` is the user interrupting, not a deploy that went wrong —
      // and a SIGKILLed run reports nothing at all, leaving the build
      // permanently `running` (nothing sweeps builds, by platform design).
      try {
        await api.update(buildId, {
          state: outcome.ok ? 'succeeded' : outcome.cancelled ? 'cancelled' : 'failed',
          ...(outcome.failingStep !== undefined && !outcome.cancelled
            ? { failingStep: outcome.failingStep }
            : {}),
          ...(outcome.errorMessage !== undefined && !outcome.cancelled
            ? { errorMessage: outcome.errorMessage }
            : {}),
          ...deployedApp(outcome.entities),
        });
      } catch (error) {
        // Same contract as begin: finish never rejects, whatever the api does.
        warn(
          `Could not report this deploy's outcome: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
