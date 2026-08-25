/**
 * The safety-critical migration decision + apply logic (ref-based
 * target per review R4), proven against a real local Postgres — isolated from
 * the Alchemy stack / Prisma Cloud provisioning. Exercises `applyPnMigration`
 * end to end in three shapes (replay-only: the pipeline never synthesizes):
 *
 * No authored graph (empty migrations dir):
 *   - empty DB → the structured refusal: PnMigrationError
 *     (MIGRATION_PATH_NOT_FOUND) naming both exits (`prisma db update` /
 *     `prisma migration plan`), DB left untouched
 *
 * Authored baseline (EMPTY → widgetHash, built via PN's own migration-tools
 * writers so hashes and manifests are the real thing):
 *   - empty DB           → `migrate` replays the baseline and signs the marker
 *   - same target re-run → `noop`
 *   - no authored path   → throws PnMigrationError(MIGRATION_PATH_NOT_FOUND),
 *                          DB left unchanged
 *
 * Authored graph with a DATA invariant:
 *   - a fresh DB whose target ref REQUIRES an invariant goes through
 *     `migrate` and the marker records the invariant
 *   - re-run at the ref → `noop`
 *   - hash-match-but-invariant-missing (the A→A data-only self-edge, after a
 *     default-head replay) triggers `migrate`, which applies the data step
 *     and stamps the invariant
 *
 * Schema/marker setup uses PN's control client directly (the same machinery
 * the lowering drives). The shared harness checks the environment: the suite
 * skips cleanly without a local Postgres, runs on CI against the wired service.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPostgresControlClient } from '@prisma/orm-postgres/control';
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
import {
  authorWidgetBackfill,
  authorWidgetInit,
  BACKFILL_INVARIANT,
  widgetHash,
} from './widget-migrations-fixture.ts';

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[app-cloud] skipping prisma-next migrate integration test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

const gadgetHash = targetStorageHash(gadgetContractJson);

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

describe.skipIf(pg === undefined)(
  'applyPnMigration — no authored graph (structured refusal)',
  () => {
    if (pg === undefined) return;
    let migrationsDir: string;
    // A database this suite owns — never the shared `postgres`/`public` the
    // state-store suite uses — so the empty-DB assertion holds in any order.
    let db: TestDatabase;

    beforeAll(async () => {
      migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-pn-refuse-'));
      db = await createTestDatabase(pg.url);
    });
    afterAll(async () => {
      await db?.drop().catch(() => {});
      if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
    });

    test('empty DB, empty migrations dir → refuses with both exits named; DB untouched', async () => {
      expect(await readMarker(db.url)).toBeNull();

      const ref = await resolveTargetRef(migrationsDir, widgetContractJson);
      expect(ref).toEqual({ hash: widgetHash, invariants: [] });

      let thrown: unknown;
      try {
        await applyPnMigration({
          url: db.url,
          contractJson: widgetContractJson,
          migrationsDir,
          ref,
        });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(PnMigrationError);
      const error = thrown as PnMigrationError;
      expect(error.code).toBe('MIGRATION_PATH_NOT_FOUND');
      // The refusal names both exits: local iteration and authoring the path.
      expect(error.message).toContain('prisma db update');
      expect(error.message).toContain('prisma contract emit && prisma migration plan');
      // Nothing was applied — the pipeline never synthesizes.
      expect(await readMarker(db.url)).toBeNull();
    });
  },
);

describe.skipIf(pg === undefined)('applyPnMigration — authored baseline (replay path)', () => {
  if (pg === undefined) return;
  let migrationsDir: string;
  let db: TestDatabase;
  let url: string;

  beforeAll(async () => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-pn-mig-'));
    await authorWidgetInit(migrationsDir);
    db = await createTestDatabase(pg.url);
    url = db.url;
  });
  afterAll(async () => {
    await db?.drop().catch(() => {});
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('empty DB + committed baseline → migrate replays it and signs the marker', async () => {
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

    expect(outcome.action).toBe('migrate');
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
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-pn-inv-'));
    await authorWidgetInit(migrationsDir);
    await authorWidgetBackfill(migrationsDir);
  });
  afterAll(async () => {
    pg.stop();
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('fresh DB + ref with invariants → migrate; marker records the invariant; re-run no-ops', async () => {
    const db = await createTestDatabase(pg.url);
    try {
      const ref = await resolveTargetRef(migrationsDir, widgetContractJson, 'with-backfill');
      expect(ref).toEqual({ hash: widgetHash, invariants: [BACKFILL_INVARIANT] });

      // (a) The fresh DB replays the authored graph from empty, including the
      // invariant-bearing data step.
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
      // ref (head = emitted contract, zero invariants) replays the baseline
      // only — the data self-edge provides an invariant nothing requires yet.
      const headRef = await resolveTargetRef(migrationsDir, widgetContractJson);
      const baseline = await applyPnMigration({
        url: db.url,
        contractJson: widgetContractJson,
        migrationsDir,
        ref: headRef,
      });
      expect(baseline.action).toBe('migrate');
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
