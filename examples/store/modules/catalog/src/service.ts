import node from '@prisma/compose/node';
import { compute } from '@prisma/compose-prisma-cloud';
import { pnPostgres } from '@prisma/compose-prisma-cloud/prisma-next';
import { catalogContract } from './contract.ts';
import { catalogData } from './data.ts';

// The `db` dependency is Prisma Next-typed: `load()` returns the typed
// client the framework constructs from the contract + the injected URL
// (ADR-0022) — server.ts queries `db.orm.public.Product` directly.
export default compute({
  name: 'catalog',
  deps: {
    db: pnPostgres(catalogData),
  },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: catalogContract },
});
