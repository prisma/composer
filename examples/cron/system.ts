import routerService from '@cron/router';
import { schedule } from '@cron/router/schedule';
import workerService from '@cron/worker';
import { system } from '@prisma/app';
import { cron } from '@prisma/app-cron';

/**
 * The cron example: a worker (the target), a router that implements
 * `trigger(jobId)` via `serveSchedule` and depends on the worker, and the
 * reusable cron scheduler — composed by `cron()` (ADR-0020). The root
 * provisions nothing of the scheduler itself: it wires the worker's exposed
 * `rpc` port into the cron system's own `worker` boundary input, exactly as
 * it would for any other producer of that contract.
 *
 * A closed root: empty boundary (no inputs, no outputs).
 */
export default system('cron-example', {}, ({ provision }) => {
  const worker = provision('worker', workerService);
  provision('cron', cron('cron', { schedule, router: routerService }), { worker: worker.rpc });
  return {};
});
