/**
 * The handler layer over a fake in-memory store: the null shapes, the
 * exactly-one-of `getUser` validation (pinned message), cursor threading on
 * `listUsers`, the thrown-when-absent ban ops, and `createUser`'s Better
 * Auth semantics (lowercased email, generated ids, Better Auth's own
 * password hash, thrown-on-duplicate). SQL semantics live in
 * pg-auth-store.integration.test.ts — this file proves the layer between
 * the rpc contracts and the store.
 */
import { describe, expect, test } from 'bun:test';
import { verifyPassword } from 'better-auth/crypto';
import type { AuthStore, ListUsersFilters, NewUser } from '../auth-store.ts';
import { decodeCursor } from '../auth-store.ts';
import type { SessionRecord, UserRecord } from '../contract.ts';
import { createAuthHandlers } from '../handlers.ts';

const user = (id: string, over?: Partial<UserRecord>): UserRecord => ({
  id,
  email: `${id}@example.com`,
  emailVerified: true,
  name: id,
  image: null,
  role: null,
  banned: false,
  banReason: null,
  banExpiresAt: null,
  createdAt: '2026-07-23T00:00:00.000Z',
  updatedAt: '2026-07-23T00:00:00.000Z',
  ...over,
});

const session = (id: string, userId: string): SessionRecord => ({
  id,
  userId,
  expiresAt: '2026-07-24T00:00:00.000Z',
  ipAddress: null,
  userAgent: null,
  createdAt: '2026-07-23T00:00:00.000Z',
  updatedAt: '2026-07-23T00:00:00.000Z',
});

/** A store stub that records calls; each test overrides what it needs. */
function fakeStore(overrides: Partial<AuthStore> = {}): AuthStore & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const record =
    <A extends unknown[], R>(name: string, result: R) =>
    (...args: A): Promise<R> => {
      calls.push([name, ...args]);
      return Promise.resolve(result);
    };
  return {
    calls,
    getSession: record('getSession', null),
    getUser: record('getUser', null),
    listUsers: record('listUsers', { users: [], hasMore: false }),
    listSessions: record('listSessions', []),
    revokeSession: record('revokeSession', false),
    revokeUserSessions: record('revokeUserSessions', 0),
    banUser: record('banUser', null),
    unbanUser: record('unbanUser', null),
    createUser: record('createUser', null),
    setEmailVerified: record('setEmailVerified', null),
    ...overrides,
  };
}

describe('session handlers', () => {
  test('getSession: a store miss becomes the one null shape — both fields null', async () => {
    const { session: handlers } = createAuthHandlers(fakeStore());
    expect(await handlers.getSession({ token: 'nope' })).toEqual({ session: null, user: null });
  });

  test('getSession: a hit returns both records', async () => {
    const hit = { session: session('s1', 'u1'), user: user('u1') };
    const { session: handlers } = createAuthHandlers(fakeStore({ getSession: async () => hit }));
    expect(await handlers.getSession({ token: 't' })).toEqual(hit);
  });

  test('getUser resolves by id through the store', async () => {
    const store = fakeStore({ getUser: async () => user('u1') });
    const { session: handlers } = createAuthHandlers(store);
    expect(await handlers.getUser({ id: 'u1' })).toEqual({ user: user('u1') });
  });
});

describe('admin.findUser — exactly one of id, email', () => {
  const message = 'auth admin findUser: pass exactly one of id, email';

  test('both set → the pinned error', async () => {
    const { admin } = createAuthHandlers(fakeStore());
    await expect(admin.findUser({ id: 'u1', email: 'a@b.c' })).rejects.toThrow(message);
  });

  test('neither set → the pinned error', async () => {
    const { admin } = createAuthHandlers(fakeStore());
    await expect(admin.findUser({})).rejects.toThrow(message);
  });

  test('id alone and email alone both pass through to the store', async () => {
    const store = fakeStore();
    const { admin } = createAuthHandlers(store);
    await admin.findUser({ id: 'u1' });
    await admin.findUser({ email: 'a@b.c' });
    expect(store.calls).toEqual([
      ['getUser', { id: 'u1' }],
      ['getUser', { email: 'a@b.c' }],
    ]);
  });
});

describe('admin.listUsers — cursor threading', () => {
  test('defaults the limit to 50 and passes filters through', async () => {
    const store = fakeStore();
    const { admin } = createAuthHandlers(store);
    await admin.listUsers({ query: 'ali', banned: true });
    expect(store.calls).toEqual([
      ['listUsers', { query: 'ali', banned: true, limit: 50 } satisfies ListUsersFilters],
    ]);
  });

  test('emits nextCursor from the last row only when more remain', async () => {
    const users = [user('u2'), user('u1')];
    const { admin } = createAuthHandlers(
      fakeStore({ listUsers: async () => ({ users, hasMore: true }) }),
    );
    const page = await admin.listUsers({ limit: 2 });
    expect(page.users).toEqual(users);
    expect(page.nextCursor).toBeDefined();
    expect(decodeCursor(page.nextCursor ?? '')).toEqual({
      createdAt: '2026-07-23T00:00:00.000Z',
      id: 'u1',
    });

    const { admin: admin2 } = createAuthHandlers(
      fakeStore({ listUsers: async () => ({ users, hasMore: false }) }),
    );
    expect((await admin2.listUsers({ limit: 2 })).nextCursor).toBeUndefined();
  });

  test('decodes an incoming cursor into the keyset position', async () => {
    const store = fakeStore();
    const { admin } = createAuthHandlers(store);
    const cursor = Buffer.from('2026-07-23T00:00:00.000Z|u9', 'utf-8').toString('base64url');
    await admin.listUsers({ cursor });
    expect(store.calls).toEqual([
      ['listUsers', { after: { createdAt: '2026-07-23T00:00:00.000Z', id: 'u9' }, limit: 50 }],
    ]);
  });
});

describe('admin ban/unban — thrown when absent', () => {
  test('banUser on a missing user rejects', async () => {
    const { admin } = createAuthHandlers(fakeStore());
    await expect(admin.banUser({ userId: 'ghost' })).rejects.toThrow(
      'auth admin banUser: no user with id "ghost"',
    );
  });

  test('banUser passes reason/expiresAt as nulls when omitted', async () => {
    const store = fakeStore();
    store.banUser = async (...args) => {
      store.calls.push(['banUser', ...args]);
      return user('u1', { banned: true });
    };
    const { admin } = createAuthHandlers(store);
    await admin.banUser({ userId: 'u1' });
    expect(store.calls).toEqual([['banUser', 'u1', null, null]]);
  });

  test('unbanUser on a missing user rejects', async () => {
    const { admin } = createAuthHandlers(fakeStore());
    await expect(admin.unbanUser({ userId: 'ghost' })).rejects.toThrow(
      'auth admin unbanUser: no user with id "ghost"',
    );
  });
});

describe('admin revocation pass-throughs', () => {
  test('revokeSession and revokeUserSessions surface the store outcomes', async () => {
    const { admin } = createAuthHandlers(
      fakeStore({ revokeSession: async () => true, revokeUserSessions: async () => 3 }),
    );
    expect(await admin.revokeSession({ sessionId: 's1' })).toEqual({ revoked: true });
    expect(await admin.revokeUserSessions({ userId: 'u1' })).toEqual({ revokedCount: 3 });
  });
});

describe('admin.createUser — the rows Better Auth sign-up writes, minus the mail', () => {
  /** A store whose createUser echoes the row it was handed back as a record. */
  function creatingStore(): AuthStore & { calls: unknown[][]; created: NewUser[] } {
    const created: NewUser[] = [];
    const store = fakeStore({
      createUser: async (input) => {
        created.push(input);
        return user(input.id, {
          email: input.email,
          name: input.name,
          emailVerified: input.emailVerified,
        });
      },
    });
    return Object.assign(store, { created });
  }

  test("lowercases the email, mints 32-char ids, and hashes with Better Auth's own hasher", async () => {
    const store = creatingStore();
    const { admin } = createAuthHandlers(store);
    const { user: created } = await admin.createUser({
      email: 'Ada@Example.COM',
      name: 'Ada',
      password: 'correct-horse-battery',
    });

    const row = store.created[0];
    if (row === undefined || row.credential === null) throw new Error('no credential row');
    expect(row.email).toBe('ada@example.com');
    expect(created.email).toBe('ada@example.com');
    expect(row.id).toMatch(/^[a-zA-Z0-9]{32}$/);
    expect(row.credential.id).toMatch(/^[a-zA-Z0-9]{32}$/);
    expect(row.credential.id).not.toBe(row.id);
    expect(row.emailVerified).toBe(false);
    // The hash is one Better Auth's own verifier accepts — sign-in will too.
    expect(
      await verifyPassword({
        hash: row.credential.passwordHash,
        password: 'correct-horse-battery',
      }),
    ).toBe(true);
    expect(await verifyPassword({ hash: row.credential.passwordHash, password: 'wrong' })).toBe(
      false,
    );
  });

  test('no password → no credential row; emailVerified passes through', async () => {
    const store = creatingStore();
    const { admin } = createAuthHandlers(store);
    await admin.createUser({ email: 'b@example.com', name: 'B', emailVerified: true });
    expect(store.created[0]?.credential).toBeNull();
    expect(store.created[0]?.emailVerified).toBe(true);
  });

  test('a duplicate email (store returns null) rejects with the pinned message', async () => {
    const { admin } = createAuthHandlers(fakeStore());
    await expect(admin.createUser({ email: 'Dup@example.com', name: 'D' })).rejects.toThrow(
      'auth admin createUser: a user with email "Dup@example.com" already exists',
    );
  });

  test("applies Better Auth's sign-up password bounds before touching the store", async () => {
    const store = creatingStore();
    const { admin } = createAuthHandlers(store);
    await expect(
      admin.createUser({ email: 'c@example.com', name: 'C', password: 'short' }),
    ).rejects.toThrow('auth admin createUser: password must be at least 8 characters');
    await expect(
      admin.createUser({ email: 'c@example.com', name: 'C', password: 'x'.repeat(129) }),
    ).rejects.toThrow('auth admin createUser: password must be at most 128 characters');
    expect(store.created).toEqual([]);
  });
});

describe('admin.setEmailVerified', () => {
  test("passes the flag through and surfaces the store's null for an unknown id", async () => {
    const store = fakeStore();
    const { admin } = createAuthHandlers(store);
    expect(await admin.setEmailVerified({ userId: 'ghost', emailVerified: true })).toEqual({
      user: null,
    });
    expect(store.calls).toEqual([['setEmailVerified', 'ghost', true]]);

    const verified = user('u1', { emailVerified: true });
    const { admin: admin2 } = createAuthHandlers(
      fakeStore({ setEmailVerified: async () => verified }),
    );
    expect(await admin2.setEmailVerified({ userId: 'u1', emailVerified: true })).toEqual({
      user: verified,
    });
  });
});
