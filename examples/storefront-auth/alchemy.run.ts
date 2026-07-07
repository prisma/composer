import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lowering } from '@makerkit/core/deploy';
import * as Prisma from '@makerkit/prisma-alchemy';
import { prismaCloud } from '@makerkit/prisma-cloud/target';
import * as Alchemy from 'alchemy';
import * as Output from 'alchemy/Output';
import { localState } from 'alchemy/State/LocalState';
import * as Effect from 'effect/Effect';
import authService from './hexes/auth/src/service.ts';
import storefrontService from './hexes/storefront/src/service.ts';

/**
 * The storefront-auth MIXED stack: both services are MakerKit-authored nodes
 * lowered through the pack, wired inside a hand-written stack that carries
 * only what the primitives can't express yet — the AUTH_URL environment
 * variable (the Connection gap).
 *
 *   pnpm build     # builds both hex artifacts under hexes/each/dist/
 *   pnpm deploy    # builds, sources ../../.env, runs `alchemy deploy`
 *
 * Requires env (repo-root .env, see `pnpm setup:env`):
 * PRISMA_SERVICE_TOKEN, PRISMA_WORKSPACE_ID, ALCHEMY_PASSWORD.
 */
const artifact = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
// `alchemy destroy` never uploads artifacts, so it must not require a prior
// build; deploy always builds first (see the `deploy` script).
const sha256 = (path: string) =>
  existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent';

const workspaceId = process.env['PRISMA_WORKSPACE_ID'];
if (!workspaceId) throw new Error('PRISMA_WORKSPACE_ID is required');

const target = prismaCloud({ workspaceId });

// A lowering's outputs are untyped (Record<string, unknown>) and are lazy
// Output expressions at stack-effect time. Narrow with the exported guard and
// fail the deploy explicitly if the resolved value is absent — no casts (D2).
function requireStringOutput(value: unknown, what: string): Output.Output<string> {
  if (!Output.isOutput(value)) {
    throw new Error(`${what} is not an Output — the lowering did not produce it`);
  }
  return Output.map(value, (resolved): string => {
    if (typeof resolved !== 'string' || resolved.length === 0) {
      throw new Error(`${what} resolved to no value — cannot wire AUTH_URL`);
    }
    return resolved;
  });
}

const stack = Effect.gen(function* () {
  const authArtifact = artifact('./hexes/auth/dist/auth.tar.gz');
  const auth = yield* lowering(authService, target, {
    name: 'makerkit-auth',
    artifact: { path: authArtifact, sha256: sha256(authArtifact) },
  });
  const authUrl = requireStringOutput(auth.outputs['url'], 'auth deployed URL');

  const storefrontArtifact = artifact('./hexes/storefront/dist/storefront.tar.gz');
  const store = yield* lowering(storefrontService, target, {
    name: 'makerkit-storefront',
    artifact: { path: storefrontArtifact, sha256: sha256(storefrontArtifact) },
  });
  const storeProjectId = requireStringOutput(store.outputs['projectId'], 'storefront project id');

  // The hand-wired Connection gap: AUTH_URL in the storefront project's
  // production env. Upstream edges: {storefront project (projectId), auth
  // deployment (url)} — the same dependency structure the old hand-written
  // stack had. Those edges order the env var after its inputs exist; there is
  // NO edge to the storefront Deployment, so the env var RACES the storefront
  // version start (in practice the one-POST env var usually beats the
  // minutes-long deployment — identical to the old stack, whose textual
  // ordering was registration-order luck at unbounded apply concurrency). An
  // enforced ordering edge is the Connection primitive's job (later project).
  yield* Prisma.EnvironmentVariable('storefront-auth-url', {
    projectId: storeProjectId,
    key: 'AUTH_URL',
    value: authUrl,
    class: 'production',
  });

  return { authUrl, storefrontUrl: store.outputs['url'] };
});

// A LowerError at deploy is fatal (orDie); the requirements channel is
// `unknown` by design (the pack's lowerings carry their own provider
// requirements, satisfied by the target's providers()) — narrowed here for
// Stack's inference, mirroring core's own lower() seam.
type StackOutputs = { authUrl: Output.Output<string>; storefrontUrl: unknown };
const stackEffect = Effect.orDie(stack) as Effect.Effect<StackOutputs, never>;

export default Alchemy.Stack(
  'StorefrontAuth',
  { providers: target.providers(), state: localState() },
  stackEffect,
);
