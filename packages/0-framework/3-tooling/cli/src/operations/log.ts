/**
 * The programmatic `log` operation (`@prisma/composer/control`): typed input,
 * the merged stream back as an AsyncIterable ended by the caller's
 * AbortSignal — no argv, no console, no process.exit. The executor loads
 * lazily, so importing this module executes nothing; an executor that fails
 * to load comes back as a structured `pipeline` failure, never a throw out
 * of the host.
 */
import type { PrismaAppConfig } from '@internal/core/config';
import type { AppIdentity } from '../pipeline.ts';
import type { DevEndpoint } from './dev.ts';
import { executorLoadFailure, type OperationFailure } from './shared.ts';

export interface LogLine {
  readonly service: string;
  readonly line: string;
}

export type LogEvent =
  /** One attachment's stream died; the others continue. */
  { readonly kind: 'stream-failed'; readonly message: string };

/**
 * @internal Test seam — lets the CLI's own tests drive `log` without a real
 * config evaluation or entry module. No stability guarantee.
 */
export interface LogDeps {
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
  readonly deps?: LogDeps | undefined;
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

export async function log(input: LogInput): Promise<LogResult> {
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-log.ts');
  try {
    executor = await import('./execute-log.ts');
  } catch (error) {
    return { outcome: 'failed', failure: executorLoadFailure(error, cwd) };
  }
  return executor.executeLog(input, cwd);
}
