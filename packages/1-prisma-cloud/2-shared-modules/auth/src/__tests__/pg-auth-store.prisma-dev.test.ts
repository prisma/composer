/**
 * `pg-auth-store` against local `prisma dev`'s Postgres, which (PGlite behind
 * a socket) shares ONE backend session across every client connection. A
 * restarted auth service then re-prepares Bun's per-connection statement
 * names (`P<sql>$0`, …) into a session that already holds them — 42P05 on
 * its first query. A real Postgres gives each connection its own session,
 * so only this emulator reproduces it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPrismaDevServer } from '@prisma/dev';
import { ensureLocalAuthSchema } from '../execution/local-schema.ts';
import { createPgAuthStore } from '../pg-auth-store.ts';

let server: Awaited<ReturnType<typeof startPrismaDevServer>>;

beforeAll(async () => {
  server = await startPrismaDevServer({
    name: `auth-test-${crypto.randomUUID()}`,
    persistenceMode: 'stateless',
  });
  await ensureLocalAuthSchema(server.database.connectionString);
}, 60_000); // a cold CI runner boots @prisma/dev well past the 5s default

afterAll(async () => {
  await server?.close();
});

test('a restarted process runs its first query again on the shared session', async () => {
  const url = server.database.connectionString;
  expect(await createPgAuthStore(url).getSession('none')).toBeNull(); // first boot
  // throws 42P05 with prepared statements on
  expect(await createPgAuthStore(url).getSession('none')).toBeNull();
});
