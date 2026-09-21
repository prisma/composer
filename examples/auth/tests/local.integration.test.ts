/**
 * The example's own wiring against `startLocalAuthServer` / `startLocalEmailServer`,
 * driven through the framework's integration seam. `bootstrapService` boots each
 * service's real built entry (`dist/{api,ops}/server.mjs`) in-process with its
 * dependency inputs pointed at the running local servers, so `service.load()`
 * hydrates the same client shapes a deploy would — no hand-built deps, no cloud
 * credentials.
 *
 * `email` is wired to `startLocalEmailServer`'s outbox — the SAME
 * `emailSender(authTemplates).connection.hydrate(...)` call a deploy graph
 * produces, no full `Load` graph needed. Signup requires verification
 * (`requireEmailVerification: true`), so this test reads the verification link
 * back through the ops service's own find-sent-email route (onto the email
 * module's outbox port) and follows it before logging in — the
 * module-depends-on-module proof this example exists to make.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { authTemplates } from '@prisma/composer-prisma-cloud/auth';
import type { LocalAuthServer } from '@prisma/composer-prisma-cloud/auth/testing';
import { startLocalAuthServer } from '@prisma/composer-prisma-cloud/auth/testing';
import { emailSender } from '@prisma/composer-prisma-cloud/email';
import type { LocalEmailServer } from '@prisma/composer-prisma-cloud/email/testing';
import { startLocalEmailServer } from '@prisma/composer-prisma-cloud/email/testing';
import type { BootstrappedService } from '@prisma/composer-prisma-cloud/testing';
import { bootstrapService } from '@prisma/composer-prisma-cloud/testing';
import apiService from '../src/api/service.ts';
import opsService from '../src/ops/service.ts';
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
const API_PORT = 4520;
const OPS_PORT = 4521;

describe.skipIf(pgServer === undefined)('the example wiring against startLocalAuthServer', () => {
  if (pgServer === undefined) return;
  let db: TestDatabase;
  let mailServer: LocalEmailServer;
  let auth: LocalAuthServer;
  let apiApp: BootstrappedService;
  let opsApp: BootstrappedService;

  const call = (app: BootstrappedService, path: string, init?: RequestInit) =>
    app.fetch(new URL(path, app.url), init);
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

    // Boot each service's real built entry with its inputs pointed at the local
    // servers — the framework hydrates the same client shapes a deploy would.
    apiApp = await bootstrapService(apiService, {
      service: { port: API_PORT },
      inputs: {
        authApi: { url: auth.url },
        verifier: { url: auth.url },
        session: { url: auth.url },
      },
    });
    opsApp = await bootstrapService(opsService, {
      service: { port: OPS_PORT },
      inputs: { admin: { url: auth.url }, outbox: { url: mailServer.url } },
    });
  });
  afterAll(async () => {
    await auth?.stop();
    await mailServer?.stop();
    await db?.drop().catch(() => {});
    pgServer.stop();
  });

  test('the full loop: signup → verify (via outbox) → login → token → /me → session → revoke → null → delete', async () => {
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

    // Self-service account deletion through the proxy, on a fresh sign-in.
    const fresh = await call(
      apiApp,
      '/api/auth/sign-in/email',
      json({ email: EMAIL, password: PASSWORD }),
    );
    const freshBearer = fresh.headers.get('set-auth-token') ?? '';
    const deleted = await call(
      apiApp,
      '/api/auth/delete-user',
      json({}, { authorization: `Bearer ${freshBearer}` }),
    );
    expect(deleted.status).toBe(200);
    const lookup = await call(opsApp, '/admin/find-user', json({ email: EMAIL }));
    expect(await lookup.json()).toEqual({ user: null });

    // The operator path is idempotent: the account is already gone.
    const removed = await call(opsApp, '/admin/remove-user', json({ userId }));
    expect(await removed.json()).toEqual({ removed: false });
  });

  test('/me rejects a missing or garbage bearer', async () => {
    expect((await call(apiApp, '/me')).status).toBe(401);
    expect(
      (await call(apiApp, '/me', { headers: { authorization: 'Bearer garbage' } })).status,
    ).toBe(401);
  });
});
