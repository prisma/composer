import { createBlobApp } from './app.ts';
import service from './service.ts';

const { store } = service.load();
const { port } = service.config();

process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

Bun.serve({ port, hostname: '0.0.0.0', fetch: createBlobApp(store) });
