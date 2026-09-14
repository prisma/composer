/**
 * One-time, on-read rewrite of legacy Composer state rows into the shapes
 * upstream alchemy's `Prisma.*` providers expect, so their `read`/`diff`
 * adopts the deployed resources instead of planning a create. Old rows carry
 * hand-rolled attributes (`{id, name}`, `{id, connectionString}`, …); upstream
 * expects `{projectId, …}` / `{databaseId, …}` / etc. Fields old rows never
 * carried are left absent — upstream recomputes them from observed API state.
 * Legacy `DATABASE_URL` claim rows are retired ({@link retireDatabaseUrlClaimRow}).
 *
 * Operator-visible one-time effects of the first migrated deploy (branch-stage
 * database rename + default-connection rotation, one fresh deployment per
 * service) are documented in docs/guides/deploying.md. Hosted state only:
 * local dev state is cleared with `prisma-composer dev --fresh` instead.
 */

import * as Redacted from 'effect/Redacted';
import { ARTIFACT_CONTENT_TYPE } from '../compute/artifact.ts';
import { RESERVED_DATABASE_URL_KEYS } from '../database-url-claim.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const EPOCH = '1970-01-01T00:00:00.000Z';

/** Where a legacy row recorded no region: the only region Composer's descriptors ever defaulted to. */
const DEFAULT_REGION = 'us-east-1';

/**
 * The reserved keys older Composer versions claimed through tracked
 * EnvironmentVariable resources. Today the claim is a create-only API call
 * outside deploy state (database-url-claim.ts, whose key set this is), so the
 * tracked rows those versions left behind are disposed of here.
 */
const CLAIMED_DATABASE_URL_KEYS: ReadonlySet<string> = new Set(RESERVED_DATABASE_URL_KEYS);

type Family =
  | 'Project'
  | 'Database'
  | 'Connection'
  | 'App'
  | 'Deployment'
  | 'EnvironmentVariable'
  | 'Bucket'
  | 'BucketAccessKey';

const FAMILY_BY_LEGACY_TYPE: Readonly<Record<string, Family>> = {
  'Prisma.Project': 'Project',
  'Prisma.Database': 'Database',
  'Prisma.Connection': 'Connection',
  'Prisma.ComputeService': 'App',
  'Prisma.Deployment': 'Deployment',
  'Prisma.EnvironmentVariable': 'EnvironmentVariable',
  'Prisma.Bucket': 'Bucket',
  'Prisma.BucketKey': 'BucketAccessKey',
  'PrismaComposer.Project': 'Project',
  'PrismaComposer.Database': 'Database',
  'PrismaComposer.Connection': 'Connection',
  'PrismaComposer.ComputeService': 'App',
  'PrismaComposer.Deployment': 'Deployment',
  'PrismaComposer.EnvironmentVariable': 'EnvironmentVariable',
  'PrismaComposer.Bucket': 'Bucket',
  'PrismaComposer.BucketKey': 'BucketAccessKey',
};

/** The type-id upstream registers each family under. */
const UPSTREAM_TYPE: Readonly<Record<Family, string>> = {
  Project: 'Prisma.Project',
  Database: 'Prisma.Database',
  Connection: 'Prisma.Connection',
  App: 'Prisma.App',
  Deployment: 'Prisma.Deployment',
  EnvironmentVariable: 'Prisma.EnvironmentVariable',
  Bucket: 'Prisma.Bucket',
  BucketAccessKey: 'Prisma.BucketAccessKey',
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
    case 'Bucket':
      return 'projectId' in props && !('project' in props);
    case 'BucketAccessKey':
      return 'bucketId' in props && !('bucket' in props);
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
    case 'Bucket':
      return {
        project: props['projectId'],
        name: props['name'],
        ...(props['branchId'] !== undefined ? { branchId: props['branchId'] } : {}),
      };
    case 'BucketAccessKey':
      return {
        bucket: props['bucketId'],
        name: props['name'],
        role: props['role'],
      };
  }
};

/**
 * A legacy claim row (an EnvironmentVariable resource an older Composer
 * persisted for a reserved DATABASE_URL key) names a variable Composer must
 * stop managing. Deleting one
 * for real is not safe: the legacy adoption matched on `{projectId, class,
 * key}` with no branch id, so the recorded scope may not equal the live
 * variable's, and upstream's delete refuses — loudly, mid-deploy — on a scope
 * mismatch. Whether the live variable is the platform's own system-managed
 * template or the `"-"` placeholder Composer wrote over it depends on the
 * stage, and neither is Composer's to remove.
 *
 * Two halves, doing different jobs:
 *
 *   · `removalPolicy: "retain"` on the ROW. Alchemy's engine honors it before
 *     the provider is ever consulted: it drops the state row, makes no API
 *     call, and reports the resource as `retained` rather than `deleted` —
 *     which is the truthful verb, and the one an operator reading the deploy
 *     log needs to see.
 *   · An `environmentVariableId` the engine reads as "not a cloud resource"
 *     (`isPrismaDevId`). This governs what the PROVIDER would do if it were
 *     ever handed these attributes on some other path: nothing.
 */
const retireDatabaseUrlClaimRow = (row: Record<string, unknown>, key: string) => ({
  ...row,
  removalPolicy: 'retain',
  attr: { environmentVariableId: `dev:legacy-claim-${key}`, key },
});

/**
 * The reserved key a legacy claim row named, from whichever half of the row still carries it
 * — for LEGACY rows only. Upstream's own `EnvironmentVariable` rows share this
 * type-id, so without the props-shape check a live, upstream-managed
 * `DATABASE_URL` variable would be retired from state on every read.
 */
const claimedKeyOf = (family: Family, props: unknown, attr: unknown): string | undefined => {
  if (family !== 'EnvironmentVariable') return undefined;
  if (!isRecord(props) || !isLegacyProps(family, props)) return undefined;
  const fromAttr = isRecord(attr) ? attr['key'] : undefined;
  const fromProps = isRecord(props) ? props['key'] : undefined;
  const key = typeof fromAttr === 'string' ? fromAttr : fromProps;
  return typeof key === 'string' && CLAIMED_DATABASE_URL_KEYS.has(key) ? key : undefined;
};

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
      return {
        environmentVariableId: attr['id'],
        projectId: oldProps['projectId'],
        branchId: oldProps['branchId'] ?? null,
        class: oldProps['class'] ?? 'production',
        key: attr['key'] ?? oldProps['key'],
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
    case 'Bucket': {
      if (typeof attr['id'] !== 'string' || 'bucketId' in attr) return attr;
      return {
        bucketId: attr['id'],
        name: attr['name'],
        projectId: oldProps['projectId'],
        createdAt: EPOCH,
      };
    }
    case 'BucketAccessKey': {
      if (typeof attr['id'] !== 'string' || 'bucketAccessKeyId' in attr) return attr;
      const secret = attr['secretAccessKey'];
      return {
        bucketAccessKeyId: attr['id'],
        bucketId: attr['bucketId'],
        accessKeyId: attr['accessKeyId'],
        // Legacy rows already persisted the secret Redacted (the reveal-once
        // create response is the only copy) — keep it; wrap defensively if a
        // row somehow carries plaintext.
        secretAccessKey: Redacted.isRedacted(secret) ? secret : Redacted.make(String(secret ?? '')),
        endpoint: attr['endpoint'],
        bucketName: attr['bucketName'],
      };
    }
  }
};

/**
 * Type-id renames where the props/attr shapes are unchanged: rewriting the
 * `resourceType` (here and on any nested `old` row) is the whole migration.
 */
const RENAMED_TYPES: Readonly<Record<string, string>> = {
  'PrismaNext.Migration': 'PrismaOrm.Migration',
};

const renameResourceType = (
  row: Record<string, unknown>,
  renamed: string,
): Record<string, unknown> => {
  const migrated: Record<string, unknown> = { ...row, resourceType: renamed };
  const old = row['old'];
  if (isRecord(old) && typeof old['resourceType'] === 'string') {
    migrated['old'] = migrateResourceRow(old);
  }
  return migrated;
};

const migrateResourceRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const resourceType = row['resourceType'];
  if (typeof resourceType !== 'string') return row;
  const renamed = RENAMED_TYPES[resourceType];
  if (renamed !== undefined) return renameResourceType(row, renamed);
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

  // Retiring the row happens AFTER the `old` chain is rewritten: a replaced
  // claim row still carries the displaced generation, and it must reach the
  // engine in the upstream shape even though this row is on its way out.
  const claimedKey = claimedKeyOf(family, row['props'], row['attr']);
  if (claimedKey !== undefined) return retireDatabaseUrlClaimRow(migrated, claimedKey);

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
