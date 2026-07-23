#!/usr/bin/env bun
/**
 * Verifies a DEPLOYED auth example end to end: resolves the `api` and `ops`
 * services' URLs via the Management API, then drives the whole loop through
 * the app's OWN endpoints (never the module's ports directly):
 *
 *   signup → verify (read the outbox via ops's own route, follow the link)
 *   → login (bearer) → /api/auth/token → JWT-verified /me →
 *   session.getSession via the api service → admin revokeUserSessions via
 *   the ops service → getSession now null → /me STILL verifies (stateless
 *   JWT: revocation is the per-call opt-in).
 *
 * The email module runs `deliveryMode: none` on this stage (a junk
 * delivery credential, no real provider account — the same preview-stage
 * story as the email example) — the outbox readback is what proves a real
 * send happened, not just that Better Auth called the callback.
 *
 *   [AUTH_STACK_NAME=…] bun scripts/smoke.ts
 *
 * Requires PRISMA_SERVICE_TOKEN (run via `pnpm smoke:deployed`, which
 * sources the deploy env file).
 */
import { blindCast } from '@prisma/composer/casts';

const api = 'https://api.prisma.io/v1';
const token = process.env['PRISMA_SERVICE_TOKEN'];
if (token === undefined || token === '') {
  throw new Error('PRISMA_SERVICE_TOKEN is required to resolve the deployed URLs');
}
const stack = process.env['AUTH_STACK_NAME'] ?? 'auth-example';

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

const rows = (body: unknown): Record<string, unknown>[] =>
  blindCast<
    { data?: Record<string, unknown>[] },
    'every Management API collection endpoint returns { data: [...] }'
  >(body).data ?? [];

const asId = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value === '') throw new Error(`${what} is not a string id`);
  return value;
};

const project = rows(await get('/projects?limit=100')).find((p) => p['name'] === stack);
if (project === undefined) throw new Error(`no project named "${stack}" in the workspace`);
const projectId = asId(project['id'], 'project.id');

const branches = rows(await get(`/projects/${projectId}/branches?limit=100`));
const branch = branches.find((b) => b['isDefault'] === true);
if (branch === undefined) throw new Error('project has no default branch');
const branchId = asId(branch['id'], 'branch.id');

const apps = rows(await get(`/apps?projectId=${projectId}&limit=100`));
function urlOf(name: string): string {
  const app = apps.find((s) => s['name'] === name && s['branchId'] === branchId);
  if (app === undefined) throw new Error(`no "${name}" app on the production branch`);
  const domain = app['appEndpointDomain'];
  if (typeof domain !== 'string' || domain === '')
    throw new Error(`app "${name}" has no endpoint domain yet`);
  return (domain.startsWith('http') ? domain : `https://${domain}`).replace(/\/$/, '');
}
const apiUrl = urlOf('api');
const opsUrl = urlOf('ops');
console.log(`api URL: ${apiUrl}`);
console.log(`ops URL: ${opsUrl}`);

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}
function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

/** Smoke-scoped JSON projection: reads only the named fields; a wrong shape fails the check. */
const asJson = <T>(value: unknown): T =>
  blindCast<T, 'smoke assertions read only the named optional fields; absence fails the check'>(
    value,
  );

const email = `smoke-${Date.now()}@example.com`;
const password = 'correct-horse-battery-staple';
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

let userId = '';
let verificationLink = '';
let bearer = '';
let sessionToken = '';
let jwt = '';

await check('health: api and ops answer', async () => {
  expect((await fetch(`${apiUrl}/health`)).status === 200, 'api /health not 200');
  expect((await fetch(`${opsUrl}/health`)).status === 200, 'ops /health not 200');
});

await check('signup through the proxied /api/auth/sign-up/email', async () => {
  const res = await fetch(
    `${apiUrl}/api/auth/sign-up/email`,
    json({ email, password, name: 'Smoke' }),
  );
  expect(res.status === 200, `signup status ${res.status}`);
  const body = asJson<{ user?: { id?: string } }>(await res.json());
  userId = body.user?.id ?? '';
  expect(userId !== '', 'no user id in signup response');
});

await check(
  'login is rejected until the outbox link is followed (requireEmailVerification)',
  async () => {
    const res = await fetch(`${apiUrl}/api/auth/sign-in/email`, json({ email, password }));
    expect(
      res.status === 403,
      `expected sign-in to be rejected pre-verification, got ${res.status}`,
    );
  },
);

await check(
  'ops’s find-sent-email route reads the verification email back through the outbox port',
  async () => {
    const res = await fetch(
      `${opsUrl}/admin/find-sent-email`,
      json({ to: email, templateId: 'verification' }),
    );
    expect(res.status === 200, `find-sent-email status ${res.status}`);
    const body = asJson<{ subject?: string; text?: string | null }>(await res.json());
    expect(body.subject === 'Verify your email address', `unexpected subject: ${body.subject}`);
    const link = body.text ?? '';
    expect(link !== '', 'verification email carried no link');
    verificationLink = link;
  },
);

await check('following the outbox link verifies the address', async () => {
  const res = await fetch(verificationLink, { redirect: 'manual' });
  expect([200, 302].includes(res.status), `verify status ${res.status}`);
});

await check('login returns a bearer token and a session token', async () => {
  const res = await fetch(`${apiUrl}/api/auth/sign-in/email`, json({ email, password }));
  expect(res.status === 200, `login status ${res.status}`);
  bearer = res.headers.get('set-auth-token') ?? '';
  expect(bearer !== '', 'no set-auth-token header');
  sessionToken = asJson<{ token?: string }>(await res.json()).token ?? '';
  expect(sessionToken !== '', 'no session token in login response');
});

await check('/api/auth/token mints a JWT for the bearer session', async () => {
  const res = await fetch(`${apiUrl}/api/auth/token`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  expect(res.status === 200, `token status ${res.status}`);
  jwt = asJson<{ token?: string }>(await res.json()).token ?? '';
  expect(jwt !== '', 'no jwt in token response');
});

await check('/me verifies the JWT statelessly', async () => {
  const res = await fetch(`${apiUrl}/me`, { headers: { authorization: `Bearer ${jwt}` } });
  expect(res.status === 200, `/me status ${res.status}`);
  const body = asJson<{ userId?: string; email?: string }>(await res.json());
  expect(body.userId === userId, '/me userId mismatch');
  expect(body.email === email, '/me email mismatch');
});

await check('the session port answers through the api service', async () => {
  const res = await fetch(`${apiUrl}/session`, json({ token: sessionToken }));
  expect(res.status === 200, `/session status ${res.status}`);
  const body = asJson<{ user?: { id?: string } | null }>(await res.json());
  expect(body.user?.id === userId, 'session lookup did not return the user');
});

await check('the ops service finds the user through the admin port', async () => {
  const res = await fetch(`${opsUrl}/admin/find-user`, json({ email }));
  expect(res.status === 200, `find-user status ${res.status}`);
  const body = asJson<{ user?: { id?: string } | null }>(await res.json());
  expect(body.user?.id === userId, 'find-user did not return the user');
});

await check('revokeUserSessions through the ops service revokes the session', async () => {
  const res = await fetch(`${opsUrl}/admin/revoke-user-sessions`, json({ userId }));
  expect(res.status === 200, `revoke status ${res.status}`);
  const body = asJson<{ revokedCount?: number }>(await res.json());
  expect((body.revokedCount ?? 0) >= 1, `revokedCount ${body.revokedCount}`);
});

await check('getSession is now null — instant logout through the port', async () => {
  const res = await fetch(`${apiUrl}/session`, json({ token: sessionToken }));
  expect(res.status === 200, `/session status ${res.status}`);
  const body = asJson<{ session: unknown; user: unknown }>(await res.json());
  expect(body.session === null && body.user === null, 'session survived revocation');
});

await check('/me STILL verifies — stateless JWTs outlive revocation until expiry', async () => {
  const res = await fetch(`${apiUrl}/me`, { headers: { authorization: `Bearer ${jwt}` } });
  expect(res.status === 200, `/me status ${res.status}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
