/** Pins the upstream `Prisma.Database` semantics the database descriptors depend on — real provider, fake Management client. */
import { describe, expect, test } from 'bun:test';
import { InstanceId } from 'alchemy/InstanceId';
import { PrismaClient, type PrismaManagementClient } from 'alchemy/Prisma/Client';
import { Database, DatabaseProvider } from 'alchemy/Prisma/Database';
import type { Database as ApiDatabase } from 'alchemy/Prisma/Types';
import { Stack } from 'alchemy/Stack';
import { Stage } from 'alchemy/Stage';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';

const PROJECT_ID = 'proj_1';
const DEFAULT_BRANCH_ID = 'br_default';
const DIRECT_URL = 'postgres://user:secret@db.prisma.example:5432/postgres';

const unassignedDb = (): ApiDatabase => ({
  id: 'db_1',
  type: 'database',
  url: 'https://api.prisma.io/v1/databases/db_1',
  name: 'data',
  status: 'ready',
  createdAt: '2026-01-01T00:00:00.000Z',
  isDefault: false,
  defaultConnectionId: 'conn_1',
  connections: [],
  project: { id: PROJECT_ID, url: 'https://api.prisma.io/v1/projects/proj_1', name: 'shop' },
  region: { id: 'us-east-1', name: 'US East (N. Virginia)' },
  source: { type: 'empty' },
  branchId: null,
});

const persistedOutput = (db: ApiDatabase): Database['Attributes'] => ({
  databaseId: db.id,
  databaseName: db.name,
  projectId: db.project.id,
  status: db.status,
  region: db.region?.id ?? null,
  isDefault: db.isDefault,
  branchId: db.branchId,
  defaultConnectionId: db.defaultConnectionId,
  createdAt: db.createdAt,
  directConnectionString: Redacted.make(DIRECT_URL),
  pooledConnectionString: undefined,
  accelerateConnectionString: undefined,
  host: 'db.prisma.example',
  user: 'user',
  password: undefined,
});

/** State attrs as `legacy-resources.ts`'s `migrateAttr` writes them: identity only, no connection secrets. */
const legacyMigratedOutput = (db: ApiDatabase): Database['Attributes'] => ({
  databaseId: db.id,
  databaseName: db.name,
  projectId: db.project.id,
  status: 'ready',
  region: db.region?.id ?? null,
  isDefault: false,
  branchId: db.branchId,
  defaultConnectionId: null,
  createdAt: '1970-01-01T00:00:00.000Z',
  directConnectionString: undefined,
  pooledConnectionString: undefined,
  accelerateConnectionString: undefined,
  host: undefined,
  user: undefined,
  password: undefined,
});

const oldProps = { project: PROJECT_ID, region: 'us-east-1', name: 'data' } as const;
const newProps = { project: PROJECT_ID, region: 'us-east-1', branchId: DEFAULT_BRANCH_ID } as const;

interface FakeClientCalls {
  update: Array<[string, { name?: string; branchId?: string | null }]>;
  rotate: string[];
  create: number;
  delete: number;
}

/** A stateful fake Management client: one database, PATCHable, never deletable. */
function fakeClient(): { client: PrismaManagementClient; calls: FakeClientCalls } {
  let current = unassignedDb();
  const calls: FakeClientCalls = { update: [], rotate: [], create: 0, delete: 0 };
  const client = {
    getDatabase: (id: string) =>
      id === current.id
        ? Effect.succeed(current)
        : Effect.die(new Error(`unexpected getDatabase(${id})`)),
    updateDatabase: (id: string, patch: { name?: string; branchId?: string | null }) => {
      calls.update.push([id, patch]);
      current = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.branchId !== undefined ? { branchId: patch.branchId } : {}),
      };
      return Effect.succeed(current);
    },
    rotateConnection: (id: string) => {
      calls.rotate.push(id);
      return Effect.succeed({
        id,
        type: 'connection',
        url: `https://api.prisma.io/v1/connections/${id}`,
        name: 'default',
        createdAt: '2026-01-01T00:00:00.000Z',
        kind: 'postgres',
        database: { id: current.id, url: current.url, name: current.name },
        endpoints: {
          direct: {
            connectionString: DIRECT_URL,
            host: 'db.prisma.example',
            user: 'user',
            password: 'rotated-secret',
          },
        },
      });
    },
    createDatabase: () => {
      calls.create += 1;
      return Effect.die(new Error('createDatabase must not be called for an existing database'));
    },
    deleteDatabase: () => {
      calls.delete += 1;
      return Effect.die(new Error('deleteDatabase must not be called — that is the data loss'));
    },
  } as unknown as PrismaManagementClient;
  return { client, calls };
}

// Loosely typed: the real request types carry engine-session fields the handlers never read.
interface ProviderHandlers {
  diff: (req: unknown) => Effect.Effect<unknown, unknown, unknown>;
  reconcile: (req: unknown) => Effect.Effect<Database['Attributes'], unknown, unknown>;
}

function handlersFor(client: PrismaManagementClient): ProviderHandlers {
  const resolved = Effect.gen(function* () {
    return yield* Database.Provider;
  }).pipe(
    Effect.provide(DatabaseProvider()),
    Effect.provideService(PrismaClient, client),
  ) as Effect.Effect<unknown>;
  return Effect.runSync(resolved) as ProviderHandlers;
}

// Fixed values keep `createPhysicalName`'s generated name deterministic.
const provideLifecycle = <A>(eff: Effect.Effect<A, unknown, unknown>): Effect.Effect<A> =>
  eff.pipe(
    Effect.provideService(Stack, { name: 'shop' } as unknown as Stack['Service']),
    Effect.provideService(Stage, DEFAULT_BRANCH_ID),
    Effect.provideService(InstanceId, '00112233445566778899aabbccddeeff'),
  ) as unknown as Effect.Effect<A>;

describe('upstream Prisma.Database — converging an unassigned, explicitly named database', () => {
  test('diff plans an in-place UPDATE, never a replace', async () => {
    const { client } = fakeClient();
    const handlers = handlersFor(client);

    const decision = await Effect.runPromise(
      provideLifecycle(
        handlers.diff({
          id: 'data-db',
          olds: oldProps,
          news: newProps,
          output: persistedOutput(unassignedDb()),
        }),
      ),
    );

    expect(decision).toEqual({ action: 'update' });
  });

  test('reconcile PATCHes the existing database onto the default Branch — no create, no delete', async () => {
    const { client, calls } = fakeClient();
    const handlers = handlersFor(client);

    const attrs = await Effect.runPromise(
      provideLifecycle(
        handlers.reconcile({
          id: 'data-db',
          olds: oldProps,
          news: newProps,
          output: persistedOutput(unassignedDb()),
        }),
      ),
    );

    expect(calls.update).toHaveLength(1);
    const [patchedId, patch] = calls.update[0] ?? ['', {}];
    expect(patchedId).toBe('db_1');
    expect(patch.branchId).toBe(DEFAULT_BRANCH_ID);
    expect(typeof patch.name).toBe('string');
    expect(calls.create).toBe(0);
    expect(calls.delete).toBe(0);
    expect(calls.rotate).toEqual([]);
    expect(attrs.databaseId).toBe('db_1');
    expect(attrs.branchId).toBe(DEFAULT_BRANCH_ID);
  });

  test('a legacy-migrated state row (no stored secrets) attaches in place and rotates the DEFAULT connection', async () => {
    const { client, calls } = fakeClient();
    const handlers = handlersFor(client);

    const decision = await Effect.runPromise(
      provideLifecycle(
        handlers.diff({
          id: 'data-db',
          olds: oldProps,
          news: newProps,
          output: legacyMigratedOutput(unassignedDb()),
        }),
      ),
    );
    expect(decision).toEqual({ action: 'update' });

    const attrs = await Effect.runPromise(
      provideLifecycle(
        handlers.reconcile({
          id: 'data-db',
          olds: oldProps,
          news: newProps,
          output: legacyMigratedOutput(unassignedDb()),
        }),
      ),
    );

    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]?.[1].branchId).toBe(DEFAULT_BRANCH_ID);
    expect(calls.create).toBe(0);
    expect(calls.delete).toBe(0);
    expect(calls.rotate).toEqual(['conn_1']);
    expect(attrs.databaseId).toBe('db_1');
    expect(attrs.branchId).toBe(DEFAULT_BRANCH_ID);
    expect(attrs.directConnectionString).toBeDefined();
  });

  test('the converged state is stable — a second reconcile issues no PATCH', async () => {
    const { client, calls } = fakeClient();
    const handlers = handlersFor(client);

    const first = await Effect.runPromise(
      provideLifecycle(
        handlers.reconcile({
          id: 'data-db',
          olds: oldProps,
          news: newProps,
          output: persistedOutput(unassignedDb()),
        }),
      ),
    );
    expect(calls.update).toHaveLength(1);

    const second = await Effect.runPromise(
      provideLifecycle(
        handlers.reconcile({
          id: 'data-db',
          olds: newProps,
          news: newProps,
          output: first,
        }),
      ),
    );

    expect(calls.update).toHaveLength(1);
    expect(second.databaseId).toBe('db_1');
    expect(second.branchId).toBe(DEFAULT_BRANCH_ID);
  });
});
