/**
 * One-time, on-read rewrite of legacy postgres-family state rows into the
 * shapes upstream alchemy's `Prisma.{Project,Database,Connection}` providers
 * expect.
 *
 * Composer's own postgres resources persisted rows under the type-ids
 * `Prisma.Database` / `Prisma.Connection` / `Prisma.Project` (and, for one
 * unreleased window, `PrismaComposer.*`) with attribute shapes `{id, name}`
 * (database/project) and `{id, connectionString}` (connection). Upstream's
 * classes carry the SAME type-ids but expect `{databaseId, …}` /
 * `{connectionId, …}` / `{projectId, …}` attributes. This module maps old rows
 * to the upstream shape as they are read out of the hosted state store, so
 * upstream's providers adopt them (their `read`/`diff` key off
 * `output.databaseId` / `output.connectionId`) instead of planning a create.
 *
 * The legacy connection string was captured direct-preferred (pooled only as
 * a fallback the API never actually took), so it maps to
 * `directConnectionString` — and to `databaseUrl`, which is what the string
 * was used as. Fields the old rows never carried (pooled/accelerate strings,
 * host/user/password, origins) are left absent; upstream recomputes them from
 * observed API state on the next reconcile that needs them.
 *
 * One-time operator-visible effects on BRANCH-STAGE environments (documented
 * in docs/guides/deploying.md, "Upgrading to the upstream postgres
 * resources"): the branch-stage descriptor passes no display name, so the
 * first deploy after migration renames each stage database to a generated
 * physical name and, in the same reconcile, rotates the database's DEFAULT
 * connection credentials. The framework's own named Connection — the one
 * services use — is not rotated. Production rows converge with no action.
 *
 * Scope: the HOSTED state store only. Local dev state (alchemy's local
 * store) is never migrated — a stale local row under an unregistered type-id
 * fails at plan time with alchemy's missing-provider error, and
 * `prisma-composer dev --fresh` clears it (see docs/guides/running-locally.md).
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const EPOCH = '1970-01-01T00:00:00.000Z';

type Family = 'Project' | 'Database' | 'Connection';

const FAMILY_BY_LEGACY_TYPE: Readonly<Record<string, Family>> = {
  'Prisma.Project': 'Project',
  'Prisma.Database': 'Database',
  'Prisma.Connection': 'Connection',
  'PrismaComposer.Project': 'Project',
  'PrismaComposer.Database': 'Database',
  'PrismaComposer.Connection': 'Connection',
};

const migrateProps = (family: Family, props: unknown): unknown => {
  if (!isRecord(props)) return props;
  switch (family) {
    case 'Project':
      // Upstream ProjectProps carry no workspaceId; keep only the name.
      return 'workspaceId' in props ? { name: props['name'] } : props;
    case 'Database': {
      if (!('projectId' in props) || 'project' in props) return props;
      return {
        project: props['projectId'],
        name: props['name'],
        region: props['region'],
        ...(props['branchId'] !== undefined ? { branchId: props['branchId'] } : {}),
      };
    }
    case 'Connection': {
      if (!('databaseId' in props) || 'database' in props) return props;
      return { database: props['databaseId'], name: props['name'] };
    }
  }
};

const migrateAttr = (family: Family, attr: unknown, props: unknown): unknown => {
  if (!isRecord(attr) || typeof attr['id'] !== 'string') return attr;
  const oldProps = isRecord(props) ? props : {};
  switch (family) {
    case 'Project': {
      if ('projectId' in attr) return attr;
      return {
        projectId: attr['id'],
        projectName: attr['name'],
        workspaceId: oldProps['workspaceId'] ?? '',
        createdAt: EPOCH,
        defaultRegion: null,
      };
    }
    case 'Database': {
      if ('databaseId' in attr) return attr;
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
      if ('connectionId' in attr) return attr;
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
  }
};

const migrateResourceRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const resourceType = row['resourceType'];
  if (typeof resourceType !== 'string') return row;
  const family = FAMILY_BY_LEGACY_TYPE[resourceType];
  if (family === undefined) return row;

  const migrated: Record<string, unknown> = {
    ...row,
    resourceType: `Prisma.${family}`,
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
 * Maps a revived state value from the legacy Composer postgres shape to the
 * upstream shape. Non-postgres rows (and action rows) pass through untouched;
 * the function is idempotent, so already-migrated rows pass through too.
 */
export const migrateLegacyPostgresState = (value: unknown): unknown => {
  if (!isRecord(value) || value['kind'] === 'action') return value;
  return migrateResourceRow(value);
};
