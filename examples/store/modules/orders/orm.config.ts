import { definePrismaConfig } from '@prisma/cli-engine';
import { defineConfig } from '@prisma/orm-postgres/config';

// Anchors the contract source and migrations/ on disk. The deploy lowering
// loads it (by path, from the postgres resource's `config`) to find the
// migrations — the app build never imports it. `db.connection` is dead
// weight: the framework injects the URL at hydrate (no-globals).
// Regenerate contract.{json,d.ts}: prisma contract emit --config orm.config.ts
export default definePrismaConfig({
  orm: defineConfig({
    contract: './contract.prisma',
    db: { connection: 'postgres://localhost:5432/placeholder' },
  }),
});
