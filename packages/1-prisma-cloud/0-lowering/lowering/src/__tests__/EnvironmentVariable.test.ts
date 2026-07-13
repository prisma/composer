import { beforeEach, describe, expect, test } from 'bun:test';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import { type ManagementApiClient, ManagementClient } from '../client.ts';
import {
  EnvironmentVariable,
  EnvironmentVariableProvider,
} from '../compute/EnvironmentVariable.ts';

interface RecordedCall {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}

interface FakeState {
  calls: RecordedCall[];
  /** Rows the own-row GET /{envVarId} resolves (keyed by id); absent → 404. */
  byId: Record<string, { id: string; key: string }>;
  /** What the list GET (project, class, key) returns as its `data` array. */
  listMatch: { id: string }[];
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
 * A stubbed `ManagementApiClient` covering the EnvironmentVariable provider's
 * endpoints, recording every call — the ComputeService.test.ts idiom. `as
 * unknown as ManagementApiClient` is acceptable here (test file — exempt from
 * the no-bare-cast rule).
 */
const fakeClient = (state: FakeState): ManagementApiClient => {
  const GET = (path: string, init: { params?: { path?: { envVarId?: string } } } = {}) => {
    state.calls.push({ method: 'GET', path });
    if (path === '/v1/environment-variables/{envVarId}') {
      const id = init.params?.path?.envVarId ?? '';
      const row = state.byId[id];
      return Promise.resolve(row ? okResponse(row) : notFoundResponse());
    }
    if (path === '/v1/environment-variables') {
      return Promise.resolve(okResponse({ data: state.listMatch }));
    }
    throw new Error(`fakeClient: unexpected GET ${path}`);
  };

  const POST = (path: string, init: { body?: Record<string, unknown> } = {}) => {
    state.calls.push({ method: 'POST', path, body: init.body });
    return Promise.resolve(
      okResponse({ data: { id: 'ev-created', key: String(init.body?.['key']) } }, 201),
    );
  };

  const PATCH = (path: string, init: { body?: Record<string, unknown> } = {}) => {
    state.calls.push({ method: 'PATCH', path, body: init.body });
    return Promise.resolve(okResponse({ ok: true }));
  };

  return { GET, POST, PATCH } as unknown as ManagementApiClient;
};

const getService = (state: FakeState) =>
  Effect.runPromise(
    EnvironmentVariable.Provider.pipe(
      Effect.provide(EnvironmentVariableProvider()),
      Effect.provideService(ManagementClient, fakeClient(state)),
    ),
  );

const reconcile = async (
  state: FakeState,
  input: {
    news: Record<string, unknown>;
    output?: { id: string; key: string } | undefined;
  },
) => {
  const svc = await getService(state);
  return Effect.runPromise(svc.reconcile(input as unknown as Parameters<typeof svc.reconcile>[0]));
};

const reconcileExit = async (
  state: FakeState,
  input: { news: Record<string, unknown>; output?: { id: string; key: string } | undefined },
) => {
  const svc = await getService(state);
  return Effect.runPromiseExit(
    svc.reconcile(input as unknown as Parameters<typeof svc.reconcile>[0]),
  );
};

describe('EnvironmentVariable reconcile — restricted adoption (ADR-0029)', () => {
  let state: FakeState;

  beforeEach(() => {
    state = { calls: [], byId: {}, listMatch: [] };
  });

  test('own prior row (output.id still exists): PATCHes it, no adoption GET-list', async () => {
    state.byId['ev-mine'] = { id: 'ev-mine', key: 'COMPOSE_INGEST_STRIPEKEY' };

    const result = await reconcile(state, {
      news: { projectId: 'proj-1', key: 'COMPOSE_INGEST_STRIPEKEY', value: 'STRIPE_SECRET_KEY' },
      output: { id: 'ev-mine', key: 'COMPOSE_INGEST_STRIPEKEY' },
    });

    expect(result).toEqual({ id: 'ev-mine', key: 'COMPOSE_INGEST_STRIPEKEY' });
    // GET the own row, then PATCH it — never the (project,class,key) adoption list.
    expect(state.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(state.calls.filter((c) => c.path === '/v1/environment-variables')).toHaveLength(0);
  });

  test('a poison key with a pre-existing platform row is adopted and PATCHed', async () => {
    state.listMatch = [{ id: 'ev-poison' }];

    const result = await reconcile(state, {
      news: { projectId: 'proj-1', key: 'DATABASE_URL', value: '-' },
      output: undefined,
    });

    expect(result).toEqual({ id: 'ev-poison', key: 'DATABASE_URL' });
    expect(state.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('a COMPOSE_ key with a pre-existing row it has no state for fails loudly, never overwrites', async () => {
    state.listMatch = [{ id: 'ev-foreign' }];

    const exit = await reconcileExit(state, {
      news: { projectId: 'proj-1', key: 'COMPOSE_INGEST_STRIPEKEY', value: 'STRIPE_SECRET_KEY' },
      output: undefined,
    });

    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      expect(Cause.pretty(exit.cause)).toContain('reserved COMPOSE_ key');
    }
    // It observed the collision, then refused — no PATCH, no POST.
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('a COMPOSE_ key with no pre-existing row creates it', async () => {
    state.listMatch = [];

    const result = await reconcile(state, {
      news: { projectId: 'proj-1', key: 'COMPOSE_INGEST_STRIPEKEY', value: 'STRIPE_SECRET_KEY' },
      output: undefined,
    });

    expect(result).toEqual({ id: 'ev-created', key: 'COMPOSE_INGEST_STRIPEKEY' });
    const post = state.calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({
      projectId: 'proj-1',
      key: 'COMPOSE_INGEST_STRIPEKEY',
      value: 'STRIPE_SECRET_KEY',
    });
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});
