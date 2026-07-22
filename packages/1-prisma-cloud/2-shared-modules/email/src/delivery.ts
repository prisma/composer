/**
 * The `Delivery` interface `handlers.ts`'s `send` calls for modes `resend`
 * and `smtp`, plus the shared retry policy `delivery-resend.ts`/
 * `delivery-smtp.ts` wrap their provider call in (spec §"Delivery policy"):
 * up to 3 attempts (1 initial + 2 retries), 500ms then 2000ms between them,
 * a 10s per-attempt timeout, and `attempts` in the result — the number of
 * provider tries that invocation made.
 *
 * A backing supplies only `Attempt`: one provider call, classified as
 * retryable or not when it completes with a rejection. A thrown error
 * (network failure, timeout, connection error) is always retried by the
 * policy — the backing does not need to classify those; it only classifies
 * a completed-but-rejected provider response (an HTTP status, an SMTP
 * response code).
 */
import type { EmailRow } from './outbox-store.ts';

export type DeliveryResult =
  | { readonly ok: true; readonly providerMessageId: string | null; readonly attempts: number }
  | { readonly ok: false; readonly error: string; readonly attempts: number };

export interface Delivery {
  deliver(row: EmailRow): Promise<DeliveryResult>;
}

/** Mode `none` never calls `Delivery` (`handlers.ts`'s `send` returns before it) — this placeholder satisfies the required config slot in the entrypoint and the local test server without a real backing. */
export const noneDelivery: Delivery = {
  deliver: () => {
    throw new Error('unreachable: deliveryMode "none" never calls Delivery.deliver');
  },
};

export interface AttemptSuccess {
  readonly ok: true;
  readonly providerMessageId: string | null;
}

export interface AttemptFailure {
  readonly ok: false;
  readonly error: string;
  readonly retryable: boolean;
}

export type AttemptOutcome = AttemptSuccess | AttemptFailure;

/** One provider call. `signal` aborts at the per-attempt timeout; a backing that can pass it through to its client should (e.g. `fetch`'s `signal`). */
export type Attempt = (row: EmailRow, signal: AbortSignal) => Promise<AttemptOutcome>;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELAYS_MS = [500, 2000];
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RetryPolicyOptions {
  readonly maxAttempts?: number;
  /** Delay before each retry, indexed by (attempt number - 1); the last entry repeats if attempts exceed the list. */
  readonly delaysMs?: readonly number[];
  readonly timeoutMs?: number;
  /** Injectable for fake-timer tests; defaults to a real `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wraps a backing's `Attempt` in the shared retry/timeout policy. */
export function withRetryPolicy(attempt: Attempt, opts: RetryPolicyOptions = {}): Delivery {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delaysMs = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? realSleep;

  return {
    async deliver(row: EmailRow): Promise<DeliveryResult> {
      for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
        const isLastAttempt = attemptNumber === maxAttempts;
        let outcome: AttemptOutcome;
        try {
          outcome = await attempt(row, AbortSignal.timeout(timeoutMs));
        } catch (error) {
          // Thrown/network/timeout errors are always retryable (spec).
          if (isLastAttempt) {
            return { ok: false, error: errorMessage(error), attempts: attemptNumber };
          }
          await sleep(delaysMs[attemptNumber - 1] ?? delaysMs.at(-1) ?? 0);
          continue;
        }

        if (outcome.ok) {
          return {
            ok: true,
            providerMessageId: outcome.providerMessageId,
            attempts: attemptNumber,
          };
        }
        if (!outcome.retryable || isLastAttempt) {
          return { ok: false, error: outcome.error, attempts: attemptNumber };
        }
        await sleep(delaysMs[attemptNumber - 1] ?? delaysMs.at(-1) ?? 0);
      }
      // Unreachable: maxAttempts >= 1, and every loop iteration returns on its last attempt.
      throw new Error('withRetryPolicy: exhausted attempts without returning a result');
    },
  };
}

/**
 * Races a promise against a signal's abort — for backings whose client
 * (e.g. nodemailer) doesn't accept an `AbortSignal` directly.
 */
export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
