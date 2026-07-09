import { beforeEach, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import type { ManagementApiClient } from '../../client.ts';
import { ManagementClient } from '../../client.ts';
import { bootstrapStateConnection } from '../bootstrap.ts';

interface FakeProject {
  id: string;
  name: string;
  workspace: { id: string };
}

interface FakeDatabase {
  id: string;
  name: string;
  isDefault: boolean;
}

interface FakeState {
  projects: FakeProject[];
  /** List call number (1-indexed) from which `projects` becomes visible via GET. */
  projectsVisibleFromCall: number;
  databases: Record<string, FakeDatabase[]>;
  createShouldFail: boolean;
  createCalls: number;
  listCalls: number;
  databaseCreateCalls: number;
  connectionCalls: string[];
}

const newFakeState = (overrides: Partial<FakeState> = {}): FakeState => ({
  projects: [],
  projectsVisibleFromCall: 1,
  databases: {},
  createShouldFail: false,
  createCalls: 0,
  listCalls: 0,
  databaseCreateCalls: 0,
  connectionCalls: [],
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
 * A stubbed `ManagementApiClient` — just enough of `GET`/`POST` to exercise
 * `bootstrapStateConnection`'s find-or-create, default-database, and
 * connection-minting paths without touching the cloud. `as ManagementApiClient`
 * is acceptable here (test file — exempt from the no-bare-cast rule) because
 * hand-writing the full openapi-fetch generic signature adds no safety this
 * fake's shape doesn't already guarantee at each call site below.
 */
const fakeClient = (state: FakeState): ManagementApiClient => {
  const GET = (path: string, init: { params?: { path?: Record<string, string> } } = {}) => {
    if (path === '/v1/projects') {
      state.listCalls++;
      const visible = state.listCalls >= state.projectsVisibleFromCall ? state.projects : [];
      return Promise.resolve(
        okResponse({ data: visible, pagination: { nextCursor: null, hasMore: false } }),
      );
    }
    if (path === '/v1/projects/{projectId}/databases') {
      const projectId = init.params?.path?.['projectId'] ?? '';
      const databases = state.databases[projectId] ?? [];
      return Promise.resolve(
        okResponse({ data: databases, pagination: { nextCursor: null, hasMore: false } }),
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
            id: `conn-${databaseId}`,
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

  // biome-ignore lint/suspicious/noExplicitAny: test stub — see the doc comment above.
  return { GET, POST } as any as ManagementApiClient;
};

const run = (state: FakeState, workspaceId = 'ws-1') =>
  Effect.runPromise(
    bootstrapStateConnection(workspaceId).pipe(
      Effect.provideService(ManagementClient, fakeClient(state)),
    ),
  );

describe('bootstrapStateConnection', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState();
  });

  test('find path: an existing makerkit-state project in the workspace is used as-is', async () => {
    state.projects.push({ id: 'proj-existing', name: 'makerkit-state', workspace: { id: 'ws-1' } });
    state.databases['proj-existing'] = [{ id: 'db-existing', name: 'default', isDefault: true }];

    const result = await run(state);

    expect(result.projectId).toBe('proj-existing');
    expect(result.databaseId).toBe('db-existing');
    expect(state.createCalls).toBe(0);
  });

  test('create path: no existing project creates one', async () => {
    const result = await run(state);

    expect(result.projectId).toBe('proj-1');
    expect(state.createCalls).toBe(1);
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]?.name).toBe('makerkit-state');
  });

  test('adopt-on-race path: a failed create adopts the concurrent winner by re-listing', async () => {
    state.createShouldFail = true;
    state.projectsVisibleFromCall = 2; // invisible on the first list, present by the second
    state.projects.push({ id: 'proj-winner', name: 'makerkit-state', workspace: { id: 'ws-1' } });
    state.databases['proj-winner'] = [{ id: 'db-winner', name: 'default', isDefault: true }];

    const result = await run(state);

    expect(result.projectId).toBe('proj-winner');
    expect(state.createCalls).toBe(1);
  });

  test('a real create failure (no concurrent winner ever appears) is surfaced, not swallowed', async () => {
    state.createShouldFail = true;

    await expect(run(state)).rejects.toThrow();
  });

  test('connection minting reads endpoints.direct.connectionString and never creates a database', async () => {
    const result = await run(state);

    expect(Redacted.value(result.connectionString)).toBe(`postgres://fake/${result.databaseId}`);
    expect(state.connectionCalls).toEqual([result.databaseId]);
    expect(state.databaseCreateCalls).toBe(0);
  });

  test('a workspace with no default database fails loudly rather than creating one', async () => {
    state.projects.push({
      id: 'proj-nodefault',
      name: 'makerkit-state',
      workspace: { id: 'ws-1' },
    });
    state.databases['proj-nodefault'] = [{ id: 'db-x', name: 'not-default', isDefault: false }];

    await expect(run(state)).rejects.toThrow();
    expect(state.databaseCreateCalls).toBe(0);
  });
});
