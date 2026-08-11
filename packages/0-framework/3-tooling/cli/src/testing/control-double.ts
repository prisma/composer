/**
 * The published control-API double (`@prisma/composer/testing`): the four
 * control operations with their real signatures and Result shapes, backed by
 * fixtures instead of alchemy, containers, or a network.
 *
 * Hosts that mount composer's command family — prisma-cli above all — test
 * against this instead of the real operations, so their suites never spawn a
 * converge and their typecheck never needs the alchemy/effect constellation.
 * The conformance guarantee is carried by the types: `ComposerOperations` is
 * defined as `typeof deploy` (etc.) of the REAL operations, and the double is
 * declared against it, so a drift in any real signature fails `tsc --noEmit`
 * right here. Every import of implementation modules is type-only and erases
 * at build — the built `testing` chunk must contain no path to the real
 * control implementation, which scripts/check-family-static-graph.mjs proves
 * against the packed tarball.
 */
import type { CliStructuredError } from '@internal/foundation/errors';
import { ok, okVoid, type Result } from '@internal/foundation/result';
import type { ComposerOperations } from '../family/family.ts';
import type { DeployInput, DeploySuccess } from '../operations/deploy.ts';
import type { DestroyEvent, DestroyInput } from '../operations/destroy.ts';
import type { DevInput, DevSession } from '../operations/dev.ts';
import type { LogAttached, LogInput, LogLine } from '../operations/log.ts';
import type { ServiceEndpoint } from '../operations/shared.ts';

export interface ControlDoubleFixtures {
  /** Returned as-is; pass notOk(error) for a failing deploy. Default: ok with no summary. */
  readonly deploy?: Result<DeploySuccess, CliStructuredError> | undefined;
  /** Returned as-is. Default: ok. */
  readonly destroy?: Result<void, CliStructuredError> | undefined;
  /** Delivered to the caller's onEvent, in order, before destroy resolves. */
  readonly destroyEvents?: readonly DestroyEvent[] | undefined;
  /**
   * A failing dev: returned as-is, no session starts. When absent, dev
   * succeeds with a working DevSession double over `devEndpoints`.
   */
  readonly dev?: Result<DevSession, CliStructuredError> | undefined;
  /** The session's front door; emitted as the initial 'ready' event, like the real operation's. */
  readonly devEndpoints?: readonly ServiceEndpoint[] | undefined;
  /** A failing log: returned as-is. When absent, log attaches over the fixtures below. */
  readonly log?: Result<LogAttached, CliStructuredError> | undefined;
  readonly logAppName?: string | undefined;
  readonly logServices?: readonly ServiceEndpoint[] | undefined;
  /** Replayed through the attachment's stream, then the stream ends (or ends early on signal abort). */
  readonly logLines?: readonly LogLine[] | undefined;
}

/** Every input each operation received, in call order — the assertion surface. */
export interface ControlDoubleCalls {
  readonly deploy: readonly DeployInput[];
  readonly destroy: readonly DestroyInput[];
  readonly dev: readonly DevInput[];
  readonly log: readonly LogInput[];
}

export interface ControlDouble {
  /** Drop-in for the real operations: hand to createComposerFamily({ operations }). */
  readonly operations: ComposerOperations;
  readonly calls: ControlDoubleCalls;
}

function devSessionDouble(input: DevInput, endpoints: readonly ServiceEndpoint[]): DevSession {
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let stopped = false;
  input.onEvent?.({ kind: 'ready', endpoints });
  return {
    endpoints,
    closed,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      input.onEvent?.({ kind: 'stopping' });
      input.onEvent?.({ kind: 'stopped' });
      resolveClosed();
    },
  };
}

async function* replayLines(
  lines: readonly LogLine[],
  address: string | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<LogLine> {
  for (const line of lines) {
    if (signal?.aborted === true) return;
    if (address !== undefined && line.service !== address) continue;
    yield line;
  }
}

export function createControlDouble(fixtures: ControlDoubleFixtures = {}): ControlDouble {
  const calls = {
    deploy: [] as DeployInput[],
    destroy: [] as DestroyInput[],
    dev: [] as DevInput[],
    log: [] as LogInput[],
  };

  const operations: ComposerOperations = {
    deploy: async (input) => {
      calls.deploy.push(input);
      return fixtures.deploy ?? ok({ summary: undefined });
    },
    destroy: async (input) => {
      calls.destroy.push(input);
      for (const event of fixtures.destroyEvents ?? []) input.onEvent?.(event);
      return fixtures.destroy ?? okVoid();
    },
    dev: async (input) => {
      calls.dev.push(input);
      return fixtures.dev ?? ok(devSessionDouble(input, fixtures.devEndpoints ?? []));
    },
    log: async (input) => {
      calls.log.push(input);
      return (
        fixtures.log ??
        ok({
          appName: fixtures.logAppName ?? 'app',
          services: fixtures.logServices ?? [],
          lines: replayLines(fixtures.logLines ?? [], input.address, input.signal),
        })
      );
    },
  };

  return { operations, calls };
}
