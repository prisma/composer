/**
 * The promotions runner: the work target the shared cron module fires at
 * (ADR-0020). The schedule lives here — the one source of truth for the job
 * ids serveSchedule forces handlers for and the intervals the scheduler
 * fires on. Rotates the catalog's special of the day.
 */
import node from '@prisma/composer/node';
import { rpc } from '@prisma/composer/service-rpc';
import { compute } from '@prisma/composer-prisma-cloud';
import { defineSchedule, triggerContract } from '@prisma/composer-prisma-cloud/cron';
import { catalogContract } from '@store/catalog/contract';

export const schedule = defineSchedule({ rotateSpecial: '30s' });

export default compute({
  name: 'promotions',
  deps: { catalog: rpc(catalogContract) },
  // `prisma dev` runs the source under bun's watcher instead of the build (ADR-0056).
  build: node({
    module: import.meta.url,
    entry: '../dist/server.mjs',
    dev: ['bun', '--watch', 'server.ts'],
  }),
  expose: { trigger: triggerContract },
});
