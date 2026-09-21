import { definePrismaConfig } from '@prisma/cli-engine';
import authPack from '@prisma/composer-prisma-cloud/auth/pack';
import { defineConfig } from '@prisma/orm-postgres/config';

// The ORM config anchors the (empty) app contract and the migrations
// directory, and declares the auth extension pack — `prisma migration
// plan` materialises the pack's shipped migrations into migrations/auth/, and
// the deploy's migration step migrates BOTH spaces. The deploy lowering loads
// this file by path (from the postgres resource's `config`); the app build
// never imports it.
// Regenerate contract.{json,d.ts}: prisma contract emit --config prisma.config.ts
export default definePrismaConfig({
  orm: defineConfig({
    contract: './contract.prisma',
    db: { connection: 'postgres://localhost:5432/placeholder' },
    extensions: [authPack],
  }),
});
