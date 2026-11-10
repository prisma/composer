/**
 * The published operations double (`@prisma/composer-cli/testing`): the
 * operations the command family calls, `deploy`, `dev`, `devUrl` and
 * `devStop`, with their real
 * signatures and Result shapes, backed by fixtures instead of alchemy,
 * containers, or a network. It does not cover `destroy` and `log`, which no
 * command calls.
 *
 * Hosts that mount composer's command family — prisma-cli above all — test
 * against this instead of the real operations, so their suites never spawn a
 * converge and their typecheck never needs the alchemy/effect constellation.
 * The conformance guarantee is carried by the types: `ComposerOperations` is
 * defined as `typeof deployWithDeps` (etc.) of the REAL operations, and the
 * double is declared against it, so a drift in any real signature fails
 * `tsc --noEmit` right here. Every import of implementation modules is
 * type-only and erases at build — the built `testing` chunk must contain no path to the real
 * control implementation, which scripts/check-family-static-graph.mjs proves
 * against the packed tarball.
 */
import type { CliStructuredError } from '@internal/foundation/errors';
import { ok, type Result } from '@internal/foundation/result';
import type { ComposerOperations } from '../family/family.ts';
import type { DeployEvent, DeployInput, DeploySuccess } from '../operations/deploy.ts';
import type { DevEvent, DevInput, DevSession } from '../operations/dev.ts';
import type { DevStopInput, DevStopped, DevUrl, DevUrlInput } from '../operations/dev-current.ts';
import type { OperationDeps, ServiceEndpoint } from '../operations/shared.ts';

export interface OperationsDoubleFixtures {
  /** Returned as-is; pass notOk(error) for a failing deploy. Default: ok with no summary and a zero duration. */
  readonly deploy?: Result<DeploySuccess, CliStructuredError> | undefined;
  /** Sent to the deploy's `onEvent`, in order, before it returns. */
  readonly deployEvents?: readonly DeployEvent[] | undefined;
  /**
   * A failing dev: returned as-is, no session starts. When absent, dev
   * succeeds with a working DevSession double over `devEndpoints`.
   */
  readonly dev?: Result<DevSession, CliStructuredError> | undefined;
  /** The session's front door; emitted as the initial 'ready' event, like the real operation's. */
  readonly devEndpoints?: readonly ServiceEndpoint[] | undefined;
  /** Sent to the dev session's `onEvent`, in order, right after the initial 'ready'. */
  readonly devEvents?: readonly DevEvent[] | undefined;
  /** Returned as-is. Default: the address as a running service at http://localhost:3000. */
  readonly devUrl?: Result<DevUrl, CliStructuredError> | undefined;
  /** Returned as-is. Default: an app named `app` with nothing to stop. */
  readonly devStop?: Result<DevStopped, CliStructuredError> | undefined;
}

/**
 * The deps each call carried, in the same order as the inputs beside them.
 * These are the operation's SECOND argument — the seam the credentials and
 * the converge environment ride in on — so a host that
 * drops one of those is caught here rather than by its absence downstream.
 */
export interface OperationsDoubleDeps {
  readonly deploy: readonly OperationDeps[];
  readonly dev: readonly OperationDeps[];
}

/** Every input each operation received, in call order — the assertion surface. */
export interface OperationsDoubleCalls {
  readonly deploy: readonly DeployInput[];
  readonly dev: readonly DevInput[];
  readonly devUrl: readonly DevUrlInput[];
  readonly devStop: readonly DevStopInput[];
  readonly deps: OperationsDoubleDeps;
}

export interface OperationsDouble {
  /** Drop-in for the real operations: hand to createComposerFamily({ operations }). */
  readonly operations: ComposerOperations;
  readonly calls: OperationsDoubleCalls;
}

function devSessionDouble(
  input: DevInput,
  endpoints: readonly ServiceEndpoint[],
  events: readonly DevEvent[],
): DevSession {
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let stopped = false;
  input.onEvent?.({ kind: 'ready', endpoints });
  for (const event of events) input.onEvent?.(event);
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

export function createOperationsDouble(fixtures: OperationsDoubleFixtures = {}): OperationsDouble {
  const deployCalls: DeployInput[] = [];
  const devCalls: DevInput[] = [];
  const deployDeps: OperationDeps[] = [];
  const devDeps: OperationDeps[] = [];
  const deps = { deploy: deployDeps, dev: devDeps };
  const devUrlCalls: DevUrlInput[] = [];
  const devStopCalls: DevStopInput[] = [];
  const calls = {
    deploy: deployCalls,
    dev: devCalls,
    devUrl: devUrlCalls,
    devStop: devStopCalls,
    deps,
  };

  const operations: ComposerOperations = {
    deploy: async (input, operationDeps) => {
      calls.deploy.push(input);
      deps.deploy.push(operationDeps);
      for (const event of fixtures.deployEvents ?? []) {
        try {
          input.onEvent?.(event);
        } catch {
          // The real deploy ignores a throwing onEvent, so the double does too.
        }
      }
      return fixtures.deploy ?? ok({ summary: undefined, durationMs: 0 });
    },
    dev: async (input, operationDeps) => {
      calls.dev.push(input);
      deps.dev.push(operationDeps);
      return (
        fixtures.dev ??
        ok(devSessionDouble(input, fixtures.devEndpoints ?? [], fixtures.devEvents ?? []))
      );
    },
    devUrl: async (input) => {
      devUrlCalls.push(input);
      return (
        fixtures.devUrl ??
        ok({
          address: input.address,
          kind: 'service',
          url: 'http://localhost:3000',
          state: 'running',
        })
      );
    },
    devStop: async (input) => {
      devStopCalls.push(input);
      return (
        fixtures.devStop ?? ok({ app: 'app', environment: input.environment ?? 'dev', stopped: [] })
      );
    },
  };

  return { operations, calls };
}
