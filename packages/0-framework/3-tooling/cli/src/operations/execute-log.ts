/**
 * The log executor — run-log.ts's attach-and-tail (config → localTarget →
 * container → attach → logs) with console and signal handling removed: the
 * merged stream comes back as an AsyncIterable, ended by the caller's
 * AbortSignal. Reached only by lazy import from operations.ts — this module's
 * static graph transitively loads alchemy's provider tree, so the control
 * entry must never import it statically.
 */
import * as path from 'node:path';
import type { LocalTargetAttachment, LocalTargetDescriptor } from '@internal/core/local-target';
import { DEV_DIR, resolveLocalTargets } from '@internal/core/local-target';
import { CliError } from '../cli-error.ts';
import { resolveAppIdentity } from '../pipeline.ts';
import type { LogInput, LogLine, LogResult } from './results.ts';

function toCliError(error: unknown): CliError {
  return error instanceof CliError
    ? error
    : new CliError(error instanceof Error ? error.message : String(error));
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Merges every attachment's log stream into one iterable: one pump per
 * attachment pushing into a shared queue. A pump's throw becomes a
 * `stream-failed` event and ends that pump only; the merged iterable ends when
 * `input.signal` aborts or every pump ends. Address filtering and `tail` apply
 * exactly as the CLI always has.
 */
async function* mergeLogStreams(
  attachments: readonly LocalTargetAttachment[],
  input: LogInput,
): AsyncGenerator<LogLine, void, undefined> {
  const signal = input.signal ?? new AbortController().signal;
  const queue: LogLine[] = [];
  let active = attachments.length;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  signal.addEventListener('abort', notify, { once: true });

  const pumps = attachments.map(async (attachment) => {
    try {
      for await (const { service, line } of attachment.logs(signal, {
        tail: input.tail ?? 0,
      })) {
        if (signal.aborted) return;
        if (input.address !== undefined && service !== input.address) continue;
        queue.push({ service, line });
        notify();
      }
    } catch (error) {
      if (!signal.aborted) {
        input.onEvent?.({ kind: 'stream-failed', message: failureMessage(error) });
      }
    } finally {
      active -= 1;
      notify();
    }
  });

  try {
    while (true) {
      let next = queue.shift();
      while (next !== undefined) {
        yield next;
        next = queue.shift();
      }
      if (signal.aborted || active === 0) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    signal.removeEventListener('abort', notify);
    await Promise.all(pumps);
  }
}

/** Resolves the running app and attaches to its log streams; the caller consumes `lines`. */
export async function executeLog(input: LogInput, cwd: string): Promise<LogResult> {
  if (process.platform === 'win32') {
    return {
      outcome: 'failed',
      failure: { kind: 'unsupported', message: 'local dev is not supported on Windows yet.' },
    };
  }

  const devDir = path.join(cwd, DEV_DIR);

  let name: string;
  const attachments: LocalTargetAttachment[] = [];
  let services: readonly { readonly address: string; readonly url: string }[];

  try {
    const identity =
      input.deps?.identity ??
      (await resolveAppIdentity(input.entry, input.name, cwd, { config: input.deps?.config }));
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
        attachments.push(await target.attach({ container, devDir }));
      } catch (error) {
        throw toCliError(error);
      }
    }

    services = (await Promise.all(attachments.map((a) => a.endpoints()))).flat();
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
