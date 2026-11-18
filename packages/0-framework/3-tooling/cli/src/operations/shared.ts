/**
 * What every operation module shares: the injectable deps seam, the
 * structured-error helpers, and the executor-load failure. Import-light —
 * the per-operation modules (deploy/destroy/dev/log) stay cheap to import
 * because this is all they pull in statically.
 */
import type { RunAssembler } from '@internal/assemble';
import type {
  CallerCredentials,
  ContainerDescriptor,
  ContainerInstance,
} from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import type { AppConvergeEntry } from '../app-converge.ts';
import type { ConvergeFailureReason } from '../converge-in-process.ts';
import type { startWatch } from '../dev/watch.ts';
import type { SecretRedaction } from '../redaction.ts';
import type { RunDevConverge } from './dev-converge.ts';

/** The `id` of an ExtensionDescriptor — what keys the executors' per-extension maps. */
export type ExtensionId = string;

/** The environment name local development runs as when none is given. */
export const DEV_ENVIRONMENT = 'dev';

/** A running service's dotted address plus its local URL — what `dev` reports
 * as the front door and `log` reports as the tailable services. */
export interface ServiceEndpoint {
  readonly address: string;
  readonly url: string;
  /** The dev server the service runs in place of its artifact, as its build adapter displays it (`next dev`) — absent for a service that runs its artifact (ADR-0056). */
  readonly devServer?: string;
}

/**
 * The operations' in-package injection seam — lets the CLI's own tests drive
 * them without a real wrapper build or Alchemy converge.
 * Threaded through the *WithDeps variants, never part of the published
 * surface: the fields mirror internal types.
 */
export interface OperationDeps {
  readonly runAssembler?: RunAssembler | undefined;
  /** The `lower` and converge functions `deploy` and `destroy` run; defaults to the app's own install (`loadAppConvergeEntry`). Tests substitute it. */
  readonly appConvergeEntry?: AppConvergeEntry | undefined;
  /** Runs one `dev` converge and reports its events; defaults to a new worker thread per converge (`runDevConvergeInWorker`). Tests substitute it. */
  readonly runDevConverge?: RunDevConverge | undefined;
  /** What `deploy` and `dev` redact from everything they report. Defaults to one built from `process.env`; the CLI passes its own so its console redirect redacts the same values. */
  readonly redaction?: SecretRedaction | undefined;
  /** Starts a file watch for `dev`; defaults to chokidar-backed `startWatch`. Tests substitute it to drive changes directly. */
  readonly watch?: typeof startWatch | undefined;
  /**
   * How the in-process leg authenticates: the caller's already-authenticated
   * API client and the workspace it acts in. Supplied by the CLI from the
   * engine's credential read, so no code below this point reads the
   * environment for token material. Absent for hosts that have not adopted
   * the seam — the container descriptors then fall back to the environment
   * protocol.
   *
   * Read by `deploy` and `destroy` only, because they are the operations that
   * reach a PLATFORM container. `dev` and `log` resolve local targets, whose
   * container is "a stable local identity — resolved without any platform
   * call", and both commands are credential-free by contract: there is no
   * authenticated call on those paths for this to reach.
   */
  readonly credentials?: CallerCredentials | undefined;
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
export type OperationName = 'deploy' | 'destroy' | 'dev' | 'dev url' | 'dev stop' | 'log';

/** A failed executor import: an environmental failure of the consumer's
 * installed tree, not a bug here. The import error rides as the cause. */
export function executorLoadFailure(operation: OperationName, error: unknown): CliStructuredError {
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

const RUN_OF = {
  deploy: { running: 'this deploy', runs: 'the deploy' },
  destroy: { running: 'this destroy', runs: 'the destroy' },
  dev: { running: '`prisma dev`', runs: '`prisma dev`' },
} as const;

/**
 * An extension older than this Composer stores the input it is given but
 * resolves from a key without `environment`, so it may read every name as
 * production, or, locally, put every environment in one copy. Its
 * `deserialize` rebuilds only the fields it knows, so the container it
 * rebuilds shows which environment it really resolved.
 * Refusing here keeps a mismatched install from deploying into, destroying
 * or running the wrong place.
 */
export function requireContainerForEnvironment(
  action: keyof typeof RUN_OF,
  extensionId: ExtensionId,
  descriptor: ContainerDescriptor,
  instance: ContainerInstance,
  environment: string,
): void {
  let rebuiltEnvironment: string | undefined;
  try {
    rebuiltEnvironment = descriptor.deserialize(instance.serialize()).input.environment;
  } catch {
    rebuiltEnvironment = undefined;
  }
  if (rebuiltEnvironment === environment) return;
  const { running, runs } = RUN_OF[action];
  throw new CliStructuredError(
    'DEPS.EXTENSION_INCOMPATIBLE',
    `The extension ${extensionId} is older than the Composer running ${running}, so it would not resolve the environment ${environment}.`,
    {
      fix: `Install the same Composer version of ${extensionId} as the Composer that runs ${runs}.`,
    },
  );
}

/** A failed converge's reasons as text, one per line, without a tag the message already starts with. */
export function convergeReasonsText(reasons: readonly ConvergeFailureReason[]): string {
  return reasons
    .map(({ tag, message }) =>
      tag === 'Error' || tag === 'Unknown' || message.startsWith(tag)
        ? message
        : `${tag}: ${message}`,
    )
    .join('\n');
}
