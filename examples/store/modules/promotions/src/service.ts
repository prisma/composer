/**
 * The promotions runner: the work target the shared cron module fires at
 * (ADR-0020). The schedule lives here — the one source of truth for the job
 * ids serveSchedule forces handlers for and the intervals the scheduler
 * fires on. Rotates the catalog's special of the day.
 */
import node from '@prisma/compose/node';
import { rpc } from '@prisma/compose/rpc';
import { compute } from '@prisma/compose-prisma-cloud';
import { defineSchedule, triggerContract } from '@prisma/compose-prisma-cloud/cron';
import { catalogContract } from '@store/catalog/contract';

export const schedule = defineSchedule({ rotateSpecial: '30s' });

export default compute({
  name: 'promotions',
  deps: { catalog: rpc(catalogContract) },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { trigger: triggerContract },
});
