import { afterAll, describe, expect, test } from 'bun:test';
import { assertDefined } from '@prisma/compose/assertions';
import * as Effect from 'effect/Effect';
import postgres from 'postgres';
import { acquireStateLock } from '../lock.ts';
import { startTestPostgres, type TestPostgres } from './harness.ts';

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[alchemy/state] skipping lock tests: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL to point at one, or install initdb/pg_ctl ' +
      '(e.g. `brew install postgresql@15`) on PATH.',
  );
}

describe.skipIf(pg === undefined)('acquireStateLock', () => {
  if (pg === undefined) return;

  afterAll(() => pg.stop());

  const client = () => postgres(pg.url, { max: 5, onnotice: () => {} });

  test('acquire, contend, release, re-acquire — two real sessions against the same (stack, stage)', async () => {
    const stack = 'lock-stack';
    const stage = 'acquire-contend-release';
    const sqlA = client();
    const sqlB = client();

    const lockA = await Effect.runPromise(acquireStateLock(sqlA, stack, stage));

    await expect(Effect.runPromise(acquireStateLock(sqlB, stack, stage))).rejects.toThrow(
      /another deploy holds the state lock for lock-stack\/acquire-contend-release/,
    );

    await lockA.release();

    const lockB = await Effect.runPromise(acquireStateLock(sqlB, stack, stage));
    await lockB.release();

    await sqlA.end({ timeout: 1 });
    await sqlB.end({ timeout: 1 });
  });

  test('crash-release: a dropped connection (no explicit release) frees the lock for another session', async () => {
    const stack = 'lock-stack';
    const stage = 'crash-release';
    const sqlA = client();
    const sqlB = client();

    await Effect.runPromise(acquireStateLock(sqlA, stack, stage));
    // Simulate the deployer process dying: the connection drops without
    // `lock.release()` ever running. Postgres auto-releases the
    // session-scoped advisory lock when the session ends.
    await sqlA.end({ timeout: 0 });

    const lockB = await Effect.runPromise(acquireStateLock(sqlB, stack, stage));
    await lockB.release();

    await sqlB.end({ timeout: 1 });
  });

  test('lease-loss: once the reserved connection dies mid-run, checkLive fails loudly', async () => {
    const stack = 'lock-stack';
    const stage = 'lease-loss';
    const sqlA = client();

    const lockA = await Effect.runPromise(acquireStateLock(sqlA, stack, stage));

    // Sanity: the lease is live immediately after acquiring it.
    await Effect.runPromise(lockA.checkLive);

    // Kill the reserved connection without calling release() — the lease
    // is now lost, and every subsequent state operation must refuse to
    // run unlocked.
    await sqlA.end({ timeout: 0 });

    await expect(Effect.runPromise(lockA.checkLive)).rejects.toThrow();
  });

  // FT-5219's real failure mode is a server-side kill of the reserved lock
  // connection (e.g. an idle-connection reaper), not a client-side
  // `sql.end()` (the previous test) — `.end()` marks the connection
  // `terminated` client-side, which makes postgres.js reject the next query
  // cleanly. A server-side `pg_terminate_backend` does not set that flag,
  // so this exercises the scenario the design actually depends on: does
  // `checkLive` still fail, or does postgres.js silently hand it a
  // reconnected session that no longer holds the lock?
  test('FT-5219: a server-killed reserved connection (not a client-side .end()) is still caught by checkLive', async () => {
    const stack = 'lock-stack';
    const stage = 'server-kill';
    const sqlA = client();
    const admin = client();

    const lockA = await Effect.runPromise(acquireStateLock(sqlA, stack, stage));
    await Effect.runPromise(lockA.checkLive);

    // Find the reserved connection's backend pid the way an operator would
    // — by joining the advisory lock it holds (identified by the same key
    // `acquireStateLock` computes) to `pg_stat_activity`, not by reaching
    // into `acquireStateLock`'s internals.
    const key = `prisma-compose:${stack}/${stage}`;
    const lockRows = await admin<{ pid: number }[]>`
      select l.pid
      from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory'
        and l.granted
        and ((l.classid::bigint << 32) | (l.objid::bigint & 4294967295))
          = hashtextextended(${key}, 0)
    `;
    expect(lockRows.length).toBe(1);
    const lockPid = lockRows[0]?.pid;
    assertDefined(lockPid, 'expected to find the reserved connection holding the advisory lock');

    await admin`select pg_terminate_backend(${lockPid})`;

    // Poll briefly: pg_terminate_backend signals the backend but does not
    // block until it has fully exited.
    let stillHeld = true;
    for (let attempt = 0; attempt < 50 && stillHeld; attempt++) {
      const rows = await admin<{ live: boolean }[]>`
        select exists (
          select 1 from pg_locks where locktype = 'advisory' and pid = ${lockPid}
        ) as live
      `;
      stillHeld = rows[0]?.live ?? false;
      if (stillHeld) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(stillHeld).toBe(false);

    // The real assertion: checkLive must fail rather than silently succeed
    // against a transparently-reconnected session that no longer holds the
    // lock.
    await expect(Effect.runPromise(lockA.checkLive)).rejects.toThrow();

    // And the lock is genuinely free — a second session can now acquire it.
    const sqlB = client();
    const lockB = await Effect.runPromise(acquireStateLock(sqlB, stack, stage));
    await lockB.release();
    await sqlB.end({ timeout: 1 });

    await sqlA.end({ timeout: 1 });
    await admin.end({ timeout: 1 });
  });
});
