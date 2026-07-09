import { afterAll, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import postgres from 'postgres';
import { acquireStateLock } from '../lock.ts';
import { startTestPostgres, type TestPostgres } from './harness.ts';

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[prisma-alchemy/state] skipping lock tests: no Postgres available. ' +
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
});
