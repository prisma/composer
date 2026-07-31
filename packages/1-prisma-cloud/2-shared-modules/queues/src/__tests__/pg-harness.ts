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

const PG_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

const probe = (binary: string): boolean =>
  spawnSync(binary, ['--version'], { stdio: 'ignore', env: PG_ENV }).status === 0;

function ubuntuCandidates(name: string): string[] {
  try {
    return fs
      .readdirSync('/usr/lib/postgresql')
      .map((version) => path.join('/usr/lib/postgresql', version, 'bin', name));
  } catch {
    return [];
  }
}

function findBinary(name: string): string | undefined {
  return [
    name,
    `/opt/homebrew/opt/postgresql@15/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/opt/postgresql@15/bin/${name}`,
    `/usr/local/bin/${name}`,
    ...ubuntuCandidates(name),
  ].find(probe);
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export async function createTestDatabase(baseUrl: string): Promise<TestDatabase> {
  const name = `queues_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new SQL({ url: baseUrl, max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  return {
    url: withDatabase(baseUrl, name),
    drop: async () => {
      const sql = new SQL({ url: baseUrl, max: 1 });
      try {
        await sql`select pg_terminate_backend(pid) from pg_stat_activity
                  where datname = ${name} and pid <> pg_backend_pid()`;
        await sql.unsafe(`drop database if exists "${name}"`);
      } finally {
        await sql.end();
      }
    },
  };
}

export function startTestPostgres(): TestPostgres | undefined {
  const configured = process.env['STATE_TEST_DATABASE_URL'];
  if (configured !== undefined) return { url: configured, stop: () => {} };

  const initdb = findBinary('initdb');
  const pgCtl = findBinary('pg_ctl');
  if (initdb === undefined || pgCtl === undefined) {
    if (process.env['CI'] !== undefined) {
      throw new Error(
        'CI has no queue test Postgres: set STATE_TEST_DATABASE_URL or install initdb and pg_ctl.',
      );
    }
    return undefined;
  }

  const baseDir = process.env['QUEUES_TEST_PG_TMPDIR'] ?? os.tmpdir();
  fs.mkdirSync(baseDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(baseDir, 'prisma-composer-queues-pg-'));
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
  throw new Error(`queue test Postgres failed to start: ${lastError}`);
}
