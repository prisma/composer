// The reusable boot module every app's scheduler build points `entry` at
// (see cronScheduler's `node({ entry: './scheduler-entrypoint.mjs' })`). It builds
// its own bare scheduler node rather than importing the app's — the stash is
// address-free (config by owner+param-name, the input document under its one
// well-known row), so a node with the same `trigger`/input shape reads the
// same env keys the app's own node wrote.
import { KeepAwakeGuard } from '@prisma/compute';
import { cronScheduler, runScheduler } from '../scheduler.ts';

// The scheduler is the clock (ADR-0020): it receives no requests, and Prisma
// Compute idles a service that receives none, so it holds the platform's
// keep-awake guard for its whole lifetime. Never released — the process ends
// only when the platform stops it. A no-op outside Compute.
new KeepAwakeGuard();

const service = cronScheduler();

const { trigger } = service.load();
const { jobs } = service.input();

runScheduler({ jobs, call: (jobId) => trigger.trigger({ jobId }) });
