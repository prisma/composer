import * as fs from 'node:fs';
import { runDevConvergeInWorker } from '../../dev-converge-in-worker.ts';
import { jobFor, makeWorkerApp } from './worker-app.ts';

const app = makeWorkerApp('v1');
const quiet = { onEvent: () => undefined, output: () => undefined };
const first = await runDevConvergeInWorker(jobFor(app), quiet);
app.label('v2');
const second = await runDevConvergeInWorker(jobFor(app), quiet);
const seen = app.seen();
fs.rmSync(app.dir, { recursive: true, force: true });

process.stdout.write(
  JSON.stringify({
    outcomes: [first, second].map((result) => result.kind === 'converged' && result.outcome),
    seen,
    dir: app.dir,
  }),
);
