/**
 * The worker thread one `prisma dev` converge runs in (`dev-converge-in-worker.ts`
 * starts it). A new thread has its own module cache, so it imports the config
 * and the app as they are on disk now. It receives a `DevConvergeJob` as its
 * `workerData` and posts `WorkerMessage`s back.
 */
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';
import type { PrismaAppConfig } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import { loadAppConvergeEntry } from '../app-converge.ts';
import { checkComposerConfig, noComposerExportMessage } from '../composer-config.ts';
import { appFileNamedBy, registerEntryResolution } from '../entry-resolution.ts';
import { loadEntry } from '../load-entry.ts';
import {
  convergeDevJob,
  type DevConvergeJob,
  type DevConvergeResult,
  thrownResult,
} from './dev-converge.ts';
import { isAbortMessage, type WorkerMessage } from './dev-converge-messages.ts';

const port = parentPort;
if (port === null) throw new Error('dev-converge-worker runs only as a worker thread.');

const post = (message: WorkerMessage): void => port.postMessage(message);
const output = (text: string): void => post({ kind: 'output', text });
/** Every function on `console`, its own and inherited, except constructors. */
function consoleFunctionNames(): readonly string[] {
  const names = new Set<string>();
  for (let level: object | null = console; level !== null && level !== Object.prototype; ) {
    for (const name of Object.getOwnPropertyNames(level)) {
      if (name === 'constructor' || name === 'Console') continue;
      if (typeof Reflect.get(console, name) === 'function') names.add(name);
    }
    level = Object.getPrototypeOf(level);
  }
  return [...names];
}

const textOf = (chunk: string | Uint8Array): string =>
  typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');

// Whatever the app's code or a provider prints goes to the main thread, which redacts it.
// Bun's own console methods and warnings write to the terminal directly, so every function on
// `console` is replaced, and warnings are forwarded. A direct write to the process's file
// descriptors cannot be caught here.
for (const stream of [process.stdout, process.stderr]) {
  stream.write = (chunk: string | Uint8Array) => {
    output(textOf(chunk));
    return true;
  };
}
const sink = new Writable({
  write(chunk: string | Uint8Array, _encoding, done) {
    output(textOf(chunk));
    done();
  },
});
const replacement = new Console({ stdout: sink, stderr: sink });
for (const name of consoleFunctionNames()) {
  const own: unknown = Reflect.get(replacement, name);
  Reflect.set(
    console,
    name,
    typeof own === 'function'
      ? own.bind(replacement)
      : (...args: unknown[]) =>
          output(args.map((arg) => (typeof arg === 'string' ? arg : format(arg))).join(' ')),
  );
}
if (typeof process.versions.bun === 'string') {
  process.on('warning', (warning) => output(`${warning.name}: ${warning.message}\n`));
}

registerEntryResolution();

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
  if (!checked.ok) {
    const [finding] = checked.findings;
    throw new CliStructuredError(finding.code, finding.summary, {
      ...(finding.why === undefined ? {} : { why: finding.why }),
      fix: finding.fix,
    });
  }
  return checked.value;
}

async function run(job: DevConvergeJob): Promise<DevConvergeResult> {
  const recorded = new Set<string>();
  try {
    const config = await importConfig(job.configFile);
    const { root, files } = await loadEntry(job.entry, job.cwd, undefined, recorded);
    const entry = await loadAppConvergeEntry(job.appDir);
    return await convergeDevJob(
      job,
      { config, root, entry, appFiles: files },
      { onEvent: (event) => post({ kind: 'event', event }), output },
      controller.signal,
    );
  } catch (error) {
    const named = appFileNamedBy(error);
    return thrownResult(error, named === undefined ? [...recorded] : [...recorded, named]);
  }
}

const job: DevConvergeJob = workerData;
// Not a top-level await: Bun delivers no message to a worker while its module evaluation is pending.
void run(job).then((result) => {
  post({ kind: 'result', result });
  process.exit(0);
});
