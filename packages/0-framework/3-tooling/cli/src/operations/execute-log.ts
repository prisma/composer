/**
 * The log executor — run-log.ts's attach-and-tail (config → localTarget →
 * container → attach → logs) with console and signal handling removed: the
 * merged stream comes back as an AsyncIterable, ended by the caller's
 * AbortSignal. Reached only by lazy import from log.ts — this module's
 * static graph transitively loads alchemy's provider tree, so the control
 * entry must never import it statically.
 */
import * as path from 'node:path';
import type { LocalTargetAttachment, LocalTargetDescriptor } from '@internal/core/local-target';
import { DEV_DIR, resolveLocalTargets } from '@internal/core/local-target';
import { CliError } from '../cli-error.ts';
import { resolveAppIdentity } from '../pipeline.ts';
import { withEmulatorRetry } from './emulator-retry.ts';
import type { LogDeps, LogEvent, LogInput, LogLine, LogResult } from './log.ts';

function toCliError(error: unknown): CliError {
  return error instanceof CliError
    ? error
    : new CliError(error instanceof Error ? error.message : String(error), { cause: error });
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The merge queue's bound: past this, the oldest line is dropped and the
 * consumer is told via a `lines-dropped` event — a log viewer tolerates loss
 * better than the host tolerates unbounded memory growth. Exported so tests
 * can size their floods relative to the bound. */
export const LOG_QUEUE_LIMIT = 10_000;

/**
 * Merges every attachment's log stream into one iterable: one pump per
 * attachment pushing into a shared bounded queue. A pump's throw becomes a
 * `stream-failed` event and ends that pump only; the merged iterable ends
 * when `input.signal` aborts, when every pump ends, or when the consumer
 * stops iterating (an early `break` aborts an internal controller so the
 * pumps tear down — the generator never waits on a source that will not
 * end). No event is delivered after the iterable has ended. Address
 * filtering and `tail` apply exactly as the CLI always has.
 */
async function* mergeLogStreams(
  attachments: readonly LocalTargetAttachment[],
  input: LogInput,
): AsyncGenerator<LogLine, void, undefined> {
  // Internal controller linked to the caller's signal: the caller's abort
  // propagates in, and the generator's own end (early break/return) aborts it
  // too, so the pumps always have a signal that CAN fire.
  const controller = new AbortController();
  const { signal } = controller;
  const abortInternal = (): void => controller.abort();
  if (input.signal?.aborted === true) controller.abort();
  input.signal?.addEventListener('abort', abortInternal, { once: true });

  const queue: LogLine[] = [];
  let dropped = 0;
  let done = false;
  let active = attachments.length;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  signal.addEventListener('abort', notify, { once: true });

  const emit = (event: LogEvent): void => {
    if (!done) input.onEvent?.(event);
  };

  // The pumps are fire-and-forget by design: they never reject (fully
  // caught), and the generator's finally aborts rather than awaits them.
  const pump = async (attachment: LocalTargetAttachment): Promise<void> => {
    try {
      for await (const { service, line } of attachment.logs(signal, {
        tail: input.tail ?? 0,
      })) {
        if (signal.aborted) return;
        if (input.address !== undefined && service !== input.address) continue;
        if (queue.length >= LOG_QUEUE_LIMIT) {
          queue.shift();
          dropped += 1;
        }
        queue.push({ service, line });
        notify();
      }
    } catch (error) {
      if (!signal.aborted) {
        emit({ kind: 'stream-failed', message: failureMessage(error) });
      }
    } finally {
      active -= 1;
      notify();
    }
  };
  for (const attachment of attachments) void pump(attachment);

  try {
    while (true) {
      let next = queue.shift();
      while (next !== undefined) {
        if (dropped > 0) {
          const count = dropped;
          dropped = 0;
          emit({ kind: 'lines-dropped', count });
        }
        yield next;
        next = queue.shift();
      }
      if (signal.aborted || active === 0) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    // End-of-life, whichever way it came (abort, sources ended, consumer
    // broke out): mark the stream done so no event lands in torn-down host
    // state, abort the pumps, and DON'T await them — a source that ignores
    // the signal must not wedge the consumer's `break`.
    done = true;
    controller.abort();
    signal.removeEventListener('abort', notify);
    input.signal?.removeEventListener('abort', abortInternal);
  }
}

/** Resolves the running app and attaches to its log streams; the caller consumes `lines`. */
export async function executeLog(input: LogInput, deps: LogDeps, cwd: string): Promise<LogResult> {
  if (process.platform === 'win32') {
    return {
      outcome: 'failed',
      failure: {
        kind: 'unsupported-platform',
        message: 'local dev is not supported on Windows yet.',
      },
    };
  }

  const devDir = path.join(cwd, DEV_DIR);

  let name: string;
  const attachments: LocalTargetAttachment[] = [];
  let services: readonly { readonly address: string; readonly url: string }[];

  try {
    const identity =
      deps.identity ??
      (await resolveAppIdentity(input.entry, input.name, cwd, { config: deps.config }));
    name = identity.name;

    let resolved: ReadonlyMap<string, LocalTargetDescriptor>;
    try {
      resolved = await resolveLocalTargets(identity.config);
    } catch (error) {
      throw toCliError(error);
    }

    for (const target of resolved.values()) {
      try {
        const container = await target.container.ensure({ appName: name, stage: undefined });
        attachments.push(await withEmulatorRetry(() => target.attach({ container, devDir })));
      } catch (error) {
        throw toCliError(error);
      }
    }

    services = (
      await Promise.all(attachments.map((a) => withEmulatorRetry(() => a.endpoints())))
    ).flat();
  } catch (error) {
    return {
      outcome: 'failed',
      failure: { kind: 'pipeline', message: failureMessage(error), cause: error },
    };
  }

  if (services.length === 0) {
    return {
      outcome: 'attached',
      appName: name,
      services: [],
      lines: mergeLogStreams([], input),
    };
  }
  if (input.address !== undefined && !services.some((s) => s.address === input.address)) {
    return {
      outcome: 'failed',
      failure: {
        kind: 'invalid-input',
        message: `no service "${input.address}" in "${name}" — running services: ${services
          .map((s) => s.address)
          .join(', ')}.`,
      },
    };
  }

  return {
    outcome: 'attached',
    appName: name,
    services,
    lines: mergeLogStreams(attachments, input),
  };
}
