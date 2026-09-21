import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { postgres } from '@prisma/composer-prisma-cloud/orm';
import { widgetContract } from './contract.ts';

/**
 * The orm-demo compute service. Its `db` dependency is the Prisma
 * Next-typed Postgres: `postgres(widgetContract)`'s binding (what
 * `load()` returns) carries the raw connection URL and the typed Prisma ORM
 * client, built lazily from the contract + the injected URL (ADR-0040), so
 * server.ts queries `db.client.orm.public.Widget` directly, typed by the contract.
 */
export default compute({
  name: 'widgets',
  deps: {
    db: postgres(widgetContract),
  },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
});
