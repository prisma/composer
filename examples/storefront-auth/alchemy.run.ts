import { fileURLToPath } from 'node:url';
import { lower } from '@makerkit/core/deploy';
import { prismaCloud } from '@makerkit/prisma-cloud/target';
import app from './hex.ts';
import { nextStandaloneDir } from './scripts/bundle-next.ts';

/**
 * Interim deploy adapter — lowers the hex (hex.ts) onto Prisma Cloud. This is
 * the throwaway part: it goes away when `makerkit deploy` (over a declarative
 * makerkit.config.ts) lands — see core-model.md's Extension points. The app
 * topology itself is hex.ts; this file only says where to deploy it and where
 * the built bundles are.
 *
 *   pnpm build     # builds both hex artifacts
 *   pnpm deploy    # builds, sources ../../.env, runs `alchemy deploy`
 *
 * Requires env (repo-root .env): PRISMA_SERVICE_TOKEN, PRISMA_WORKSPACE_ID,
 * ALCHEMY_PASSWORD.
 */
const workspaceId = process.env['PRISMA_WORKSPACE_ID'];
if (!workspaceId) throw new Error('PRISMA_WORKSPACE_ID is required');

export default lower(app, prismaCloud({ workspaceId }), {
  // The stack name becomes the PDP Project name. CI overrides it per run
  // (STOREFRONT_STACK_NAME) so an ephemeral e2e deploy never collides with a
  // standing demo; local dev uses the default.
  name: process.env['STOREFRONT_STACK_NAME'] ?? 'storefront-auth',
  bundles: {
    auth: {
      dir: fileURLToPath(new URL('./hexes/auth/dist/bundle', import.meta.url)),
      entry: 'server.js',
    },
    storefront: {
      dir: nextStandaloneDir(fileURLToPath(new URL('./hexes/storefront', import.meta.url))),
      entry: 'server.js',
    },
  },
});
