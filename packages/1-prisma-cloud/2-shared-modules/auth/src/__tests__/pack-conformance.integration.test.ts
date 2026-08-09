/**
 * Schema conformance (spec § Test plan): the pack's authored schema IS the
 * schema Better Auth expects at the pinned version + plugin set — proven
 * against a real local Postgres, from both directions the module relies on:
 *
 *  1. THE DEPLOY PATH: migrate a scratch DB the way a consumer deploy does —
 *     PN control client with `extensions: [authPack]`, pack space
 *     materialised on disk from the descriptor's own shipped data (what
 *     `migration plan` does in a consumer project) — then point Better
 *     Auth's own migration generator (`getMigrations`, the engine behind
 *     `@better-auth/cli generate`) at the migrated schema and assert ZERO
 *     pending changes.
 *
 *  2. THE LOCAL-DEV PATH: `ensureLocalAuthSchema` (the testing export's
 *     bootstrap) brings a fresh DB to the same conforming schema through the
 *     same PN pipeline, and a second boot is a marker no-op.
 *
 * A better-auth version bump that changes the schema fails here first.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPostgresControlClient } from '@prisma/orm-postgres/control';
import { materialiseExtensionMigrationPackageIfMissing } from '@prisma/orm-toolchain/migration-tools/io';
import {
  emitContractSpaceArtifacts,
  spaceMigrationDirectory,
} from '@prisma/orm-toolchain/migration-tools/spaces';
import { getMigrations } from 'better-auth/db/migration';
import { admin, bearer, jwt, magicLink } from 'better-auth/plugins';
import pg from 'pg';
import emptyAppContractJson from '../execution/empty-app-contract.json' with { type: 'json' };
import { ensureLocalAuthSchema } from '../execution/local-schema.ts';
import { AUTH_PACK_ID, AUTH_SCHEMA, authPack } from '../pack/index.ts';
import {
  createTestDatabase,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from './postgres-harness.ts';

const pgServer: TestPostgres | undefined = startTestPostgres();

if (pgServer === undefined) {
  console.warn(
    '[auth] skipping pack conformance test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

const packDir = path.join(import.meta.dir, '..', 'pack');

/**
 * The EXACT Better Auth surface the pack's schema was generated for (spec
 * § Better Auth version and plugins). `getMigrations` derives the expected
 * tables from these options and diffs them against the live schema.
 */
function betterAuthOptions(pool: pg.Pool) {
  return {
    database: pool,
    secret: 'conformance-test-secret',
    baseURL: 'http://localhost:3000',
    emailAndPassword: { enabled: true },
    plugins: [jwt(), bearer(), admin(), magicLink({ sendMagicLink: async () => {} })],
  };
}

/** Assert Better Auth sees NOTHING to create or add on the given database. */
async function expectZeroPendingChanges(url: string): Promise<void> {
  // Better Auth is schema-unqualified; the service pins search_path=auth the
  // same way (buildAuthOptions), so the conformance check and the runtime
  // agree on where the tables live.
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${AUTH_SCHEMA}` });
  try {
    const { toBeCreated, toBeAdded } = await getMigrations(betterAuthOptions(pool));
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
  } finally {
    await pool.end();
  }
}

describe.skipIf(pgServer === undefined)('auth pack schema conformance', () => {
  if (pgServer === undefined) return;
  let migrationsDir: string;
  let db: TestDatabase;

  beforeAll(async () => {
    // Materialise the pack space on disk FROM THE DESCRIPTOR'S OWN DATA —
    // the same artefacts `migration plan` writes into a consumer project.
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-auth-pack-'));
    const space = authPack.contractSpace;
    if (space === undefined) throw new Error('authPack has no contractSpace');
    await emitContractSpaceArtifacts(migrationsDir, AUTH_PACK_ID, {
      contract: space.contractJson,
      contractDts: fs.readFileSync(path.join(packDir, 'contract.d.ts'), 'utf8'),
      headRef: space.headRef,
    });
    const spaceDir = spaceMigrationDirectory(migrationsDir, AUTH_PACK_ID);
    for (const pkg of space.migrations) {
      // Writes `<spaceDir>/<pkg.dirName>/{migration,ops}.json`.
      await materialiseExtensionMigrationPackageIfMissing(spaceDir, pkg);
    }
    db = await createTestDatabase(pgServer.url);
  });
  afterAll(async () => {
    await db?.drop().catch(() => {});
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('a deploy-path migration (empty app space + authPack) leaves Better Auth with zero pending changes', async () => {
    const client = createPostgresControlClient({
      connection: db.url,
      extensions: [authPack],
    });
    await client.connect();
    try {
      const result = await client.dbInit({
        contract: emptyAppContractJson,
        mode: 'apply',
        migrationsDir,
      });
      expect(result.ok).toBe(true);
    } finally {
      await client.close();
    }

    await expectZeroPendingChanges(db.url);
  });

  test('the auth marker row is signed at the pack head', async () => {
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      const res = await client.query(
        'SELECT core_hash FROM prisma_contract.marker WHERE space = $1',
        [AUTH_PACK_ID],
      );
      expect(res.rows[0]?.core_hash).toBe(authPack.contractSpace?.headRef.hash);
    } finally {
      await client.end();
    }
  });
});

describe.skipIf(pgServer === undefined)(
  'ensureLocalAuthSchema (the testing-export bootstrap)',
  () => {
    if (pgServer === undefined) return;

    afterAll(() => {
      pgServer.stop();
    });

    test('boots a fresh database to a conforming schema; a second boot is a marker no-op', async () => {
      const db = await createTestDatabase(pgServer.url);
      try {
        await ensureLocalAuthSchema(db.url);
        // Repeat boots are the local server's contract: the signed marker
        // makes the second call a clean no-op.
        await ensureLocalAuthSchema(db.url);
        await expectZeroPendingChanges(db.url);
      } finally {
        await db.drop().catch(() => {});
      }
    });

    test('refuses a database that carries other contract spaces without the auth pack', async () => {
      const db = await createTestDatabase(pgServer.url);
      try {
        const client = new pg.Client({ connectionString: db.url });
        await client.connect();
        try {
          await client.query('CREATE SCHEMA prisma_contract');
          await client.query(
            'CREATE TABLE prisma_contract.marker (space text PRIMARY KEY, core_hash text NOT NULL)',
          );
          await client.query("INSERT INTO prisma_contract.marker VALUES ('app', 'some-app')");
        } finally {
          await client.end();
        }
        await expect(ensureLocalAuthSchema(db.url)).rejects.toThrow(/extensions/);
      } finally {
        await db.drop().catch(() => {});
      }
    });
  },
);
