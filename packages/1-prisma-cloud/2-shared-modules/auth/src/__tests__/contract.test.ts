/**
 * The authoring surface's runtime shapes: the `auth-api` contract's
 * kind-only satisfies, the dependency factories' node shapes (what wires,
 * what hydrates), `authDb()`'s pack claim, and the wire record schemas.
 * jose's actual verification runs against a live server in the local-server
 * integration suite — here we only prove hydrate is pure construction (no fetch).
 */
import { describe, expect, test } from 'bun:test';
import type { Contract } from '@internal/core';
import { requiredPackHeadOf } from '@internal/prisma-cloud';
import { type } from 'arktype';
import {
  authAdminContract,
  authApi,
  authApiContract,
  authDb,
  jwtVerifier,
  sessionRecord,
  userRecord,
} from '../contract.ts';
import { AUTH_PACK_HEAD_HASH, AUTH_PACK_ID } from '../pack/constants.ts';

describe('authApiContract', () => {
  test('satisfies compares kind only', () => {
    const other = {
      kind: 'auth-api',
      __cmp: undefined,
      satisfies: () => false,
    } as Contract<'auth-api', unknown>;
    expect(authApiContract.satisfies(other)).toBe(true);
  });

  test('is frozen and carries the auth-api kind', () => {
    expect(authApiContract.kind).toBe('auth-api');
    expect(Object.isFrozen(authApiContract)).toBe(true);
  });
});

describe('authApi()', () => {
  test('yields an auth-api dependency binding a URL-anchored client', async () => {
    const dep = authApi();
    expect(dep.kind).toBe('dependency');
    expect(dep.type).toBe('auth-api');
    expect(dep.required).toBe(authApiContract);
    expect(Object.keys(dep.connection.params)).toEqual(['url']);

    const client = await dep.connection.hydrate({ url: 'https://auth.example' });
    expect(client.url).toBe('https://auth.example');
    expect(typeof client.fetch).toBe('function');
  });
});

describe('jwtVerifier()', () => {
  test('yields an auth-api dependency; hydrate constructs without network', async () => {
    const dep = jwtVerifier();
    expect(dep.kind).toBe('dependency');
    expect(dep.type).toBe('auth-api');
    expect(dep.required).toBe(authApiContract);
    expect(Object.keys(dep.connection.params)).toEqual(['url']);

    // Construction is pure — the JWKS is fetched lazily at first verify().
    const verifier = await dep.connection.hydrate({ url: 'https://auth.example' });
    expect(typeof verifier.verify).toBe('function');
  });

  test('a syntactically malformed token resolves null without touching the JWKS', async () => {
    // jose rejects a non-compact-JWS string before any key fetch, so this
    // works against an unreachable url — proving both the null-not-throw
    // contract for token content and that no fetch happened.
    const verifier = await jwtVerifier().connection.hydrate({
      url: 'http://127.0.0.1:1/unreachable',
    });
    expect(await verifier.verify('not-a-jwt')).toBeNull();
  });
});

describe('authDb()', () => {
  test('claims the auth pack at the installed head, binding the bare url', async () => {
    const dep = authDb();
    expect(dep.kind).toBe('dependency');
    expect(dep.type).toBe('postgres');
    expect(requiredPackHeadOf(dep.required)).toEqual({
      packId: AUTH_PACK_ID,
      headHash: AUTH_PACK_HEAD_HASH,
    });
    expect(Object.keys(dep.connection.params)).toEqual(['url']);
    // Identity hydrate: Better Auth builds its own pool — no PN client here.
    expect(await dep.connection.hydrate({ url: 'postgres://x/y' })).toEqual({
      url: 'postgres://x/y',
    });
  });
});

describe('wire record schemas', () => {
  test('userRecord accepts the full shape and rejects a missing field', () => {
    const valid = {
      id: 'u1',
      email: 'a@b.c',
      emailVerified: true,
      name: null,
      image: null,
      role: null,
      banned: false,
      banReason: null,
      banExpiresAt: null,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    };
    expect(userRecord(valid)).toEqual(valid);
    const { banned: _banned, ...missing } = valid;
    expect(userRecord(missing)).toBeInstanceOf(type.errors);
  });

  test('sessionRecord accepts the full shape and declares NO token field', () => {
    const valid = {
      id: 's1',
      userId: 'u1',
      expiresAt: '2026-07-24T00:00:00.000Z',
      ipAddress: null,
      userAgent: null,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    };
    expect(sessionRecord(valid)).toEqual(valid);
    expect(sessionRecord({ ...valid, expiresAt: 42 })).toBeInstanceOf(type.errors);
    // "No token on the wire" is enforced at the type level
    // (contract.test-d.ts) and by the store's mapping
    // (pg-auth-store.integration.test.ts) — arktype ignores undeclared keys,
    // so a runtime rejection assertion here would test the wrong thing.
  });
});

// `rpc({ input, output })` returns the pair unchanged at runtime; reaching
// through `__cmp.<method>` is the established way to test a contract's
// schemas directly (email's contract.test.ts).
interface RpcMethodSchemas {
  readonly input: (value: unknown) => unknown;
  readonly output: (value: unknown) => unknown;
}

describe('authAdminContract — the provisioning methods', () => {
  test('createUser: email and name required, password and emailVerified optional; returns a user', () => {
    const { input, output } = authAdminContract.__cmp.createUser as unknown as RpcMethodSchemas;
    expect(input({ email: 'a@b.co', name: 'A' })).toEqual({ email: 'a@b.co', name: 'A' });
    expect(
      input({ email: 'a@b.co', name: 'A', password: 'correct-horse-battery', emailVerified: true }),
    ).not.toBeInstanceOf(type.errors);
    expect(input({ email: 'a@b.co' })).toBeInstanceOf(type.errors);
    // The address shape is validated at the rpc boundary, as Better Auth's
    // sign-up validates it — a typo'd email is a 400, not a dead account.
    expect(input({ email: 'ops@example', name: 'Ops' })).toBeInstanceOf(type.errors);
    expect(input({ email: 'not an email', name: 'Ops' })).toBeInstanceOf(type.errors);
    // So are Better Auth's sign-up password bounds (8–128), for the same reason.
    expect(input({ email: 'a@b.co', name: 'A', password: 'short' })).toBeInstanceOf(type.errors);
    expect(input({ email: 'a@b.co', name: 'A', password: 'x'.repeat(129) })).toBeInstanceOf(
      type.errors,
    );
    expect(input({ email: 'a@b.co', name: 'A', password: 'x'.repeat(8) })).not.toBeInstanceOf(
      type.errors,
    );
    expect(input({ email: 'a@b.co', name: 'A', emailVerified: 'yes' })).toBeInstanceOf(type.errors);
    expect(output({ user: null })).toBeInstanceOf(type.errors);
  });

  test('setEmailVerified: userId + flag in; a nullable user out', () => {
    const { input, output } = authAdminContract.__cmp
      .setEmailVerified as unknown as RpcMethodSchemas;
    expect(input({ userId: 'u1', emailVerified: true })).toEqual({
      userId: 'u1',
      emailVerified: true,
    });
    expect(input({ userId: 'u1' })).toBeInstanceOf(type.errors);
    expect(output({ user: null })).toEqual({ user: null });
  });
});
