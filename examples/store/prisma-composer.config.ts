/**
 * The app's control-plane config (ADR-0017) — read ONLY by `prisma-composer
 * deploy`/`destroy`, never imported by app code.
 */
import { defineConfig } from '@prisma/composer/config';
import { frameworkBuild } from '@prisma/composer/frameworks/control';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';

export default defineConfig({
  extensions: [prismaCloud(), nodeBuild(), frameworkBuild()],
  state: prismaState(),
});
