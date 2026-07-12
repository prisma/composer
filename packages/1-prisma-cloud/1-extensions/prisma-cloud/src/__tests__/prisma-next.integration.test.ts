/**
 * The live proof: a hydrated Prisma Next client round-trips a real query
 * against a real Postgres whose schema is at the `widget-contract` fixture's
 * contract.
 *
 * Schema is applied the faithful way — through Prisma Next's own control
 * client (`createPostgresControlClient(...).dbInit({ mode: 'apply' })`), the
 * same machinery slice 2's deploy lowering will drive — rather than
 * hand-written SQL, so this exercises the real apply-and-sign path end to end.
 * (Pulling the control/CLI machinery into the TEST is fine; it never enters
 * the app bundle — that isolation is asserted separately in invariants.test.ts.)
 *
 * Environment-gated: skips cleanly when no Postgres is available locally (no
 * `STATE_TEST_DATABASE_URL` and no initdb/pg_ctl), throws on CI. See
 * postgres-harness.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPostgresControlClient } from '@prisma-next/postgres/control';
import type { Char } from '@prisma-next/target-postgres/codec-types';
import type { Client } from '../prisma-next.ts';
import { pnContract, pnPostgres } from '../prisma-next.ts';
import type { Contract as WidgetContract } from './fixtures/widget-contract/emitted/contract.d.ts';
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};
import {
  createTestDatabase,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from './postgres-harness.ts';

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[app-cloud] skipping prisma-next integration test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL to point at one, or install initdb/pg_ctl ' +
      '(e.g. `brew install postgresql@15`) on PATH.',
  );
}

describe.skipIf(pg === undefined)('pnPostgres hydrate — live round trip', () => {
  if (pg === undefined) return;

  // The wrapped, branded contract — the exact value both the resource and the
  // dependency reference. Typing it as WidgetContract makes the hydrated
  // client `Client<WidgetContract>`, so the round-trip below is type-checked.
  const contract = pnContract<WidgetContract>(widgetContractJson);
  let migrationsDir: string;
  let db: Client<typeof contract>;
  // An owned database (not the shared `postgres`/`public`) so dbInit applies
  // onto an empty schema and the fixed-id insert can't collide with a prior run.
  let testDb: TestDatabase;

  beforeAll(async () => {
    // Bring the DB's schema to the contract via PN's control client — creates
    // the Widget table and writes the contract marker. `migrationsDir` is a
    // fresh empty dir: with no authored migrations and no extension spaces,
    // dbInit synthesizes the additive create-table plan for the single app
    // contract and signs it.
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-compose-pn-mig-'));
    testDb = await createTestDatabase(pg.url);
    const url = testDb.url;
    const control = createPostgresControlClient({ connection: url });
    await control.connect();
    const result = await control.dbInit({
      contract: widgetContractJson,
      mode: 'apply',
      migrationsDir,
    });
    expect(result.ok).toBe(true);
    await control.close();

    // Construct the client exactly as a service would: through the dependency
    // end's hydrate, given only the DB url.
    db = await pnPostgres(contract).connection.hydrate({ url });
  });

  afterAll(async () => {
    await db?.close().catch(() => {});
    await testDb?.drop().catch(() => {});
    pg.stop();
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('inserts and reads back a Widget row through the typed client', async () => {
    // Widget.id is a char(36) column, so its typed value is the branded
    // Char<36> — casting here (test files may) is itself proof the client
    // is contract-typed: a plain string does not compile as the id.
    const id = '11111111-1111-1111-1111-111111111111' as Char<36>;

    const created = await db.orm.public.Widget.create({ id, name: 'gizmo' });
    // Typed result: the ORM row is the contract's Widget shape. Accessing
    // `.id`/`.name` compiles only because hydrate returned Client<WidgetContract>.
    expect(created.id).toBe(id);
    expect(created.name).toBe('gizmo');

    const one = await db.orm.public.Widget.where({ id }).first();
    expect(one).not.toBeNull();
    expect(one?.name).toBe('gizmo');

    const all = await db.orm.public.Widget.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(id);
  });
});
