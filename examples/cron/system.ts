import { system } from '@prisma/app';
import { cron } from '@prisma/app-cloud/cron';
import runnerService, { schedule } from './src/runner/service.ts';
import workerService from './src/worker/service.ts';

/**
 * The cron example: a worker (the target), a runner that implements
 * `trigger(jobId)` via `serveSchedule` and depends on the worker, and the
 * reusable cron scheduler — composed by `cron()`. Each provision takes its id
 * from the node's own name (`worker`, and `cron` from the cron system), so the
 * root wires the worker's exposed `rpc` port into the cron system's `worker`
 * boundary input exactly as it would for any other producer of that contract.
 *
 * A closed root: no boundary argument and no return — it only provisions.
 */
export default system('cron-example', ({ provision }) => {
  const worker = provision(workerService);
  provision(cron({ schedule, runner: runnerService }), { deps: { worker: worker.rpc } });
});
