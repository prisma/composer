/**
 * serve(service, handlers) forces an exhaustive, correctly-typed handler map
 * straight off the service's `expose` and `load()`'s return — a missing or
 * mistyped handler must not compile.
 *
 * Type-only (vitest `--typecheck`, never executed). The positive cases stay
 * direct `serve(...)` calls: the handler callbacks get their parameter types
 * by contextual inference from serve's signature, which `toBeCallableWith`
 * does not flow into a standalone argument — the call itself is the
 * assertion. The negative handler shapes keep a `// @ts-expect-error` on the
 * offending line.
 */
import type { DependencyEnd, RunnableServiceNode } from '@internal/core';
import { dependency, service } from '@internal/core';
import { type } from 'arktype';
import { test } from 'vitest';
import { contract } from '../contract.ts';
import { rpc } from '../rpc.ts';
import { serve } from '../serve.ts';

const authContract = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});

interface FakeDb {
  readonly validTokens: readonly string[];
}

const db: DependencyEnd<FakeDb> = dependency({
  name: 'db',
  type: 'fake/db',
  connection: { params: {}, hydrate: () => ({ validTokens: [] }) },
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

declare const authService: RunnableServiceNode<
  typeof node.inputs,
  typeof node.params,
  { rpc: typeof authContract }
>;

test('the exhaustive, correctly-typed handler map is accepted', () => {
  serve(authService, {
    rpc: {
      verify: async ({ token }, { db }) => ({ ok: token.length > 0 && db.validTokens.length >= 0 }),
    },
  });
});

test('ctx.idempotencyKey is typed string | undefined on the three-argument handler form', () => {
  serve(authService, {
    rpc: {
      verify: async ({ token }, { db }, ctx) => {
        const key: string | undefined = ctx.idempotencyKey;
        return { ok: token.length > 0 && db.validTokens.length >= 0 && key !== undefined };
      },
    },
  });
});

test('extra handler methods/ports beyond what is exposed are allowed (width)', () => {
  serve(authService, {
    rpc: {
      verify: async ({ token }, _deps) => ({ ok: token.length > 0 }),
      extra: async (_input: { note: string }, _deps: unknown) => ({ handled: true }),
    },
    extraPort: {
      anything: async (_input: unknown, _deps: unknown) => 1,
    },
  });
});

test('a missing or mistyped handler does not compile', () => {
  // @ts-expect-error missing the required "verify" handler for the exposed "rpc" port
  serve(authService, { rpc: {} });

  // @ts-expect-error missing the exposed "rpc" port entirely
  serve(authService, {});

  // @ts-expect-error wrong input shape (token must be a string, not a number)
  serve(authService, { rpc: { verify: async (_input: { token: number }) => ({ ok: true }) } });

  // @ts-expect-error wrong output shape (ok must be a boolean, not a string)
  serve(authService, { rpc: { verify: async ({ token }, _deps) => ({ ok: token }) } });
});

// ——— Mixed expose: non-rpc ports are skipped by Handlers<S> ———

/** A non-rpc exposed port — connection config as __cmp, not a method map. */
const httpishContract = {
  kind: 'httpish',
  __cmp: { url: '' },
  satisfies: () => true,
} as unknown as import('@internal/core').Contract<'httpish', { url: string }>;

declare const mixedService: RunnableServiceNode<
  typeof node.inputs,
  typeof node.params,
  { api: typeof httpishContract; rpc: typeof authContract }
>;

test('Handlers<S> does not demand a handler map for a non-rpc exposed port', () => {
  serve(mixedService, {
    rpc: {
      verify: async ({ token }, _deps) => ({ ok: token.length > 0 }),
    },
  });
});

test('the rpc port stays exhaustive even beside a non-rpc port', () => {
  // @ts-expect-error missing the required "verify" handler for the exposed "rpc" port
  serve(mixedService, { rpc: {} });
});
