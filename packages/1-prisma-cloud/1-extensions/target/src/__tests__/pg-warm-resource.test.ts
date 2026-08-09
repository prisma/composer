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
import net from 'node:net';
import * as Effect from 'effect/Effect';
import { pgWarmProviderService, warmDatabase } from '../pg-warm-resource.ts';
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
      fqn: 'db',
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

/**
 * FT-5226's second shape: the cold upstream ACCEPTS the connection and then
 * drops the socket. pg reports that by emitting 'error' on the client rather
 * than only rejecting the query, and an 'error' event with no listener is an
 * uncaught exception — raised outside the promise, so `withConnectionRetry`
 * cannot catch it and it would take the deploy process down.
 *
 * Needs no real Postgres: the stub speaks just enough of the startup protocol
 * to make pg's `connect()` resolve, which is what puts the client past
 * `_connecting` and into the path that emits on the client.
 */
describe('a cold upstream that drops the socket after connecting', () => {
  let server: net.Server;
  let url: string;

  beforeAll(async () => {
    server = net.createServer((socket) => {
      socket.on('error', () => {});
      let startupAnswered = false;
      socket.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        // SSLRequest → refuse, so the startup continues in plaintext.
        if (buf.length >= 8 && buf.readInt32BE(4) === 80877103) {
          socket.write(Buffer.from('N'));
          return;
        }
        // Never answer `select 1` — answering it would complete the query and
        // the warm would succeed before the drop lands.
        if (startupAnswered) return;
        startupAnswered = true;
        const authOk = Buffer.alloc(9);
        authOk.write('R', 0, 'ascii');
        authOk.writeInt32BE(8, 1);
        authOk.writeInt32BE(0, 5);
        const readyForQuery = Buffer.alloc(6);
        readyForQuery.write('Z', 0, 'ascii');
        readyForQuery.writeInt32BE(5, 1);
        readyForQuery.write('I', 5, 'ascii');
        socket.write(Buffer.concat([authOk, readyForQuery]));
        setTimeout(() => socket.destroy(), 20);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    url = `postgres://warm:warm@127.0.0.1:${port}/warm?sslmode=disable`;
  });
  afterAll(() => server.close());

  test('surfaces as a rejection instead of killing the process', async () => {
    // attempts: 1 — the retry itself is proven in pg-connection.test.ts; what
    // this asserts is that the drop comes back as a rejected promise at all.
    await expect(warmDatabase(url, { attempts: 1 })).rejects.toThrow();
  });
});
