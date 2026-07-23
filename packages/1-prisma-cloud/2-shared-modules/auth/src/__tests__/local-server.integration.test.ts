/**
 * The full local loop with no cloud credentials (spec § Testing
 * export), against a real local Postgres: signup → login (cookie AND
 * bearer) → `/api/auth/token` → verification through the REAL
 * `jwtVerifier()` hydrate pointed at the local URL → the session and admin
 * ports over real rpc HTTP (`makeClient`) → `/health` and the 404
 * fallthrough → magic-link capture readback. Same topology as production:
 * the same fetch composition, the same handlers, the same options builder.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { makeClient } from '@internal/service-rpc';
import { authAdminContract, authSessionContract, jwtVerifier } from '../contract.ts';
import type { LocalAuthServer } from '../execution/testing.ts';
import { startLocalAuthServer } from '../execution/testing.ts';
import {
  createTestDatabase,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from './postgres-harness.ts';

const pgServer: TestPostgres | undefined = startTestPostgres();

if (pgServer === undefined) {
  console.warn(
    '[auth] skipping local-server integration test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct-horse-battery';

describe.skipIf(pgServer === undefined)('startLocalAuthServer — the full local loop', () => {
  if (pgServer === undefined) return;
  let db: TestDatabase;
  let server: LocalAuthServer;
  let userId: string;
  let sessionCookie: string;
  let bearerToken: string;
  let sessionToken: string;

  const api = (path: string, init?: RequestInit) => fetch(`${server.url}${path}`, init);
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    db = await createTestDatabase(pgServer.url);
    server = await startLocalAuthServer({ databaseUrl: db.url });
  });
  afterAll(async () => {
    await server?.stop();
    await db?.drop().catch(() => {});
    pgServer.stop();
  });

  test('signup creates the user and captures the verification email link', async () => {
    const res = await api(
      '/api/auth/sign-up/email',
      json({ email: EMAIL, password: PASSWORD, name: 'Ada' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string } };
    expect(body.user.email).toBe(EMAIL);
    userId = body.user.id;

    // sendOnSignUp: true + the capture seam: the live verification link is
    // readable BEFORE any real email wiring exists.
    const captured = server.capturedEmails.find((e) => e.template === 'verification');
    expect(captured?.to).toBe(EMAIL);
    expect(captured?.url).toContain(server.url);
  });

  test('login sets a first-party session cookie AND returns a bearer token', async () => {
    const res = await api('/api/auth/sign-in/email', json({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('better-auth.session_token=');
    sessionCookie = setCookie.split(';')[0] ?? '';

    // The bearer plugin surfaces the session token for header auth.
    bearerToken = res.headers.get('set-auth-token') ?? '';
    expect(bearerToken.length).toBeGreaterThan(0);
    const body = (await res.json()) as { token: string };
    sessionToken = body.token;
    expect(sessionToken.length).toBeGreaterThan(0);
  });

  test('the cookie authenticates /api/auth/get-session', async () => {
    const res = await api('/api/auth/get-session', { headers: { cookie: sessionCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } | null };
    expect(body.user?.id).toBe(userId);
  });

  test('the bearer token authenticates /api/auth/get-session', async () => {
    const res = await api('/api/auth/get-session', {
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } | null };
    expect(body.user?.id).toBe(userId);
  });

  test('/api/auth/token mints a JWT the real jwtVerifier() hydrate verifies', async () => {
    const res = await api('/api/auth/token', { headers: { cookie: sessionCookie } });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };

    const verifier = await jwtVerifier().connection.hydrate({ url: server.url });
    const session = await verifier.verify(token);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe(userId);
    expect(session?.email).toBe(EMAIL);
    expect(typeof session?.sessionId).toBe('string');
    expect(session?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Tampering makes it invalid token content — null, not a throw.
    expect(await verifier.verify(`${token}x`)).toBeNull();
  });

  test('the session port answers over real rpc HTTP', async () => {
    const session = makeClient(authSessionContract, server.url);

    const hit = await session.getSession({ token: sessionToken });
    expect(hit.session?.userId).toBe(userId);
    expect(hit.user?.id).toBe(userId);
    expect(hit.user?.banned).toBe(false);

    const miss = await session.getSession({ token: 'no-such-token' });
    expect(miss).toEqual({ session: null, user: null });

    const { user } = await session.getUser({ id: userId });
    expect(user?.email).toBe(EMAIL);
  });

  test('the admin port: findUser, listUsers, listSessions over real rpc HTTP', async () => {
    const admin = makeClient(authAdminContract, server.url);

    const byEmail = await admin.findUser({ email: EMAIL.toUpperCase() });
    expect(byEmail.user?.id).toBe(userId);

    const listed = await admin.listUsers({});
    expect(listed.users.map((u) => u.id)).toContain(userId);

    const { sessions } = await admin.listSessions({ userId });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]?.userId).toBe(userId);
  });

  test('ban → instant logout via the session port; unban restores login', async () => {
    const admin = makeClient(authAdminContract, server.url);
    const session = makeClient(authSessionContract, server.url);

    const banned = await admin.banUser({ userId, reason: 'test-ban' });
    expect(banned.user.banned).toBe(true);
    // Ban implies revoke: the session token is now a dead row.
    expect(await session.getSession({ token: sessionToken })).toEqual({
      session: null,
      user: null,
    });

    const unbanned = await admin.unbanUser({ userId });
    expect(unbanned.user.banned).toBe(false);

    // A fresh login works again after the un-ban.
    const res = await api('/api/auth/sign-in/email', json({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(200);
    sessionToken = ((await res.json()) as { token: string }).token;
    const hit = await session.getSession({ token: sessionToken });
    expect(hit.user?.id).toBe(userId);
  });

  test('revokeUserSessions logs the user out everywhere; idempotent on repeat', async () => {
    const admin = makeClient(authAdminContract, server.url);
    const session = makeClient(authSessionContract, server.url);

    const first = await admin.revokeUserSessions({ userId });
    expect(first.revokedCount).toBeGreaterThan(0);
    expect(await session.getSession({ token: sessionToken })).toEqual({
      session: null,
      user: null,
    });
    const second = await admin.revokeUserSessions({ userId });
    expect(second.revokedCount).toBe(0);

    const { revoked } = await admin.revokeSession({ sessionId: 'no-such-session' });
    expect(revoked).toBe(false);
  });

  test('magic-link: the capture seam surfaces the live link and completing it signs in', async () => {
    const res = await api('/api/auth/sign-in/magic-link', json({ email: EMAIL }));
    expect(res.status).toBe(200);

    const captured = server.capturedEmails.find((e) => e.template === 'magicLink');
    expect(captured?.to).toBe(EMAIL);
    expect(captured?.url).toContain(server.url);

    // Completing the captured link establishes a session (302 back to the
    // app origin with a fresh session cookie — redirects stay manual, the
    // proxy contract's posture).
    const complete = await fetch(captured?.url ?? '', { redirect: 'manual' });
    expect([200, 302]).toContain(complete.status);
    expect(complete.headers.get('set-cookie') ?? '').toContain('better-auth.session_token=');
  });

  test('/health answers without auth; unknown paths fall through to 404', async () => {
    const health = await api('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    expect((await api('/nope')).status).toBe(404);
    expect((await api('/rpc/no-such-method', json({}))).status).toBe(404);
  });
});
