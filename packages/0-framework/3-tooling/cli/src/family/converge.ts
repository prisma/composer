/**
 * What `deploy` and `destroy` share: the two-leg authenticated run of a
 * converge, and the settlement rules for how the child ended.
 *
 * The two legs (S3 § Auth). The IN-PROCESS leg is the pre-work that happens
 * in this process — config evaluation, container ensure/locate, preflight —
 * and it authenticates through composer's own injection seam: the engine's
 * pinned, refreshing API client goes in as the operation deps' client, and
 * the workspace id comes from the engine's credential read. Nothing here
 * reads the environment for token material. The CHILD leg is the engine's:
 * it composes the credential into the child environment at spawn time because
 * the command declares `needs: { credentials: 'child' }`, which is also what
 * makes the engine refuse a near-expiry credential BEFORE the handler runs —
 * before the in-process leg creates anything on any platform.
 */
import type {
  ChildResult,
  ChildStatusSettlement,
  ManagementApiClient,
  PresentedResult,
} from '@prisma/cli-engine';
import { exitWithChildStatus } from '@prisma/cli-engine';
import type { CliStructuredError, NextAction, Result } from '@prisma/cli-engine/protocol';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import { executionDiagnostics, type OperationDeps } from '../operations/shared.ts';
import { alchemyCommandLine, type RunAlchemy } from '../run-alchemy.ts';
import { toEngineError } from './translate-error.ts';

// Inline import types, not aliased imports: the no-bare-cast plugin reads the
// `as` in `import type { X as Y }` as a cast and the ratchet rejects it.
type ComposerError = import('@internal/foundation/errors').CliStructuredError;
type ComposerResult<T, F> = import('@internal/foundation/result').Result<T, F>;

/** What a result command's handler may settle with. */
export type HandlerResult = Result<
  PresentedResult<unknown> | ChildStatusSettlement,
  CliStructuredError
>;

/** The subset of the engine context this module needs, so the helpers stay
 *  testable without building a whole context. */
export interface ConvergeContext {
  readonly spawn: (options: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  }) => Promise<ChildResult>;
}

/** Records the converge child so the handler settles on how the child ENDED
 *  rather than on how the operation described the ending. */
export interface ConvergeSpawn {
  readonly alchemy: RunAlchemy;
  /** The child, once one has run. Undefined when the operation failed before
   *  reaching the converge — a config error, a failed preflight. */
  child(): ChildResult | undefined;
}

/** The adapter the operations call, backed by the engine's `ctx.spawn` so the
 *  terminal reaches alchemy natively and the engine owns signal policy. */
export function convergeSpawn(ctx: ConvergeContext): ConvergeSpawn {
  let seen: ChildResult | undefined;
  return {
    alchemy: async (invocation) => {
      const line = alchemyCommandLine(invocation);
      const result = await ctx.spawn({
        command: line.command,
        args: line.args,
        cwd: line.cwd,
        env: line.env,
      });
      seen = result;
      return result;
    },
    child: () => seen,
  };
}

/** The in-process leg's deps: composer's existing seam, carrying the engine's
 *  own client and workspace id rather than anything read from the env. */
export function operationDeps(spec: {
  readonly spawn: ConvergeSpawn;
  readonly configPath: string | undefined;
  readonly workspaceId: string | undefined;
  readonly client: ManagementApiClient;
}): OperationDeps {
  return {
    alchemy: spec.spawn.alchemy,
    configPath: spec.configPath,
    credentials: { workspaceId: spec.workspaceId, client: spec.client },
  };
}

/**
 * The reproduce hint a failed converge carries. Deliberately absent for an
 * aborted one: the user stopped it, so there is nothing to reproduce.
 */
export function reproduceHint(failure: ComposerError): readonly NextAction[] {
  const diagnostics = executionDiagnostics(failure);
  if (diagnostics === undefined) return [];
  return [
    {
      kind: 'run-command',
      label: `Run the converge directly from ${diagnostics.cwd} to reproduce this`,
      command: diagnostics.reproduceCommand,
      reason: `Generated stack file: ${diagnostics.stackFilePath}`,
    },
  ];
}

/**
 * How a converge settles, in the order the outcome must be read.
 *
 * `signal` FIRST: a signal-killed child is the user aborting, not a deploy
 * that failed. It settles 128 + the signal with no failure envelope and no
 * reproduce hint — replacing the old status collapse, which reported a
 * Ctrl-C'd deploy as an engine failure.
 *
 * Then the operation's own verdict. A failure that reached the child exits
 * with the child's status verbatim, carrying the reproduce hint; a failure
 * that never reached the child is an ordinary structured error and gets the
 * normal envelope.
 */
export function settleConverge<T>(
  result: ComposerResult<T, ComposerError>,
  spawn: ConvergeSpawn,
  present: (value: T) => PresentedResult<unknown>,
): HandlerResult {
  const child = spawn.child();

  if (child !== undefined && child.signal !== null) {
    return ok(exitWithChildStatus(child));
  }

  if (!result.ok) {
    if (child !== undefined && child.exitCode !== 0) {
      return ok(exitWithChildStatus(child, { nextActions: reproduceHint(result.failure) }));
    }
    return notOk(toEngineError(result.failure));
  }

  return ok(present(result.value));
}
