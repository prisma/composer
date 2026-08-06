/**
 * Typed inputs and structured results for the programmatic operations
 * (`@prisma/composer/control`). Zero runtime imports from the heavy
 * alchemy-touching tree — everything here is `import type`, erased in the
 * build, so this module is import-safe in a broken effect tree (TML-3158).
 */
import type { RunAssembler } from '@internal/assemble';
import type { PrismaAppConfig } from '@internal/core/config';
import type { AppIdentity } from '../pipeline.ts';
import type { DeploymentSummary } from '../render-deployment.ts';
import type { RunAlchemyInput } from '../run-alchemy.ts';

/** The injectable seams every operation shares — identical to main.ts's RunDeps
 * (which becomes a re-export alias of this type). */
export interface OperationDeps {
  readonly runAssembler?: RunAssembler | undefined;
  readonly alchemy?: ((input: RunAlchemyInput) => number) | undefined;
  readonly config?: PrismaAppConfig | undefined;
}

/** Why an operation did not complete. `message` is the same fix-naming text the
 * CLI prints today; `cause` is the original thrown error. */
export type OperationFailure =
  /** TML-3158: alchemy would resolve a mismatched `effect`; nothing was imported, nothing ran. */
  | { readonly kind: 'effect-resolution'; readonly message: string; readonly cause?: unknown }
  /** A typed input was rejected (invalid --stage ref name, unknown log address). */
  | { readonly kind: 'invalid-input'; readonly message: string; readonly cause?: unknown }
  /** The host platform cannot run this operation (dev/log on win32). */
  | { readonly kind: 'unsupported'; readonly message: string; readonly cause?: unknown }
  /** Any failure between config discovery and the alchemy spawn: missing config,
   * bad entry export, LoadError, coverage miss, assemble, container, extension preflight.
   * (Finer-grained diagnostics are the next slice.) */
  | { readonly kind: 'pipeline'; readonly message: string; readonly cause?: unknown }
  /** The alchemy child ran and failed. `exitCode` undefined means the spawn itself threw. */
  | {
      readonly kind: 'execution';
      readonly message: string;
      readonly exitCode: number | undefined;
      readonly stackFilePath: string;
      readonly reproduceCommand: string;
      readonly cwd: string;
      readonly cause?: unknown;
    };

export interface DeployInput {
  /** Path to the entry module, resolved against `cwd` — same contract as `prisma-composer deploy <entry>`. */
  readonly entry: string;
  /** Override the root node's name (the `--name` flag's slot). */
  readonly name?: string | undefined;
  /** Target stage. ABSENT = production — bare deploy targets production (main.ts effectiveStage). */
  readonly stage?: string | undefined;
  /** Defaults to process.cwd(); the directory `.prisma-composer/` and `.alchemy` state live under. */
  readonly cwd?: string | undefined;
  readonly deps?: OperationDeps | undefined;
}

export type DeployResult =
  | {
      readonly outcome: 'deployed';
      /** Parsed from the alchemy child's result file. Undefined when the child
       * did not write one (injected fake alchemy, or a report-less apply). */
      readonly summary: DeploymentSummary | undefined;
    }
  | { readonly outcome: 'failed'; readonly failure: OperationFailure };

/** Destroy must name its target explicitly — no silent default to production. Encoded, not re-derived from flags. */
export type DestroyTarget =
  | { readonly kind: 'production' }
  | { readonly kind: 'stage'; readonly stage: string };

export type DestroyEvent =
  /** Emitted before the pipeline when `<cwd>/.alchemy` is missing/empty. */
  { readonly kind: 'no-local-deploy-state'; readonly cwd: string };

export interface DestroyInput {
  readonly entry: string;
  readonly name?: string | undefined;
  readonly target: DestroyTarget;
  readonly cwd?: string | undefined;
  /** Mid-operation notifications, in real time. Rendering is the host's. */
  readonly onEvent?: ((event: DestroyEvent) => void) | undefined;
  readonly deps?: OperationDeps | undefined;
}

export type DestroyResult =
  | { readonly outcome: 'destroyed' }
  | { readonly outcome: 'failed'; readonly failure: OperationFailure };

// ---- dev ----

export interface DevEndpoint {
  readonly address: string;
  readonly url: string;
}

export type DevEvent =
  /** Initial front door + after each successful re-converge. */
  | { readonly kind: 'ready'; readonly endpoints: readonly DevEndpoint[] }
  | { readonly kind: 'unwatchable'; readonly address: string }
  | { readonly kind: 'rebuild-failed'; readonly message: string }
  /** The app keeps running, still watching. */
  | {
      readonly kind: 'converge-failed';
      readonly stackFilePath: string;
      readonly reproduceCommand: string;
      readonly cwd: string;
    }
  | { readonly kind: 'stopping' }
  | { readonly kind: 'stopped' };

export interface DevInput {
  readonly entry: string;
  readonly name?: string | undefined;
  readonly fresh?: boolean | undefined;
  readonly cwd?: string | undefined;
  readonly onEvent?: ((event: DevEvent) => void) | undefined;
  readonly deps?: OperationDeps | undefined;
}

/** A running dev session. The operation NEVER touches process signal handlers —
 * the host owns signals (and must evict alchemy's import-time SIGINT/SIGTERM
 * listeners before installing its own; see run-dev.ts). */
export interface DevSession {
  /** The initial front door, already merged across attachments. */
  readonly endpoints: readonly DevEndpoint[];
  /** Stop the watch loop and the app's services (emulators and data stay up).
   * Idempotent; emits 'stopping'/'stopped'; resolves `closed`. */
  stop(): Promise<void>;
  /** Settles when the session has fully stopped (via stop()). */
  readonly closed: Promise<void>;
}

export type DevStartResult =
  | { readonly outcome: 'started'; readonly session: DevSession }
  | { readonly outcome: 'failed'; readonly failure: OperationFailure };

// ---- log ----

export interface LogLine {
  readonly service: string;
  readonly line: string;
}

export type LogEvent =
  /** One attachment's stream died; the others continue. */
  { readonly kind: 'stream-failed'; readonly message: string };

export interface LogInput {
  readonly entry: string;
  readonly name?: string | undefined;
  /** Restrict to one service's dotted address; validated against running services. */
  readonly address?: string | undefined;
  /** Trailing history lines before live output. Defaults to 0 (live only) —
   * the attachment contract's default; the CLI's user-facing default of 20 stays in main.ts. */
  readonly tail?: number | undefined;
  readonly cwd?: string | undefined;
  /** Ends the stream when aborted. The host owns SIGINT/SIGTERM → abort. */
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: ((event: LogEvent) => void) | undefined;
  readonly deps?:
    | {
        readonly config?: PrismaAppConfig | undefined;
        readonly identity?: AppIdentity | undefined;
      }
    | undefined;
}

export type LogResult =
  | {
      readonly outcome: 'attached';
      /** For the adapter's empty-services notice. */
      readonly appName: string;
      /** Every running service. EMPTY means nothing is running — a valid, non-failure state;
       * `lines` is then an already-finished iterable. */
      readonly services: readonly DevEndpoint[];
      /** Merged, address-filtered stream; ends on signal abort or when every source ends. */
      readonly lines: AsyncIterable<LogLine>;
    }
  | { readonly outcome: 'failed'; readonly failure: OperationFailure };
