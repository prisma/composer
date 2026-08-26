/**
 * The catalog Module: a reusable unit that owns its own Postgres — a Prisma
 * Next-typed one (ADR-0022). The resource carries two doors: `contract`
 * (types + wires the resource, gives the deploy its target storageHash) and
 * `config` (the ORM config PATH the deploy's migration step loads
 * to find migrations/ — never imported by the app build). A consumer wires
 * only the exposed rpc contract — it never sees the database.
 *
 * The database provision id is "database" (the Connection API rejects names
 * shorter than 3 characters); the service keeps an explicit "service" id so
 * it doesn't read as "catalog.catalog".
 */
import { fileURLToPath } from 'node:url';
import { module } from '@prisma/composer';
import { postgres } from '@prisma/composer-prisma-cloud/orm';
import { catalogContract } from './contract.ts';
import { catalogData } from './data.ts';
import catalogService from './service.ts';

const config = fileURLToPath(new URL('../prisma.config.ts', import.meta.url));

export default module('catalog', { expose: { rpc: catalogContract } }, ({ provision }) => {
  const db = provision(postgres({ name: 'database', contract: catalogData, config }));
  const service = provision(catalogService, { id: 'service', deps: { db } });
  return { rpc: service.rpc };
});
