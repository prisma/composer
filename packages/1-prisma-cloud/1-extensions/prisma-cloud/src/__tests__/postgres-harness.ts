/**
 * A throwaway local Postgres for the prisma-next integration test — mirrors
 * `packages/alchemy/src/state/__tests__/harness.ts` (the state store's harness)
 * so both suites share one Postgres availability contract and one CI service
 * container. Kept as a local copy rather than a cross-package import: that
 * harness is another package's private test file with no export, and the
 * workspace convention keeps a package's tests self-contained.
 *
 * Availability signaling is identical: honors `STATE_TEST_DATABASE_URL` (the
 * env var the CI test job already wires), else spins an ephemeral cluster via
 * `initdb`/`pg_ctl`, else returns `undefined` locally (caller skips loudly) —
 * except on CI, where the absence of both throws so the suite can't silently
 * go unexecuted.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pg from 'pg';

export interface TestPostgres {
  readonly url: string;
  readonly stop: () => void;
}

export interface TestDatabase {
  /** A DSN pointing at the freshly-created, isolated database. */
  readonly url: string;
  /** Drop the database (terminating any lingering connections first). */
  readonly drop: () => Promise<void>;
}

/** Swap the database segment of a Postgres DSN, preserving user/host/params. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Create a fresh, uniquely-named database on the same server as `baseUrl` and
 * return a DSN for it plus a `drop`. Integration tests own a database instead
 * of a schema, so they never touch the tables another suite shares in the CI
 * Postgres's `public` (the state-store suite lives there). Isolates the PN
 * tests from the state store AND from each other, in any order, on one server.
 * `baseUrl`'s own database is the admin connection used to CREATE/DROP.
 */
export async function createTestDatabase(baseUrl: string): Promise<TestDatabase> {
  const name = `pn_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  return {
    url: withDatabase(baseUrl, name),
    drop: async () => {
      const a = new pg.Client({ connectionString: baseUrl });
      await a.connect();
      try {
        await a.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [name],
        );
        await a.query(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await a.end();
      }
    },
  };
}

// Some sandboxes leave LANG/LC_* unset or pointed at a locale glibc/ICU can't
// resolve, which makes postmaster become multithreaded during startup and
// refuse to serve. Pin C for every initdb/pg_ctl invocation.
const PG_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

const probe = (bin: string): boolean =>
  spawnSync(bin, ['--version'], { stdio: 'ignore', env: PG_ENV }).status === 0;

// Ubuntu's postgresql-common packaging installs versioned server binaries
// under /usr/lib/postgresql/<version>/bin, never on PATH — glob every version.
const globUbuntuPostgresqlBinCandidates = (name: string): string[] => {
  const base = '/usr/lib/postgresql';
  try {
    return fs.readdirSync(base).map((version) => path.join(base, version, 'bin', name));
  } catch {
    return [];
  }
};

const findBinary = (name: string): string | undefined => {
  const candidates = [
    name,
    `/opt/homebrew/opt/postgresql@15/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/opt/postgresql@15/bin/${name}`,
    `/usr/local/bin/${name}`,
    ...globUbuntuPostgresqlBinCandidates(name),
  ];
  return candidates.find(probe);
};

/**
 * Synchronously starts (or reuses) a throwaway Postgres. Runs at module load
 * — before `describe.skipIf` gates the suite — because bun collects tests
 * synchronously, so availability must be known before the file registers its
 * `describe` blocks.
 *
 * Returns `undefined` when neither `STATE_TEST_DATABASE_URL` nor initdb/pg_ctl
 * is available and `CI` is unset (a dev machine without Postgres) — callers
 * skip loudly. On CI the absence of both throws instead, so the suite can
 * never quietly go unexecuted.
 */
export const startTestPostgres = (): TestPostgres | undefined => {
  const fromEnv = process.env['STATE_TEST_DATABASE_URL'];
  if (fromEnv !== undefined) {
    return { url: fromEnv, stop: () => {} };
  }

  const initdb = findBinary('initdb');
  const pgCtl = findBinary('pg_ctl');
  if (initdb === undefined || pgCtl === undefined) {
    if (process.env['CI'] !== undefined) {
      throw new Error(
        'CI is set but no Postgres is available for the prisma-next integration test: neither ' +
          'STATE_TEST_DATABASE_URL nor initdb/pg_ctl (PATH, Homebrew, or Ubuntu ' +
          '/usr/lib/postgresql/*/bin) were found. The CI test job wires a `services: postgres:` ' +
          'container and STATE_TEST_DATABASE_URL (see .github/workflows/ci.yml).',
      );
    }
    return undefined;
  }

  const baseDir = process.env['STATE_TEST_PG_TMPDIR'] ?? os.tmpdir();
  fs.mkdirSync(baseDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(baseDir, 'prisma-compose-pn-pg-'));
  const logFile = path.join(dataDir, 'server.log');

  execFileSync(
    initdb,
    ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'],
    { stdio: 'pipe', env: PG_ENV },
  );

  let lastError = 'unknown error';
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const result = spawnSync(
      pgCtl,
      ['-D', dataDir, '-o', `-p ${port} -h 127.0.0.1`, '-w', '-l', logFile, 'start'],
      { stdio: 'pipe', env: PG_ENV },
    );
    if (result.status === 0) {
      return {
        url: `postgres://postgres@127.0.0.1:${port}/postgres`,
        stop: () => {
          try {
            execFileSync(pgCtl, ['-D', dataDir, '-m', 'fast', 'stop'], {
              stdio: 'pipe',
              env: PG_ENV,
            });
          } finally {
            fs.rmSync(dataDir, { recursive: true, force: true });
          }
        },
      };
    }
    lastError = result.stderr.toString();
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  throw new Error(
    `initdb/pg_ctl were found on PATH but the ephemeral test Postgres failed to start after 5 attempts: ${lastError}`,
  );
};
