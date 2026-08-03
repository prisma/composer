/**
 * Legacy postgres-family state rows (written by Composer's own deleted
 * `Prisma.Database` / `Prisma.Connection` resources) must round-trip through
 * the hosted state store into shapes upstream alchemy's providers ACCEPT —
 * meaning: the provider's `diff` plans no action (so no create and no
 * replace), its `read` finds the physical resource instead of returning
 * `undefined` (which would plan a create), and `reconcile` keeps the
 * persisted secret without rotating anything.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { InstanceId } from 'alchemy/InstanceId';
import * as Prisma from 'alchemy/Prisma';
import type * as Provider from 'alchemy/Provider';
import { Stack } from 'alchemy/Stack';
import { Stage } from 'alchemy/Stage';
import type { CreatedResourceState, ReplacedResourceState } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import postgres from 'postgres';
import { migrateLegacyPostgresState } from '../legacy-postgres.ts';
import { migratePrismaState } from '../schema.ts';
import { makePrismaStateService } from '../service.ts';
import { startTestPostgres, type TestPostgres } from './harness.ts';

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[alchemy/state] skipping legacy-postgres migration tests: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL to point at one, or install initdb/pg_ctl ' +
      '(e.g. `brew install postgresql@15`) on PATH.',
  );
}

const DIRECT_URL = 'postgres://user:pass@db.prisma.io:5432/postgres';

const legacyDatabaseRow = (): CreatedResourceState => ({
  resourceType: 'Prisma.Database',
  namespace: undefined,
  fqn: 'data-db',
  logicalId: 'data-db',
  instanceId: 'inst-db',
  providerVersion: 1,
  status: 'created',
  downstream: [],
  bindings: [],
  props: { projectId: 'proj-1', name: 'data', region: 'us-east-1' },
  attr: { id: 'db-1', name: 'data' },
});

const legacyConnectionRow = (): CreatedResourceState => ({
  resourceType: 'Prisma.Connection',
  namespace: undefined,
  fqn: 'data-conn',
  logicalId: 'data-conn',
  instanceId: 'inst-conn',
  providerVersion: 1,
  status: 'created',
  downstream: [],
  bindings: [],
  props: { databaseId: 'db-1', name: 'data' },
  attr: { id: 'conn-1', connectionString: Redacted.make(DIRECT_URL) },
});

const apiDatabase = {
  id: 'db-1',
  name: 'data',
  project: { id: 'proj-1' },
  status: 'ready',
  region: { id: 'us-east-1' },
  isDefault: false,
  branchId: null,
  defaultConnectionId: 'conn-default',
  createdAt: '2025-01-01T00:00:00.000Z',
  source: { type: 'empty' },
  connections: [],
};

const apiConnection = {
  id: 'conn-1',
  name: 'data',
  database: { id: 'db-1' },
  kind: 'postgres',
  createdAt: '2025-01-01T00:00:00.000Z',
};

/** Only the endpoints the adoption paths under test actually hit; anything else throws loudly. */
const stubClient = {
  getDatabase: (id: string) =>
    id === 'db-1' ? Effect.succeed(apiDatabase) : Effect.die(`unexpected getDatabase ${id}`),
  getConnection: (id: string) =>
    id === 'conn-1' ? Effect.succeed(apiConnection) : Effect.die(`unexpected getConnection ${id}`),
  rotateConnection: (id: string) =>
    Effect.die(`rotateConnection(${id}) must not be called for an adopted legacy row`),
} as unknown as Prisma.PrismaManagementClient;

// The provider layers' inferred environment leaks an `any` through
// Provider.effect's typing; the stubbed PrismaClient is the only real
// requirement and it IS provided, so the runtime environment is complete.
const databaseService = () =>
  Effect.runPromise(
    Prisma.Database.Provider.pipe(
      Effect.provide(
        Prisma.DatabaseProvider().pipe(
          Layer.provide(Layer.succeed(Prisma.PrismaClient, stubClient)),
        ),
      ),
    ) as Effect.Effect<Provider.ProviderService<Prisma.Database>, never, never>,
  );

const connectionService = () =>
  Effect.runPromise(
    Prisma.Connection.Provider.pipe(
      Effect.provide(
        Prisma.ConnectionProvider().pipe(
          Layer.provide(Layer.succeed(Prisma.PrismaClient, stubClient)),
        ),
      ),
    ) as Effect.Effect<Provider.ProviderService<Prisma.Connection>, never, never>,
  );

type MigratedRow = CreatedResourceState & {
  props: Record<string, unknown>;
  attr: Record<string, unknown>;
};

describe('migrateLegacyPostgresState (pure mapping)', () => {
  test('maps a legacy Database row to upstream field names, idempotently', () => {
    const migrated = migrateLegacyPostgresState(legacyDatabaseRow()) as MigratedRow;
    expect(migrated.resourceType).toBe('Prisma.Database');
    expect(migrated.props).toEqual({ project: 'proj-1', name: 'data', region: 'us-east-1' });
    expect(migrated.attr).toMatchObject({
      databaseId: 'db-1',
      databaseName: 'data',
      projectId: 'proj-1',
      region: 'us-east-1',
      isDefault: false,
      branchId: null,
    });
    expect(migrateLegacyPostgresState(migrated)).toEqual(migrated);
  });

  test('maps a legacy Connection row, carrying the Redacted secret into directConnectionString', () => {
    const migrated = migrateLegacyPostgresState(legacyConnectionRow()) as MigratedRow;
    expect(migrated.resourceType).toBe('Prisma.Connection');
    expect(migrated.props).toEqual({ database: 'db-1', name: 'data' });
    expect(migrated.attr).toMatchObject({
      connectionId: 'conn-1',
      connectionName: 'data',
      databaseId: 'db-1',
      kind: 'postgres',
    });
    const direct = migrated.attr['directConnectionString'];
    expect(Redacted.isRedacted(direct)).toBe(true);
    expect(Redacted.value(direct as Redacted.Redacted<string>)).toBe(DIRECT_URL);
    expect(migrateLegacyPostgresState(migrated)).toEqual(migrated);
  });

  test('migrates the nested old-generation chain of a replaced row', () => {
    const replaced: ReplacedResourceState = {
      ...legacyDatabaseRow(),
      status: 'replaced',
      old: legacyDatabaseRow(),
      deleteFirst: false,
    } as ReplacedResourceState;
    const migrated = migrateLegacyPostgresState(replaced) as ReplacedResourceState & {
      old: MigratedRow;
    };
    expect(migrated.old.resourceType).toBe('Prisma.Database');
    expect(migrated.old.attr).toMatchObject({ databaseId: 'db-1', databaseName: 'data' });
    expect(migrated.old.props).toEqual({ project: 'proj-1', name: 'data', region: 'us-east-1' });
  });

  test('maps the unreleased PrismaComposer.* type-ids too, and passes foreign rows through', () => {
    const composerEra = { ...legacyDatabaseRow(), resourceType: 'PrismaComposer.Database' };
    expect((migrateLegacyPostgresState(composerEra) as MigratedRow).resourceType).toBe(
      'Prisma.Database',
    );
    const foreign = { ...legacyDatabaseRow(), resourceType: 'Prisma.ComputeService' };
    expect(migrateLegacyPostgresState(foreign)).toEqual(foreign);
  });
});

describe('upstream provider acceptance of migrated rows (stubbed management client)', () => {
  const migratedDb = migrateLegacyPostgresState(legacyDatabaseRow()) as MigratedRow;
  const migratedConn = migrateLegacyPostgresState(legacyConnectionRow()) as MigratedRow;

  test('Database: diff plans NO action, and read finds the database (no create)', async () => {
    const service = await databaseService();
    if (service.diff === undefined || service.read === undefined) {
      throw new Error('upstream provider must expose diff and read');
    }
    const diff = await Effect.runPromise(
      service.diff({
        id: 'data-db',
        fqn: 'data-db',
        instanceId: 'inst-db',
        olds: migratedDb.props,
        news: { project: 'proj-1', name: 'data', region: 'us-east-1' },
        output: migratedDb.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(diff).toBeUndefined();

    const read = await Effect.runPromise(
      service.read({
        id: 'data-db',
        fqn: 'data-db',
        instanceId: 'inst-db',
        olds: migratedDb.props,
        output: migratedDb.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(read).toMatchObject({ databaseId: 'db-1', databaseName: 'data', projectId: 'proj-1' });
  });

  test('Connection: diff plans NO action, read finds it, reconcile keeps the secret WITHOUT rotating', async () => {
    const service = await connectionService();
    if (service.diff === undefined || service.read === undefined) {
      throw new Error('upstream provider must expose diff and read');
    }
    const diff = await Effect.runPromise(
      service.diff({
        id: 'data-conn',
        fqn: 'data-conn',
        instanceId: 'inst-conn',
        olds: migratedConn.props,
        news: { database: 'db-1', name: 'data' },
        output: migratedConn.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(diff).toBeUndefined();

    const read = await Effect.runPromise(
      service.read({
        id: 'data-conn',
        fqn: 'data-conn',
        instanceId: 'inst-conn',
        olds: migratedConn.props,
        output: migratedConn.attr,
        session: undefined,
        bindings: [],
      } as never),
    );
    expect(read).toMatchObject({ connectionId: 'conn-1', databaseId: 'db-1' });

    // The stub's rotateConnection dies, so this passing proves reconcile
    // never touched the live credentials.
    const reconciled = (await Effect.runPromise(
      service.reconcile({
        id: 'data-conn',
        fqn: 'data-conn',
        instanceId: 'inst-conn',
        olds: migratedConn.props,
        news: { database: 'db-1', name: 'data' },
        output: migratedConn.attr,
        session: undefined,
        bindings: [],
      } as never),
    )) as Record<string, unknown>;
    const direct = reconciled['directConnectionString'];
    expect(Redacted.isRedacted(direct)).toBe(true);
    expect(Redacted.value(direct as Redacted.Redacted<string>)).toBe(DIRECT_URL);
  });
});

describe('branch-stage migrated rows against upstream Database provider', () => {
  // A branch-stage row: the legacy descriptor passed an explicit name AND a
  // branchId; the replacement descriptor omits the name when branchId is set.
  const legacyBranchRow = (): CreatedResourceState => ({
    ...legacyDatabaseRow(),
    props: { projectId: 'proj-1', name: 'data', region: 'us-east-1', branchId: 'branch_1' },
  });

  test('diff plans an UPDATE (the one-time rename + credential-recovery path), never a replace or create', async () => {
    const migrated = migrateLegacyPostgresState(legacyBranchRow()) as MigratedRow;
    expect(migrated.props).toEqual({
      project: 'proj-1',
      name: 'data',
      region: 'us-east-1',
      branchId: 'branch_1',
    });
    expect(migrated.attr).toMatchObject({ branchId: 'branch_1' });

    const service = await databaseService();
    if (service.diff === undefined) throw new Error('upstream provider must expose diff');
    const diff = await Effect.runPromise(
      service
        .diff({
          id: 'data-db',
          fqn: 'data-db',
          instanceId: 'inst-db',
          olds: migrated.props,
          // Branch-stage news shape from descriptors/postgres.ts: NO name.
          news: { project: 'proj-1', region: 'us-east-1', branchId: 'branch_1' },
          output: migrated.attr,
          session: undefined,
          bindings: [],
        } as never)
        .pipe(
          // The omitted name makes upstream derive a generated physical name,
          // which reads the engine's Stack/Stage/InstanceId context.
          Effect.provideService(Stack, { name: 'app' } as never),
          Effect.provideService(Stage, 'stage1'),
          Effect.provideService(InstanceId, 'abcd1234abcd1234abcd1234abcd1234'),
        ),
    );
    expect(diff).toEqual({ action: 'update' });
  });
});

describe.skipIf(pg === undefined)('state service round-trip of legacy rows', () => {
  if (pg === undefined) return;

  const sql = postgres(pg.url, { max: 5, onnotice: () => {} });
  const service = makePrismaStateService(sql);
  const stack = 'legacy-postgres-stack';
  const stage = 'legacy-postgres-stage';

  beforeAll(async () => {
    await Effect.runPromise(migratePrismaState(sql));
  });

  afterAll(async () => {
    await Effect.runPromise(service.deleteStack({ stack }));
    await sql.end({ timeout: 1 });
    pg.stop();
  });

  test('an old-shape Database row persisted as-is is read back in the upstream shape', async () => {
    await Effect.runPromise(
      service.set({ stack, stage, fqn: 'data-db', value: legacyDatabaseRow() }),
    );
    const row = (await Effect.runPromise(
      service.get({ stack, stage, fqn: 'data-db' }),
    )) as MigratedRow;
    expect(row.resourceType).toBe('Prisma.Database');
    expect(row.attr).toMatchObject({ databaseId: 'db-1', databaseName: 'data' });
    expect(row.props).toEqual({ project: 'proj-1', name: 'data', region: 'us-east-1' });
  });

  test('an old-shape Connection row round-trips with the Redacted secret intact', async () => {
    await Effect.runPromise(
      service.set({ stack, stage, fqn: 'data-conn', value: legacyConnectionRow() }),
    );
    const row = (await Effect.runPromise(
      service.get({ stack, stage, fqn: 'data-conn' }),
    )) as MigratedRow;
    expect(row.resourceType).toBe('Prisma.Connection');
    expect(row.attr).toMatchObject({ connectionId: 'conn-1', databaseId: 'db-1' });
    const direct = row.attr['directConnectionString'];
    expect(Redacted.isRedacted(direct)).toBe(true);
    expect(Redacted.value(direct as Redacted.Redacted<string>)).toBe(DIRECT_URL);
    // The databaseUrl mirror keeps the value usable where the conventional
    // application URL is read.
    expect(Redacted.value(row.attr['databaseUrl'] as Redacted.Redacted<string>)).toBe(DIRECT_URL);
  });
});
