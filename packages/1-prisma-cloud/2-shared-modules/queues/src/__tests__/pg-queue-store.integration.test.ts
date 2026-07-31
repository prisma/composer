import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPgQueueStore } from '../execution/pg-queue-store.ts';
import type { QueueStore } from '../queue-store.ts';
import { createTestDatabase, startTestPostgres, type TestDatabase } from './pg-harness.ts';

const pg = startTestPostgres();
const suite = pg ? describe : describe.skip;

suite('persistent queue', () => {
  let database: TestDatabase;
  let store: QueueStore;

  beforeAll(async () => {
    if (pg === undefined) throw new Error('no Postgres available');
    database = await createTestDatabase(pg.url);
    store = await createPgQueueStore(database.url, [
      { name: 'messages', maxAttempts: 5, retryDelayMs: 1_000 },
      { name: 'delayed', maxAttempts: 5, retryDelayMs: 1_000 },
      { name: 'single-attempt', maxAttempts: 1, retryDelayMs: 1_000 },
    ]);
  });

  afterAll(async () => {
    await database?.drop();
    pg?.stop();
  });

  test('enqueue is idempotent and a completed message is not claimed again', async () => {
    const enqueueKey = crypto.randomUUID();
    const first = await store.enqueue({
      queue: 'messages',
      body: { text: 'hello' },
      enqueueKey,
    });
    const duplicate = await store.enqueue({
      queue: 'messages',
      body: { text: 'ignored duplicate' },
      enqueueKey,
    });
    expect(duplicate.id).toBe(first.id);

    const leased = await store.claim(30);
    expect(leased?.message).toEqual({
      id: first.id,
      queue: 'messages',
      body: { text: 'hello' },
      attempt: 1,
      enqueuedAt: expect.any(String),
    });
    if (leased === null) throw new Error('expected a leased message');
    expect(await store.complete(leased.message.id, leased.leaseToken)).toBe(true);
    expect(await store.claim(30)).toBeNull();
  });

  test('concurrent claims lease a message to only one dispatcher', async () => {
    const enqueued = await store.enqueue({
      queue: 'messages',
      body: { text: 'one owner' },
      enqueueKey: crypto.randomUUID(),
    });
    const claims = await Promise.all([store.claim(30), store.claim(30)]);
    const leased = claims.filter((claim) => claim !== null);
    expect(leased).toHaveLength(1);
    expect(leased[0]?.message.id).toBe(enqueued.id);
    const winner = leased[0];
    if (winner === undefined) throw new Error('expected one winning claim');
    expect(await store.complete(winner.message.id, winner.leaseToken)).toBe(true);
  });

  test('persists the retry delay before making a failed delivery available', async () => {
    await store.enqueue({
      queue: 'delayed',
      body: { text: 'wait before retrying' },
      enqueueKey: crypto.randomUUID(),
    });
    const first = await store.claim(30);
    if (first === null) throw new Error('expected the message to lease');

    expect(await store.release(first.message.id, first.leaseToken)).toBe('retrying');
    expect(await store.claim(30)).toBeNull();

    await Bun.sleep(1_100);
    const retried = await store.claim(30);
    expect(retried?.message.id).toBe(first.message.id);
    expect(retried?.message.attempt).toBe(2);
    if (retried === null) throw new Error('expected the delayed retry');
    expect(await store.complete(retried.message.id, retried.leaseToken)).toBe(true);
  });

  test('marks a message failed after its configured maximum attempts', async () => {
    await store.enqueue({
      queue: 'single-attempt',
      body: { text: 'stop retrying' },
      enqueueKey: crypto.randomUUID(),
    });
    const leased = await store.claim(30);
    if (leased === null) throw new Error('expected the message to lease');

    expect(await store.release(leased.message.id, leased.leaseToken)).toBe('failed');
    expect(await store.claim(30)).toBeNull();
  });
});
