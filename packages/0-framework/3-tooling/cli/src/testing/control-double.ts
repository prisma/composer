/**
 * The published control-API double (`@prisma/composer/testing`): the four
 * control operations with their real signatures and Result shapes, backed by
 * fixtures instead of alchemy, containers, or a network.
 *
 * Hosts that mount composer's command family — prisma-cli above all — test
 * against this instead of the real operations, so their suites never spawn a
 * converge and their typecheck never needs the alchemy/effect constellation.
 * The conformance guarantee is carried by the types: `ComposerOperations` is
 * defined as `typeof deployWithDeps` (etc.) of the REAL operations, and the
 * double is declared against it, so a drift in any real signature fails
 * `tsc --noEmit` right here. Every import of implementation modules is
 * type-only and erases
 * at build — the built `testing` chunk must contain no path to the real
 * control implementation, which scripts/check-family-static-graph.mjs proves
 * against the packed tarball.
 */
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok, okVoid, type Result } from '@internal/foundation/result';
import type { ComposerOperations } from '../family/family.ts';
import type { DeployInput, DeploySuccess } from '../operations/deploy.ts';
import type { DestroyEvent, DestroyInput } from '../operations/destroy.ts';
import type { DevInput, DevSession } from '../operations/dev.ts';
import type { LogAttached, LogInput, LogLine } from '../operations/log.ts';
import type { OperationDeps, ServiceEndpoint } from '../operations/shared.ts';

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

/**
 * Runs the caller's converge adapter, when it supplied one, against a
 * synthetic invocation — no alchemy bin is resolved and no real child is
 * started; the adapter decides what the child does.
 *
 * This is what makes a host's tests cover the settlement rules rather than
 * just the grammar: a scripted fake child that exits non-zero, or is killed
 * by a signal, produces the same failure shape the real executor produces, so
 * the handler's "signal first, then exit status" branch is genuinely
 * exercised. Returns undefined when no adapter was injected, leaving the
 * fixture result untouched.
 */
async function runConverge(
  action: 'deploy' | 'destroy',
  deps: OperationDeps,
  cwd: string | undefined,
): Promise<Result<never, CliStructuredError> | undefined> {
  if (deps.alchemy === undefined) return undefined;
  const stackFilePath = '.prisma-composer/alchemy.run.ts';
  const reproduceCommand = `alchemy ${action} ${stackFilePath} --yes --stage test`;
  const workingDirectory = cwd ?? '.';
  const outcome = await deps.alchemy({
    action,
    stackFileRelativePath: stackFilePath,
    cwd: workingDirectory,
    stage: 'test',
    env: {},
  });

  if (outcome.signal !== null) {
    return notOk(
      new CliStructuredError(
        'DEPLOY.ENGINE_FAILED',
        `alchemy ${action} was interrupted by ${outcome.signal}.`,
        {
          meta: {
            signal: outcome.signal,
            diagnostics: {
              exitCode: undefined,
              signal: outcome.signal,
              stackFilePath,
              reproduceCommand,
              cwd: workingDirectory,
            },
          },
        },
      ),
    );
  }
  const status = outcome.exitCode ?? 1;
  if (status === 0) return undefined;
  return notOk(
    new CliStructuredError(
      'DEPLOY.ENGINE_FAILED',
      `alchemy ${action} exited with status ${status}.`,
      {
        meta: {
          exitCode: status,
          diagnostics: { exitCode: status, stackFilePath, reproduceCommand, cwd: workingDirectory },
        },
      },
    ),
  );
}

export function createControlDouble(fixtures: ControlDoubleFixtures = {}): ControlDouble {
  const deployCalls: DeployInput[] = [];
  const destroyCalls: DestroyInput[] = [];
  const devCalls: DevInput[] = [];
  const logCalls: LogInput[] = [];
  const calls = { deploy: deployCalls, destroy: destroyCalls, dev: devCalls, log: logCalls };

  const operations: ComposerOperations = {
    deploy: async (input, deps) => {
      calls.deploy.push(input);
      const converge = await runConverge('deploy', deps, input.cwd);
      if (converge !== undefined) return converge;
      return fixtures.deploy ?? ok({ summary: undefined });
    },
    destroy: async (input, deps) => {
      calls.destroy.push(input);
      for (const event of fixtures.destroyEvents ?? []) input.onEvent?.(event);
      const converge = await runConverge('destroy', deps, input.cwd);
      if (converge !== undefined) return converge;
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
