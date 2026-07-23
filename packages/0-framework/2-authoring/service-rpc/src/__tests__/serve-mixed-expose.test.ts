/**
 * serve() with a MIXED expose: a service may expose non-rpc ports beside its
 * rpc ones (a public HTTP surface whose contract carries connection config,
 * not methods). serve() dispatches the rpc ports and skips the rest — no
 * "no handler supplied" throw for a port nobody could handle — while the
 * duplicate-method construction throw still fires between real rpc ports.
 */
import { describe, expect, test } from 'bun:test';
import type { Contract, DependencyEnd, RunnableServiceNode } from '@internal/core';
import { dependency, service } from '@internal/core';
import { type } from 'arktype';
import { contract } from '../contract.ts';
import { rpc } from '../rpc.ts';
import { serve } from '../serve.ts';

const pingContract = contract({
  ping: rpc({ input: type({}), output: type({ pong: 'boolean' }) }),
});

const echoContract = contract({
  echo: rpc({ input: type({ value: 'string' }), output: type({ value: 'string' }) }),
});

/** A non-rpc exposed port: connection config as __cmp, kind-only satisfies. */
const httpish: Contract<'httpish', { url: string }> = Object.freeze({
  kind: 'httpish',
  __cmp: { url: '' },
  satisfies: (required: Contract<'httpish', unknown>) => required.kind === 'httpish',
});

function mixedService<E extends Record<string, Contract<string, unknown>>>(expose: E) {
  const db: DependencyEnd<{ ok: true }> = dependency({
    name: 'db',
    type: 'fake/db',
    connection: { params: {}, hydrate: () => ({ ok: true as const }) },
  });
  const node = service({
    name: 'mixed-service',
    extension: 'test/pack',
    type: 'fake/rpc-test',
    inputs: { db },
    params: {},
    build: { extension: '@fake/adapter', type: 'fake', module: 'file:///t.ts', entry: 'x' },
    expose,
  });
  return {
    ...node,
    run: (_address: string, boot: () => Promise<unknown>) => boot(),
    load: () => ({ db: { ok: true as const } }),
  } as unknown as RunnableServiceNode<typeof node.inputs, typeof node.params, E>;
}

const post = (method: string, body: unknown): Request =>
  new Request(`http://svc.internal/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
    body: JSON.stringify(body),
  });

describe('serve() with a mixed expose', () => {
  test('constructs without handlers for the non-rpc port and dispatches the rpc ones', async () => {
    const svc = mixedService({ api: httpish, rpc: pingContract });
    // Handlers<S> demands ONLY the rpc port's map — this compiles without
    // an `api` key (the type-level skip), and constructs without throwing
    // "no handler supplied for exposed method api.url" (the runtime skip).
    const handler = serve(svc, { rpc: { ping: async () => ({ pong: true }) } });

    const res = await handler(post('ping', {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  test('the non-rpc port contributes no dispatchable method', async () => {
    const svc = mixedService({ api: httpish, rpc: pingContract });
    const handler = serve(svc, { rpc: { ping: async () => ({ pong: true }) } });
    // The config key on the non-rpc contract must not be routable.
    const res = await handler(post('url', {}));
    expect(res.status).toBe(404);
  });

  test('the duplicate-method construction throw still fires between rpc ports', () => {
    const svc = mixedService({ a: pingContract, b: pingContract });
    expect(() =>
      serve(svc, {
        a: { ping: async () => ({ pong: true }) },
        b: { ping: async () => ({ pong: true }) },
      }),
    ).toThrow(/method "ping" is exposed by more than one port/);
  });

  test('two distinct rpc ports beside a non-rpc port all dispatch', async () => {
    const svc = mixedService({ api: httpish, p: pingContract, e: echoContract });
    const handler = serve(svc, {
      p: { ping: async () => ({ pong: true }) },
      e: { echo: async (input: { value: string }) => ({ value: input.value }) },
    });
    expect(await (await handler(post('ping', {}))).json()).toEqual({ pong: true });
    expect(await (await handler(post('echo', { value: 'x' }))).json()).toEqual({ value: 'x' });
  });
});
