import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { pnPostgres } from '@prisma/composer-prisma-cloud/prisma-next';
import { widgetContract } from './contract.ts';

/**
 * The pn-widgets compute service. Its `db` dependency is the Prisma
 * Next-typed Postgres: `pnPostgres(widgetContract)`'s binding (what
 * `load()` returns) carries the raw connection URL and the typed Prisma Next
 * client, built lazily from the contract + the injected URL (ADR-0040), so
 * server.ts queries `db.client.orm.public.Widget` directly, typed by the contract.
 */
export default compute({
  name: 'widgets',
  deps: {
    db: pnPostgres(widgetContract),
  },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
});
