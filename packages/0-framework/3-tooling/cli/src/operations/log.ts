/**
 * The programmatic `log` operation (`@prisma/composer/control`): typed input,
 * the merged stream back as an AsyncIterable ended by the caller's
 * AbortSignal — no argv, no console, no process.exit. The executor loads
 * lazily, so importing this module executes nothing; an executor that fails
 * to load comes back as a structured failure, never a throw out of the
 * host.
 */
import type { PrismaAppConfig } from '@internal/core/config';
import type { CliStructuredError } from '@internal/foundation/errors';
import { notOk, type Result } from '@internal/foundation/result';
import type { AppIdentity } from '../pipeline.ts';
import { executorLoadFailure, type ServiceEndpoint } from './shared.ts';

export interface LogLine {
  readonly service: string;
  readonly line: string;
}

export type LogEvent =
  /** One attachment's stream died; the others continue. */
  | { readonly kind: 'stream-failed'; readonly message: string }
  /** The consumer fell behind and the bounded merge queue overflowed:
   * `count` oldest lines were dropped since the last delivered line. */
  | { readonly kind: 'lines-dropped'; readonly count: number };

/** The log operation's in-package injection seam (the CLI's LogRunDeps, unit
 * tests) — threaded through logWithDeps, never part of the published surface. */
export interface LogDeps {
  /** Substituted for the c12 evaluation of the discovered config file (discovery still runs). */
  readonly config?: PrismaAppConfig | undefined;
  /** Overrides the identity resolution (config + name) — lets tests skip a real entry module. */
  readonly identity?: AppIdentity | undefined;
}

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
}

export interface LogAttached {
  /** For the adapter's empty-services notice. */
  readonly appName: string;
  /** Every running service. EMPTY means nothing is running — a valid, non-failure state;
   * `lines` is then an already-finished iterable. */
  readonly services: readonly ServiceEndpoint[];
  /** Merged, address-filtered stream; ends on signal abort or when every source ends. */
  readonly lines: AsyncIterable<LogLine>;
}

export async function log(input: LogInput): Promise<Result<LogAttached, CliStructuredError>> {
  return logWithDeps(input, {});
}

/** In-package variant threading the injection seam (the CLI's LogRunDeps,
 * unit tests). Deliberately NOT re-exported through `./control` — the seam
 * mirrors internal types and is not part of the published surface. */
export async function logWithDeps(
  input: LogInput,
  deps: LogDeps,
): Promise<Result<LogAttached, CliStructuredError>> {
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-log.ts');
  try {
    executor = await import('./execute-log.ts');
  } catch (error) {
    return notOk(executorLoadFailure('log', error, cwd));
  }
  return executor.executeLog(input, deps, cwd);
}
