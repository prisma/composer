import { beforeEach, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import { type ManagementApiClient, ManagementClient } from '../client.ts';
import { Database, DatabaseProvider } from '../postgres/Database.ts';

interface RecordedCall {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}

interface FakeState {
  calls: RecordedCall[];
  /** When set, GET /v1/databases/{databaseId} resolves to this — the observed path. */
  observed?: { id: string; name: string };
}

const okResponse = <T>(data: T, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});

const notFoundResponse = () => ({
  data: undefined,
  error: undefined,
  response: new Response(null, { status: 404 }),
});

/**
 * A stubbed `ManagementApiClient` covering only the Database provider's
 * endpoints (GET/POST for observe-or-create, PATCH for Branch attachment),
 * recording every call it receives — the container.test.ts fake-client
 * idiom. `as unknown as ManagementApiClient` is acceptable here (test file
 * — exempt from the no-bare-cast rule).
 */
const fakeClient = (state: FakeState): ManagementApiClient => {
  const GET = (path: string) => {
    state.calls.push({ method: 'GET', path });
    if (path === '/v1/databases/{databaseId}') {
      return Promise.resolve(
        state.observed ? okResponse({ data: state.observed }) : notFoundResponse(),
      );
    }
    throw new Error(`fakeClient: unexpected GET ${path}`);
  };

  const POST = (path: string, init: { body?: Record<string, unknown> } = {}) => {
    state.calls.push({ method: 'POST', path, body: init.body });
    if (path === '/v1/projects/{projectId}/databases') {
      return Promise.resolve(
        okResponse({ data: { id: 'db-created', name: String(init.body?.['name']) } }, 201),
      );
    }
    throw new Error(`fakeClient: unexpected POST ${path}`);
  };

  const PATCH = (path: string, init: { body?: Record<string, unknown> } = {}) => {
    state.calls.push({ method: 'PATCH', path, body: init.body });
    if (path === '/v1/databases/{databaseId}') {
      return Promise.resolve(okResponse({ data: { id: 'db-created', name: 'db' } }));
    }
    throw new Error(`fakeClient: unexpected PATCH ${path}`);
  };

  return { GET, POST, PATCH } as unknown as ManagementApiClient;
};

const getService = (state: FakeState) =>
  Effect.runPromise(
    Database.Provider.pipe(
      Effect.provide(DatabaseProvider()),
      Effect.provideService(ManagementClient, fakeClient(state)),
    ),
  );

const reconcile = async (
  state: FakeState,
  input: { news: Record<string, unknown>; output?: { id: string; name: string } | undefined },
) => {
  const svc = await getService(state);
  return Effect.runPromise(svc.reconcile(input as unknown as Parameters<typeof svc.reconcile>[0]));
};

describe('Database reconcile — Branch attachment via PATCH', () => {
  let state: FakeState;

  beforeEach(() => {
    state = { calls: [] };
  });

  test('branchId set, no prior output: creates, then PATCHes the Branch', async () => {
    const result = await reconcile(state, {
      news: { projectId: 'proj-1', name: 'db', region: 'us-east-1', branchId: 'br-1' },
      output: undefined,
    });

    expect(result).toEqual({ id: 'db-created', name: 'db' });
    expect(state.calls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(state.calls[0]?.body).toEqual({ name: 'db', region: 'us-east-1' });
    expect(state.calls[1]).toEqual({
      method: 'PATCH',
      path: '/v1/databases/{databaseId}',
      body: { branchId: 'br-1' },
    });
  });

  test('branchId set, prior output exists: observes, and still PATCHes (idempotent/self-healing)', async () => {
    state.observed = { id: 'db-existing', name: 'db' };

    const result = await reconcile(state, {
      news: { projectId: 'proj-1', name: 'db', region: 'us-east-1', branchId: 'br-1' },
      output: { id: 'db-existing', name: 'db' },
    });

    expect(result).toEqual({ id: 'db-existing', name: 'db' });
    expect(state.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(state.calls[1]).toEqual({
      method: 'PATCH',
      path: '/v1/databases/{databaseId}',
      body: { branchId: 'br-1' },
    });
  });

  test('branchId unset, no prior output: creates and issues no PATCH', async () => {
    const result = await reconcile(state, {
      news: { projectId: 'proj-1', name: 'db', region: 'us-east-1' },
      output: undefined,
    });

    expect(result).toEqual({ id: 'db-created', name: 'db' });
    expect(state.calls.map((c) => c.method)).toEqual(['POST']);
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  test('branchId unset, prior output exists: observes and issues no PATCH', async () => {
    state.observed = { id: 'db-existing', name: 'db' };

    const result = await reconcile(state, {
      news: { projectId: 'proj-1', name: 'db', region: 'us-east-1' },
      output: { id: 'db-existing', name: 'db' },
    });

    expect(result).toEqual({ id: 'db-existing', name: 'db' });
    expect(state.calls.map((c) => c.method)).toEqual(['GET']);
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});
