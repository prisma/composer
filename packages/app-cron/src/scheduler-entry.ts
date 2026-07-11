// The reusable boot module every app's scheduler build points `entry` at
// (see cronScheduler's `node({ entry: './scheduler-entry.mjs' })`). It builds
// its own bare scheduler node rather than importing the app's — S1's stash
// keys config by owner+param-name, address-free, so a node with the same
// `jobs`/`trigger` shape reads the same env keys the app's own node wrote.
import { cronScheduler, runScheduler } from './scheduler.ts';

const service = cronScheduler<string>({ jobs: [] });

const { trigger } = service.load();
const { jobs } = service.config();

runScheduler({ jobs, call: (jobId) => trigger.trigger({ jobId }) });
