/**
 * Local dev's `OrmMigration` diff, against a real Postgres: a database the
 * emulator created again comes back empty on the same URL, so this diff —
 * which reads the migration marker — is the only thing that migrates it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as Effect from 'effect/Effect';
import { applyOrmMigration, resolveTargetRef } from '../orm-migrate.ts';
import { LocalOrmMigrationProvider, OrmMigration } from '../orm-migration-resource.ts';
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};
import {
  createTestDatabase,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from './postgres-harness.ts';
import { authorWidgetInit, widgetHash } from './widget-migrations-fixture.ts';

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[app-cloud] skipping the local OrmMigration diff test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

/** A port nothing listens on: bound once by the OS, then released. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function localDiff(url: string): Promise<unknown> {
  const provider = await Effect.runPromise(
    OrmMigration.Provider.pipe(Effect.provide(LocalOrmMigrationProvider())),
  );
  const diff = provider.diff;
  if (!diff) throw new Error('the local OrmMigration provider has no diff');
  const olds = { url, targetHash: widgetHash, invariants: [] };
  return Effect.runPromise(diff({ olds } as never));
}

describe.skipIf(pg === undefined)("local dev's OrmMigration diff", () => {
  if (pg === undefined) return;
  let migrationsDir: string;
  let db: TestDatabase;

  beforeAll(async () => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-local-diff-'));
    await authorWidgetInit(migrationsDir);
    db = await createTestDatabase(pg.url);
  });
  afterAll(async () => {
    await db?.drop().catch(() => {});
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('a database with no marker, such as one created again empty, asks for an update', async () => {
    expect(await localDiff(db.url)).toEqual({ action: 'update' });
  });

  test('a database at the target by its marker asks for nothing', async () => {
    const ref = await resolveTargetRef(migrationsDir, widgetContractJson);
    await applyOrmMigration({ url: db.url, contractJson: widgetContractJson, migrationsDir, ref });

    expect(await localDiff(db.url)).toBeUndefined();
  });

  test('a database that cannot be reached asks for an update, which reports the failure', async () => {
    const port = await freePort();

    expect(await localDiff(`postgres://postgres:postgres@127.0.0.1:${String(port)}/x`)).toEqual({
      action: 'update',
    });
  });
});
