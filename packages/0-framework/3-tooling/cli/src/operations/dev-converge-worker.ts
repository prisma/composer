/**
 * The worker thread one `prisma dev` converge runs in (`converge-in-worker.ts`
 * starts it). A new thread has its own module cache, so it imports the config
 * and the app as they are on disk now. It receives a `DevConvergeJob` as its
 * `workerData` and posts `WorkerMessage`s back.
 */

import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';
import type { PrismaAppConfig } from '@internal/core/config';
import { loadAppConvergeEntry } from '../app-converge.ts';
import { checkComposerConfig, noComposerExportMessage } from '../composer-config.ts';
import type { ConvergeOutcome } from '../converge-in-process.ts';
import { loadEntry } from '../load-entry.ts';
import { convergeDevJob, type DevConvergeJob, thrownOutcome } from './dev-converge.ts';
import { isAbortMessage, type WorkerMessage } from './dev-converge-messages.ts';

const port = parentPort;
if (port === null) throw new Error('dev-converge-worker runs only as a worker thread.');

const post = (message: WorkerMessage): void => port.postMessage(message);
const output = (text: string): void => post({ kind: 'output', text });

// Whatever the app's code or a provider prints goes to the main thread, which redacts it.
for (const stream of [process.stdout, process.stderr]) {
  stream.write = (chunk: string | Uint8Array) => {
    output(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
}
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
  console[method] = (...args: unknown[]) => output(`${format(...args)}\n`);
}

const controller = new AbortController();
port.on('message', (message: unknown) => {
  if (isAbortMessage(message)) controller.abort();
});

async function importConfig(file: string): Promise<PrismaAppConfig> {
  const exported: unknown = (await import(pathToFileURL(file).href)).default;
  const section =
    typeof exported === 'object' && exported !== null && 'composer' in exported
      ? exported.composer
      : undefined;
  if (section === undefined) throw new Error(noComposerExportMessage(file));
  const checked = checkComposerConfig(section, file);
  if (!checked.ok) throw new Error(checked.findings[0].summary);
  return checked.value;
}

async function run(job: DevConvergeJob): Promise<ConvergeOutcome> {
  try {
    const config = await importConfig(job.configFile);
    const { root } = await loadEntry(job.entry, job.cwd);
    const entry = await loadAppConvergeEntry(job.appDir);
    return await convergeDevJob(
      job,
      { config, root, entry },
      { onEvent: (event) => post({ kind: 'event', event }), output },
      controller.signal,
    );
  } catch (error) {
    return thrownOutcome(error);
  }
}

const job: DevConvergeJob = workerData;
// Not a top-level await: Bun delivers no message to a worker while its module evaluation is pending.
void run(job).then((outcome) => {
  post({ kind: 'outcome', outcome });
  process.exit(0);
});
