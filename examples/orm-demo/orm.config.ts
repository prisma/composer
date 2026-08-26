import { definePrismaConfig } from '@prisma/cli-engine';
import { defineConfig } from '@prisma/orm-postgres/config';

// The ORM config anchors the contract source and the migrations
// directory on the filesystem. The deploy lowering loads it (by path, from the
// postgres resource's `config`) to resolve `migrations/` — the app build
// never imports it. Named orm.config.ts, not prisma.config.ts: the standalone
// prisma-composer bin discovers prisma.config.ts as its own config and
// rejects the ORM sections (CLI.CONFIG_UNKNOWN_SECTION). `db.connection` is dead weight here: the framework injects
// the URL at hydrate (no-globals), so nothing reads it.
// Regenerate contract.{json,d.ts}: prisma contract emit --config orm.config.ts
export default definePrismaConfig({
  orm: defineConfig({
    contract: './contract.prisma',
    db: { connection: 'postgres://localhost:5432/placeholder' },
  }),
});
