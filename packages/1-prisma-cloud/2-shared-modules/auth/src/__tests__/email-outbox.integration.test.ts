/**
 * `startLocalAuthServer`'s `email` option accepts a real
 * `EmailSender<AuthTemplates>` hydrated against the email module's
 * OWN local stand-in (`startLocalEmailServer`) — the same
 * `emailSender(...).connection.hydrate(...)` call a deploy graph produces,
 * with no full `Load` graph required. This is the outbox-readback path
 * production uses, not the in-memory `capturedEmails` default (which
 * `local-server.integration.test.ts` covers). Signup → verify via the
 * outbox → login; magic-link → the outbox → a session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { emailOutboxContract, emailSender } from '@internal/email';
import { type LocalEmailServer, startLocalEmailServer } from '@internal/email/testing';
import { makeClient } from '@internal/service-rpc';
import { type LocalAuthServer, startLocalAuthServer } from '../execution/testing.ts';
import { authTemplates } from '../templates.ts';
import {
  createTestDatabase,
  SCHEMA_BOOTSTRAP_TIMEOUT_MS,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from './postgres-harness.ts';

const pgServer: TestPostgres | undefined = startTestPostgres();

if (pgServer === undefined) {
  console.warn(
    '[auth] skipping email-outbox integration test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

const EMAIL = 'outbox@example.com';
const PASSWORD = 'correct-horse-battery';

describe.skipIf(pgServer === undefined)(
  'startLocalAuthServer — email wired to the real outbox',
  () => {
    if (pgServer === undefined) return;
    let db: TestDatabase;
    let mailServer: LocalEmailServer;
    let auth: LocalAuthServer;
    let outbox: ReturnType<typeof makeClient<typeof emailOutboxContract>>;

    const api = (path: string, init?: RequestInit) => fetch(`${auth.url}${path}`, init);
    const json = (body: unknown, headers: Record<string, string> = {}) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    beforeAll(async () => {
      db = await createTestDatabase(pgServer.url);
      mailServer = await startLocalEmailServer();
      // The standalone hydrate a deploy graph would produce — no full Load()
      // graph needed, and no second hand-rolled email client.
      const email = await emailSender(authTemplates).connection.hydrate({ url: mailServer.url });
      auth = await startLocalAuthServer({ databaseUrl: db.url, email });
      outbox = makeClient(emailOutboxContract, mailServer.url);
    }, SCHEMA_BOOTSTRAP_TIMEOUT_MS);
    afterAll(async () => {
      await auth?.stop();
      await mailServer?.stop();
      await db?.drop().catch(() => {});
      pgServer.stop();
    });

    test('signup → verification email lands in the outbox; capturedEmails stays empty', async () => {
      const res = await api(
        '/api/auth/sign-up/email',
        json({ email: EMAIL, password: PASSWORD, name: 'Outbox' }),
      );
      expect(res.status).toBe(200);
      expect(auth.capturedEmails).toEqual([]);

      const { emails } = await outbox.listEmails({ to: EMAIL, templateId: 'verification' });
      expect(emails).toHaveLength(1);
      expect(emails[0]?.subject).toBe('Verify your email address');
      // startLocalEmailServer runs deliveryMode 'none' — the row is stored,
      // never dispatched to a real provider.
      expect(emails[0]?.status).toBe('stored');
    });

    test('login is rejected until the outbox link is followed, then succeeds', async () => {
      const rejected = await api(
        '/api/auth/sign-in/email',
        json({ email: EMAIL, password: PASSWORD }),
      );
      expect(rejected.status).toBe(403);

      const { emails } = await outbox.listEmails({ to: EMAIL, templateId: 'verification' });
      const link = emails[0]?.text;
      if (link === undefined || link === null)
        throw new Error('verification email carried no link');
      expect(link).toContain(auth.url);

      const verify = await fetch(link, { redirect: 'manual' });
      expect([200, 302]).toContain(verify.status);

      const login = await api(
        '/api/auth/sign-in/email',
        json({ email: EMAIL, password: PASSWORD }),
      );
      expect(login.status).toBe(200);
    });

    test('magic-link e2e: the outbox link establishes a session', async () => {
      const res = await api('/api/auth/sign-in/magic-link', json({ email: EMAIL }));
      expect(res.status).toBe(200);

      const { emails } = await outbox.listEmails({ to: EMAIL, templateId: 'magicLink' });
      expect(emails).toHaveLength(1);
      expect(emails[0]?.subject).toBe('Sign in to auth');
      const link = emails[0]?.text;
      if (link === undefined || link === null) throw new Error('magic-link email carried no link');

      const complete = await fetch(link, { redirect: 'manual' });
      expect([200, 302]).toContain(complete.status);
      expect(complete.headers.get('set-cookie') ?? '').toContain('better-auth.session_token=');
    });
  },
);
