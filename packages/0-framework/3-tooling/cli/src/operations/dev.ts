/**
 * The programmatic `dev` operation (`@prisma/composer/control`): typed input,
 * events out through `onEvent`, lifetime owned by the returned DevSession —
 * no argv, no console, no process.exit, and NEVER any process signal
 * handling (the host owns signals; the CLI adapter dev/run-dev.ts shows the
 * pattern). The executor loads lazily, so importing this module executes
 * nothing; an executor that fails to load comes back as a structured
 * `pipeline` failure, never a throw out of the host.
 */
import {
  executorLoadFailure,
  type OperationDeps,
  type OperationFailure,
  type ServiceEndpoint,
} from './shared.ts';

export type DevEvent =
  /** Initial front door + after each successful re-converge. */
  | { readonly kind: 'ready'; readonly endpoints: readonly ServiceEndpoint[] }
  | { readonly kind: 'unwatchable'; readonly address: string }
  | { readonly kind: 'rebuild-failed'; readonly message: string }
  /** The file watcher itself errored (EMFILE, a vanished directory); the session keeps running. */
  | { readonly kind: 'watch-error'; readonly message: string }
  /** The app keeps running, still watching. */
  | {
      readonly kind: 'converge-failed';
      readonly stackFilePath: string;
      readonly reproduceCommand: string;
      readonly cwd: string;
    }
  | { readonly kind: 'stopping' }
  /** One service refused to stop during stop(); teardown continues and `stopped` still follows. */
  | { readonly kind: 'stop-error'; readonly message: string }
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
  readonly endpoints: readonly ServiceEndpoint[];
  /** Stop the watch loop and the app's services (emulators and data stay up).
   * Idempotent; emits 'stopping'/'stopped'; resolves `closed`. */
  stop(): Promise<void>;
  /** Settles when the session has fully stopped (via stop()). */
  readonly closed: Promise<void>;
}

export type DevStartResult =
  | { readonly outcome: 'started'; readonly session: DevSession }
  | { readonly outcome: 'failed'; readonly failure: OperationFailure };

export async function dev(input: DevInput): Promise<DevStartResult> {
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-dev.ts');
  try {
    executor = await import('./execute-dev.ts');
  } catch (error) {
    return { outcome: 'failed', failure: executorLoadFailure(error, cwd) };
  }
  return executor.executeDev(input, cwd);
}
