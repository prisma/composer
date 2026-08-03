/**
 * One-time, on-read rewrite of legacy Composer state rows into the shapes
 * upstream alchemy's `Prisma.*` providers expect — the postgres family
 * (`Project`, `Database`, `Connection`) and the compute family (`App`,
 * `Deployment`, `EnvironmentVariable`).
 *
 * Composer's own resources persisted rows under the type-ids `Prisma.Database`
 * / `Prisma.Connection` / `Prisma.Project` / `Prisma.ComputeService` /
 * `Prisma.Deployment` / `Prisma.EnvironmentVariable` (and, for one unreleased
 * window, `PrismaComposer.*`) with hand-rolled attribute shapes: `{id, name}`
 * (project/database/compute service), `{id, connectionString}` (connection),
 * `{deploymentId, deployedUrl}` (deployment), `{id, key}` (environment
 * variable). Upstream's classes carry the same type-ids — `ComputeService`
 * becomes `App` — but expect `{projectId, …}` / `{databaseId, …}` /
 * `{connectionId, …}` / `{appId, …}` / `{deploymentId, appId, …}` /
 * `{environmentVariableId, …}`. This module maps old rows to the upstream
 * shape as they are read out of the hosted state store, so upstream's
 * providers adopt them (their `read`/`diff` key off those ids) instead of
 * planning a create.
 *
 * The legacy connection string was captured direct-preferred (pooled only as
 * a fallback the API never actually took), so it maps to
 * `directConnectionString` — and to `databaseUrl`, which is what the string
 * was used as. Fields the old rows never carried (pooled/accelerate strings,
 * host/user/password, origins) are left absent; upstream recomputes them from
 * observed API state on the next reconcile that needs them.
 *
 * Operator-visible effects of the first deploy after migration, documented in
 * docs/guides/deploying.md:
 *
 *   · BRANCH-STAGE databases are renamed to a generated physical name and the
 *     database's DEFAULT connection credentials rotate once (the branch-stage
 *     descriptor passes no display name). The framework's own named
 *     Connection — the one services use — is not rotated. Production database
 *     rows converge with no action.
 *   · Every service ships ONE fresh deployment. Upstream keys a deployment's
 *     replacement on an artifact fingerprint that hashes the artifact digest
 *     together with the upload content type, which a legacy row's bare digest
 *     cannot reproduce, so the first plan sees a fingerprint it has never
 *     recorded and replaces: the same upload → start → promote a code change
 *     takes, with the same artifact bytes.
 *   · PRODUCTION apps plan an update (never a replace): the legacy row records
 *     no branch id and the project's default branch id is not derivable
 *     offline, so upstream re-reads the App and repairs the attribute in
 *     place. Branch-stage apps recorded their branch id and converge silently.
 *   · The poison `DATABASE_URL`/`DATABASE_URL_POOLED` rows are neutralised —
 *     see {@link poisonKeyAttr}.
 *
 * Scope: the HOSTED state store only. Local dev state (alchemy's local
 * store) is never migrated — a stale local row under an unregistered type-id
 * fails at plan time with alchemy's missing-provider error, and
 * `prisma-composer dev --fresh` clears it (see docs/guides/running-locally.md).
 */

import * as Redacted from 'effect/Redacted';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const EPOCH = '1970-01-01T00:00:00.000Z';

/** Where a legacy row recorded no region: the only region Composer's descriptors ever defaulted to. */
const DEFAULT_REGION = 'us-east-1';

/** The content type `descriptors/compute.ts` uploads Composer's tar.gz artifact with. */
const ARTIFACT_CONTENT_TYPE = 'application/gzip';

/**
 * The keys the platform seeds and owns. Composer used to overwrite them with a
 * garbage value so nothing could rely on the platform default; upstream
 * refuses to manage a variable the platform marks `isManagedBySystem`, so
 * those writes are gone (see control/extension.ts) and the rows they left
 * behind are disposed of here.
 */
const POISON_KEYS: ReadonlySet<string> = new Set(['DATABASE_URL', 'DATABASE_URL_POOLED']);

type Family = 'Project' | 'Database' | 'Connection' | 'App' | 'Deployment' | 'EnvironmentVariable';

const FAMILY_BY_LEGACY_TYPE: Readonly<Record<string, Family>> = {
  'Prisma.Project': 'Project',
  'Prisma.Database': 'Database',
  'Prisma.Connection': 'Connection',
  'Prisma.ComputeService': 'App',
  'Prisma.Deployment': 'Deployment',
  'Prisma.EnvironmentVariable': 'EnvironmentVariable',
  'PrismaComposer.Project': 'Project',
  'PrismaComposer.Database': 'Database',
  'PrismaComposer.Connection': 'Connection',
  'PrismaComposer.ComputeService': 'App',
  'PrismaComposer.Deployment': 'Deployment',
  'PrismaComposer.EnvironmentVariable': 'EnvironmentVariable',
};

/** The type-id upstream registers each family under. */
const UPSTREAM_TYPE: Readonly<Record<Family, string>> = {
  Project: 'Prisma.Project',
  Database: 'Prisma.Database',
  Connection: 'Prisma.Connection',
  App: 'Prisma.App',
  Deployment: 'Prisma.Deployment',
  EnvironmentVariable: 'Prisma.EnvironmentVariable',
};

/**
 * Four of the six families keep the type-id they always had, so the type-id
 * alone cannot say whether a row is legacy or already upstream's. Each shape
 * is told apart by a props field only the legacy one has, which is also what
 * makes the whole rewrite idempotent.
 */
const isLegacyProps = (family: Family, props: Record<string, unknown>): boolean => {
  switch (family) {
    case 'Project':
      return 'workspaceId' in props;
    case 'Database':
      return 'projectId' in props && !('project' in props);
    case 'Connection':
      return 'databaseId' in props && !('database' in props);
    case 'App':
      return 'projectId' in props && !('project' in props);
    case 'Deployment':
      return 'computeServiceId' in props;
    case 'EnvironmentVariable':
      return 'projectId' in props && !('project' in props);
  }
};

const migrateProps = (family: Family, props: unknown): unknown => {
  if (!isRecord(props) || !isLegacyProps(family, props)) return props;
  switch (family) {
    case 'Project':
      // Upstream ProjectProps carry no workspaceId; keep only the name.
      return { name: props['name'] };
    case 'Database':
      return {
        project: props['projectId'],
        name: props['name'],
        region: props['region'],
        ...(props['branchId'] !== undefined ? { branchId: props['branchId'] } : {}),
      };
    case 'Connection':
      return { database: props['databaseId'], name: props['name'] };
    case 'App':
      return {
        project: props['projectId'],
        displayName: props['name'],
        regionId: props['region'] ?? DEFAULT_REGION,
        ...(props['branchId'] !== undefined ? { branchId: props['branchId'] } : {}),
      };
    case 'Deployment':
      // The legacy `environment` prop is dropped: upstream's Deployment has no
      // such prop, and the ordering edge it carried rides `app` instead (see
      // compute/deployment-edge.ts). `start`/`promote` are what the legacy
      // provider always did unconditionally.
      return {
        app: props['computeServiceId'],
        artifactPath: props['artifactPath'],
        artifactContentType: ARTIFACT_CONTENT_TYPE,
        ...(props['port'] !== undefined ? { portMapping: { http: props['port'] } } : {}),
        start: true,
        promote: true,
      };
    case 'EnvironmentVariable': {
      const value = props['value'];
      return {
        project: props['projectId'],
        key: props['key'],
        class: props['class'] ?? 'production',
        // Legacy rows persisted the value as PLAIN TEXT. Upstream types it
        // `Redacted`, which is also what keeps it out of the next state write.
        value: Redacted.isRedacted(value) ? value : Redacted.make(String(value ?? '')),
        ...(props['branchId'] !== undefined ? { branchId: props['branchId'] } : {}),
      };
    }
  }
};

/**
 * A poison-key row named a variable the PLATFORM owns. Deleting one for real
 * is not safe: the legacy adoption matched on `{projectId, class, key}` with
 * no branch id, so the recorded scope may not equal the live variable's, and
 * upstream's delete refuses — loudly, mid-deploy — on a scope mismatch.
 * Handing it an id upstream reads as "not a cloud resource"
 * (`isPrismaDevId`) makes that delete a guaranteed no-op: the state row goes
 * away on the next deploy, the platform's own variable is left untouched, and
 * nothing is left double-managed.
 */
const poisonKeyAttr = (key: string) => ({
  environmentVariableId: `dev:legacy-poison-${key}`,
  key,
});

const migrateAttr = (family: Family, attr: unknown, props: unknown): unknown => {
  if (!isRecord(attr)) return attr;
  const oldProps = isRecord(props) ? props : {};
  switch (family) {
    case 'Project': {
      if (typeof attr['id'] !== 'string' || 'projectId' in attr) return attr;
      return {
        projectId: attr['id'],
        projectName: attr['name'],
        workspaceId: oldProps['workspaceId'] ?? '',
        createdAt: EPOCH,
        defaultRegion: null,
      };
    }
    case 'Database': {
      if (typeof attr['id'] !== 'string' || 'databaseId' in attr) return attr;
      return {
        databaseId: attr['id'],
        databaseName: attr['name'] ?? oldProps['name'],
        projectId: oldProps['projectId'],
        status: 'ready',
        region: oldProps['region'] ?? null,
        isDefault: oldProps['isDefault'] ?? false,
        branchId: oldProps['branchId'] ?? null,
        defaultConnectionId: null,
        createdAt: EPOCH,
      };
    }
    case 'Connection': {
      if (typeof attr['id'] !== 'string' || 'connectionId' in attr) return attr;
      return {
        connectionId: attr['id'],
        connectionName: oldProps['name'],
        databaseId: oldProps['databaseId'],
        kind: 'postgres',
        createdAt: EPOCH,
        directConnectionString: attr['connectionString'],
        databaseUrl: attr['connectionString'],
      };
    }
    case 'App': {
      if (typeof attr['id'] !== 'string' || 'appId' in attr) return attr;
      return {
        appId: attr['id'],
        name: attr['name'] ?? oldProps['name'],
        projectId: oldProps['projectId'],
        regionId: oldProps['region'] ?? DEFAULT_REGION,
        // A production row recorded no branch: null makes upstream's diff plan
        // an update, whose reconcile re-reads the App and records the real
        // default-branch id. A branch stage recorded its own and converges.
        branchId: oldProps['branchId'] ?? null,
        latestDeploymentId: null,
        // Absent only on a row written before the platform returned a domain.
        // Left unset rather than faked: a service's own origin is read from
        // this attribute, and an empty string would wire a broken origin
        // silently where an absent one fails loudly.
        ...(attr['endpointDomain'] !== undefined
          ? { appEndpointDomain: attr['endpointDomain'] }
          : {}),
        createdAt: EPOCH,
      };
    }
    case 'Deployment': {
      if (typeof attr['deploymentId'] !== 'string' || 'appId' in attr) return attr;
      return {
        deploymentId: attr['deploymentId'],
        appId: oldProps['computeServiceId'],
        // `foundryVersionId` is deliberately absent, not invented: upstream
        // uses it to recover a deployment whose id was lost, and a made-up
        // one would either match nothing or claim a stranger's deployment.
        // Absent means "recover by deployment id only".
        status: undefined,
        previewDomain: undefined,
        appEndpointDomain: attr['deployedUrl'],
        createdAt: undefined,
      };
    }
    case 'EnvironmentVariable': {
      if (typeof attr['id'] !== 'string' || 'environmentVariableId' in attr) return attr;
      const key = attr['key'] ?? oldProps['key'];
      if (typeof key === 'string' && POISON_KEYS.has(key)) return poisonKeyAttr(key);
      return {
        environmentVariableId: attr['id'],
        projectId: oldProps['projectId'],
        branchId: oldProps['branchId'] ?? null,
        class: oldProps['class'] ?? 'production',
        key,
        // The API never returns plaintext, so upstream's own cold-read
        // placeholder is what belongs here — the desired value arrives from
        // props on every reconcile.
        value: Redacted.make(''),
        valueKid: '',
        isManagedBySystem: false,
        createdAt: EPOCH,
        updatedAt: EPOCH,
      };
    }
  }
};

const migrateResourceRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const resourceType = row['resourceType'];
  if (typeof resourceType !== 'string') return row;
  const family = FAMILY_BY_LEGACY_TYPE[resourceType];
  if (family === undefined) return row;

  const migrated: Record<string, unknown> = {
    ...row,
    resourceType: UPSTREAM_TYPE[family],
    ...('props' in row ? { props: migrateProps(family, row['props']) } : {}),
    ...('attr' in row ? { attr: migrateAttr(family, row['attr'], row['props']) } : {}),
  };

  // Replacement rows nest the displaced generation under `old` (a full row);
  // updating rows nest `{props, attr, bindings}`. Migrate both forms so no
  // stale shape survives anywhere in the chain.
  const old = row['old'];
  if (isRecord(old)) {
    migrated['old'] =
      typeof old['resourceType'] === 'string'
        ? migrateResourceRow(old)
        : {
            ...old,
            ...('props' in old ? { props: migrateProps(family, old['props']) } : {}),
            ...('attr' in old ? { attr: migrateAttr(family, old['attr'], old['props']) } : {}),
          };
  }
  return migrated;
};

/**
 * Maps a revived state value from a legacy Composer resource shape to the
 * upstream shape. Rows of other resource types (and action rows) pass through
 * untouched; the function is idempotent, so already-migrated rows pass
 * through too.
 */
export const migrateLegacyResourceState = (value: unknown): unknown => {
  if (!isRecord(value) || value['kind'] === 'action') return value;
  return migrateResourceRow(value);
};
