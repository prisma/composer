import { afterAll, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import postgres from 'postgres';
import { verifyOwnership } from '../bootstrap.ts';
import { migratePrismaState } from '../schema.ts';
import { startTestPostgres, type TestPostgres } from './harness.ts';

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[alchemy/state] skipping ownership tests: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL to point at one, or install initdb/pg_ctl ' +
      '(e.g. `brew install postgresql@15`) on PATH.',
  );
}

// verifyOwnership inspects every table in a database's public schema, so
// each scenario below needs its own fresh database rather than sharing one
// (unlike state.test.ts's truncate-between-tests strategy, which works
// because that suite only ever cares about row contents, never which
// tables exist).
describe.skipIf(pg === undefined)('verifyOwnership', () => {
  if (pg === undefined) return;

  const admin = postgres(pg.url, { max: 1, onnotice: () => {} });
  let counter = 0;

  afterAll(async () => {
    await admin.end({ timeout: 1 });
    pg.stop();
  });

  const freshDatabaseUrl = async (): Promise<string> => {
    counter++;
    const name = `prisma_app_state_ownership_test_${counter}`;
    await admin.unsafe(`create database ${name}`);
    const url = new URL(pg.url);
    url.pathname = `/${name}`;
    return url.toString();
  };

  test('an empty database (no tables at all) verifies as empty', async () => {
    const url = await freshDatabaseUrl();

    const verdict = await Effect.runPromise(verifyOwnership(Redacted.make(url)));

    expect(verdict).toEqual({ kind: 'empty' });
  });

  test('a database migrated by migratePrismaState verifies as ours', async () => {
    const url = await freshDatabaseUrl();
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await Effect.runPromise(migratePrismaState(sql));
    await sql.end({ timeout: 1 });

    const verdict = await Effect.runPromise(verifyOwnership(Redacted.make(url)));

    expect(verdict).toEqual({ kind: 'ours' });
  });

  test('a database with our state tables but no marker (pre-hardening deployment) verifies as legacy', async () => {
    const url = await freshDatabaseUrl();
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`
      create table alchemy_resource_state (
        stack text not null, stage text not null, fqn text not null,
        value jsonb not null, updated_at timestamptz not null default now(),
        primary key (stack, stage, fqn)
      )
    `;
    await sql.end({ timeout: 1 });

    const verdict = await Effect.runPromise(verifyOwnership(Redacted.make(url)));

    expect(verdict).toEqual({ kind: 'legacy' });
  });

  test('a database with foreign tables and no marker verifies as squatter, naming the tables', async () => {
    const url = await freshDatabaseUrl();
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`create table users (id text primary key)`;
    await sql.end({ timeout: 1 });

    const verdict = await Effect.runPromise(verifyOwnership(Redacted.make(url)));

    expect(verdict.kind).toBe('squatter');
    if (verdict.kind === 'squatter') expect(verdict.tables).toContain('users');
  });

  test('a marker table present without our marker row verifies as squatter (someone else’s marker scheme)', async () => {
    const url = await freshDatabaseUrl();
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`
      create table prisma_app_state_meta (
        marker text primary key, created_at timestamptz not null default now()
      )
    `;
    await sql`insert into prisma_app_state_meta (marker) values ('not-our-marker')`;
    await sql.end({ timeout: 1 });

    const verdict = await Effect.runPromise(verifyOwnership(Redacted.make(url)));

    expect(verdict.kind).toBe('squatter');
  });
});
