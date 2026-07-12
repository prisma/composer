/**
 * The app's control-plane config (ADR-0017) — read ONLY by `prisma-compose
 * deploy`/`destroy`, never imported by app code. These static imports are the
 * one place the extensions' /control entries (provisioning, bundlers,
 * alchemy) enter the deploy; they resolve from this app's own dependencies.
 */
import { defineConfig } from '@prisma/compose/config';
import { nodeBuild } from '@prisma/compose/node/control';
import { prismaCloud, prismaState } from '@prisma/compose-prisma-cloud/control';

export default defineConfig({
  extensions: [prismaCloud(), nodeBuild()],
  // ONE state store per deploy — the workspace-hosted ledger (reads
  // PRISMA_WORKSPACE_ID), shared by every deployer of this app.
  state: () => prismaState(),
});
