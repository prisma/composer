/**
 * The orders Module: owns its own Prisma-ORM-typed Postgres (ADR-0022), but
 * NOT the catalog — that comes in through the module's boundary
 * (`deps.catalog`), wired by whoever provisions this module. The consumer
 * supplies any producer of `catalogContract`; orders never knows which.
 */
import { fileURLToPath } from 'node:url';
import { module } from '@prisma/composer';
import { rpc } from '@prisma/composer/service-rpc';
import { postgres } from '@prisma/composer-prisma-cloud/orm';
import { catalogContract } from '@store/catalog/contract';
import { ordersContract } from './contract.ts';
import { ordersData } from './data.ts';
import ordersService from './service.ts';

const config = fileURLToPath(new URL('../prisma.config.ts', import.meta.url));

export default module(
  'orders',
  { deps: { catalog: rpc(catalogContract) }, expose: { rpc: ordersContract } },
  ({ inputs, provision }) => {
    const db = provision(postgres({ name: 'database', contract: ordersData, config }));
    const service = provision(ordersService, {
      id: 'service',
      deps: { db, catalog: inputs.catalog },
    });
    return { rpc: service.rpc };
  },
);
