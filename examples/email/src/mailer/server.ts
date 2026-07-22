// The mailer service's entrypoint (the build adapter's `entry`). After
// main.run(address, boot) re-keys the environment, service.load() hands the
// wired email/outbox clients directly. Bind all interfaces — Compute routes
// external HTTP to the VM.
import { createEmailApp } from './app.ts';
import service from './service.ts';

const { email, outbox } = service.load();
const { port } = service.config();

process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

Bun.serve({ port, hostname: '0.0.0.0', fetch: createEmailApp(email, outbox) });
