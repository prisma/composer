/**
 * The `PgWarm` resource (slice 3, FT-5226), proven WITHOUT Prisma Cloud: its
 * provider `reconcile` connects and runs `select 1`, then echoes the url — so a
 * downstream resource that depends on `warm.url` runs only after the DB answers.
 * Driven directly against the exported provider service (no Effect layer built).
 * The cold-start retry itself is unit-proven in pg-connection.test.ts; the live
 * warm-then-connect is proven by the two E2E deploys.
 *
 * Self-isolating: owns a uniquely-named database (never the shared `public`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import { pgWarmProviderService } from '../pg-warm-resource.ts';
import {
  createTestDatabase,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from './postgres-harness.ts';

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[app-cloud] skipping PgWarm reconcile test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

describe.skipIf(pg === undefined)('PgWarm reconcile warms a real database', () => {
  if (pg === undefined) return;
  let testDb: TestDatabase;

  const reconcile = (url: string) =>
    pgWarmProviderService.reconcile({
      id: 'db',
      instanceId: 'db',
      news: { url },
      olds: undefined,
      output: undefined,
      session: undefined as never,
      bindings: undefined as never,
    });

  beforeAll(async () => {
    testDb = await createTestDatabase(pg.url);
  });
  afterAll(async () => {
    await testDb?.drop().catch(() => {});
    pg.stop();
  });

  test('connects, runs select 1, and echoes the url', async () => {
    const result = await Effect.runPromise(reconcile(testDb.url));
    expect(result.url).toBe(testDb.url);
  });

  test('is idempotent — a second reconcile on the same warm DB also succeeds', async () => {
    const result = await Effect.runPromise(reconcile(testDb.url));
    expect(result.url).toBe(testDb.url);
  });
});
