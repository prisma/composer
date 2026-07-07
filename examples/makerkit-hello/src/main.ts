// Runtime bundle entry (app-owned) — the whole thing.
import { runHost } from '@makerkit/core/runtime';
import service from './service.ts';

await runHost(service);
