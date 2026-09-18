/**
 * The full local loop with no cloud credentials (spec § Testing export),
 * against a real local Postgres: signup → login rejected pre-verification
 * (`requireEmailVerification: true`) → completing the DEFAULT capture's
 * verification link verifies the user → login (cookie AND
 * bearer) → `/api/auth/token` → verification through the REAL
 * `jwtVerifier()` hydrate pointed at the local URL → the session and admin
 * ports over real rpc HTTP (`makeClient`) → `/health` and the 404
 * fallthrough → magic-link capture readback → an operator-provisioned
 * account (`admin.createUser`, no mail) signing in through Better Auth's
 * REAL `/sign-in/email`. Same topology as production:
 * the same fetch composition, the same handlers, the same options builder.
 * Uses the default in-memory capture (no `email` option) — the outbox-
 * readback path against a REAL email module local server is proved
 * separately in `email-outbox.integration.test.ts`.
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

  // Better Auth's default rate limiter keys its (module-global, in-process)
  // memory store on `${ip}|${path}`, and every local test server resolves
  // to the SAME ip (127.0.0.1) absent a forwarded-for header — so, within
  // one `bun test` process, this file's sign-in bucket would otherwise be
  // shared with every OTHER integration test file's local server. A
  // synthetic per-file client ip isolates the bucket; it changes nothing
  // about the pinned `rateLimit: { enabled: true }` behavior itself.
  const CLIENT_IP = '10.10.0.1';
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { 'x-forwarded-for': CLIENT_IP, ...(init.headers as Record<string, string>) },
    });
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

  test('signup creates the user and captures the RENDERED verification email', async () => {
    const res = await api(
      '/api/auth/sign-up/email',
      json({ email: EMAIL, password: PASSWORD, name: 'Ada' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string } };
    expect(body.user.email).toBe(EMAIL);
    userId = body.user.id;

    // sendOnSignUp: true + the default capture sender: the live verification
    // link AND its rendered content are readable, because the capture renders
    // through the real authTemplates rather than recording a bare url.
    const captured = server.capturedEmails.find((e) => e.template === 'verification');
    expect(captured?.to).toBe(EMAIL);
    expect(captured?.url).toContain(server.url);
    expect(captured?.subject).toBe('Verify your email address');
    // The href carries the HTML-escaped link (Better Auth's own url embeds a
    // `&callbackURL=` query param); the plain-text part carries it bare.
    expect(captured?.html).toContain(`href="${captured?.url.replaceAll('&', '&amp;')}"`);
    expect(captured?.text).toBe(captured?.url);
  });

  test('login is rejected before the email is verified (requireEmailVerification: true)', async () => {
    const res = await api('/api/auth/sign-in/email', json({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(403);
  });

  test('completing the captured verification link verifies the user', async () => {
    const captured = server.capturedEmails.find((e) => e.template === 'verification');
    if (captured === undefined) throw new Error('no verification email was captured');

    const res = await fetch(captured.url, { redirect: 'manual' });
    expect([200, 302]).toContain(res.status);

    const session = makeClient(authSessionContract, server.url);
    const { user } = await session.getUser({ id: userId });
    expect(user?.emailVerified).toBe(true);
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

  test("admin.createUser provisions an account Better Auth's own sign-in accepts", async () => {
    const admin = makeClient(authAdminContract, server.url);
    const emailsBefore = server.capturedEmails.length;

    const { user } = await admin.createUser({
      email: 'Grace@Example.com',
      name: 'Grace',
      password: 'hopper-cobol-1959',
      emailVerified: true,
    });
    expect(user.email).toBe('grace@example.com');
    expect(user.emailVerified).toBe(true);
    // No verification (or any other) mail: provisioning is silent.
    expect(server.capturedEmails).toHaveLength(emailsBefore);

    // The proof that the rows and the hash match what Better Auth expects:
    // its real sign-in endpoint accepts them. Own forwarded-for ip: the
    // earlier sign-ins above have used up this file's sign-in bucket.
    const fromGrace = { 'x-forwarded-for': '10.10.0.2' };
    const res = await api(
      '/api/auth/sign-in/email',
      json({ email: 'grace@example.com', password: 'hopper-cobol-1959' }, fromGrace),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string }; token: string };
    expect(body.user.id).toBe(user.id);

    const wrong = await api(
      '/api/auth/sign-in/email',
      json({ email: 'grace@example.com', password: 'not-the-password' }, fromGrace),
    );
    expect(wrong.status).toBe(401);
  });

  test('admin.createUser refuses a duplicate email as a THROWN rpc error', async () => {
    const admin = makeClient(authAdminContract, server.url);
    // Same address, different case — the refusal is case-insensitive, and
    // a typed client cannot mistake it for success the way a script
    // ignoring an HTTP status can. The client retries a 500 with backoff
    // before it throws, hence the timeout.
    await expect(
      admin.createUser({ email: 'GRACE@example.com', name: 'Grace again' }),
    ).rejects.toThrow('RPC call "createUser" failed: 500');
  }, 20_000);

  test('admin.createUser refuses a malformed email at the rpc boundary (400, no retries)', async () => {
    const admin = makeClient(authAdminContract, server.url);
    await expect(admin.createUser({ email: 'ops@example', name: 'Ops' })).rejects.toThrow(
      'RPC call "createUser" failed: 400',
    );
    expect(await admin.findUser({ email: 'ops@example' })).toEqual({ user: null });
  });

  test('admin.setEmailVerified flips the flag over rpc; null for an unknown id', async () => {
    const admin = makeClient(authAdminContract, server.url);
    const { user } = await admin.createUser({ email: 'linus@example.com', name: 'Linus' });
    expect(user.emailVerified).toBe(false);

    // Unverified: Better Auth's sign-in refuses even a right password — the
    // flag is what `requireEmailVerification: true` reads.
    const verified = await admin.setEmailVerified({ userId: user.id, emailVerified: true });
    expect(verified.user?.emailVerified).toBe(true);
    const back = await admin.setEmailVerified({ userId: user.id, emailVerified: false });
    expect(back.user?.emailVerified).toBe(false);
    expect(await admin.setEmailVerified({ userId: 'no-such-user', emailVerified: true })).toEqual({
      user: null,
    });
  });

  test('/health answers without auth; unknown paths fall through to 404', async () => {
    const health = await api('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    expect((await api('/nope')).status).toBe(404);
    expect((await api('/rpc/no-such-method', json({}))).status).toBe(404);
  });
});
