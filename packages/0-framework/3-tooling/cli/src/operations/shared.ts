/**
 * What every operation module shares: the injectable deps seam, the
 * structured-error helpers, and the executor-load diagnosis. Import-light —
 * the per-operation modules (deploy/destroy/dev/log) stay cheap to import
 * because this is all they pull in statically.
 */
import type { RunAssembler } from '@internal/assemble';
import type { ContainerCredentials, PrismaAppConfig } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import { checkEffectResolution } from '../check-effect-resolution.ts';
import type { RunAlchemy } from '../run-alchemy.ts';

/** The `id` of an ExtensionDescriptor — what keys the executors' per-extension maps. */
export type ExtensionId = string;

/** A running service's dotted address plus its local URL — what `dev` reports
 * as the front door and `log` reports as the tailable services. */
export interface ServiceEndpoint {
  readonly address: string;
  readonly url: string;
}

/**
 * The operations' in-package injection seam — lets the CLI's own tests drive
 * them without a real wrapper build, config evaluation, or alchemy process.
 * Threaded through the *WithDeps variants, never part of the published
 * surface: the fields mirror internal types.
 */
export interface OperationDeps {
  readonly runAssembler?: RunAssembler | undefined;
  /**
   * Starts the converge child. The CLI passes one backed by the engine's
   * `ctx.spawn`, so the terminal reaches the child natively and the engine
   * owns signal policy; hosts get the default `spawnAlchemy`.
   */
  readonly alchemy?: RunAlchemy | undefined;
  readonly config?: PrismaAppConfig | undefined;
  /** Names the config file explicitly instead of walking up from the entry. */
  readonly configPath?: string | undefined;
  /**
   * How the in-process leg authenticates: the caller's already-authenticated
   * API client and the workspace it acts in. Supplied by the CLI from the
   * engine's credential read, so no code below this point reads the
   * environment for token material. Absent for hosts that have not adopted
   * the seam — the container descriptors then fall back to the environment
   * protocol, as the spawned child does.
   */
  readonly credentials?: ContainerCredentials | undefined;
}

/**
 * Where a failed execution left its artifacts — details of the CURRENT
 * execution mechanism (a spawned deploy-engine child driving a generated
 * stack file), for hosts that want to print a reproduce hint. The mechanism
 * is not part of the surface's contract, so these fields may change or
 * disappear if the mechanism does; branch on `code`/`message`/`cause` for
 * anything durable.
 */
export interface ExecutionDiagnostics {
  /** The child's exit status; undefined means the spawn itself threw, or the
   *  child was killed by a signal (`signal` then names it). */
  readonly exitCode: number | undefined;
  /** The signal that killed the child, when one did. A signal-killed converge
   *  is an abort the user asked for, not a failure of the deploy — a host
   *  should report it as an interruption and print no reproduce hint. */
  readonly signal?: string | undefined;
  readonly stackFilePath: string;
  readonly reproduceCommand: string;
  readonly cwd: string;
}

/**
 * Reads the execution diagnostics an engine-failure error carries in
 * `meta.diagnostics`; undefined for every other failure.
 */
export function executionDiagnostics(f: CliStructuredError): ExecutionDiagnostics | undefined {
  const diagnostics = f.meta?.['diagnostics'];
  if (typeof diagnostics !== 'object' || diagnostics === null) return undefined;
  const candidate = blindCast<
    Record<string, unknown>,
    'probe for the structural field checks below; typeof above proves it is a non-null object'
  >(diagnostics);
  if (
    (candidate['exitCode'] !== undefined && typeof candidate['exitCode'] !== 'number') ||
    typeof candidate['stackFilePath'] !== 'string' ||
    typeof candidate['reproduceCommand'] !== 'string' ||
    typeof candidate['cwd'] !== 'string'
  ) {
    return undefined;
  }
  return blindCast<
    ExecutionDiagnostics,
    'the field checks above validate the runtime shape (optional numeric exitCode, string stackFilePath/reproduceCommand/cwd)'
  >(diagnostics);
}

/**
 * Site-specific wrap for foreign extension/environment causes — passthrough
 * when already structured; never a boundary fallback (base-type rule 6(ii)).
 */
export function toStructured(code: `${string}.${string}`, error: unknown): CliStructuredError {
  return CliStructuredError.is(error)
    ? error
    : new CliStructuredError(code, error instanceof Error ? error.message : String(error), {
        cause: error,
      });
}

/** The operation whose executor failed to load — named in the failure so a
 * host driving several operations can tell which one broke. */
export type OperationName = 'deploy' | 'destroy' | 'dev' | 'log';

/** Diagnoses a failed executor import: when the app's tree resolves a
 * mismatched `effect` (the known way that import breaks), the failure is the
 * fix-naming DEPS.EFFECT_VERSION_CONFLICT from checkEffectResolution with the
 * import error riding as cause; otherwise DEPS.EXECUTOR_UNLOADABLE — an
 * environmental failure of the consumer's installed tree, not a bug here. */
export function executorLoadFailure(
  operation: OperationName,
  error: unknown,
  cwd: string,
): CliStructuredError {
  try {
    checkEffectResolution(cwd);
  } catch (diagnostic) {
    if (CliStructuredError.is(diagnostic)) {
      return new CliStructuredError(diagnostic.code, diagnostic.message, {
        ...(diagnostic.why !== undefined ? { why: diagnostic.why } : {}),
        ...(diagnostic.fix !== undefined ? { fix: diagnostic.fix } : {}),
        ...(diagnostic.meta !== undefined ? { meta: diagnostic.meta } : {}),
        cause: error,
      });
    }
  }
  return new CliStructuredError(
    'DEPS.EXECUTOR_UNLOADABLE',
    `Could not load the ${operation} executor: ${error instanceof Error ? error.message : String(error)}`,
    {
      why:
        `The ${operation} operation's executor imports the deploy engine's provider tree from ` +
        "your app's installed dependencies, and that import failed.",
      fix: 'Reinstall your dependencies, and check that `alchemy` is installed and loadable from your app.',
      cause: error,
    },
  );
}
