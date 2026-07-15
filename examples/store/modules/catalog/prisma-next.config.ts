import { defineConfig } from '@prisma-next/postgres/config';

// Anchors the contract source and migrations/ on disk. The deploy lowering
// loads it (by path, from the pnPostgres resource's `config`) to find the
// migrations — the app build never imports it. `db.connection` is dead
// weight: the framework injects the URL at hydrate (no-globals).
export default defineConfig({
  contract: './contract.prisma',
  db: { connection: 'postgres://localhost:5432/placeholder' },
});
