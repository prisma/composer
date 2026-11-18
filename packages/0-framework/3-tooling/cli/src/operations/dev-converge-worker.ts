/**
 * The worker thread one `prisma dev` converge runs in (`dev-converge-in-worker.ts`
 * starts it). A new thread has its own module cache, so it imports the config
 * and the app as they are on disk now. It receives a `DevConvergeJob` as its
 * `workerData` and posts `WorkerMessage`s back.
 */
import { existsSync } from 'node:fs';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';
import type { PrismaAppConfig } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import { loadAppConvergeEntry } from '../app-converge.ts';
import { checkComposerConfig, noComposerExportMessage } from '../composer-config.ts';
import { appFilesNamedBy, registerEntryResolution } from '../entry-resolution.ts';
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
/**
 * Methods that send only to an attached inspector and print nothing to the terminal, under Node or
 * Bun. They keep their own behaviour: `console.createTask` returns a task whose `run` callers use.
 */
const INSPECTOR_ONLY = new Set([
  'context',
  'createTask',
  'profile',
  'profileEnd',
  'record',
  'recordEnd',
  'screenshot',
  'timeStamp',
]);

/** Every function on `console` that can print, its own and inherited, except constructors. */
function printingConsoleFunctionNames(): readonly string[] {
  const names = new Set<string>();
  for (let level: object | null = console; level !== null && level !== Object.prototype; ) {
    for (const name of Object.getOwnPropertyNames(level)) {
      if (name === 'constructor' || name === 'Console' || INSPECTOR_ONLY.has(name)) continue;
      if (typeof Reflect.get(console, name) === 'function') names.add(name);
    }
    level = Object.getPrototypeOf(level);
  }
  return [...names];
}

const textOf = (chunk: string | Uint8Array): string =>
  typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');

/** Bun's `console.write`: each argument's bytes one after another, returning how many were written. */
function bunConsoleWrite(...args: unknown[]): number {
  const chunks: Uint8Array[] = [];
  try {
    if (args.length === 0) throw writeArgumentError('ERR_STREAM_NULL_VALUES');
    for (const arg of args) chunks.push(bytesOf(arg));
  } finally {
    if (chunks.length > 0) output(textOf(Buffer.concat(chunks)));
  }
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}

function bytesOf(arg: unknown): Uint8Array {
  if (typeof arg === 'string') return Buffer.from(arg, 'utf8');
  if (arg instanceof ArrayBuffer) return new Uint8Array(arg);
  if (ArrayBuffer.isView(arg)) return new Uint8Array(arg.buffer, arg.byteOffset, arg.byteLength);
  throw writeArgumentError('ERR_INVALID_ARG_TYPE');
}

function writeArgumentError(code: string): TypeError {
  return Object.assign(new TypeError('write() expects a string, ArrayBufferView, or ArrayBuffer'), {
    code,
  });
}

// The worker must not import `node:console`: under Bun its named exports are fixed at the first
// import, which must come after the replacement below.
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
const replacement = new console.Console({ stdout: sink, stderr: sink });
const printed = (arg: unknown): string =>
  typeof arg === 'string' || arg instanceof Uint8Array ? textOf(arg) : format(arg);
for (const name of printingConsoleFunctionNames()) {
  const own: unknown = Reflect.get(replacement, name);
  Reflect.set(
    console,
    name,
    name === 'write'
      ? bunConsoleWrite
      : typeof own === 'function'
        ? own.bind(replacement)
        : (...args: unknown[]) => output(args.map(printed).join(' ')),
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
    const named = appFilesNamedBy(error);
    const result = thrownResult(error, [...recorded, ...named]);
    return result.kind === 'error' && bunKeepsTheFailedLookup(error, named)
      ? {
          ...result,
          error: { ...result.error, summary: `${result.error.summary}\n${RESTART_FOR_LOOKUP}` },
        }
      : result;
  }
}

const RESTART_FOR_LOOKUP =
  'The file exists now, but Bun keeps a failed lookup of a directory import for as long as the process runs. Restart `prisma dev` to load it.';

function bunKeepsTheFailedLookup(error: unknown, named: readonly string[]): boolean {
  return process.versions.bun !== undefined && moduleNotFound(error) && named.some(existsSync);
}

function moduleNotFound(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    if ('specifier' in current && typeof current.specifier === 'string') return true;
    seen.add(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

const job: DevConvergeJob = workerData;
// Not a top-level await: Bun delivers no message to a worker while its module evaluation is pending.
void run(job).then((result) => {
  post({ kind: 'result', result });
  process.exit(0);
});
