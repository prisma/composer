// The jobs service's entrypoint (the build adapter's `entry`). After
// main.run(address, boot) re-keys the environment, service.load() hands the
// wired StreamsConfig binding directly; the app builds its own HTTP client
// from it. Bind all interfaces — Compute routes external HTTP to the VM.
import { createJobsApp } from './app.ts';
import service from './service.ts';

const { events } = service.load(); // StreamsConfig: { url, apiKey }
const { port } = service.config();

process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

Bun.serve({ port, hostname: '0.0.0.0', fetch: createJobsApp(events) });
