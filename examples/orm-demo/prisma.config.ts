import { definePrismaConfig } from '@prisma/cli-engine';
import { defineConfig as composer } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';
import { defineConfig as orm } from '@prisma/orm-postgres/config';

// The ORM config anchors the contract source and the migrations
// directory on the filesystem. The deploy lowering loads it (by path, from the
// postgres resource's `config`) to resolve `migrations/` — the app build
// never imports it. `db.connection` is dead weight here: the framework injects
// the URL at hydrate (no-globals), so nothing reads it.
// Regenerate contract.{json,d.ts}: prisma contract emit --config prisma.config.ts
export default definePrismaConfig({
  // Composer's control-plane config (ADR-0017), read only by the deploy
  // tooling and never imported by app code.
  composer: composer({
    extensions: [prismaCloud(), nodeBuild()],
    // ONE state store per deploy — the workspace-hosted ledger (reads
    // PRISMA_WORKSPACE_ID), shared by every deployer of this app.
    state: prismaState(),
  }),
  orm: orm({
    contract: './contract.prisma',
    db: { connection: 'postgres://localhost:5432/placeholder' },
  }),
});
