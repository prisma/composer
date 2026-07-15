/**
 * A throwaway local Postgres for the blob store example's local integration test — the
 * same availability contract as the state-store harness (honors
 * `STATE_TEST_DATABASE_URL`, else spins an ephemeral `initdb`/`pg_ctl` cluster,
 * else returns `undefined` so the caller skips loudly; on CI the absence throws).
 * The whole cluster is thrown away, so the test uses its `postgres` database
 * directly — no per-run database is needed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TestPostgres {
  readonly url: string;
  readonly stop: () => void;
}

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

export const startTestPostgres = (): TestPostgres | undefined => {
  const fromEnv = process.env['STATE_TEST_DATABASE_URL'];
  if (fromEnv !== undefined) return { url: fromEnv, stop: () => {} };

  const initdb = findBinary('initdb');
  const pgCtl = findBinary('pg_ctl');
  if (initdb === undefined || pgCtl === undefined) {
    if (process.env['CI'] !== undefined) {
      throw new Error(
        'CI is set but no Postgres is available for the storage example integration test: neither ' +
          'STATE_TEST_DATABASE_URL nor initdb/pg_ctl were found.',
      );
    }
    return undefined;
  }

  const baseDir = process.env['STATE_TEST_PG_TMPDIR'] ?? os.tmpdir();
  fs.mkdirSync(baseDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(baseDir, 'example-storage-pg-'));
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
  throw new Error(`ephemeral test Postgres failed to start after 5 attempts: ${lastError}`);
};
