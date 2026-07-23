/**
 * The example's own wiring against `startLocalAuthServer` — the api and ops
 * apps driven with bindings shaped exactly as the framework hydrates them
 * (authApi client, jwtVerifier over the local JWKS, rpc clients), no cloud
 * credentials.
 *
 * `email` is wired to `startLocalEmailServer`'s outbox — the SAME
 * `emailSender(authTemplates).connection.hydrate(...)` call a deploy graph
 * produces, no full `Load` graph needed. Signup requires verification
 * (`requireEmailVerification: true`), so this test reads the verification
 * link back through the email module's outbox port (not the in-memory
 * `capturedEmails` capture) and follows it before logging in — the
 * module-depends-on-module proof this example exists to make.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { makeClient } from '@prisma/composer/service-rpc';
import {
  authAdminContract,
  authSessionContract,
  authTemplates,
  jwtVerifier,
} from '@prisma/composer-prisma-cloud/auth';
import type { LocalAuthServer } from '@prisma/composer-prisma-cloud/auth/testing';
import { startLocalAuthServer } from '@prisma/composer-prisma-cloud/auth/testing';
import { emailOutboxContract, emailSender } from '@prisma/composer-prisma-cloud/email';
import type { LocalEmailServer } from '@prisma/composer-prisma-cloud/email/testing';
import { startLocalEmailServer } from '@prisma/composer-prisma-cloud/email/testing';
import { createApiApp } from '../src/api/app.ts';
import { createOpsApp } from '../src/ops/app.ts';
import {
  createTestDatabase,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from './pg-harness.ts';

const pgServer: TestPostgres | undefined = startTestPostgres();

if (pgServer === undefined) {
  console.warn(
    '[example-auth] skipping local integration test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

const EMAIL = 'local@example.com';
const PASSWORD = 'correct-horse-battery';

describe.skipIf(pgServer === undefined)('the example wiring against startLocalAuthServer', () => {
  if (pgServer === undefined) return;
  let db: TestDatabase;
  let mailServer: LocalEmailServer;
  let auth: LocalAuthServer;
  let apiApp: (request: Request) => Promise<Response>;
  let opsApp: (request: Request) => Promise<Response>;

  const call = (app: (request: Request) => Promise<Response>, path: string, init?: RequestInit) =>
    app(new Request(`https://app.example${path}`, init));
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    db = await createTestDatabase(pgServer.url);
    mailServer = await startLocalEmailServer();
    const email = await emailSender(authTemplates).connection.hydrate({ url: mailServer.url });
    auth = await startLocalAuthServer({ databaseUrl: db.url, email });

    // The same binding shapes the framework hydrates in the deployed app.
    apiApp = createApiApp({
      authApi: { url: auth.url, fetch: (path, init) => fetch(new URL(path, auth.url), init) },
      verifier: await jwtVerifier().connection.hydrate({ url: auth.url }),
      session: makeClient(authSessionContract, auth.url),
    });
    opsApp = createOpsApp({
      admin: makeClient(authAdminContract, auth.url),
      outbox: makeClient(emailOutboxContract, mailServer.url),
    });
  });
  afterAll(async () => {
    await auth?.stop();
    await mailServer?.stop();
    await db?.drop().catch(() => {});
    pgServer.stop();
  });

  test('the full loop: signup → verify (via outbox) → login → token → /me → session → revoke → null', async () => {
    const signup = await call(
      apiApp,
      '/api/auth/sign-up/email',
      json({ email: EMAIL, password: PASSWORD, name: 'L' }),
    );
    expect(signup.status).toBe(200);
    const userId = ((await signup.json()) as { user: { id: string } }).user.id;

    // Login is rejected until verified — requireEmailVerification: true.
    const rejected = await call(
      apiApp,
      '/api/auth/sign-in/email',
      json({ email: EMAIL, password: PASSWORD }),
    );
    expect(rejected.status).toBe(403);

    // Read the sent email back through the ops app's OWN route (never the
    // outbox port directly) — the same shape the deployed smoke script uses.
    const sentEmail = await call(
      opsApp,
      '/admin/find-sent-email',
      json({ to: EMAIL, templateId: 'verification' }),
    );
    expect(sentEmail.status).toBe(200);
    const link = ((await sentEmail.json()) as { text: string | null }).text;
    if (link === undefined || link === null) throw new Error('verification email carried no link');
    const verify = await fetch(link, { redirect: 'manual' });
    expect([200, 302]).toContain(verify.status);

    const login = await call(
      apiApp,
      '/api/auth/sign-in/email',
      json({ email: EMAIL, password: PASSWORD }),
    );
    expect(login.status).toBe(200);
    const bearer = login.headers.get('set-auth-token') ?? '';
    const sessionToken = ((await login.json()) as { token: string }).token;

    const tokenRes = await call(apiApp, '/api/auth/token', {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(tokenRes.status).toBe(200);
    const jwt = ((await tokenRes.json()) as { token: string }).token;

    const me = await call(apiApp, '/me', { headers: { authorization: `Bearer ${jwt}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { userId: string }).userId).toBe(userId);

    const session = await call(apiApp, '/session', json({ token: sessionToken }));
    expect(((await session.json()) as { user: { id: string } | null }).user?.id).toBe(userId);

    const found = await call(opsApp, '/admin/find-user', json({ email: EMAIL.toUpperCase() }));
    expect(((await found.json()) as { user: { id: string } | null }).user?.id).toBe(userId);

    const revoked = await call(opsApp, '/admin/revoke-user-sessions', json({ userId }));
    expect(((await revoked.json()) as { revokedCount: number }).revokedCount).toBeGreaterThan(0);

    const gone = await call(apiApp, '/session', json({ token: sessionToken }));
    expect(await gone.json()).toEqual({ session: null, user: null });

    // The stateless trade-off: the JWT still verifies until it expires.
    const stillMe = await call(apiApp, '/me', { headers: { authorization: `Bearer ${jwt}` } });
    expect(stillMe.status).toBe(200);
  });

  test('/me rejects a missing or garbage bearer', async () => {
    expect((await call(apiApp, '/me')).status).toBe(401);
    expect(
      (await call(apiApp, '/me', { headers: { authorization: 'Bearer garbage' } })).status,
    ).toBe(401);
  });
});
