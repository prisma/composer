/**
 * `pg-outbox-store` against local `prisma dev`'s Postgres, which (PGlite
 * behind a socket) shares ONE backend session across every client
 * connection. A restarted `mail.service` then re-prepares Bun's
 * per-connection statement names (`P<sql>$0`, …) into a session that already
 * holds them — 42P05 at boot, crash loop. A real Postgres gives each
 * connection its own session, so only this emulator reproduces it.
 */
import { afterAll, beforeAll, test } from 'bun:test';
import { startPrismaDevServer } from '@prisma/dev';
import { createPgOutboxStore } from '../pg-outbox-store.ts';

let server: Awaited<ReturnType<typeof startPrismaDevServer>>;

beforeAll(async () => {
  server = await startPrismaDevServer({
    name: `email-test-${crypto.randomUUID()}`,
    persistenceMode: 'stateless',
  });
}, 60_000); // a cold CI runner boots @prisma/dev well past the 5s default

afterAll(async () => {
  await server?.close();
});

test('a restarted process boots the store again on the shared session', async () => {
  const url = server.database.connectionString;
  await createPgOutboxStore(url); // first boot
  // restart: the same statements, in the same order, on the same session
  await createPgOutboxStore(url); // throws 42P05 with prepared statements on
});
