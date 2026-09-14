// The app's own entrypoint (the build adapter's `entry`) — the pack-printed
// bootstrap dynamically imports this AFTER main.run(address, boot) has
// re-keyed the platform environment address-free, so service.load()/config()
// below read it directly, with no address.

import { serveSchedule } from '@prisma/composer-prisma-cloud/cron';
import service, { schedule } from './service.ts';

// serveSchedule is exhaustive over the schedule's job ids at compile time —
// omitting `tick` or `mrr` here would be a type error, the same way a
// missing serve() method is.
// Each firing is logged with the runner's clock so the deployment log proves
// the scheduler is still firing long after boot (the keep-awake canary reads it).
const fired = (jobId: string) => console.log(`cron fired ${jobId} at ${new Date().toISOString()}`);
const handler = serveSchedule(service, schedule, {
  tick: (deps) => {
    fired('tick');
    return deps.worker.tick({});
  },
  mrr: (deps) => {
    fired('mrr');
    return deps.worker.refreshMrr({});
  },
  heartbeat: (deps) => {
    fired('heartbeat');
    return deps.worker.tick({});
  },
});
export default handler;

const port = service.port();

// Bind all interfaces — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handler });
