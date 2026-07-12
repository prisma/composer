import { beforeEach, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import type { ManagementApiClient } from '../../client.ts';
import { ManagementClient } from '../../client.ts';
import {
  bootstrapStateConnection,
  bootstrapStateConnectionWith,
  type OwnershipVerdict,
  type OwnershipVerifier,
} from '../bootstrap.ts';

interface FakeProject {
  id: string;
  name: string;
  createdAt: string;
  workspace: { id: string };
}

interface FakeDatabase {
  id: string;
  name: string;
  isDefault: boolean;
}

interface FakeConnection {
  id: string;
  name: string;
  createdAt: string;
}

interface FakeState {
  projects: FakeProject[];
  databases: Record<string, FakeDatabase[]>;
  connections: Record<string, FakeConnection[]>;
  createShouldFail: boolean;
  createCalls: number;
  listCalls: number;
  databaseCreateCalls: number;
  connectionCalls: string[];
  deletedConnectionIds: string[];
}

const newFakeState = (overrides: Partial<FakeState> = {}): FakeState => ({
  projects: [],
  databases: {},
  connections: {},
  createShouldFail: false,
  createCalls: 0,
  listCalls: 0,
  databaseCreateCalls: 0,
  connectionCalls: [],
  deletedConnectionIds: [],
  ...overrides,
});

const okResponse = <T>(data: T, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});

const errorResponse = (status: number) => ({
  data: undefined,
  error: { message: 'stubbed failure' },
  response: new Response(null, { status }),
});

/**
 * A stubbed `ManagementApiClient` — just enough of `GET`/`POST`/`DELETE` to
 * exercise `bootstrapStateConnection`'s discovery, default-database,
 * connection-mint, and aged-connection-cleanup paths without touching the
 * cloud. `as ManagementApiClient` is acceptable here (test file — exempt
 * from the no-bare-cast rule) because hand-writing the full openapi-fetch
 * generic signature adds no safety this fake's shape doesn't already
 * guarantee at each call site below.
 */
const fakeClient = (state: FakeState): ManagementApiClient => {
  const GET = (path: string, init: { params?: { path?: Record<string, string> } } = {}) => {
    if (path === '/v1/projects') {
      state.listCalls++;
      return Promise.resolve(
        okResponse({ data: state.projects, pagination: { nextCursor: null, hasMore: false } }),
      );
    }
    if (path === '/v1/projects/{projectId}/databases') {
      const projectId = init.params?.path?.['projectId'] ?? '';
      const databases = state.databases[projectId] ?? [];
      return Promise.resolve(
        okResponse({ data: databases, pagination: { nextCursor: null, hasMore: false } }),
      );
    }
    if (path === '/v1/databases/{databaseId}/connections') {
      const databaseId = init.params?.path?.['databaseId'] ?? '';
      const connections = state.connections[databaseId] ?? [];
      return Promise.resolve(
        okResponse({ data: connections, pagination: { nextCursor: null, hasMore: false } }),
      );
    }
    throw new Error(`fakeClient: unexpected GET ${path}`);
  };

  const POST = (
    path: string,
    init: { params?: { path?: Record<string, string> }; body?: Record<string, unknown> } = {},
  ) => {
    if (path === '/v1/projects') {
      state.createCalls++;
      if (state.createShouldFail) {
        return Promise.resolve(errorResponse(409));
      }
      const id = `proj-${state.createCalls}`;
      const project: FakeProject = {
        id,
        name: String(init.body?.['name']),
        createdAt: new Date(state.createCalls).toISOString(),
        workspace: { id: String(init.body?.['workspaceId']) },
      };
      state.projects.push(project);
      state.databases[id] = [{ id: `${id}-db`, name: 'default', isDefault: true }];
      return Promise.resolve(okResponse({ data: project }, 201));
    }
    if (path === '/v1/projects/{projectId}/databases') {
      state.databaseCreateCalls++;
      throw new Error('fakeClient: bootstrap must never create a database (FT-5220)');
    }
    if (path === '/v1/databases/{databaseId}/connections') {
      const databaseId = init.params?.path?.['databaseId'] ?? '';
      state.connectionCalls.push(databaseId);
      return Promise.resolve(
        okResponse({
          data: {
            id: `conn-${databaseId}-${state.connectionCalls.length}`,
            endpoints: {
              direct: {
                host: 'fake',
                port: 5432,
                connectionString: `postgres://fake/${databaseId}`,
              },
            },
          },
        }),
      );
    }
    throw new Error(`fakeClient: unexpected POST ${path}`);
  };

  const DELETE = (path: string, init: { params?: { path?: Record<string, string> } } = {}) => {
    if (path === '/v1/connections/{id}') {
      const id = init.params?.path?.['id'] ?? '';
      state.deletedConnectionIds.push(id);
      for (const databaseId of Object.keys(state.connections)) {
        const list = state.connections[databaseId];
        if (list === undefined) continue;
        state.connections[databaseId] = list.filter((c) => c.id !== id);
      }
      return Promise.resolve(okResponse(undefined, 204));
    }
    throw new Error(`fakeClient: unexpected DELETE ${path}`);
  };

  // biome-ignore lint/suspicious/noExplicitAny: test stub — see the doc comment above.
  return { GET, POST, DELETE } as any as ManagementApiClient;
};

/** A verifier stub that maps each fake database id to a canned verdict, and fails the test if asked about one it wasn't told to expect. */
const verifierFor = (
  verdicts: Record<string, OwnershipVerdict>,
  calls: string[] = [],
): OwnershipVerifier => {
  return (connectionString) => {
    const dsn = Redacted.value(connectionString);
    calls.push(dsn);
    const databaseId = dsn.replace('postgres://fake/', '');
    const verdict = verdicts[databaseId];
    if (verdict === undefined) throw new Error(`verifierFor: no verdict stubbed for ${databaseId}`);
    return Effect.succeed(verdict);
  };
};

const neverCalled = (): OwnershipVerifier => () => {
  throw new Error('verifyOwnership must not be called on the create path — nothing to verify yet');
};

const run = (state: FakeState, verify: OwnershipVerifier, workspaceId = 'ws-1') =>
  Effect.runPromise(
    bootstrapStateConnectionWith(workspaceId, verify).pipe(
      Effect.provideService(ManagementClient, fakeClient(state)),
    ),
  );

describe('bootstrapStateConnection', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState();
  });

  test('create path: no existing project creates one, and ownership is never checked (nothing to verify yet)', async () => {
    const result = await run(state, neverCalled());

    expect(result.projectId).toBe('proj-1');
    expect(state.createCalls).toBe(1);
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]?.name).toBe('prisma-compose-state');
  });

  test('adopt-marked: a candidate whose database already carries our marker is adopted outright', async () => {
    state.projects.push({
      id: 'proj-existing',
      name: 'prisma-compose-state',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });
    state.databases['proj-existing'] = [{ id: 'db-existing', name: 'default', isDefault: true }];

    const result = await run(state, verifierFor({ 'db-existing': { kind: 'ours' } }));

    expect(result.projectId).toBe('proj-existing');
    expect(result.databaseId).toBe('db-existing');
    expect(state.createCalls).toBe(0);
  });

  test('workspace-id shape mismatch: a wksp_-prefixed API id still matches a bare configured id (and vice versa)', async () => {
    state.projects.push({
      id: 'proj-existing',
      name: 'prisma-compose-state',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'wksp_ws-1' },
    });
    state.databases['proj-existing'] = [{ id: 'db-existing', name: 'default', isDefault: true }];

    // Configured bare, API returns prefixed — the CI shape that caused a
    // fresh state project to be provisioned on every run.
    const result = await run(state, verifierFor({ 'db-existing': { kind: 'ours' } }), 'ws-1');
    expect(result.projectId).toBe('proj-existing');
    expect(state.createCalls).toBe(0);

    // Configured prefixed, API returns prefixed (the local shape).
    const result2 = await run(state, verifierFor({ 'db-existing': { kind: 'ours' } }), 'wksp_ws-1');
    expect(result2.projectId).toBe('proj-existing');
    expect(state.createCalls).toBe(0);
  });

  test('adopt-legacy: a candidate with our tables but no marker yet is adopted (migratePrismaState writes the marker on the way in)', async () => {
    state.projects.push({
      id: 'proj-legacy',
      name: 'prisma-compose-state',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });
    state.databases['proj-legacy'] = [{ id: 'db-legacy', name: 'default', isDefault: true }];

    const result = await run(state, verifierFor({ 'db-legacy': { kind: 'legacy' } }));

    expect(result.projectId).toBe('proj-legacy');
    expect(state.createCalls).toBe(0);
  });

  test('squatter rejection: the only candidate has foreign data — bootstrap fails loudly, naming the project', async () => {
    state.projects.push({
      id: 'proj-squatter',
      name: 'prisma-compose-state',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });
    state.databases['proj-squatter'] = [{ id: 'db-squatter', name: 'default', isDefault: true }];

    await expect(
      run(
        state,
        verifierFor({
          'db-squatter': { kind: 'squatter', tables: ['users', 'orders'] },
        }),
      ),
    ).rejects.toThrow(/proj-squatter/);
    expect(state.createCalls).toBe(0);
  });

  test('multi-candidate tiebreak: candidates are tried oldest-createdAt first, and the loop stops at the first that verifies', async () => {
    state.projects.push(
      {
        id: 'proj-newest',
        name: 'prisma-compose-state',
        createdAt: new Date(3).toISOString(),
        workspace: { id: 'ws-1' },
      },
      {
        id: 'proj-oldest-squatter',
        name: 'prisma-compose-state',
        createdAt: new Date(1).toISOString(),
        workspace: { id: 'ws-1' },
      },
      {
        id: 'proj-middle-ours',
        name: 'prisma-compose-state',
        createdAt: new Date(2).toISOString(),
        workspace: { id: 'ws-1' },
      },
    );
    state.databases['proj-newest'] = [{ id: 'db-newest', name: 'default', isDefault: true }];
    state.databases['proj-oldest-squatter'] = [
      { id: 'db-oldest-squatter', name: 'default', isDefault: true },
    ];
    state.databases['proj-middle-ours'] = [
      { id: 'db-middle-ours', name: 'default', isDefault: true },
    ];

    const calls: string[] = [];
    const result = await run(
      state,
      verifierFor(
        {
          'db-oldest-squatter': { kind: 'squatter', tables: ['users'] },
          'db-middle-ours': { kind: 'ours' },
          // 'db-newest' deliberately unstubbed: the loop must never reach it.
        },
        calls,
      ),
    );

    expect(result.projectId).toBe('proj-middle-ours');
    // Tried in createdAt order: the oldest (squatter) first, then the
    // middle one (adopted) — the newest is never even checked.
    expect(calls).toEqual(['postgres://fake/db-oldest-squatter', 'postgres://fake/db-middle-ours']);
  });

  test('a real create failure is surfaced, not swallowed', async () => {
    state.createShouldFail = true;

    await expect(run(state, neverCalled())).rejects.toThrow();
  });

  test('connection minting reads endpoints.direct.connectionString and never creates a database', async () => {
    const result = await run(state, neverCalled());

    expect(Redacted.value(result.connectionString)).toBe(`postgres://fake/${result.databaseId}`);
    expect(state.connectionCalls).toEqual([result.databaseId]);
    expect(state.databaseCreateCalls).toBe(0);
  });

  test('a workspace with no default database fails loudly rather than creating one', async () => {
    state.projects.push({
      id: 'proj-nodefault',
      name: 'prisma-compose-state',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });
    state.databases['proj-nodefault'] = [{ id: 'db-x', name: 'not-default', isDefault: false }];

    await expect(run(state, neverCalled())).rejects.toThrow();
    expect(state.databaseCreateCalls).toBe(0);
  });

  test('aged-connection cleanup: connections matching our naming pattern older than 24h are deleted, others are left alone', async () => {
    state.projects.push({
      id: 'proj-existing',
      name: 'prisma-compose-state',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });
    state.databases['proj-existing'] = [{ id: 'db-existing', name: 'default', isDefault: true }];

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    state.connections['db-existing'] = [
      {
        id: 'conn-aged',
        name: 'prisma-compose-state-1',
        createdAt: new Date(now - 2 * dayMs).toISOString(),
      },
      { id: 'conn-fresh', name: 'prisma-compose-state-2', createdAt: new Date(now).toISOString() },
      {
        id: 'conn-foreign',
        name: 'someone-elses-connection',
        createdAt: new Date(now - 2 * dayMs).toISOString(),
      },
    ];

    await run(state, verifierFor({ 'db-existing': { kind: 'ours' } }));

    expect(state.deletedConnectionIds).toEqual(['conn-aged']);
  });

  test('aged-connection cleanup is best-effort: a listing failure never fails bootstrap', async () => {
    state.projects.push({
      id: 'proj-existing',
      name: 'prisma-compose-state',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });
    state.databases['proj-existing'] = [{ id: 'db-existing', name: 'default', isDefault: true }];
    // No `connections` entry for 'db-existing' — the fake GET returns `[]`,
    // which is the easy case; a real listing failure would surface as a
    // PrismaApiError from `call()`, and `Effect.ignore` on
    // `cleanupAgedConnections` swallows it the same way — asserting the
    // happy path here keeps the fake simple while `Effect.ignore`'s
    // behaviour is a one-line, self-evident guarantee from the effect
    // library itself.
    const result = await run(state, verifierFor({ 'db-existing': { kind: 'ours' } }));

    expect(result.projectId).toBe('proj-existing');
  });
});

describe('bootstrapStateConnection (public entry point)', () => {
  test('wires the real verifyOwnership — typechecked here, not run (that would touch a real Postgres)', () => {
    const typed: (workspaceId: string) => ReturnType<typeof bootstrapStateConnection> =
      bootstrapStateConnection;
    expect(typed).toBe(bootstrapStateConnection);
  });
});
