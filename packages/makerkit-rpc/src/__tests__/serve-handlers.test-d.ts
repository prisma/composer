/**
 * serve(service, handlers) forces an exhaustive, correctly-typed handler map
 * straight off the service's `expose` and `load()`'s return — a missing or
 * mistyped handler must not compile. Typechecked only (this package's
 * `typecheck` script), never executed — see contract-satisfaction.test-d.ts
 * for the convention.
 */
import type { ResourceEnd, RunnableServiceNode } from '@makerkit/core';
import { resourceEnd, service } from '@makerkit/core';
import { type } from 'arktype';
import { contract } from '../contract.ts';
import { rpc } from '../rpc.ts';
import { serve } from '../serve.ts';

const authContract = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});

interface FakeDb {
  readonly validTokens: readonly string[];
}

const db: ResourceEnd<FakeDb> = resourceEnd({
  name: 'db',
  type: 'fake/db',
  connection: { params: {}, hydrate: () => ({ validTokens: [] }) },
});
const node = service({
  name: 'test-service',
  pack: 'test/pack',
  type: 'fake/rpc-test',
  inputs: { db },
  params: {},
  build: { kind: 'fake', pack: '@fake/adapter', module: 'file:///test/service.ts', entry: 'x' },
  expose: { rpc: authContract },
});

declare const authService: RunnableServiceNode<
  typeof node.inputs,
  typeof node.params,
  { rpc: typeof authContract }
>;

// ---- MUST compile: every exposed method has a matching handler ----
serve(authService, {
  rpc: {
    verify: async ({ token }, { db }) => ({ ok: token.length > 0 && db.validTokens.length >= 0 }),
  },
});

// extra handler methods/ports beyond what's exposed are allowed (width).
serve(authService, {
  rpc: {
    verify: async ({ token }, _deps) => ({ ok: token.length > 0 }),
    extra: async (_input: { note: string }, _deps: unknown) => ({ handled: true }),
  },
  extraPort: {
    anything: async (_input: unknown, _deps: unknown) => 1,
  },
});

// ---- MUST be rejected ----
// @ts-expect-error missing the required "verify" handler for the exposed "rpc" port
serve(authService, { rpc: {} });

// @ts-expect-error missing the exposed "rpc" port entirely
serve(authService, {});

// @ts-expect-error wrong input shape (token must be a string, not a number)
serve(authService, { rpc: { verify: async (_input: { token: number }, _deps) => ({ ok: true }) } });

// @ts-expect-error wrong output shape (ok must be a boolean, not a string)
serve(authService, { rpc: { verify: async ({ token }, _deps) => ({ ok: token }) } });
