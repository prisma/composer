/**
 * `auth({ signUp: 'closed' })`, end to end against a real local Postgres:
 * Better Auth itself refuses `/sign-up/email`; a magic link for an unknown
 * email is still sent (1.6.24 sends before it checks) but completing it
 * redirects with `new_user_signup_disabled` and creates no user; while an
 * account provisioned through `admin.createUser` signs in as before, and a
 * magic link for THAT account still completes. Nothing about the origin /
 * CSRF posture changes — the same `trustedOrigins`, the same checks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { makeClient } from '@internal/service-rpc';
import { authAdminContract } from '../contract.ts';
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
    '[auth] skipping closed-sign-up integration test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

const EMAIL = 'invited@example.com';
const PASSWORD = 'invited-only-password';

describe.skipIf(pgServer === undefined)("startLocalAuthServer — signUp: 'closed'", () => {
  if (pgServer === undefined) return;
  let db: TestDatabase;
  let server: LocalAuthServer;

  // A per-file client ip keeps this file's rate-limit bucket apart from the
  // other integration suites' (see local-server.integration.test.ts).
  const CLIENT_IP = '10.10.0.3';
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { 'x-forwarded-for': CLIENT_IP, ...(init.headers as Record<string, string>) },
    });
  const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    db = await createTestDatabase(pgServer.url);
    server = await startLocalAuthServer({ databaseUrl: db.url, signUp: 'closed' });
  });
  afterAll(async () => {
    await server?.stop();
    await db?.drop().catch(() => {});
    pgServer.stop();
  });

  test('/sign-up/email is refused by Better Auth itself, and no user is written', async () => {
    const res = await api(
      '/api/auth/sign-up/email',
      json({ email: 'stranger@example.com', password: PASSWORD, name: 'Stranger' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');

    const admin = makeClient(authAdminContract, server.url);
    expect(await admin.findUser({ email: 'stranger@example.com' })).toEqual({ user: null });
  });

  test('a magic link for an unknown email completes to a refusal and creates nobody', async () => {
    const res = await api('/api/auth/sign-in/magic-link', json({ email: 'stranger@example.com' }));
    expect(res.status).toBe(200);
    const captured = server.capturedEmails.find(
      (e) => e.template === 'magicLink' && e.to === 'stranger@example.com',
    );
    if (captured === undefined) throw new Error('no magic-link email was captured');

    const complete = await fetch(captured.url, { redirect: 'manual' });
    expect(complete.status).toBe(302);
    expect(complete.headers.get('location') ?? '').toContain('error=new_user_signup_disabled');
    expect(complete.headers.get('set-cookie') ?? '').not.toContain('better-auth.session_token=');

    const admin = makeClient(authAdminContract, server.url);
    expect(await admin.findUser({ email: 'stranger@example.com' })).toEqual({ user: null });
  });

  test('an account provisioned through admin.createUser signs in, by password and by magic link', async () => {
    const admin = makeClient(authAdminContract, server.url);
    const { user } = await admin.createUser({
      email: EMAIL,
      name: 'Invited',
      password: PASSWORD,
      emailVerified: true,
    });

    const login = await api('/api/auth/sign-in/email', json({ email: EMAIL, password: PASSWORD }));
    expect(login.status).toBe(200);
    expect(((await login.json()) as { user: { id: string } }).user.id).toBe(user.id);

    const sent = await api('/api/auth/sign-in/magic-link', json({ email: EMAIL }));
    expect(sent.status).toBe(200);
    const captured = server.capturedEmails.find(
      (e) => e.template === 'magicLink' && e.to === EMAIL,
    );
    if (captured === undefined) throw new Error('no magic-link email was captured');
    const complete = await fetch(captured.url, { redirect: 'manual' });
    expect([200, 302]).toContain(complete.status);
    expect(complete.headers.get('location') ?? '').not.toContain('error=');
    expect(complete.headers.get('set-cookie') ?? '').toContain('better-auth.session_token=');
  });
});
