/**
 * `pg-store` against local `prisma dev`'s Postgres, which (PGlite behind a
 * socket) shares ONE backend session across every client connection. A
 * restarted storage service then re-prepares Bun's per-connection statement
 * names (`P<sql>$0`, …) into a session that already holds them — 42P05 at
 * boot, crash loop. A real Postgres gives each connection its own session,
 * so only this emulator reproduces it.
 */
import { afterAll, beforeAll, test } from 'bun:test';
import { startPrismaDevServer } from '@prisma/dev';
import { createPgStore } from '../pg-store.ts';

let server: Awaited<ReturnType<typeof startPrismaDevServer>>;

beforeAll(async () => {
  server = await startPrismaDevServer({
    name: `storage-test-${crypto.randomUUID()}`,
    persistenceMode: 'stateless',
  });
}, 60_000); // a cold CI runner boots @prisma/dev well past the 5s default

afterAll(async () => {
  await server?.close();
});

test('a restarted process boots the store again on the shared session', async () => {
  const url = server.database.connectionString;
  await createPgStore(url); // first boot
  await createPgStore(url); // throws 42P05 with prepared statements on
});
