/**
 * Multi-space migration with a declared extension pack,
 * proven against a real local Postgres: the app space (widget contract) and
 * one synthetic pack space (`gadget`, the gadget contract) migrate in ONE
 * `applyPnMigration` call —
 *
 *   - fresh DB → `init`: PN's aggregate pipeline applies BOTH spaces and
 *     signs a marker row per space;
 *   - re-run → the app-space marker says "at target", but with packs declared
 *     the `noop` short-circuit is suppressed: the call reports `migrate` and
 *     PN's per-space path resolution no-ops each up-to-date space;
 *   - without packs the `noop` short-circuit is untouched (the existing
 *     single-space behavior, re-asserted here on the same DB).
 *
 * The pack space is materialised the way `migration plan` would: on-disk
 * artefacts (`contract.json`, `refs/head.json`) plus an authored migration
 * package — the aggregate loader reads extension spaces from disk; the
 * descriptor declares the space and its head.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeMigrationHash } from '@prisma-next/migration-tools/hash';
import { writeMigrationPackage } from '@prisma-next/migration-tools/io';
import {
  emitContractSpaceArtefacts,
  spaceMigrationDirectory,
} from '@prisma-next/migration-tools/spaces';
import pg from 'pg';
import type { PnExtensionPack } from '../pn-config.ts';
import { applyPnMigration, targetStorageHash } from '../prisma-next-migrate.ts';
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

const pgServer: TestPostgres | undefined = startTestPostgres();

if (pgServer === undefined) {
  console.warn(
    '[app-cloud] skipping pn extension-packs integration test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

const widgetHash = targetStorageHash(widgetContractJson);
const gadgetHash = targetStorageHash(gadgetContractJson);
const PACK_SPACE_ID = 'gadget';

/** The pack descriptor, as a published pack would ship it. */
const gadgetPack = {
  kind: 'extension',
  id: PACK_SPACE_ID,
  familyId: 'sql',
  targetId: 'postgres',
  version: '0.0.1',
  contractSpace: {
    contractJson: gadgetContractJson,
    migrations: [],
    headRef: { hash: gadgetHash, invariants: [] },
  },
  create: () => ({ familyId: 'sql', targetId: 'postgres' }),
} as unknown as PnExtensionPack;

/**
 * Materialise the pack space on disk under `migrationsDir/gadget/` — the
 * artefacts `migration plan` writes: the space contract, its head ref, and
 * the authored EMPTY → gadgetHash migration creating `"Gadget"`.
 */
async function materialisePackSpace(migrationsDir: string): Promise<void> {
  const contractDts = fs.readFileSync(
    path.join(import.meta.dir, 'fixtures', 'gadget-contract', 'emitted', 'contract.d.ts'),
    'utf8',
  );
  await emitContractSpaceArtefacts(migrationsDir, PACK_SPACE_ID, {
    contract: gadgetContractJson,
    contractDts,
    headRef: { hash: gadgetHash, invariants: [] },
  });

  const ops = [
    {
      id: 'table.Gadget',
      label: 'Create table "Gadget"',
      summary: 'Creates table "Gadget"',
      operationClass: 'additive' as const,
      target: {
        id: 'postgres',
        details: { schema: 'public', objectType: 'table', name: 'Gadget' },
      },
      precheck: [
        {
          description: 'ensure table "Gadget" does not exist',
          sql: 'SELECT (to_regclass($1)) IS NULL AS "result"',
          params: ['"public"."Gadget"'],
        },
      ],
      execute: [
        {
          description: 'create table "Gadget"',
          sql: 'CREATE TABLE "public"."Gadget" (\n  "id" character(36) NOT NULL,\n  "label" text NOT NULL,\n  PRIMARY KEY ("id")\n)',
          params: [],
        },
      ],
      postcheck: [
        {
          description: 'verify table "Gadget" exists',
          sql: 'SELECT (to_regclass($1)) IS NOT NULL AS "result"',
          params: ['"public"."Gadget"'],
        },
      ],
    },
  ];
  const meta = {
    from: null,
    to: gadgetHash,
    providedInvariants: [],
    createdAt: '2026-07-22T00:00:00.000Z',
  };
  await writeMigrationPackage(
    path.join(spaceMigrationDirectory(migrationsDir, PACK_SPACE_ID), '20260722T0001_init'),
    { ...meta, migrationHash: computeMigrationHash(meta, ops) },
    ops,
  );
}

async function readMarkerRows(url: string): Promise<readonly { space: string; hash: string }[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query(
      'SELECT space, core_hash FROM prisma_contract.marker ORDER BY space',
    );
    return res.rows.map((row: { space: string; core_hash: string }) => ({
      space: row.space,
      hash: row.core_hash,
    }));
  } finally {
    await client.end();
  }
}

async function tableExists(url: string, table: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query('SELECT to_regclass($1) AS oid', [`"public"."${table}"`]);
    return res.rows[0]?.oid !== null;
  } finally {
    await client.end();
  }
}

describe.skipIf(pgServer === undefined)('applyPnMigration with a declared extension pack', () => {
  if (pgServer === undefined) return;
  let migrationsDir: string;
  let db: TestDatabase;
  let url: string;

  beforeAll(async () => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-pn-pack-'));
    await materialisePackSpace(migrationsDir);
    db = await createTestDatabase(pgServer.url);
    url = db.url;
  });
  afterAll(async () => {
    await db?.drop().catch(() => {});
    pgServer.stop();
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('fresh DB → init applies BOTH spaces and signs a marker row per space', async () => {
    const outcome = await applyPnMigration({
      url,
      contractJson: widgetContractJson,
      migrationsDir,
      ref: { hash: widgetHash, invariants: [] },
      extensionPacks: [gadgetPack],
    });

    expect(outcome.action).toBe('init');
    expect(outcome.markerHashBefore).toBeNull();
    expect(await readMarkerRows(url)).toEqual([
      { space: 'app', hash: widgetHash },
      { space: PACK_SPACE_ID, hash: gadgetHash },
    ]);
    expect(await tableExists(url, 'Widget')).toBe(true);
    expect(await tableExists(url, 'Gadget')).toBe(true);
  });

  test('re-run with packs → the app-space noop is suppressed; migrate no-ops per space', async () => {
    const outcome = await applyPnMigration({
      url,
      contractJson: widgetContractJson,
      migrationsDir,
      ref: { hash: widgetHash, invariants: [] },
      extensionPacks: [gadgetPack],
    });

    // The app marker alone cannot vouch for the pack spaces, so the decision
    // is `migrate` — and PN's per-space path resolution finds every space at
    // its head, changing nothing.
    expect(outcome.action).toBe('migrate');
    expect(outcome.markerHashBefore).toBe(widgetHash);
    expect(await readMarkerRows(url)).toEqual([
      { space: 'app', hash: widgetHash },
      { space: PACK_SPACE_ID, hash: gadgetHash },
    ]);
  });

  test('without packs the noop short-circuit is untouched', async () => {
    const outcome = await applyPnMigration({
      url,
      contractJson: widgetContractJson,
      migrationsDir,
      ref: { hash: widgetHash, invariants: [] },
    });
    expect(outcome.action).toBe('noop');
  });
});
