import { StateStoreError } from 'alchemy/State';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import type postgres from 'postgres';
import { toStateStoreError } from './errors.ts';

/** Another deploy already holds the lock for this stack/stage. Never queued — fails immediately. */
export class StateLockContentionError extends Data.TaggedError('StateLockContentionError')<{
  readonly stack: string;
  readonly stage: string;
}> {
  override get message(): string {
    return `another deploy holds the state lock for ${this.stack}/${this.stage}`;
  }
}

export interface StateLock {
  /**
   * Re-verifies the lease is still held. Every state operation runs this
   * first: if the lease is gone (e.g. an idle-closed direct connection —
   * FT-5219 class), this fails loudly instead of letting the operation run
   * unlocked.
   */
  readonly checkLive: Effect.Effect<void, StateStoreError, never>;
  /** Unlocks and releases the reserved connection. Safe to call once the run ends. */
  readonly release: () => Promise<void>;
}

// Built here (not `select ... where 'prisma-compose:' || stack || '/' || stage`)
// so the lock id is computed once, in one place, from the same string every
// caller (JS or a human reading logs) would produce.
const lockKey = (stack: string, stage: string): string => `prisma-compose:${stack}/${stage}`;

/**
 * Acquires a session-scoped Postgres advisory lock on a reserved
 * connection pulled from `sql`'s pool — session (not transaction) scope,
 * because a transaction-scoped lock releases at the first commit and a
 * deploy spans many. Held for the run's whole lifetime; contention fails
 * immediately rather than queuing. If the process crashes, the reserved
 * connection drops and Postgres auto-releases the session lock — no
 * explicit crash-recovery bookkeeping needed.
 */
export const acquireStateLock = (
  sql: postgres.Sql,
  stack: string,
  stage: string,
): Effect.Effect<StateLock, StateLockContentionError | StateStoreError> =>
  Effect.gen(function* () {
    const key = lockKey(stack, stage);
    const reserved = yield* Effect.tryPromise({
      try: () => sql.reserve(),
      catch: toStateStoreError,
    });

    const acquired = yield* Effect.tryPromise({
      try: async () => {
        const rows = await reserved<{ acquired: boolean; pid: number }[]>`
          select
            pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired,
            pg_backend_pid() as pid
        `;
        return rows[0];
      },
      catch: toStateStoreError,
    });

    if (acquired?.acquired !== true) {
      reserved.release();
      return yield* Effect.fail(new StateLockContentionError({ stack, stage }));
    }

    const lockPid = acquired.pid;

    // Deliberately does NOT run a query against the reserved connection
    // itself. Once its backend session has been killed server-side (an
    // idle-connection reaper, FT-5219 class), postgres.js does not
    // transparently reconnect a reserved connection, but issuing a further
    // query against it doesn't cleanly reject either — it throws deep
    // inside postgres.js's deferred write path, outside the query's promise
    // chain, which can crash the whole process instead of failing this
    // check. Asking a *different* pool connection whether the backend pid
    // captured at acquire time still holds this advisory lock in
    // `pg_locks` gets the same answer (a dead or reused backend can't hold
    // the lock) without ever touching the connection that might be dead.
    const checkLive: Effect.Effect<void, StateStoreError, never> = Effect.tryPromise({
      try: async () => {
        const rows = await sql<{ live: boolean }[]>`
          select exists (
            select 1 from pg_locks
            where locktype = 'advisory'
              and pid = ${lockPid}
              and objsubid = 1
              and granted
              and ((classid::bigint << 32) | (objid::bigint & 4294967295))
                = hashtextextended(${key}, 0)
          ) as live
        `;
        return rows[0]?.live ?? false;
      },
      catch: toStateStoreError,
    }).pipe(
      Effect.flatMap((live) =>
        live
          ? Effect.void
          : Effect.fail(
              new StateStoreError({
                message: `the state lock for ${stack}/${stage} was lost mid-run; refusing to continue unlocked`,
              }),
            ),
      ),
    );

    const release = async (): Promise<void> => {
      try {
        await reserved`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
      } catch {
        // The connection already dropped — Postgres auto-releases a
        // session-scoped advisory lock when the session ends, so there is
        // nothing left to unlock.
      } finally {
        reserved.release();
      }
    };

    return { checkLive, release };
  });
