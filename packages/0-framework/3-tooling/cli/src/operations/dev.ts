/**
 * The programmatic `dev` operation (`@prisma/composer/control`): typed input,
 * events out through `onEvent`, lifetime owned by the returned DevSession —
 * no argv, no console, no process.exit, and NEVER any process signal
 * handling (the host owns signals; the CLI adapter dev/run-dev.ts shows the
 * pattern). The executor loads lazily, so importing this module executes
 * nothing; an executor that fails to load comes back as a structured
 * failure, never a throw out of the host.
 */
import type { CliStructuredError } from '@internal/foundation/errors';
import { notOk, type Result } from '@internal/foundation/result';
import type { ComposerConfigSource } from '../composer-config.ts';
import { executorLoadFailure, type OperationDeps, type ServiceEndpoint } from './shared.ts';
import type { StepEvent } from './steps.ts';

/** A step of a converge. Each converge is one `converge` step, `dev.converge` for the first and `dev.rebuild.<n>` for the n-th rebuild, and each resource Alchemy touches is an `apply-resource` step inside it. */
export type DevStep =
  | { readonly name: 'converge'; readonly id: string }
  | {
      readonly name: 'apply-resource';
      /** The id of the converge step it belongs to. */
      readonly converge: string;
      /** The resource's id in the stack. */
      readonly fqn: string;
      readonly resourceType: string;
      /** Alchemy's status word for what is happening to it, such as `creating` or `created`. */
      readonly status: string;
    };

export type DevEvent =
  /** A converge's steps and Alchemy's log lines. Every step a converge opens is finished when it ends, as `failed` when it failed or was interrupted. */
  | StepEvent<DevStep>
  /** Initial front door + after each successful re-converge. */
  | { readonly kind: 'ready'; readonly endpoints: readonly ServiceEndpoint[] }
  | { readonly kind: 'unwatchable'; readonly address: string }
  /** A target's preflight warned about the graph; the session still starts. */
  | { readonly kind: 'target-warning'; readonly message: string }
  | { readonly kind: 'rebuild-failed'; readonly message: string }
  /** The file watcher itself errored (EMFILE, a vanished directory); the session keeps running. */
  | { readonly kind: 'watch-error'; readonly message: string }
  /** `prisma.config.ts` changed. The session keeps the config it started with and stops rebuilding until it is restarted. */
  | { readonly kind: 'config-changed'; readonly file: string }
  /** What the `config` or `secrets` adapters return changed since the session started. The session keeps the values it started with and stops rebuilding until it is restarted. */
  | { readonly kind: 'values-changed' }
  /** An app definition file changed: one of the app files the entry module loaded when the session started. The session keeps the app it loaded and stops rebuilding until it is restarted. */
  | { readonly kind: 'definition-changed'; readonly files: readonly string[] }
  /** A rebuild's converge failed, or was refused because another converge holds this process. The app keeps running, still watching. */
  | {
      readonly kind: 'converge-failed';
      readonly code: 'DEV.CONVERGE_FAILED' | 'DEV.CONVERGE_RUNNING' | 'DEV.WORKER_THREAD';
      readonly message: string;
      readonly reasons: readonly { readonly tag: string; readonly message: string }[];
    }
  /** Once per service that runs its build adapter's dev server, before the first converge (ADR-0056). `cwd` is absolute. */
  | {
      readonly kind: 'dev-server';
      readonly address: string;
      readonly command: string;
      readonly cwd: string;
    }
  /** A reconverge changed a dev server's environment, so the emulator restarted it. */
  | { readonly kind: 'dev-server-restarted'; readonly address: string; readonly command: string }
  /** One line a dev server wrote, while the session runs. */
  | { readonly kind: 'dev-server-output'; readonly address: string; readonly line: string }
  | { readonly kind: 'stopping' }
  /** One service refused to stop during stop(); teardown continues and `stopped` still follows. */
  | { readonly kind: 'stop-error'; readonly message: string }
  | { readonly kind: 'stopped' };

export interface DevInput {
  /**
   * Composer's configuration: the `composer` section of `prisma.config.ts` and that file. The operation does not look for a config file; it refuses a section the CLI would refuse, before any work starts.
   */
  readonly config: ComposerConfigSource;
  /** The entry module, resolved against `cwd`. Overrides the `entry` in `config`; without either the operation fails with `CONFIG.ENTRY_MISSING`. */
  readonly entry?: string | undefined;
  readonly name?: string | undefined;
  /** The environment to run as: a complete local copy of the app with its own services, databases and buckets. Defaults to `dev`. */
  readonly environment?: string | undefined;
  /** Deletes the environment's local copy of the app, and its data, before starting. Other environments are untouched. */
  readonly fresh?: boolean | undefined;
  /**
   * Return once every service answers and leave the app running, with no
   * watch loop: the session is already closed and stopping it stops nothing.
   * `devStop` stops the app later.
   */
  readonly detach?: boolean | undefined;
  readonly cwd?: string | undefined;
  readonly onEvent?: ((event: DevEvent) => void) | undefined;
  /** Interrupts a running converge. The first converge then fails with `DEV.INTERRUPTED`; a rebuild's ends quietly. It does not stop the session: `stop()` does. One process runs one converge at a time, so a `deploy` in the same process while a converge runs is refused, and so is a dev converge while a deploy runs. */
  readonly signal?: AbortSignal | undefined;
}

/** A running dev session. The operation NEVER touches process signal handlers: the host owns signals. */
export interface DevSession {
  /** The initial front door, already merged across attachments. */
  readonly endpoints: readonly ServiceEndpoint[];
  /** Stop the watch loop and the app's services (emulators and data stay up).
   * A converge still running is interrupted and awaited first, so its state lease is released.
   * Idempotent; emits 'stopping'/'stopped'; resolves `closed`. A no-op for a detached session. */
  stop(): Promise<void>;
  /** Settles when the session has fully stopped (via stop()); already settled for a detached session. */
  readonly closed: Promise<void>;
}

export async function dev(input: DevInput): Promise<Result<DevSession, CliStructuredError>> {
  return devWithDeps(input, {});
}

/** In-package variant threading the injection seam, which the family's
 * commands and the unit tests use. Deliberately NOT re-exported through `./control` — the seam mirrors
 * internal types and is not part of the published surface. */
export async function devWithDeps(
  input: DevInput,
  deps: OperationDeps,
): Promise<Result<DevSession, CliStructuredError>> {
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-dev.ts');
  try {
    executor = await import('./execute-dev.ts');
  } catch (error) {
    return notOk(executorLoadFailure('dev', error));
  }
  return executor.executeDev(input, deps, cwd);
}
