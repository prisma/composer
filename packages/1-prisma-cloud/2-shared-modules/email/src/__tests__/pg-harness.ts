/**
 * A throwaway local Postgres for the outbox integration test — copied from
 * storage's harness (`storage/src/__tests__/pg-harness.ts`) per the
 * workspace convention that a package's tests stay self-contained. Honors
 * `STATE_TEST_DATABASE_URL`, else spins an ephemeral `initdb`/`pg_ctl`
 * cluster, else returns `undefined` locally so the caller skips loudly; on
 * CI the absence of both throws. Admin CREATE/DROP DATABASE go through
 * Bun's SQL (the store's own driver) rather than adding a `pg` dep.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SQL } from 'bun';

export interface TestPostgres {
  readonly url: string;
  readonly stop: () => void;
}

export interface TestDatabase {
  readonly url: string;
  readonly drop: () => Promise<void>;
}

// Some sandboxes leave LANG/LC_* unset or pointed at a locale glibc/ICU can't
// resolve, which makes postmaster become multithreaded during startup and
// refuse to serve. Pin C for every initdb/pg_ctl invocation.
const PG_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

const probe = (bin: string): boolean =>
  spawnSync(bin, ['--version'], { stdio: 'ignore', env: PG_ENV }).status === 0;

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

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Create a fresh, uniquely-named database on `baseUrl`'s server and return a DSN plus `drop` (terminating lingering backends first). */
export async function createTestDatabase(baseUrl: string): Promise<TestDatabase> {
  const name = `email_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new SQL({ url: baseUrl, max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  return {
    url: withDatabase(baseUrl, name),
    drop: async () => {
      const a = new SQL({ url: baseUrl, max: 1 });
      try {
        await a`select pg_terminate_backend(pid) from pg_stat_activity
                where datname = ${name} and pid <> pg_backend_pid()`;
        await a.unsafe(`drop database if exists "${name}"`);
      } finally {
        await a.end();
      }
    },
  };
}

/**
 * Synchronously starts (or reuses) a throwaway Postgres — runs at module load,
 * before `describe.skipIf` gates the suite (bun collects tests synchronously).
 * `undefined` when no Postgres is available and `CI` is unset; on CI the
 * absence throws so the suite can't silently go unexecuted.
 */
export const startTestPostgres = (): TestPostgres | undefined => {
  const fromEnv = process.env['STATE_TEST_DATABASE_URL'];
  if (fromEnv !== undefined) return { url: fromEnv, stop: () => {} };

  const initdb = findBinary('initdb');
  const pgCtl = findBinary('pg_ctl');
  if (initdb === undefined || pgCtl === undefined) {
    if (process.env['CI'] !== undefined) {
      throw new Error(
        'CI is set but no Postgres is available for the email outbox integration test: neither ' +
          'STATE_TEST_DATABASE_URL nor initdb/pg_ctl (PATH, Homebrew, or Ubuntu ' +
          '/usr/lib/postgresql/*/bin) were found.',
      );
    }
    return undefined;
  }

  const baseDir = process.env['EMAIL_TEST_PG_TMPDIR'] ?? os.tmpdir();
  fs.mkdirSync(baseDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(baseDir, 'prisma-composer-email-pg-'));
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
    `initdb/pg_ctl were found but the ephemeral test Postgres failed to start after 5 attempts: ${lastError}`,
  );
};
