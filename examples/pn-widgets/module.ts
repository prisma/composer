import { module } from '@prisma/composer';
import { pnPostgres } from '@prisma/composer-prisma-cloud/prisma-next';
import { widgetContract } from './src/contract.ts';
import widgetsService from './src/service.ts';

/**
 * The pn-widgets app: one Prisma Next-typed Postgres and one compute service
 * that round-trips through it. A closed root (empty boundary).
 *
 * The database provision id is "database" (not "db"): the prisma-cloud target
 * passes it through as the Prisma resource name, and the Connection API rejects
 * names shorter than 3 characters. The resource carries two doors (ADR-0022):
 * `contract` (consumed — types + wires the resource, gives the deploy its
 * target storageHash) and `config` (the prisma-next.config.ts PATH the deploy
 * migration step loads to find migrations/ — never imported by the app build).
 */
export default module('pn-widgets', ({ provision }) => {
  const db = provision(
    pnPostgres({ name: 'database', contract: widgetContract, config: './prisma-next.config.ts' }),
    { id: 'database' },
  );
  provision(widgetsService, { id: 'widgets', deps: { db } });
});
