import node from '@prisma/compose/node';
import { compute } from '@prisma/compose-prisma-cloud';
import { pnPostgres } from '@prisma/compose-prisma-cloud/prisma-next';
import { widgetContract } from './contract.ts';

/**
 * The pn-widgets compute service. Its `db` dependency is the Prisma
 * Next-typed Postgres: `pnPostgres(widgetContract)`'s binding (what
 * `load()` returns) is the typed Prisma Next client — the framework
 * constructs it in hydrate from the contract + the injected URL (ADR-0022),
 * so server.ts queries `db.orm.public.Widget` directly, typed by the contract.
 */
export default compute({
  name: 'widgets',
  deps: {
    db: pnPostgres(widgetContract),
  },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
});
