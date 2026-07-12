/**
 * A dummy auth service for TESTING a module that depends on auth — inject it in
 * place of the real one so a consumer's tests need no Postgres and no deploy.
 * It serves the real `authContract` (so its handler map is type-checked against
 * the same contract the real auth exposes) with an in-memory `verify`. A
 * test-only entrypoint, deliberately outside `src/`, so it can never ride into
 * the deployed artifact.
 *
 * `serve()` needs a service node with the right `expose`, so this wraps a
 * minimal `compute()`. That node's `build` is inert — the fake is never
 * assembled or deployed, only `serve()`d on a loopback port by a consumer's
 * integration test.
 */
import { compute } from '@prisma/compose-cloud';
import node from '@prisma/compose-node';
import { serve } from '@prisma/compose-rpc';
import { authContract } from '../src/contract.ts';

const fakeAuth = compute({
  name: 'auth-fake',
  deps: {},
  build: node({ module: import.meta.url, entry: 'fake.ts' }),
  expose: { rpc: authContract },
});

export default serve(fakeAuth, {
  rpc: {
    verify: async ({ token }) => ({ ok: token.length > 0 }),
  },
});
