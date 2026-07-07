import { fileURLToPath } from 'node:url';
import type { HexBuilder } from '@makerkit/core';
import { hex } from '@makerkit/core';
import { lower } from '@makerkit/core/deploy';
import { prismaCloud } from '@makerkit/prisma-cloud/target';
import authService from './hexes/auth/src/service.ts';
import storefrontService from './hexes/storefront/src/service.ts';
import { nextStandaloneDir } from './scripts/bundle-next.ts';

/**
 * The storefront-auth app hex — transparent wiring, executed at Load. Two
 * services, one Project: `auth`'s db + `storefront`'s call to `auth` both
 * lower into one application's worth of Alchemy resources (see
 * core-model.md's "Two services, connected"). This replaces the old
 * hand-written mixed stack — the URL plumbing, the `requireStringOutput`
 * guard, and the hand-named EnvironmentVariable all disappear into core's
 * sequencing.
 *
 *   pnpm build     # builds both hex artifacts (bundling only)
 *   pnpm deploy    # builds, sources ../../.env, runs `alchemy deploy`
 *
 * Requires env (repo-root .env, see `pnpm setup:env`):
 * PRISMA_SERVICE_TOKEN, PRISMA_WORKSPACE_ID, ALCHEMY_PASSWORD.
 *
 * Interim hand-written stack until `makerkit deploy` (a declarative
 * makerkit.config.ts) lands — see core-model.md's Extension points.
 */
const workspaceId = process.env['PRISMA_WORKSPACE_ID'];
if (!workspaceId) throw new Error('PRISMA_WORKSPACE_ID is required');

const app = hex('storefront-auth', (h: HexBuilder) => {
  const authRef = h.provision('auth', authService);
  h.provision('storefront', storefrontService, { auth: authRef });
});

export default lower(app, prismaCloud({ workspaceId }), {
  // The stack name becomes the PDP Project name. CI overrides it per run
  // (STOREFRONT_STACK_NAME) so an ephemeral e2e deploy never collides with a
  // standing demo in the shared workspace; local dev uses the default.
  name: process.env['STOREFRONT_STACK_NAME'] ?? 'storefront-auth',
  bundles: {
    auth: { dir: fileURLToPath(new URL('./hexes/auth/dist/bundle', import.meta.url)) },
    storefront: {
      dir: nextStandaloneDir(fileURLToPath(new URL('./hexes/storefront', import.meta.url))),
    },
  },
});
