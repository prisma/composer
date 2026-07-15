import node from '@prisma/compose/node';
import { rpc } from '@prisma/compose/rpc';
import { compute } from '@prisma/compose-prisma-cloud';
import { pnPostgres } from '@prisma/compose-prisma-cloud/prisma-next';
import { catalogContract } from '@store/catalog/contract';
import { ordersContract } from './contract.ts';
import { ordersData } from './data.ts';

// Two dependencies, two kinds: `db` hydrates to the Prisma Next typed client
// (ADR-0022); `catalog` hydrates to a typed client of another module's rpc
// contract.
export default compute({
  name: 'orders',
  deps: {
    db: pnPostgres(ordersData),
    catalog: rpc(catalogContract),
  },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: ordersContract },
});
