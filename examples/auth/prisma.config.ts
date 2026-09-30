import { definePrismaConfig } from '@prisma/cli-engine';
import { defineConfig as composer } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import authPack from '@prisma/composer-prisma-cloud/auth/pack';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';
import { defineConfig as orm } from '@prisma/orm-postgres/config';

// The ORM config anchors the (empty) app contract and the migrations
// directory, and declares the auth extension pack — `prisma migration
// plan` materialises the pack's shipped migrations into migrations/auth/, and
// the deploy's migration step migrates BOTH spaces. The deploy lowering loads
// this file by path (from the postgres resource's `config`); the app build
// never imports it.
// Regenerate contract.{json,d.ts}: prisma contract emit --config prisma.config.ts
export default definePrismaConfig({
  // Composer's control-plane config (ADR-0017), read only by the deploy
  // tooling and never imported by app code.
  composer: composer({
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
  }),
  orm: orm({
    contract: './contract.prisma',
    db: { connection: 'postgres://localhost:5432/placeholder' },
    extensions: [authPack],
  }),
});
