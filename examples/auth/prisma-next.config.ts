import authPack from '@prisma/composer-prisma-cloud/auth/pack';
import { defineConfig } from '@prisma/orm-postgres/config';

// The Prisma Next config anchors the (empty) app contract and the migrations
// directory, and declares the auth extension pack — `prisma-next migration
// plan` materialises the pack's shipped migrations into migrations/auth/, and
// the deploy's migration step migrates BOTH spaces. The deploy lowering loads
// this file by path (from the pnPostgres resource's `config`); the app build
// never imports it.
export default defineConfig({
  contract: './contract.prisma',
  db: { connection: 'postgres://localhost:5432/placeholder' },
  extensions: [authPack],
});
