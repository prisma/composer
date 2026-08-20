/**
 * The local-dev schema bootstrap: bring a caller-supplied local database to
 * the auth pack's head through the REAL Prisma Next `dbInit` path — the same
 * loader → planner → runner pipeline (control client + extension packs) a
 * consumer deploy runs — never a rendered SQL file, so local dev and deploy
 * cannot drift.
 *
 * The pack space is materialised into a temp directory from the descriptor's
 * own shipped data (exactly what `migration plan` writes into a consumer
 * project), and the app space is an EMPTY emitted contract: the local auth
 * server owns no app tables. Repeat boots no-op off the signed marker; a
 * database in any other state fails loudly rather than being half-migrated.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPostgresControlClient } from '@prisma/orm-postgres/control';
import { materialiseExtensionMigrationPackageIfMissing } from '@prisma/orm-toolchain/migration-tools/io';
import {
  emitContractSpaceArtifacts,
  spaceMigrationDirectory,
} from '@prisma/orm-toolchain/migration-tools/spaces';
import pg from 'pg';
import { AUTH_PACK_HEAD_HASH, AUTH_PACK_ID, authPack } from '../pack/index.ts';
import emptyAppContractJson from './empty-app-contract.json' with { type: 'json' };

interface MarkerRow {
  readonly space: string;
  readonly core_hash: string;
}

const UNDEFINED_TABLE = '42P01';

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** The database's signed marker rows, or `undefined` when no marker table exists (a fresh database). */
async function readMarkerRows(databaseUrl: string): Promise<readonly MarkerRow[] | undefined> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const res = await client.query<MarkerRow>(
      'SELECT space, core_hash FROM prisma_contract.marker',
    );
    return res.rows;
  } catch (error) {
    if (pgErrorCode(error) === UNDEFINED_TABLE) return undefined;
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Ensures the auth schema exists at the pack's head in the database at
 * `databaseUrl`. Fresh database → PN `dbInit` (pack space + empty app
 * space, marker signed per space). Already at head → no-op. Anything else —
 * an older pack head, or a database that carries other contract spaces but
 * not the auth pack — is the caller's project to migrate, so it fails with
 * instructions instead of touching their schema.
 */
export async function ensureLocalAuthSchema(databaseUrl: string): Promise<void> {
  const rows = await readMarkerRows(databaseUrl);
  const authRow = rows?.find((row) => row.space === AUTH_PACK_ID);
  if (authRow !== undefined) {
    if (authRow.core_hash === AUTH_PACK_HEAD_HASH) return;
    throw new Error(
      `local auth bootstrap: the database's "${AUTH_PACK_ID}" contract space is signed at ` +
        `${authRow.core_hash}, but this package ships ${AUTH_PACK_HEAD_HASH}. Re-run your ` +
        "project's migration plan against the installed package (or point the local server at " +
        'a fresh database).',
    );
  }
  if (rows !== undefined && rows.length > 0) {
    throw new Error(
      'local auth bootstrap: the database already carries contract space(s) ' +
        `${rows.map((row) => `"${row.space}"`).join(', ')} but not "${AUTH_PACK_ID}" — list ` +
        "authPack in that project's prisma-next.config.ts extensions and run its migration " +
        'plan; the local server only initialises databases it owns entirely.',
    );
  }

  const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-auth-local-'));
  try {
    const space = authPack.contractSpace;
    if (space === undefined) throw new Error('authPack has no contractSpace');
    await emitContractSpaceArtifacts(migrationsDir, AUTH_PACK_ID, {
      contract: space.contractJson,
      // The loader carries the .d.ts artefact as opaque text (a types file
      // for editors); the bundled testing export ships no source files, so a
      // marker comment stands in.
      contractDts: '// prisma-composer auth local bootstrap — types artefact not shipped\n',
      headRef: space.headRef,
    });
    const spaceDir = spaceMigrationDirectory(migrationsDir, AUTH_PACK_ID);
    for (const pkg of space.migrations) {
      await materialiseExtensionMigrationPackageIfMissing(spaceDir, pkg);
    }

    const client = createPostgresControlClient({
      connection: databaseUrl,
      extensions: [authPack],
    });
    await client.connect();
    try {
      const result = await client.dbInit({
        contract: emptyAppContractJson,
        mode: 'apply',
        migrationsDir,
      });
      if (!result.ok) {
        throw new Error(
          `local auth bootstrap: prisma-next dbInit failed: ${result.failure.summary}` +
            (result.failure.why !== undefined ? ` — ${result.failure.why}` : ''),
        );
      }
    } finally {
      await client.close();
    }
  } finally {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  }
}
