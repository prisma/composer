// The jobs service's entrypoint (the build adapter's `entry`). After
// main.run(address, boot) re-keys the environment, service.load() hands the
// hydrated handle directly — no URL, no key, no protocol, no stream name
// here. Bind all interfaces — Compute routes external HTTP to the VM.
import { createJobsApp } from './app.ts';
import service from './service.ts';

const { events } = service.load(); // { jobs: StreamHandle }, ready to call
const { port } = service.config();

process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

Bun.serve({ port, hostname: '0.0.0.0', fetch: createJobsApp(events.jobs) });
