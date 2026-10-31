/**
 * Runs a lowered stack's plan and apply in this process through Alchemy's
 * programmatic API (`alchemy/Alchemist`). Alchemy's typed events and log
 * lines come back as {@link ConvergeEvent}s, and Alchemy's own output goes to
 * stderr, so the caller renders progress in its own format.
 *
 * Published as `@prisma/composer/internal/converge`: the CLI loads it from
 * the app's install, so it runs on the app's copy of alchemy and effect.
 */
import { isMainThread } from 'node:worker_threads';
import type { lower } from '@internal/core/deploy';
import * as Alchemist from 'alchemy/Alchemist';
import * as Interaction from 'alchemy/Interaction';
import { recordOf } from 'alchemy/Util/LogRecord';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Logger from 'effect/Logger';

/** What `lower()` returns: the stack value `Alchemist.plan` takes. */
export type LoweredStack = ReturnType<typeof lower>;

/** Where a resource is in its apply. `pending` is planned but not yet touched. */
export type ResourcePhase = 'pending' | 'running' | 'done' | 'failed';

export type ConvergeEvent =
  | {
      readonly kind: 'resource';
      readonly fqn: string;
      readonly resourceType: string;
      /** Alchemy's own status word, such as `creating` or `updated`. */
      readonly status: string;
      readonly phase: ResourcePhase;
      readonly message?: string | undefined;
    }
  | {
      readonly kind: 'log';
      readonly severity: 'info' | 'warn' | 'verbose';
      readonly text: string;
    };

export interface ConvergeRequest {
  /** What to plan and apply. Only `deploy` today; `prisma dev` adds its own. */
  readonly operation: 'deploy';
  readonly stack: LoweredStack;
  readonly stage: string;
  /** The directory Alchemy runs in: where it reads `.env` and keeps `.alchemy`. */
  readonly cwd: string;
  /** Set in `process.env` while Alchemy plans and applies, and restored after; `undefined` removes the variable for that time. Alchemy reads its configuration only from there. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: ((event: ConvergeEvent) => void) | undefined;
}

/** One error a failed converge ended with: the error's tag or class name, and its message. */
export interface ConvergeFailureReason {
  readonly tag: string;
  readonly message: string;
}

export type ConvergeOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'failed'; readonly reasons: readonly ConvergeFailureReason[] }
  /** Nothing ran: another converge holds this process's environment and working directory, or this is a worker thread that cannot change directory. */
  | { readonly kind: 'refused'; readonly reason: 'already-running' | 'worker-thread' };

/** Plans and applies a lowered stack. The deploy executor's default is {@link convergeInProcess}. */
export type Converge = (request: ConvergeRequest) => Promise<ConvergeOutcome>;

const FINISHED: ReadonlySet<string> = new Set([
  'created',
  'updated',
  'adopted',
  'deleted',
  'orphaned',
  'replaced',
  'ran',
  'skipped',
]);

function phaseOf(status: string): ResourcePhase {
  if (status === 'pending') return 'pending';
  if (status === 'fail') return 'failed';
  return FINISHED.has(status) ? 'done' : 'running';
}

/** Alchemy's typed event as a converge event; undefined for the events Composer does not show. */
export function toConvergeEvent(event: Alchemist.Event): ConvergeEvent | undefined {
  switch (event.type) {
    case 'apply.resource.status':
      return {
        kind: 'resource',
        fqn: event.fqn,
        resourceType: event.resourceType,
        status: event.status,
        phase: phaseOf(event.status),
        ...(event.message === undefined ? {} : { message: event.message }),
      };
    case 'apply.resource.note':
      return {
        kind: 'log',
        severity: event.kind === undefined ? 'info' : 'verbose',
        text: `${event.fqn}: ${event.message}`,
      };
    default:
      return undefined;
  }
}

const SEVERITY_OF: Readonly<Record<string, 'info' | 'warn' | undefined>> = {
  info: 'info',
  warn: 'warn',
  error: 'warn',
  fatal: 'warn',
};

/** Alchemy's log lines at info and above, as Alchemy's console sink would print them. Typed events are left to `Alchemist.onEvent`. */
function logEvents(emit: (event: ConvergeEvent) => void) {
  return Logger.make<unknown, void>((options) => {
    const record = recordOf(options);
    const severity = SEVERITY_OF[record.level];
    if (severity === undefined) return;
    if (record.kind === 'log') {
      const fqn = record.attributes['fqn'];
      const prefix = typeof fqn === 'string' ? `${fqn}: ` : '';
      emit({ kind: 'log', severity, text: `${prefix}${record.data.message}` });
      if (record.data.cause !== null) emit({ kind: 'log', severity, text: record.data.cause });
    } else if (record.kind === 'output') {
      emit({ kind: 'log', severity: 'verbose', text: record.data.text });
    }
  });
}

/** The errors a converge failed with, one per distinct error, interruptions left out. */
export function failureReasons(cause: Cause.Cause<unknown>): readonly ConvergeFailureReason[] {
  const reasons = cause.reasons.flatMap((reason): ConvergeFailureReason[] => {
    if (Cause.isInterruptReason(reason)) return [];
    const error = Cause.isFailReason(reason) ? reason.error : reason.defect;
    if (error instanceof Error) {
      const tag = '_tag' in error && typeof error._tag === 'string' ? error._tag : error.name;
      return [{ tag, message: error.message }];
    }
    return [{ tag: 'Unknown', message: typeof error === 'string' ? error : String(error) }];
  });
  const unique = new Map(reasons.map((reason) => [`${reason.tag}\0${reason.message}`, reason]));
  return unique.size > 0
    ? [...unique.values()]
    : [{ tag: 'Unknown', message: Cause.pretty(cause) }];
}

let running = false;

/**
 * Sets the process state Alchemy reads for the length of `run`, and restores
 * it on every exit path: the variables in `env` and the working directory.
 */
async function withProcessState<T>(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  run: () => Promise<T>,
): Promise<T> {
  const previousEnv = Object.keys(env).map((name) => [name, process.env[name]] as const);
  const previousCwd = process.cwd();
  try {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (previousCwd !== cwd) process.chdir(cwd);
    return await run();
  } finally {
    if (process.cwd() !== previousCwd) process.chdir(previousCwd);
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * Plans and applies `stack` in this process, as `alchemy deploy --yes` would.
 * The plan's scope, and the state-store lease it holds, closes before this
 * returns, including when `signal` interrupts it. One converge runs at a time
 * per process: a second call while one runs is refused.
 */
export const convergeInProcess: Converge = async (request) => {
  if (running) return { kind: 'refused', reason: 'already-running' };
  if (!isMainThread && process.cwd() !== request.cwd) {
    return { kind: 'refused', reason: 'worker-thread' };
  }
  running = true;
  const emit = (event: ConvergeEvent): void => {
    try {
      request.onEvent?.(event);
    } catch {
      // Rendering is the caller's; its failures are not the deploy's.
    }
  };
  const program = Effect.gen(function* () {
    const plan = yield* Alchemist.plan({
      stack: request.stack,
      operation: request.operation,
      stage: request.stage,
      updateStateStore: true,
    });
    yield* Alchemist.apply(plan);
  }).pipe(
    Alchemist.onEvent((event) =>
      Effect.sync(() => {
        const converted = toConvergeEvent(event);
        if (converted !== undefined) emit(converted);
      }),
    ),
    Effect.scoped,
    Effect.provide(Logger.layer([logEvents(emit)])),
    Effect.provide(Interaction.layerNonInteractive({ stdout: process.stderr })),
    Effect.provide(Alchemist.layer()),
  );

  try {
    return await withProcessState(request.env, request.cwd, async () => {
      const exit = await Effect.runPromiseExit(
        program,
        request.signal === undefined ? undefined : { signal: request.signal },
      );
      if (Exit.isSuccess(exit)) return { kind: 'applied' } as const;
      if (Cause.hasInterruptsOnly(exit.cause)) return { kind: 'interrupted' } as const;
      return { kind: 'failed', reasons: failureReasons(exit.cause) } as const;
    });
  } catch (error) {
    return {
      kind: 'failed',
      reasons: [
        {
          tag: error instanceof Error ? error.name : 'Unknown',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  } finally {
    running = false;
  }
};
