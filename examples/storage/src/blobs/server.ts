// The blob-store service's entrypoint (the build adapter's `entry`). After
// main.run(address, boot) re-keys the environment, service.load() hands the
// wired S3Config binding directly; the app builds its aws-sdk client from it.
// Bind all interfaces — Compute routes external HTTP to the VM.
import { createBlobApp } from './app.ts';
import service from './service.ts';

const { store } = service.load(); // S3Config: { url, bucket, accessKeyId, secretAccessKey }
const { port } = service.config();

process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

Bun.serve({ port, hostname: '0.0.0.0', fetch: createBlobApp(store) });
