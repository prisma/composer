/**
 * Pins the upstream `Prisma.Database` (alchemy) semantics the production
 * branch-attachment fix depends on — against the REAL provider, with a fake
 * Management client.
 *
 * Deployed production apps created before the fix own a database that is
 * UNASSIGNED (branchId null) under an explicit display name (the provision
 * id). The fixed descriptors now hand upstream `{ branchId: defaultBranchId }`
 * and no `name`. These tests prove that transition converges IN PLACE:
 *
 *  1. diff plans an `update`, never a `replace` — the database (and its data)
 *     survives;
 *  2. reconcile PATCHes the existing database onto the Branch — no create, no
 *     delete, same databaseId;
 *  3. the converged state is stable — a second reconcile issues no PATCH.
 *
 * If an alchemy upgrade changes any of these, this file fails before a
 * production deploy destroys someone's data.
 */
import { describe, expect, test } from 'bun:test';
import { InstanceId } from 'alchemy/InstanceId';
import { PrismaClient, type PrismaManagementClient } from 'alchemy/Prisma/Client';
import { Database, DatabaseProvider } from 'alchemy/Prisma/Database';
import type { Database as ApiDatabase } from 'alchemy/Prisma/Types';
import { Stack } from 'alchemy/Stack';
import { Stage } from 'alchemy/Stage';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';

// ——— The world before the fix: a production database created by the old
// lowering — explicit display name (the provision id), no branch attachment.
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

/** The persisted state attrs of that database (what alchemy stored). */
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

// The OLD props the state carries, and the NEW props the fixed descriptors
// produce (no name; the default Branch attached).
const oldProps = { project: PROJECT_ID, region: 'us-east-1', name: 'data' } as const;
const newProps = { project: PROJECT_ID, region: 'us-east-1', branchId: DEFAULT_BRANCH_ID } as const;

interface FakeClientCalls {
  update: Array<[string, { name?: string; branchId?: string | null }]>;
  create: number;
  delete: number;
}

/** A stateful fake Management client: one database, PATCHable, never deletable. */
function fakeClient(): { client: PrismaManagementClient; calls: FakeClientCalls } {
  let current = unassignedDb();
  const calls: FakeClientCalls = { update: [], create: 0, delete: 0 };
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

// The provider's lifecycle handlers, with loose request/response typing: the
// real ProviderService request types carry engine-session fields the handlers
// under test never read.
interface ProviderHandlers {
  diff: (req: unknown) => Effect.Effect<unknown, unknown, unknown>;
  reconcile: (req: unknown) => Effect.Effect<Database['Attributes'], unknown, unknown>;
}

function handlersFor(client: PrismaManagementClient): ProviderHandlers {
  const resolved = Effect.gen(function* () {
    // The resource class carries its own provider tag (Resource.ts wires
    // `Service.Provider = Provider(type)`).
    return yield* Database.Provider;
  }).pipe(
    Effect.provide(DatabaseProvider()),
    Effect.provideService(PrismaClient, client),
  ) as Effect.Effect<unknown>;
  return Effect.runSync(resolved) as ProviderHandlers;
}

// The lifecycle services `createPhysicalName` reads when props carry no
// explicit name. The same values every run — the generated physical name is
// deterministic per resource instance, which is what makes it recoverable.
const provideLifecycle = <A>(eff: Effect.Effect<A, unknown, unknown>): Effect.Effect<A> =>
  eff.pipe(
    Effect.provideService(Stack, { name: 'shop' } as unknown as Stack['Service']),
    Effect.provideService(Stage, DEFAULT_BRANCH_ID),
    Effect.provideService(InstanceId, '00112233445566778899aabbccddeeff'),
  ) as unknown as Effect.Effect<A>;

describe('upstream Prisma.Database — migrating a pre-fix unassigned production database', () => {
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

    // Branch attachment and display name both converge in place; anything
    // else ('replace', or a framework default of replace-on-unknown) would
    // schedule the production database for deletion.
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

    // Exactly one PATCH: the branch attachment (with upstream's generated
    // physical name replacing the explicit display name — name and branch
    // converge in the same call).
    expect(calls.update).toHaveLength(1);
    const [patchedId, patch] = calls.update[0] ?? ['', {}];
    expect(patchedId).toBe('db_1');
    expect(patch.branchId).toBe(DEFAULT_BRANCH_ID);
    expect(typeof patch.name).toBe('string');
    // The database itself was neither re-created nor deleted…
    expect(calls.create).toBe(0);
    expect(calls.delete).toBe(0);
    // …and the returned attributes keep its identity, now attached.
    expect(attrs.databaseId).toBe('db_1');
    expect(attrs.branchId).toBe(DEFAULT_BRANCH_ID);
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

    // Same identity, still attached, and no further PATCH: redeploys after
    // the migration deploy are no-ops for the database.
    expect(calls.update).toHaveLength(1);
    expect(second.databaseId).toBe('db_1');
    expect(second.branchId).toBe(DEFAULT_BRANCH_ID);
  });
});
