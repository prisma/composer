import * as fs from 'node:fs';
import { runDevConvergeInWorker } from '../../dev-converge-in-worker.ts';
import { jobFor, makeWorkerApp } from './worker-app.ts';

const app = makeWorkerApp('print-all');
const output: string[] = [];
const result = await runDevConvergeInWorker(jobFor(app), {
  onEvent: () => undefined,
  output: (text) => output.push(text),
});
fs.rmSync(app.dir, { recursive: true, force: true });

process.stdout.write(
  JSON.stringify({
    outcome: result.kind === 'outcome' && result.outcome,
    output: output.join(''),
  }),
);
