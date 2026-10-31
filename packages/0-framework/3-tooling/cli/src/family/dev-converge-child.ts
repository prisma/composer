/**
 * The `dev` command's converge child: the spawn adapter backed by the
 * engine's `ctx.spawn`, and the settlement rules for how the child ended.
 * `deploy` converges in this process and settles as an ordinary command.
 */

import type { CliStructuredError as ComposerError } from '@internal/foundation/errors';
import type { ChildResult, ChildStatusSettlement } from '@prisma/cli-engine';
import { exitWithChildStatus } from '@prisma/cli-engine';
import type { CliStructuredError, NextAction, Result } from '@prisma/cli-engine/protocol';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import { executionDiagnostics } from '../operations/shared.ts';
import { alchemyCommandLine, type RunAlchemy } from '../run-alchemy.ts';
import { toEngineError } from './translate-error.ts';

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

/**
 * Node's `--import` of a module that sends the child's stdout to stderr when
 * stdout is not a terminal. In human format the engine hands a piped run's
 * stdout to the child, and that pipe carries only the parent's data lines.
 */
const STDOUT_TO_STDERR = [
  '--import',
  `data:text/javascript,${encodeURIComponent(
    'if (process.stdout.isTTY !== true) process.stdout.write = process.stderr.write.bind(process.stderr);',
  )}`,
] as const;

/** The adapter the operations call, backed by the engine's `ctx.spawn` so the
 *  terminal reaches alchemy natively and the engine owns signal policy. */
export function convergeSpawn(ctx: ConvergeContext): RunAlchemy {
  return async (invocation) => {
    const commandLine = alchemyCommandLine(invocation);
    const result = await ctx.spawn({
      command: commandLine.command,
      args: [...STDOUT_TO_STDERR, ...commandLine.args],
      cwd: commandLine.cwd,
      env: commandLine.env,
    });
    return { ...result, commandLine };
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
 * How a FAILED `dev` converge settles.
 *
 * A failure that reached the child exits with the child's status verbatim and
 * carries the reproduce hint; a failure that never reached the child is an
 * ordinary structured error and gets the normal envelope. Nothing here reads
 * `signal`: `exitWithChildStatus` settles from the engine's own record of the
 * child, and a signal-killed one overrules it with 128 + the signal and no
 * reproduce hint.
 */
export function settleConvergeFailure(
  failure: ComposerError,
  ctx: ConvergeContext,
): Result<ChildStatusSettlement, CliStructuredError> {
  const child = ctx.lastChild();
  if (child !== undefined && child.exitCode !== 0) {
    return ok(exitWithChildStatus({ nextActions: reproduceHint(failure) }));
  }
  return notOk(toEngineError(failure));
}
