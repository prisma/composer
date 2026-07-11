// The app's own entrypoint (the build adapter's `entry`) — the pack-printed
// bootstrap dynamically imports this AFTER main.run(address, boot) has
// re-keyed the platform environment address-free, so service.load()/config()
// below read it directly, with no address.

import { serveSchedule } from '@prisma/app-cron';
import { schedule } from './schedule.ts';
import service from './service.ts';

// serveSchedule is exhaustive over the schedule's job ids at compile time —
// omitting `tick` or `mrr` here would be a type error, the same way a
// missing serve() method is.
const handler = serveSchedule(service, schedule, {
  tick: (deps) => deps.worker.tick({}),
  mrr: (deps) => deps.worker.refreshMrr({}),
});
export default handler;

const { port } = service.config();

// Bind all interfaces — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handler });
