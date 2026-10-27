import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { postgres } from '@prisma/composer-prisma-cloud/orm';
import { catalogContract } from './contract.ts';
import { catalogData } from './data.ts';

// The `db` dependency is Prisma-ORM-typed: `load()` returns the { url, client }
// binding, its typed client built lazily from the contract + the injected URL
// (ADR-0040) — server.ts queries `db.client.orm.public.Product` directly.
export default compute({
  name: 'catalog',
  deps: {
    db: postgres(catalogData),
  },
  // Deliberately no `dev` command, unlike orders and promotions: catalog runs
  // its built artifact under `prisma dev`, so this example keeps one service on
  // the rebuild-and-restart loop (the local-dev store integration proof
  // touches `dist/server.mjs` and expects exactly this service to restart).
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: catalogContract },
});
