/**
 * The app's control-plane config (ADR-0017) — read ONLY by `prisma-compose
 * deploy`/`destroy`, never imported by app code.
 */
import { defineConfig } from '@prisma/compose/config';
import { nextjsBuild } from '@prisma/compose/nextjs/control';
import { nodeBuild } from '@prisma/compose/node/control';
import { prismaCloud, prismaState } from '@prisma/compose-prisma-cloud/control';

export default defineConfig({
  extensions: [prismaCloud(), nodeBuild(), nextjsBuild()],
  state: () => prismaState(),
});
