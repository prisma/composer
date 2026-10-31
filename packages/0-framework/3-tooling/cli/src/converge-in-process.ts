/**
 * Runs a lowered stack's plan and apply in this process through Alchemy's
 * programmatic API (`alchemy/Alchemist`). Alchemy's typed events and log
 * lines come back as {@link ConvergeEvent}s, so the caller renders them in
 * its own output format; nothing here writes to stdout.
 *
 * Reached only behind an operation's lazy executor import: it loads alchemy
 * and effect.
 */
import type { lower } from '@internal/core/deploy';
import * as Alchemist from 'alchemy/Alchemist';
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
  readonly stack: LoweredStack;
  readonly stage: string;
  /** The directory Alchemy runs in: where it reads `.env` and keeps `.alchemy`. */
  readonly cwd: string;
  /** Set in `process.env` while Alchemy plans and applies, and restored after. Alchemy reads its configuration only from there. */
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: ((event: ConvergeEvent) => void) | undefined;
}

export type ConvergeOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'failed'; readonly cause: string };

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

/** The failure a converge ended with, as one line per error: the error's name when it has one, then its message. */
export function failureText(cause: Cause.Cause<unknown>): string {
  const lines = cause.reasons.flatMap((reason) => {
    if (Cause.isInterruptReason(reason)) return [];
    const error = Cause.isFailReason(reason) ? reason.error : reason.defect;
    if (error instanceof Error) {
      const tag = '_tag' in error && typeof error._tag === 'string' ? error._tag : error.name;
      return [
        tag === 'Error' || error.message.startsWith(tag)
          ? error.message
          : `${tag}: ${error.message}`,
      ];
    }
    return [typeof error === 'string' ? error : String(error)];
  });
  return lines.length > 0 ? [...new Set(lines)].join('\n') : Cause.pretty(cause);
}

/**
 * Sets the process state Alchemy reads for the length of `run`, and restores
 * it after: the variables in `env`, the working directory, and `console`'s
 * stdout methods, which go to stderr so a provider's `console.log` cannot
 * corrupt structured output.
 */
async function withProcessState<T>(
  env: Readonly<Record<string, string>>,
  cwd: string,
  run: () => Promise<T>,
): Promise<T> {
  const previousEnv = Object.keys(env).map((name) => [name, process.env[name]] as const);
  const previousCwd = process.cwd();
  const { log, info, debug } = console;
  Object.assign(process.env, env);
  if (previousCwd !== cwd) process.chdir(cwd);
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  try {
    return await run();
  } finally {
    Object.assign(console, { log, info, debug });
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
 * returns, including when `signal` interrupts it.
 */
export const convergeInProcess: Converge = (request) => {
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
      operation: 'deploy',
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
    Effect.provide(Alchemist.layer()),
  );

  return withProcessState(request.env, request.cwd, async () => {
    const exit = await Effect.runPromiseExit(
      program,
      request.signal === undefined ? undefined : { signal: request.signal },
    );
    if (Exit.isSuccess(exit)) return { kind: 'applied' };
    if (Cause.hasInterruptsOnly(exit.cause)) return { kind: 'interrupted' };
    return { kind: 'failed', cause: failureText(exit.cause) };
  });
};
