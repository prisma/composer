/**
 * Retrying state-store queries past a Prisma Postgres cold-start (FT-5226).
 *
 * A freshly provisioned or idle-resumed PPg database refuses connections while
 * its upstream warms up: the edge proxy answers "Failed to connect to upstream
 * database" until the real Postgres is reachable. The bootstrap migration
 * already rides this out (see `layer.ts`), but the per-op state queries that
 * run afterwards (plan/apply/destroy) did not — so a state DB that had gone
 * idle between bootstrap and those queries failed the deploy outright.
 *
 * The retry is deliberately scoped to connection *establishment* failures —
 * a warming upstream. Mid-session drops (a terminated/reset connection) are
 * NOT retried: for the state store those are the lost-lease signal that
 * `lock.ts`'s `checkLive` must surface loudly, not paper over. This makes the
 * set narrower than @internal/prisma-cloud's `pg-connection.ts` (which also
 * retries mid-session drops for the runtime store client); that helper can't
 * be imported here regardless — @internal/prisma-cloud depends on
 * @internal/lowering, so importing it back would cycle.
 */
import type { StateStoreError } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

/** Codes for "can't reach the host yet" — DNS/refusal, not a mid-session drop. */
const ESTABLISHMENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Connection-establishment failure messages (no useful `err.code`). `upstream database` is PPg's edge proxy while a cold/idle upstream warms up. */
const ESTABLISHMENT_MESSAGE_FRAGMENTS = ['upstream database', 'connection refused'];

/**
 * Whether a failure is a connection-establishment error against a warming
 * upstream (retry), as opposed to a lost lease, a mid-session drop, or a real
 * query error (all of which must surface at once). Unwraps a
 * {@link StateStoreError} to its driver `cause` so a code-only error still
 * classifies.
 */
export const isColdStartConnectError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (code !== undefined && ESTABLISHMENT_CODES.has(code)) return true;
  const message =
    'message' in error && typeof error.message === 'string' ? error.message.toLowerCase() : '';
  if (ESTABLISHMENT_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))) return true;
  const cause = 'cause' in error ? error.cause : undefined;
  return cause !== undefined && cause !== error && isColdStartConnectError(cause);
};

/** The same ~2-minute budget the bootstrap migration uses (`layer.ts`): retry every 5s, up to 2 minutes. */
const COLD_START_SCHEDULE = Schedule.both(
  Schedule.spaced('5 seconds'),
  Schedule.during('2 minutes'),
);

/**
 * Retries a state operation past a cold-start connection rejection only; every
 * other failure surfaces immediately. `schedule` is injectable so tests drive
 * it without real delay.
 */
export const retryColdStart = <A>(
  operation: Effect.Effect<A, StateStoreError, never>,
  schedule: Schedule.Schedule<unknown, unknown> = COLD_START_SCHEDULE,
): Effect.Effect<A, StateStoreError, never> =>
  Effect.retry(operation, { while: isColdStartConnectError, schedule });
