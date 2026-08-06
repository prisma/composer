/**
 * What every operation module shares: the injectable deps seam, the failure
 * union, and the executor-load diagnosis. Import-light — the per-operation
 * modules (deploy/destroy/dev/log) stay cheap to import because this is all
 * they pull in statically.
 */
import type { RunAssembler } from '@internal/assemble';
import type { PrismaAppConfig } from '@internal/core/config';
import { checkEffectResolution } from '../check-effect-resolution.ts';
import { CliError } from '../cli-error.ts';
import type { RunAlchemyInput } from '../run-alchemy.ts';

/** The `id` of an ExtensionDescriptor — what keys the executors' per-extension maps. */
export type ExtensionId = string;

/** A running service's dotted address plus its local URL — what `dev` reports
 * as the front door and `log` reports as the tailable services. */
export interface ServiceEndpoint {
  readonly address: string;
  readonly url: string;
}

/**
 * @internal Test seam — lets the CLI's own tests drive the operations without
 * a real wrapper build, config evaluation, or alchemy process. No stability
 * guarantee: the fields mirror internal types and can change in any release.
 */
export interface OperationDeps {
  readonly runAssembler?: RunAssembler | undefined;
  readonly alchemy?: ((input: RunAlchemyInput) => number) | undefined;
  readonly config?: PrismaAppConfig | undefined;
}

/**
 * Where a failed execution left its artifacts — details of the CURRENT
 * execution mechanism (a spawned deploy-engine child driving a generated
 * stack file), for hosts that want to print a reproduce hint. The mechanism
 * is not part of the surface's contract, so these fields may change or
 * disappear if the mechanism does; branch on `message`/`cause` for anything
 * durable.
 */
export interface ExecutionDiagnostics {
  /** The child's exit status; undefined means the spawn itself threw. */
  readonly exitCode: number | undefined;
  readonly stackFilePath: string;
  readonly reproduceCommand: string;
  readonly cwd: string;
}

/** Why an operation did not complete. `message` is the same fix-naming text the
 * CLI prints today; `cause` is the original thrown error. */
export type OperationFailure =
  /** A typed input was rejected (invalid --stage ref name, unknown log address). */
  | { readonly kind: 'invalid-input'; readonly message: string; readonly cause?: unknown }
  /** The host platform cannot run this operation (dev/log on win32). */
  | { readonly kind: 'unsupported-platform'; readonly message: string; readonly cause?: unknown }
  /** Any failure between loading the execution stack and the alchemy spawn:
   * a dependency tree the executor cannot load in, missing config, bad entry
   * export, LoadError, coverage miss, assemble, container, extension preflight.
   * (Finer-grained diagnostics are the next slice.) */
  | { readonly kind: 'pipeline'; readonly message: string; readonly cause?: unknown }
  /** The deploy engine ran and failed. */
  | {
      readonly kind: 'execution';
      readonly message: string;
      readonly cause?: unknown;
      readonly diagnostics?: ExecutionDiagnostics | undefined;
    };

/** Diagnoses a failed executor import: when the app's tree resolves a
 * mismatched `effect` (the known way that import breaks), the failure carries
 * the fix-naming message from checkEffectResolution; otherwise the original
 * error's own message. */
export function executorLoadFailure(error: unknown, cwd: string): OperationFailure {
  try {
    checkEffectResolution(cwd);
  } catch (diagnostic) {
    if (diagnostic instanceof CliError) {
      return { kind: 'pipeline', message: diagnostic.message, cause: error };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'pipeline', message, cause: error };
}
