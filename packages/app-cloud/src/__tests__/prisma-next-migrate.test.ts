/**
 * `relaxSslModeForPg` — the deploy-time connection-string normalization that
 * lets node-postgres connect to Prisma Postgres (slice 2, live-E2E fix). Pure
 * string logic, no database: a live PPG deploy is the ultimate proof, but this
 * locks the URL transform (a PPG `sslmode=require` becomes `no-verify`; a plain
 * local DSN is untouched) so a regression is caught without a live run.
 */
import { describe, expect, test } from 'bun:test';
import { relaxSslModeForPg } from '../prisma-next-migrate.ts';

describe('relaxSslModeForPg', () => {
  test('rewrites a Prisma Postgres sslmode=require DSN to no-verify', () => {
    const out = relaxSslModeForPg(
      'postgres://user:pass@db.prisma-data.net:5432/postgres?sslmode=require',
    );
    expect(new URL(out).searchParams.get('sslmode')).toBe('no-verify');
    // credentials, host, and database are preserved.
    const u = new URL(out);
    expect(u.username).toBe('user');
    expect(u.password).toBe('pass');
    expect(u.host).toBe('db.prisma-data.net:5432');
    expect(u.pathname).toBe('/postgres');
  });

  test('preserves other query params while relaxing sslmode', () => {
    const out = relaxSslModeForPg(
      'postgresql://u:p@host:5432/db?sslmode=require&connection_limit=5',
    );
    const params = new URL(out).searchParams;
    expect(params.get('sslmode')).toBe('no-verify');
    expect(params.get('connection_limit')).toBe('5');
  });

  test('relaxes every TLS-verifying sslmode (prefer / verify-ca / verify-full)', () => {
    for (const mode of ['prefer', 'verify-ca', 'verify-full']) {
      const out = relaxSslModeForPg(`postgres://u:p@h:5432/db?sslmode=${mode}`);
      expect(new URL(out).searchParams.get('sslmode')).toBe('no-verify');
    }
  });

  test('leaves a DSN with no sslmode untouched (plain local Postgres)', () => {
    const local = 'postgres://postgres@127.0.0.1:22801/postgres';
    expect(relaxSslModeForPg(local)).toBe(local);
  });

  test('leaves sslmode=disable and sslmode=no-verify untouched', () => {
    const disabled = 'postgres://u:p@h:5432/db?sslmode=disable';
    const already = 'postgres://u:p@h:5432/db?sslmode=no-verify';
    expect(relaxSslModeForPg(disabled)).toBe(disabled);
    expect(relaxSslModeForPg(already)).toBe(already);
  });

  test('returns an unparseable connection string unchanged', () => {
    const garbage = 'not a url';
    expect(relaxSslModeForPg(garbage)).toBe(garbage);
  });
});
