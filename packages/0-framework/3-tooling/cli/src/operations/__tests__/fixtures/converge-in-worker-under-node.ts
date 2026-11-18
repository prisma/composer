import * as fs from 'node:fs';
import { convergeInWorker } from '../../converge-in-worker.ts';
import { jobFor, makeWorkerApp } from './worker-app.ts';

const app = makeWorkerApp('v1');
const quiet = { onEvent: () => undefined, output: () => undefined };
const first = await convergeInWorker(jobFor(app), quiet);
app.label('v2');
const second = await convergeInWorker(jobFor(app), quiet);
const seen = app.seen();
fs.rmSync(app.dir, { recursive: true, force: true });

process.stdout.write(JSON.stringify({ outcomes: [first, second], seen, dir: app.dir }));
