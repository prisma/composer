import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { pnPostgres } from '@prisma/composer-prisma-cloud/prisma-next';
import { catalogContract } from './contract.ts';
import { catalogData } from './data.ts';

// The `db` dependency is Prisma Next-typed: `load()` returns the { url, client }
// binding, its typed client built lazily from the contract + the injected URL
// (ADR-0040) — server.ts queries `db.client.orm.public.Product` directly.
export default compute({
  name: 'catalog',
  deps: {
    db: pnPostgres(catalogData),
  },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: catalogContract },
});
