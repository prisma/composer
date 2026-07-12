/**
 * The one source of truth for this app's cron schedule (ADR-0020): the job
 * ids `serveSchedule` forces a handler for, and the `every` intervals
 * `runScheduler` fires on. Short intervals so the integration test is quick.
 */

import node from '@prisma/compose/node';
import { rpc } from '@prisma/compose/rpc';
import { compute } from '@prisma/compose-prisma-cloud';
import { defineSchedule, triggerContract } from '@prisma/compose-prisma-cloud/cron';
import { workerContract } from '../worker/contract.ts';

export const schedule = defineSchedule({ tick: '2s', mrr: '5s' });

export default compute({
  name: 'runner',
  deps: { worker: rpc(workerContract) },
  build: node({ module: import.meta.url, entry: '../../dist/runner/server.mjs' }),
  expose: { trigger: triggerContract },
});
