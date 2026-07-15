/**
 * The app's control-plane config (ADR-0017) — read ONLY by `prisma-compose
 * deploy`/`destroy`, never imported by app code. The static imports are the one
 * place the extensions' /control entries (provisioning, bundlers, alchemy)
 * enter the deploy; they resolve from this app's own dependencies.
 */
import { defineConfig } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';

export default defineConfig({
  extensions: [prismaCloud(), nodeBuild()],
  state: () => prismaState(),
});
