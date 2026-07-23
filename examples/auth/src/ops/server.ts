// The ops service's entrypoint (the build adapter's `entry`).
import { createOpsApp } from './app.ts';
import service from './service.ts';

const { admin, outbox } = service.load();
const { port } = service.config();

process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

Bun.serve({ port, hostname: '0.0.0.0', fetch: createOpsApp({ admin, outbox }) });
