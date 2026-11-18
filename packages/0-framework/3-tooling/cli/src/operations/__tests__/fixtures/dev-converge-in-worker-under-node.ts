import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDevConvergeInWorker } from '../../dev-converge-in-worker.ts';
import { jobFor, makeWorkerApp } from './worker-app.ts';

const app = makeWorkerApp('v1');
const quiet = { onEvent: () => undefined, output: () => undefined };
const first = await runDevConvergeInWorker(jobFor(app), quiet);
app.label('v2');
const second = await runDevConvergeInWorker(jobFor(app), quiet);
fs.writeFileSync(app.labelFile, "export { label } from './helpers';\n");
const missing = await runDevConvergeInWorker(jobFor(app), quiet);
fs.writeFileSync(path.join(app.dir, 'helpers.ts'), "export const label = 'v3';\n");
const third = await runDevConvergeInWorker(jobFor(app), quiet);
const seen = app.seen();
fs.rmSync(app.dir, { recursive: true, force: true });

process.stdout.write(
  JSON.stringify({
    outcomes: [first, second, third].map((result) => result.kind === 'outcome' && result.outcome),
    seen,
    missing: { kind: missing.kind, appFiles: missing.appFiles },
    dir: app.dir,
  }),
);
