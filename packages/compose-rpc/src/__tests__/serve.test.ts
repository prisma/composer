import { describe, expect, test } from 'bun:test';
import type { DependencyEnd, RunnableServiceNode } from '@prisma/compose';
import { dependency, service } from '@prisma/compose';
import { type } from 'arktype';
import { makeClient } from '../client.ts';
import { contract } from '../contract.ts';
import { rpc } from '../rpc.ts';
import { serve } from '../serve.ts';

const authContract = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});

interface FakeDb {
  readonly validTokens: readonly string[];
}

/**
 * A fake RunnableServiceNode exposing authContract — stands in for compute()'s
 * node. `db` hydrates through a real DependencyEnd (not an override cast), so
 * `load()`'s return is a genuine `Loaded<D, P>`, matching production shape.
 */
function fakeAuthService(load: () => FakeDb) {
  const db: DependencyEnd<FakeDb> = dependency({
    name: 'db',
    type: 'fake/db',
    connection: { params: {}, hydrate: load },
  });
  const node = service({
    name: 'test-service',
    extension: 'test/pack',
    type: 'fake/rpc-test',
    inputs: { db },
    params: {},
    build: {
      extension: '@fake/adapter',
      type: 'fake',
      module: 'file:///test/service.ts',
      entry: 'x',
    },
    expose: { rpc: authContract },
  });

  return {
    ...node,
    run: (_address: string, boot: () => Promise<unknown>) => boot(),
    load: () => ({ db: load() }),
  } as unknown as RunnableServiceNode<
    typeof node.inputs,
    typeof node.params,
    { rpc: typeof authContract }
  >;
}

describe('serve()', () => {
  test('round trip: a valid call reaches the handler and returns the typed result', async () => {
    const authService = fakeAuthService(() => ({ validTokens: ['good-token'] }));
    const handler = serve(authService, {
      rpc: { verify: async ({ token }, { db }) => ({ ok: db.validTokens.includes(token) }) },
    });
    const client = makeClient(authContract, 'http://auth.internal', { fetch: handler });

    await expect(client.verify({ token: 'good-token' })).resolves.toEqual({ ok: true });
    await expect(client.verify({ token: 'bad-token' })).resolves.toEqual({ ok: false });
  });

  test('a bad input is rejected — the server-side arktype validation fires', async () => {
    const authService = fakeAuthService(() => ({ validTokens: [] }));
    const handler = serve(authService, { rpc: { verify: async () => ({ ok: true }) } });

    const res = await handler(
      new Request('http://auth.internal/rpc/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 123 }),
      }),
    );

    expect(res.status).toBe(400);
  });

  test('an unknown method 404s', async () => {
    const authService = fakeAuthService(() => ({ validTokens: [] }));
    const handler = serve(authService, { rpc: { verify: async () => ({ ok: true }) } });

    const res = await handler(
      new Request('http://auth.internal/rpc/doesNotExist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(404);
  });

  test('a handler throw is a 500, not a crash', async () => {
    const authService = fakeAuthService(() => ({ validTokens: [] }));
    const handler = serve(authService, {
      rpc: {
        verify: async () => {
          throw new Error('db unreachable');
        },
      },
    });

    const res = await handler(
      new Request('http://auth.internal/rpc/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 't' }),
      }),
    );

    expect(res.status).toBe(500);
  });

  test('the wrong HTTP verb on a known method is a 405', async () => {
    const authService = fakeAuthService(() => ({ validTokens: [] }));
    const handler = serve(authService, { rpc: { verify: async () => ({ ok: true }) } });

    const res = await handler(new Request('http://auth.internal/rpc/verify', { method: 'GET' }));

    expect(res.status).toBe(405);
  });

  test('calls load() exactly once, not per request', async () => {
    let loadCalls = 0;
    const authService = fakeAuthService(() => {
      loadCalls += 1;
      return { validTokens: ['t'] };
    });
    const handler = serve(authService, {
      rpc: { verify: async ({ token }, { db }) => ({ ok: db.validTokens.includes(token) }) },
    });
    const client = makeClient(authContract, 'http://auth.internal', { fetch: handler });

    await client.verify({ token: 't' });
    await client.verify({ token: 't' });

    expect(loadCalls).toBe(1);
  });
});
