/**
 * The safety-critical migration decision + apply logic (slice 2 D2, ref-based
 * target per review R4), proven against a real local Postgres — isolated from
 * the Alchemy stack / Prisma Cloud provisioning. Exercises `applyPnMigration`
 * end to end in two shapes:
 *
 * No authored graph (empty migrations dir, the plain-schema deploy):
 *   - empty DB          → `init` (dbInit applies + signs the target marker)
 *   - same target re-run → `noop`
 *   - no authored path   → throws PnMigrationError(MIGRATION_PATH_NOT_FOUND),
 *                          DB left unchanged
 *
 * Authored graph with a DATA invariant (built via PN's own migration-tools
 * writers, so hashes and manifests are the real thing):
 *   - a fresh DB whose target ref REQUIRES an invariant goes through
 *     `migrate` (never `dbInit` — additive-only synth can't run data steps),
 *     and the marker records the invariant
 *   - re-run at the ref → `noop`
 *   - hash-match-but-invariant-missing (the A→A data-only self-edge, after a
 *     default `init`) triggers `migrate`, which applies the data step and
 *     stamps the invariant
 *
 * Schema/marker setup uses PN's control client directly (the same machinery
 * the lowering drives). Environment-gated via the shared harness: skips
 * cleanly without a local Postgres, runs on CI against the wired service.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeMigrationHash } from '@prisma-next/migration-tools/hash';
import { writeMigrationPackage } from '@prisma-next/migration-tools/io';
import { writeRef } from '@prisma-next/migration-tools/refs';
import {
  APP_SPACE_ID,
  spaceMigrationDirectory,
  spaceRefsDirectory,
} from '@prisma-next/migration-tools/spaces';
import { createPostgresControlClient } from '@prisma-next/postgres/control';
import {
  applyPnMigration,
  PnMigrationError,
  resolveTargetRef,
  targetStorageHash,
} from '../prisma-next-migrate.ts';
import gadgetContractJson from './fixtures/gadget-contract/emitted/contract.json' with {
  type: 'json',
};
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
    '[app-cloud] skipping prisma-next migrate integration test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

const widgetHash = targetStorageHash(widgetContractJson);
const gadgetHash = targetStorageHash(gadgetContractJson);
const BACKFILL_INVARIANT = 'widget-name-backfill';

async function readMarker(
  url: string,
): Promise<{ storageHash: string; invariants: readonly string[] } | null> {
  const client = createPostgresControlClient({ connection: url });
  await client.connect();
  try {
    const marker = await client.readMarker();
    if (marker === null) return null;
    return { storageHash: marker.storageHash, invariants: marker.invariants };
  } finally {
    await client.close();
  }
}

/**
 * Author the widget contract's migration graph the honest way — through PN's
 * own migration-tools writers (real manifest shape, real `migrationHash`):
 *   - init: EMPTY → widgetHash (the `CREATE TABLE "Widget"` DDL)
 *   - backfill: widgetHash → widgetHash, a `data`-class op carrying
 *     `invariantId` — the A→A self-edge only invariant routing can select
 *   - a named ref `with-backfill` = { hash: widgetHash, invariants: [...] }
 */
async function authorWidgetMigrations(migrationsDir: string): Promise<void> {
  const appDir = spaceMigrationDirectory(migrationsDir, APP_SPACE_ID);

  const initOps = [
    {
      id: 'table.Widget',
      label: 'Create table "Widget"',
      summary: 'Creates table "Widget"',
      operationClass: 'additive' as const,
      target: {
        id: 'postgres',
        details: { schema: 'public', objectType: 'table', name: 'Widget' },
      },
      precheck: [
        {
          description: 'ensure table "Widget" does not exist',
          sql: 'SELECT (to_regclass($1)) IS NULL AS "result"',
          params: ['"public"."Widget"'],
        },
      ],
      execute: [
        {
          description: 'create table "Widget"',
          sql: 'CREATE TABLE "public"."Widget" (\n  "id" character(36) NOT NULL,\n  "name" text NOT NULL,\n  PRIMARY KEY ("id")\n)',
          params: [],
        },
      ],
      postcheck: [
        {
          description: 'verify table "Widget" exists',
          sql: 'SELECT (to_regclass($1)) IS NOT NULL AS "result"',
          params: ['"public"."Widget"'],
        },
      ],
    },
  ];
  const initMeta = {
    from: null,
    to: widgetHash,
    providedInvariants: [],
    createdAt: '2026-07-12T00:00:00.000Z',
  };
  await writeMigrationPackage(
    path.join(appDir, '20260712T0001_init'),
    { ...initMeta, migrationHash: computeMigrationHash(initMeta, initOps) },
    initOps,
  );

  const backfillOps = [
    {
      id: `data_migration.${BACKFILL_INVARIANT}`,
      label: `Data transform: ${BACKFILL_INVARIANT}`,
      operationClass: 'data' as const,
      invariantId: BACKFILL_INVARIANT,
      target: { id: 'postgres' },
      precheck: [],
      execute: [
        {
          description: `Run ${BACKFILL_INVARIANT}`,
          sql: 'UPDATE "public"."Widget" SET "name" = btrim("name")',
          params: [],
        },
      ],
      postcheck: [],
    },
  ];
  const backfillMeta = {
    from: widgetHash,
    to: widgetHash,
    providedInvariants: [BACKFILL_INVARIANT],
    createdAt: '2026-07-12T00:00:01.000Z',
  };
  await writeMigrationPackage(
    path.join(appDir, '20260712T0002_backfill'),
    { ...backfillMeta, migrationHash: computeMigrationHash(backfillMeta, backfillOps) },
    backfillOps,
  );

  await writeRef(spaceRefsDirectory(appDir), 'with-backfill', {
    hash: widgetHash,
    invariants: [BACKFILL_INVARIANT],
  });
}

describe.skipIf(pg === undefined)('applyPnMigration — no authored graph (dbInit path)', () => {
  if (pg === undefined) return;
  // An empty migrations dir: dbInit synthesizes the additive first-apply plan;
  // `migrate` (no authored packages) finds no path between unrelated hashes.
  let migrationsDir: string;
  // A database this suite owns — never the shared `postgres`/`public` the
  // state-store suite uses — so the empty-DB assertion holds in any order.
  let db: TestDatabase;
  let url: string;

  beforeAll(async () => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-compose-pn-mig-'));
    db = await createTestDatabase(pg.url);
    url = db.url;
  });
  afterAll(async () => {
    await db?.drop().catch(() => {});
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('empty DB, no required invariants → init: applies the contract and signs the marker', async () => {
    expect(await readMarker(url)).toBeNull();

    // No head.json on disk and no targetRef — the resolved default is the
    // emitted contract's hash with zero invariants (PN's own app-head synth).
    const ref = await resolveTargetRef(migrationsDir, widgetContractJson);
    expect(ref).toEqual({ hash: widgetHash, invariants: [] });

    const outcome = await applyPnMigration({
      url,
      contractJson: widgetContractJson,
      migrationsDir,
      ref,
    });

    expect(outcome.action).toBe('init');
    expect(outcome.markerHashBefore).toBeNull();
    expect(outcome.targetHash).toBe(widgetHash);
    // The DB is now signed at the target hash.
    expect((await readMarker(url))?.storageHash).toBe(widgetHash);
  });

  test('re-run at the same ref → noop (idempotent redeploy)', async () => {
    const ref = await resolveTargetRef(migrationsDir, widgetContractJson);
    const outcome = await applyPnMigration({
      url,
      contractJson: widgetContractJson,
      migrationsDir,
      ref,
    });

    expect(outcome.action).toBe('noop');
    expect(outcome.markerHashBefore).toBe(widgetHash);
    expect(outcome.targetHash).toBe(widgetHash);
    expect((await readMarker(url))?.storageHash).toBe(widgetHash);
  });

  test('marker at a different hash with no authored path → fails, DB unchanged', async () => {
    // The DB is currently signed at widgetHash. Target a DIFFERENT contract
    // (gadget) with no authored migration between the two — migrate must fail
    // with MIGRATION_PATH_NOT_FOUND and leave the marker at widgetHash.
    expect((await readMarker(url))?.storageHash).toBe(widgetHash);
    expect(gadgetHash).not.toBe(widgetHash);

    const ref = await resolveTargetRef(migrationsDir, gadgetContractJson);
    let thrown: unknown;
    try {
      await applyPnMigration({ url, contractJson: gadgetContractJson, migrationsDir, ref });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(PnMigrationError);
    expect((thrown as PnMigrationError).code).toBe('MIGRATION_PATH_NOT_FOUND');
    // Failed apply left the marker (and schema) unchanged.
    expect((await readMarker(url))?.storageHash).toBe(widgetHash);
  });
});

describe.skipIf(pg === undefined)('applyPnMigration — authored graph with a data invariant', () => {
  if (pg === undefined) return;
  let migrationsDir: string;

  beforeAll(async () => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-compose-pn-inv-'));
    await authorWidgetMigrations(migrationsDir);
  });
  afterAll(async () => {
    pg.stop();
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('fresh DB + ref with invariants → migrate (not dbInit); marker records the invariant; re-run no-ops', async () => {
    const db = await createTestDatabase(pg.url);
    try {
      const ref = await resolveTargetRef(migrationsDir, widgetContractJson, 'with-backfill');
      expect(ref).toEqual({ hash: widgetHash, invariants: [BACKFILL_INVARIANT] });

      // (a) The fresh DB goes through migrate — dbInit is additive-only and
      // would leave marker.invariants empty, silently skipping the data step.
      const first = await applyPnMigration({
        url: db.url,
        contractJson: widgetContractJson,
        migrationsDir,
        ref,
        refName: 'with-backfill',
      });
      expect(first.action).toBe('migrate');
      expect(first.markerHashBefore).toBeNull();
      expect(first.targetHash).toBe(widgetHash);

      // (b) The marker records both the hash and the invariant.
      const marker = await readMarker(db.url);
      expect(marker?.storageHash).toBe(widgetHash);
      expect(marker?.invariants).toContain(BACKFILL_INVARIANT);

      // (c) Re-run at the same ref — at hash AND invariants ⊆ marker → noop.
      const second = await applyPnMigration({
        url: db.url,
        contractJson: widgetContractJson,
        migrationsDir,
        ref,
        refName: 'with-backfill',
      });
      expect(second.action).toBe('noop');
    } finally {
      await db.drop().catch(() => {});
    }
  });

  test('hash-match-but-invariant-missing (A→A data-only) → migrate stamps the invariant', async () => {
    const db = await createTestDatabase(pg.url);
    try {
      // First bring the DB to widgetHash WITHOUT the invariant: the default
      // ref (head = emitted contract, zero invariants) chooses dbInit.
      const headRef = await resolveTargetRef(migrationsDir, widgetContractJson);
      const initOutcome = await applyPnMigration({
        url: db.url,
        contractJson: widgetContractJson,
        migrationsDir,
        ref: headRef,
      });
      expect(initOutcome.action).toBe('init');
      const before = await readMarker(db.url);
      expect(before?.storageHash).toBe(widgetHash);
      expect(before?.invariants ?? []).not.toContain(BACKFILL_INVARIANT);

      // (d) Same hash, missing invariant — keying on storageHash alone would
      // wrongly no-op here. The ref decision walks the A→A self-edge instead.
      const ref = await resolveTargetRef(migrationsDir, widgetContractJson, 'with-backfill');
      const outcome = await applyPnMigration({
        url: db.url,
        contractJson: widgetContractJson,
        migrationsDir,
        ref,
        refName: 'with-backfill',
      });
      expect(outcome.action).toBe('migrate');
      expect(outcome.markerHashBefore).toBe(widgetHash);

      const after = await readMarker(db.url);
      expect(after?.storageHash).toBe(widgetHash);
      expect(after?.invariants).toContain(BACKFILL_INVARIANT);
    } finally {
      await db.drop().catch(() => {});
    }
  });
});
