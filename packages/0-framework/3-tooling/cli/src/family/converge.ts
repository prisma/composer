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
  /** How the run's most recent completed child ended, or undefined when none
   *  ran — the operation failed before reaching the converge, or the spawn
   *  never launched. The engine keeps this record; composer does not. */
  readonly lastChild: () => ChildResult | undefined;
}

/** The adapter the operations call, backed by the engine's `ctx.spawn` so the
 *  terminal reaches alchemy natively and the engine owns signal policy. */
export function convergeSpawn(ctx: ConvergeContext): RunAlchemy {
  return async (invocation) => {
    const line = alchemyCommandLine(invocation);
    return await ctx.spawn({
      command: line.command,
      args: line.args,
      cwd: line.cwd,
      env: line.env,
    });
  };
}

/** The in-process leg's deps: composer's existing seam, carrying the engine's
 *  own client and workspace id rather than anything read from the env. */
export function operationDeps(spec: {
  readonly alchemy: RunAlchemy;
  readonly configPath: string | undefined;
  readonly workspaceId: string | undefined;
  readonly client: ManagementApiClient;
}): OperationDeps {
  return {
    alchemy: spec.alchemy,
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
 * How a converge settles, now that the engine owns the child's status.
 *
 * Nothing here reads `signal`. `exitWithChildStatus` settles from the engine's
 * own record of the child, and a signal-killed one overrules whatever this
 * function asked for: 128 + the signal, no failure envelope, and the reproduce
 * hint dropped, because the user stopped the run and there is nothing to
 * reproduce.
 *
 * What is left is the operation's own verdict. A failure that reached the
 * child exits with the child's status verbatim and carries the reproduce hint;
 * a failure that never reached the child is an ordinary structured error and
 * gets the normal envelope.
 *
 * A SUCCESS presents its result even when the child was signal-killed. No
 * composer operation produces that pair today — each one reports a
 * signal-killed converge as a failure — and an operation that ever did would
 * have a real result worth showing. The run still exits 130, because the
 * engine settles a signal-terminated run from its own record of the signal
 * whatever the handler returns.
 */
export function settleConverge<T>(
  result: ComposerResult<T, ComposerError>,
  ctx: ConvergeContext,
  present: (value: T) => PresentedResult<unknown>,
): HandlerResult {
  if (!result.ok) {
    const child = ctx.lastChild();
    if (child !== undefined && child.exitCode !== 0) {
      return ok(exitWithChildStatus({ nextActions: reproduceHint(result.failure) }));
    }
    return notOk(toEngineError(result.failure));
  }

  return ok(present(result.value));
}
