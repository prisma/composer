/**
 * `prisma dev`'s default converge: one new worker thread per converge, so the
 * worker imports the app's definition files as they are on disk now. For the
 * worker's lifetime this thread holds the one-converge-per-process flag and
 * the process's working directory, which a worker cannot change.
 */
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isMainThread, Worker } from 'node:worker_threads';
import type { ConvergeOutcome } from '../converge-in-process.ts';
import { holdingConvergeProcess } from '../converge-process.ts';
import type { DevConvergeJob, DevConvergeReport, RunDevConverge } from './dev-converge.ts';
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

function failed(tag: string, message: string): ConvergeOutcome {
  return { kind: 'failed', reasons: [{ tag, message }] };
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
): Promise<ConvergeOutcome> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_URL, { workerData: job, stdout: true, stderr: true });
    // Bun gives a worker no stdout or stderr streams; the worker forwards its writes itself.
    const streams = [worker.stdout, worker.stderr];
    for (const stream of streams) {
      stream?.on('data', (chunk: Buffer | string) => report.output(String(chunk)));
    }
    const ended = Promise.all(streams.map(streamEnded));
    let outcome: ConvergeOutcome | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;

    const abort = (): void => {
      const message: AbortMessage = { kind: 'abort' };
      worker.postMessage(message);
      stopTimer = setTimeout(() => {
        outcome ??= failed(
          'ConvergeNotStopped',
          `The converge did not stop within ${String(stopTimeoutMs / 1000)}s of being interrupted, so its worker thread was ended. It may have left its state lease held.`,
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
      else outcome = message.outcome;
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

/** A {@link RunDevConverge} that runs each converge in a new worker thread. `stopTimeoutMs` bounds how long an interrupted converge may take to stop. */
export function convergeInWorkerWith(
  options: { readonly stopTimeoutMs?: number } = {},
): RunDevConverge {
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  return async (job, report, signal) => {
    if (!isMainThread && process.cwd() !== job.cwd) {
      return { kind: 'refused', reason: 'worker-thread' };
    }
    const held = await holdingConvergeProcess({}, job.cwd, () =>
      runWorker(job, report, signal, stopTimeoutMs),
    );
    return held.held ? held.value : { kind: 'refused', reason: 'already-running' };
  };
}

export const convergeInWorker: RunDevConverge = convergeInWorkerWith();
