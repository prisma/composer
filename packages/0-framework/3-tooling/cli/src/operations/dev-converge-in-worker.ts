/**
 * `prisma dev`'s default converge: one new worker thread per converge, so the
 * worker imports the app's definition files as they are on disk now. For the
 * worker's lifetime this thread holds the one-converge flag and the process's
 * working directory, which a worker cannot change.
 */
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isMainThread, Worker } from 'node:worker_threads';
import { holdingConvergeProcess } from '../converge-process.ts';
import {
  type DevConvergeJob,
  type DevConvergeReport,
  type DevConvergeResult,
  type RunDevConverge,
  thrownResult,
} from './dev-converge.ts';
import { type AbortMessage, isWorkerMessage } from './dev-converge-messages.ts';

/** How long an interrupted converge has to stop on its own before its worker is ended. */
const STOP_TIMEOUT_MS = 30_000;

/** How long to wait for a worker's output streams to end after it exits. */
const STREAM_END_TIMEOUT_MS = 1_000;

/** The worker file beside this module: `.ts` from source, `.mjs` from the built package. */
const WORKER_URL = new URL(
  `./dev-converge-worker${path.extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
);

function failed(tag: string, message: string): DevConvergeResult {
  return {
    kind: 'converged',
    outcome: { kind: 'failed', reasons: [{ tag, message }] },
    appFiles: [],
  };
}

function streamEnded(stream: Readable | null): Promise<void> {
  if (stream === null) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('end', resolve);
    stream.once('error', () => resolve());
  });
}

function runWorker(
  job: DevConvergeJob,
  report: DevConvergeReport,
  signal: AbortSignal | undefined,
  stopTimeoutMs: number,
): Promise<DevConvergeResult> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_URL, { workerData: job, stdout: true, stderr: true });
    // Bun gives a worker no stdout or stderr streams; the worker forwards its writes itself.
    const streams = [worker.stdout, worker.stderr];
    for (const stream of streams) {
      stream?.on('data', (chunk: Buffer | string) => report.output(String(chunk)));
    }
    const ended = Promise.all(streams.map(streamEnded));
    let outcome: DevConvergeResult | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;

    const abort = (): void => {
      const message: AbortMessage = { kind: 'abort' };
      worker.postMessage(message);
      stopTimer = setTimeout(() => {
        outcome ??= failed(
          'ConvergeNotStopped',
          `The converge did not stop within ${String(stopTimeoutMs / 1000)}s of being interrupted, so its worker thread was ended. Alchemy's local state may not record everything it changed; run \`prisma dev\` again, or \`prisma dev --fresh\` if that fails.`,
        );
        void worker.terminate();
      }, stopTimeoutMs);
    };
    if (signal?.aborted === true) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    worker.on('message', (message: unknown) => {
      if (!isWorkerMessage(message) || outcome !== undefined) return;
      if (message.kind === 'event') report.onEvent(message.event);
      else if (message.kind === 'output') report.output(message.text);
      else outcome = message.result;
    });
    worker.on('error', (error: unknown) => {
      outcome ??= failed(
        error instanceof Error ? error.name : 'Unknown',
        `The converge worker thread failed before it reported an outcome: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    worker.on('exit', (code) => {
      clearTimeout(stopTimer);
      signal?.removeEventListener('abort', abort);
      const settled =
        outcome ??
        failed(
          'ConvergeWorkerExited',
          `The converge worker thread exited with code ${String(code)} before it reported an outcome.`,
        );
      void Promise.race([
        ended,
        new Promise((done) => setTimeout(done, STREAM_END_TIMEOUT_MS)),
      ]).then(() => resolve(settled));
    });
  });
}

const refused = (reason: 'already-running' | 'worker-thread'): DevConvergeResult => ({
  kind: 'converged',
  outcome: { kind: 'refused', reason },
  appFiles: [],
});

/**
 * A {@link RunDevConverge} that runs each converge in a new worker thread. The worker gets the
 * job's `cwd` as the process resolves it once changed to, so a relative or symlinked `cwd`
 * matches the worker's own `process.cwd()`. `stopTimeoutMs` bounds how long an interrupted
 * converge may take to stop.
 */
export function runDevConvergeInWorkerWith(
  options: { readonly stopTimeoutMs?: number } = {},
): RunDevConverge {
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  return async (job, report, signal) => {
    try {
      if (!isMainThread && process.cwd() !== path.resolve(job.cwd)) return refused('worker-thread');
      const held = await holdingConvergeProcess({}, job.cwd, () =>
        runWorker({ ...job, cwd: process.cwd() }, report, signal, stopTimeoutMs),
      );
      return held.held ? held.value : refused('already-running');
    } catch (error) {
      return thrownResult(error);
    }
  };
}

export const runDevConvergeInWorker: RunDevConverge = runDevConvergeInWorkerWith();
