/**
 * The app's control-plane config (ADR-0017) — read ONLY by `prisma-composer
 * deploy`/`destroy`, never imported by app code. These static imports are the
 * one place the extensions' /control entries (provisioning, bundlers,
 * alchemy) enter the deploy; they resolve from this app's own dependencies.
 */
import { defineConfig } from '@prisma/composer/config';
import { frameworkBuild } from '@prisma/composer/frameworks/control';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';

export default defineConfig({
  extensions: [prismaCloud(), nodeBuild(), frameworkBuild()],
  // ONE state store per deploy — the workspace-hosted ledger (reads
  // PRISMA_WORKSPACE_ID), shared by every deployer of this app.
  state: prismaState(),
});
