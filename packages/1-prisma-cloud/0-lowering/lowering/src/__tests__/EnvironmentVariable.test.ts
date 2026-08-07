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
  query?: unknown;
}

interface FakeState {
  calls: RecordedCall[];
  /** Rows the own-row GET /{envVarId} resolves (keyed by id); absent → 404. */
  byId: Record<string, { id: string; key: string }>;
  /** What the list GET (project, class, key[, branchId]) returns as its `data` array. */
  listMatch: { id: string; branchId?: string | null }[];
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
  const GET = (
    path: string,
    init: { params?: { path?: { envVarId?: string }; query?: Record<string, unknown> } } = {},
  ) => {
    state.calls.push({ method: 'GET', path, query: init.params?.query });
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
    state.byId['ev-mine'] = { id: 'ev-mine', key: 'COMPOSER_INGEST_STRIPEKEY' };

    const result = await reconcile(state, {
      news: { projectId: 'proj-1', key: 'COMPOSER_INGEST_STRIPEKEY', value: 'STRIPE_SECRET_KEY' },
      output: { id: 'ev-mine', key: 'COMPOSER_INGEST_STRIPEKEY' },
    });

    expect(result).toEqual({ id: 'ev-mine', key: 'COMPOSER_INGEST_STRIPEKEY' });
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

  test('a COMPOSER_ key with a pre-existing row it has no state for fails loudly, never overwrites', async () => {
    state.listMatch = [{ id: 'ev-foreign' }];

    const exit = await reconcileExit(state, {
      news: { projectId: 'proj-1', key: 'COMPOSER_INGEST_STRIPEKEY', value: 'STRIPE_SECRET_KEY' },
      output: undefined,
    });

    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      expect(Cause.pretty(exit.cause)).toContain('reserved COMPOSER_ key');
    }
    // It observed the collision, then refused — no PATCH, no POST.
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('a COMPOSER_ key with no pre-existing row creates it', async () => {
    state.listMatch = [];

    const result = await reconcile(state, {
      news: { projectId: 'proj-1', key: 'COMPOSER_INGEST_STRIPEKEY', value: 'STRIPE_SECRET_KEY' },
      output: undefined,
    });

    expect(result).toEqual({ id: 'ev-created', key: 'COMPOSER_INGEST_STRIPEKEY' });
    const post = state.calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({
      projectId: 'proj-1',
      key: 'COMPOSER_INGEST_STRIPEKEY',
      value: 'STRIPE_SECRET_KEY',
    });
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});

describe('EnvironmentVariable reconcile — branch-scoped collision check', () => {
  let state: FakeState;

  beforeEach(() => {
    state = { calls: [], byId: {}, listMatch: [] };
  });

  const previewNews = {
    projectId: 'proj-1',
    key: 'COMPOSER_WEB_PORT',
    value: '3000',
    class: 'preview',
    branchId: 'br-mine',
  };

  test("a sibling preview branch's row with the same key is not a collision — this branch's row is created", async () => {
    // The fake ignores query filters, simulating a server that returned the
    // sibling row anyway — the client-side scope comparison must exclude it.
    state.listMatch = [{ id: 'ev-sibling', branchId: 'br-other' }];

    const result = await reconcile(state, { news: previewNews, output: undefined });

    expect(result).toEqual({ id: 'ev-created', key: 'COMPOSER_WEB_PORT' });
    const post = state.calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({
      projectId: 'proj-1',
      class: 'preview',
      key: 'COMPOSER_WEB_PORT',
      branchId: 'br-mine',
    });
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  test('the adoption list query narrows server-side to the target branch', async () => {
    await reconcile(state, { news: previewNews, output: undefined });

    const list = state.calls.find((c) => c.path === '/v1/environment-variables');
    expect(list?.query).toEqual({
      projectId: 'proj-1',
      class: 'preview',
      key: 'COMPOSER_WEB_PORT',
      branchId: 'br-mine',
    });
  });

  test('a project-level preview template (branchId null) is not a collision for a branch write', async () => {
    state.listMatch = [{ id: 'ev-template', branchId: null }];

    const result = await reconcile(state, { news: previewNews, output: undefined });

    expect(result).toEqual({ id: 'ev-created', key: 'COMPOSER_WEB_PORT' });
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  test("an untracked row on this deploy's own branch still fails loudly", async () => {
    state.listMatch = [{ id: 'ev-foreign', branchId: 'br-mine' }];

    const exit = await reconcileExit(state, { news: previewNews, output: undefined });

    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      expect(Cause.pretty(exit.cause)).toContain('reserved COMPOSER_ key');
      expect(Cause.pretty(exit.cause)).toContain('branch "br-mine"');
    }
    expect(state.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test("a poison key adopts this branch's own row, never a sibling branch's", async () => {
    state.listMatch = [
      { id: 'ev-db-sibling', branchId: 'br-other' },
      { id: 'ev-db-mine', branchId: 'br-mine' },
    ];

    const result = await reconcile(state, {
      news: { ...previewNews, key: 'DATABASE_URL', value: '-' },
      output: undefined,
    });

    expect(result).toEqual({ id: 'ev-db-mine', key: 'DATABASE_URL' });
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
