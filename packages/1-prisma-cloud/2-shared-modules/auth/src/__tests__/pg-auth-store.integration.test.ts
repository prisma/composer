/**
 * The `AuthStore` over a real local Postgres, bootstrapped through the same
 * PN dbInit path the local server uses (the DDL a deploy migrates to):
 * per-op SQL semantics
 * — session expiry and the banned-owner null, case-insensitive email lookup,
 * the effective-ban filter both ways (including a lapsed ban), ILIKE
 * escaping, keyset pagination edges, revocation idempotency,
 * ban-implies-revoke atomicity, and the rows `createUser` writes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { AuthStore, NewUser } from '../auth-store.ts';
import { ensureLocalAuthSchema } from '../execution/local-schema.ts';
import { createPgAuthStore } from '../pg-auth-store.ts';
import {
  createTestDatabase,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from './postgres-harness.ts';

const pgServer: TestPostgres | undefined = startTestPostgres();

if (pgServer === undefined) {
  console.warn(
    '[auth] skipping pg-auth-store integration test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

const T0 = '2026-07-20T10:00:00.000Z';
const T1 = '2026-07-21T10:00:00.000Z';
const T2 = '2026-07-22T10:00:00.000Z';
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 3_600_000).toISOString();

describe.skipIf(pgServer === undefined)('PgAuthStore', () => {
  if (pgServer === undefined) return;
  let db: TestDatabase;
  let sql: SQL;
  let store: AuthStore;

  const seedUser = async (
    id: string,
    over: {
      email?: string;
      name?: string;
      createdAt?: string;
      banned?: boolean | null;
      banReason?: string | null;
      banExpires?: string | null;
    } = {},
  ) => {
    await sql.unsafe(
      `insert into "auth"."user"
         (id, name, email, "emailVerified", "createdAt", "updatedAt", banned, "banReason", "banExpires")
       values ($1, $2, $3, true, $4, $4, $5, $6, $7)`,
      [
        id,
        over.name ?? `Name of ${id}`,
        over.email ?? `${id}@example.com`,
        over.createdAt ?? T1,
        over.banned ?? null,
        over.banReason ?? null,
        over.banExpires ?? null,
      ],
    );
  };

  const seedSession = async (
    id: string,
    userId: string,
    over: { token?: string; expiresAt?: string; createdAt?: string } = {},
  ) => {
    await sql.unsafe(
      `insert into "auth"."session"
         (id, "userId", token, "expiresAt", "createdAt", "updatedAt")
       values ($1, $2, $3, $4, $5, $5)`,
      [id, userId, over.token ?? `token-${id}`, over.expiresAt ?? FUTURE, over.createdAt ?? T1],
    );
  };

  beforeAll(async () => {
    db = await createTestDatabase(pgServer.url);
    await ensureLocalAuthSchema(db.url);
    sql = new SQL({ url: db.url, max: 1 });
    store = createPgAuthStore(db.url);
  });
  afterAll(async () => {
    await sql?.end();
    await db?.drop().catch(() => {});
    pgServer.stop();
  });

  describe('getSession', () => {
    test('a live token returns both records, ISO dates, no token field', async () => {
      await seedUser('u-live');
      await seedSession('s-live', 'u-live');

      const found = await store.getSession('token-s-live');
      expect(found).not.toBeNull();
      expect(found?.session).toEqual({
        id: 's-live',
        userId: 'u-live',
        expiresAt: FUTURE,
        ipAddress: null,
        userAgent: null,
        createdAt: T1,
        updatedAt: T1,
      });
      expect(found?.user.id).toBe('u-live');
      expect(found?.user.banned).toBe(false);
      // The store never copies the bearer token onto the wire record.
      expect(Object.keys(found?.session ?? {})).not.toContain('token');
    });

    test('unknown token → null', async () => {
      expect(await store.getSession('no-such-token')).toBeNull();
    });

    test('expired session → null (the row itself may still exist)', async () => {
      await seedUser('u-expired');
      await seedSession('s-expired', 'u-expired', { expiresAt: PAST });
      expect(await store.getSession('token-s-expired')).toBeNull();
    });

    test('banned owner → null; a lapsed ban lets the session through again', async () => {
      await seedUser('u-banned-owner', { banned: true });
      await seedSession('s-banned-owner', 'u-banned-owner');
      expect(await store.getSession('token-s-banned-owner')).toBeNull();

      await seedUser('u-lapsed-ban', { banned: true, banExpires: PAST });
      await seedSession('s-lapsed-ban', 'u-lapsed-ban');
      const found = await store.getSession('token-s-lapsed-ban');
      expect(found?.user.id).toBe('u-lapsed-ban');
      expect(found?.user.banned).toBe(false);
    });
  });

  describe('getUser', () => {
    test('by id; null when absent', async () => {
      await seedUser('u-get');
      expect((await store.getUser({ id: 'u-get' }))?.id).toBe('u-get');
      expect(await store.getUser({ id: 'u-ghost' })).toBeNull();
    });

    test('by email, case-insensitively', async () => {
      await seedUser('u-email', { email: 'Mixed.Case@Example.COM' });
      expect((await store.getUser({ email: 'mixed.case@example.com' }))?.id).toBe('u-email');
      expect((await store.getUser({ email: 'MIXED.CASE@EXAMPLE.COM' }))?.id).toBe('u-email');
    });

    test('maps banExpires → banExpiresAt and applies the effective-ban predicate', async () => {
      await seedUser('u-ban-map', { banned: true, banReason: 'spam', banExpires: FUTURE });
      const user = await store.getUser({ id: 'u-ban-map' });
      expect(user?.banned).toBe(true);
      expect(user?.banReason).toBe('spam');
      expect(user?.banExpiresAt).toBe(FUTURE);

      await seedUser('u-ban-lapsed', { banned: true, banExpires: PAST });
      expect((await store.getUser({ id: 'u-ban-lapsed' }))?.banned).toBe(false);
    });
  });

  describe('listUsers (own scratch database for deterministic paging)', () => {
    let pagedDb: TestDatabase;
    let pagedSql: SQL;
    let pagedStore: AuthStore;

    beforeAll(async () => {
      pagedDb = await createTestDatabase(pgServer.url);
      await ensureLocalAuthSchema(pagedDb.url);
      pagedSql = new SQL({ url: pagedDb.url, max: 1 });
      const insert = async (
        id: string,
        createdAt: string,
        over: { email?: string; name?: string; banned?: boolean; banExpires?: string | null } = {},
      ) =>
        pagedSql.unsafe(
          `insert into "auth"."user"
             (id, name, email, "emailVerified", "createdAt", "updatedAt", banned, "banExpires")
           values ($1, $2, $3, true, $4, $4, $5, $6)`,
          [
            id,
            over.name ?? `Name of ${id}`,
            over.email ?? `${id}@example.com`,
            createdAt,
            over.banned ?? null,
            over.banExpires ?? null,
          ],
        );

      // Order (createdAt desc, id desc): b2, b1 (tie on T2 broken by id),
      // a2, a1 (tie on T1), then z0 (oldest).
      await insert('a1', T1, { name: 'Alice One', email: 'alice.one@example.com' });
      await insert('a2', T1, { name: 'Alice Two', email: 'alice.two@example.com' });
      await insert('b1', T2, { name: 'Bob 100%_done', email: 'bob.one@example.com' });
      await insert('b2', T2, { name: 'Bob Two', email: 'bob.two@example.com', banned: true });
      await insert('z0', T0, {
        name: 'Zed Lapsed',
        email: 'zed@example.com',
        banned: true,
        banExpires: PAST,
      });
      pagedStore = createPgAuthStore(pagedDb.url);
    });
    afterAll(async () => {
      await pagedSql?.end();
      await pagedDb?.drop().catch(() => {});
    });

    test('orders createdAt desc, id desc; keyset pages resume without overlap', async () => {
      const page1 = await pagedStore.listUsers({ limit: 2 });
      expect(page1.users.map((u) => u.id)).toEqual(['b2', 'b1']);
      expect(page1.hasMore).toBe(true);

      const last = page1.users.at(-1);
      const page2 = await pagedStore.listUsers({
        limit: 2,
        after: { createdAt: last?.createdAt ?? '', id: last?.id ?? '' },
      });
      expect(page2.users.map((u) => u.id)).toEqual(['a2', 'a1']);
      expect(page2.hasMore).toBe(true);

      const last2 = page2.users.at(-1);
      const page3 = await pagedStore.listUsers({
        limit: 2,
        after: { createdAt: last2?.createdAt ?? '', id: last2?.id ?? '' },
      });
      expect(page3.users.map((u) => u.id)).toEqual(['z0']);
      expect(page3.hasMore).toBe(false);
    });

    test('a page that exactly exhausts the rows reports hasMore: false', async () => {
      const page = await pagedStore.listUsers({ limit: 5 });
      expect(page.users).toHaveLength(5);
      expect(page.hasMore).toBe(false);
    });

    test('query matches email OR name, case-insensitively', async () => {
      const byName = await pagedStore.listUsers({ query: 'alice', limit: 10 });
      expect(byName.users.map((u) => u.id).sort()).toEqual(['a1', 'a2']);

      const byEmail = await pagedStore.listUsers({ query: 'bob.two@', limit: 10 });
      expect(byEmail.users.map((u) => u.id)).toEqual(['b2']);
    });

    test('query escapes %, _, and backslash — no accidental wildcards', async () => {
      // "100%_done" appears only in b1's name; the literal % and _ must not
      // wildcard-match everything.
      const literal = await pagedStore.listUsers({ query: '100%_done', limit: 10 });
      expect(literal.users.map((u) => u.id)).toEqual(['b1']);

      const wildcardAbuse = await pagedStore.listUsers({ query: '%.two@%', limit: 10 });
      expect(wildcardAbuse.users).toEqual([]);
    });

    test('banned filters on the EFFECTIVE state both ways (lapsed ban counts as not banned)', async () => {
      const banned = await pagedStore.listUsers({ banned: true, limit: 10 });
      expect(banned.users.map((u) => u.id)).toEqual(['b2']);

      const notBanned = await pagedStore.listUsers({ banned: false, limit: 10 });
      expect(notBanned.users.map((u) => u.id).sort()).toEqual(['a1', 'a2', 'b1', 'z0']);
    });

    test('filters AND-combine', async () => {
      const both = await pagedStore.listUsers({ query: 'bob', banned: true, limit: 10 });
      expect(both.users.map((u) => u.id)).toEqual(['b2']);
    });
  });

  describe('listSessions / revocation', () => {
    test('listSessions returns the user’s sessions newest-first', async () => {
      await seedUser('u-sessions');
      await seedSession('s-old', 'u-sessions', { createdAt: T0 });
      await seedSession('s-new', 'u-sessions', { createdAt: T2 });
      const sessions = await store.listSessions('u-sessions');
      expect(sessions.map((s) => s.id)).toEqual(['s-new', 's-old']);
    });

    test('revokeSession deletes and is idempotent', async () => {
      await seedUser('u-revoke');
      await seedSession('s-revoke', 'u-revoke');
      expect(await store.revokeSession('s-revoke')).toBe(true);
      expect(await store.revokeSession('s-revoke')).toBe(false);
      expect(await store.getSession('token-s-revoke')).toBeNull();
    });

    test('revokeUserSessions counts and is idempotent', async () => {
      await seedUser('u-revoke-all');
      await seedSession('s-ra-1', 'u-revoke-all');
      await seedSession('s-ra-2', 'u-revoke-all');
      expect(await store.revokeUserSessions('u-revoke-all')).toBe(2);
      expect(await store.revokeUserSessions('u-revoke-all')).toBe(0);
    });
  });

  describe('createUser / setEmailVerified', () => {
    const newUser = (id: string, over: Partial<NewUser> = {}): NewUser => ({
      id,
      email: `${id}@example.com`,
      name: `Name of ${id}`,
      emailVerified: false,
      credential: null,
      ...over,
    });

    test('writes the user row and a credential account row carrying the hash, in one go', async () => {
      const created = await store.createUser(
        newUser('u-created', {
          emailVerified: true,
          credential: { id: 'acct-created', passwordHash: 'hash-value' },
        }),
      );
      expect(created?.id).toBe('u-created');
      expect(created?.email).toBe('u-created@example.com');
      expect(created?.emailVerified).toBe(true);
      expect(created?.banned).toBe(false);

      const accounts = await sql.unsafe<
        { id: string; accountId: string; providerId: string; userId: string; password: string }[]
      >(`select * from "auth"."account" where "userId" = $1`, ['u-created']);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        id: 'acct-created',
        accountId: 'u-created',
        providerId: 'credential',
        userId: 'u-created',
        password: 'hash-value',
      });
    });

    test('no credential → a user row and no account row', async () => {
      const created = await store.createUser(newUser('u-passwordless'));
      expect(created?.emailVerified).toBe(false);
      const accounts = await sql.unsafe<{ id: string }[]>(
        `select id from "auth"."account" where "userId" = $1`,
        ['u-passwordless'],
      );
      expect(accounts).toEqual([]);
    });

    test('a case-insensitive duplicate email → null, and nothing is written', async () => {
      await seedUser('u-taken', { email: 'Taken@Example.com' });
      const dup = await store.createUser(
        newUser('u-dup', {
          email: 'taken@example.com',
          credential: { id: 'acct-dup', passwordHash: 'h' },
        }),
      );
      expect(dup).toBeNull();
      expect(await store.getUser({ id: 'u-dup' })).toBeNull();
      const accounts = await sql.unsafe<{ id: string }[]>(
        `select id from "auth"."account" where id = $1`,
        ['acct-dup'],
      );
      expect(accounts).toEqual([]);
    });

    test('setEmailVerified flips the flag both ways; null for an unknown id', async () => {
      await store.createUser(newUser('u-verify'));
      expect((await store.setEmailVerified('u-verify', true))?.emailVerified).toBe(true);
      expect((await store.getUser({ id: 'u-verify' }))?.emailVerified).toBe(true);
      expect((await store.setEmailVerified('u-verify', false))?.emailVerified).toBe(false);
      expect(await store.setEmailVerified('u-nobody', true)).toBeNull();
    });
  });

  describe('banUser / unbanUser', () => {
    test('ban sets the columns AND revokes every session; instant logout observable', async () => {
      await seedUser('u-to-ban');
      await seedSession('s-tb-1', 'u-to-ban');
      await seedSession('s-tb-2', 'u-to-ban');

      const banned = await store.banUser('u-to-ban', 'abuse', FUTURE);
      expect(banned?.banned).toBe(true);
      expect(banned?.banReason).toBe('abuse');
      expect(banned?.banExpiresAt).toBe(FUTURE);
      expect(await store.listSessions('u-to-ban')).toEqual([]);
      expect(await store.getSession('token-s-tb-1')).toBeNull();
    });

    test('ban of an absent user → null (handler turns this into a thrown rpc error)', async () => {
      expect(await store.banUser('u-nobody', null, null)).toBeNull();
      expect(await store.unbanUser('u-nobody')).toBeNull();
    });

    test('unban clears the three columns and revokes nothing', async () => {
      await seedUser('u-to-unban', { banned: true, banReason: 'oops', banExpires: FUTURE });
      const unbanned = await store.unbanUser('u-to-unban');
      expect(unbanned?.banned).toBe(false);
      expect(unbanned?.banReason).toBeNull();
      expect(unbanned?.banExpiresAt).toBeNull();

      // Sessions created after the un-ban work; unban itself deleted nothing.
      await seedSession('s-post-unban', 'u-to-unban');
      expect((await store.getSession('token-s-post-unban'))?.user.id).toBe('u-to-unban');
    });
  });
});
