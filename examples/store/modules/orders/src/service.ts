import node from '@prisma/composer/node';
import { rpc } from '@prisma/composer/service-rpc';
import { compute } from '@prisma/composer-prisma-cloud';
import { postgres } from '@prisma/composer-prisma-cloud/orm';
import { catalogContract } from '@store/catalog/contract';
import { ordersContract } from './contract.ts';
import { ordersData } from './data.ts';

// Two dependencies, two kinds: `db` hydrates to the { url, client } Prisma
// Next binding (ADR-0040); `catalog` hydrates to a typed client of another
// module's rpc contract.
export default compute({
  name: 'orders',
  deps: {
    db: postgres(ordersData),
    catalog: rpc(catalogContract),
  },
  // `prisma dev` runs the source under bun's watcher instead of the build (ADR-0056).
  build: node({
    module: import.meta.url,
    entry: '../dist/server.mjs',
    dev: ['bun', '--watch', 'server.ts'],
  }),
  expose: { rpc: ordersContract },
});
