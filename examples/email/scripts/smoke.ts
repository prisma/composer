#!/usr/bin/env bun
/**
 * Verifies a DEPLOYED email example end to end (spec's end-to-end
 * requirement): resolves the mailer service's URL via the Management API,
 * `POST`s to the mailer's OWN `/signup` endpoint (never the email module's
 * `send` port directly), reads the stored verification body back through
 * the mailer's OWN `/emails/:id` endpoint, extracts the rendered link, and
 * follows it — proving the link a recipient would actually click works,
 * not just that a send happened — then reads the resulting welcome email
 * back the same way. Proves the `none`-mode preview-stage story: a real
 * deploy with a junk credential, no Resend account.
 *
 *   [EMAIL_STACK_NAME=…] bun scripts/smoke.ts
 *
 * Requires PRISMA_SERVICE_TOKEN (run via `pnpm smoke:deployed`, which
 * sources the deploy env file).
 */
import { blindCast } from '@prisma/composer/casts';

const api = 'https://api.prisma.io/v1';
const token = process.env['PRISMA_SERVICE_TOKEN'];
if (token === undefined || token === '') {
  throw new Error('PRISMA_SERVICE_TOKEN is required to resolve the deployed URL');
}
const stack = process.env['EMAIL_STACK_NAME'] ?? 'email-example';

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

/** The list shape every Management API collection endpoint returns; only `data` is read. */
const rows = (body: unknown): Record<string, unknown>[] =>
  blindCast<
    { data?: Record<string, unknown>[] },
    'every Management API collection endpoint returns { data: [...] }'
  >(body).data ?? [];

const asId = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value === '') throw new Error(`${what} is not a string id`);
  return value;
};

/** Every check's fetch shares this bound — a hung deployed service fails the run instead of blocking indefinitely. */
const FETCH_TIMEOUT_MS = 30_000;

const project = rows(await get('/projects?limit=100')).find((p) => p['name'] === stack);
if (project === undefined) throw new Error(`no project named "${stack}" in the workspace`);
const projectId = asId(project['id'], 'project.id');

const branches = rows(await get(`/projects/${projectId}/branches?limit=100`));
const branch = branches.find((b) => b['isDefault'] === true);
if (branch === undefined) throw new Error('project has no default branch');
const branchId = asId(branch['id'], 'branch.id');

const candidates = rows(await get(`/apps?projectId=${projectId}&limit=100`)).filter(
  (s) => s['name'] === 'mailer',
);
const service = candidates.find((s) => s['branchId'] === branchId);
if (service === undefined) {
  throw new Error(`no "mailer" app on the production branch (candidates: ${candidates.length})`);
}
const domain = service['appEndpointDomain'];
if (typeof domain !== 'string' || domain === '')
  throw new Error('service has no endpoint domain yet');
const baseUrl = (domain.startsWith('http') ? domain : `https://${domain}`).replace(/\/$/, '');
console.log(`mailer URL: ${baseUrl}`);

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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** A cold start after deploy (PRO-200) — poll until the app answers at all; the route doesn't exist, so any response (a 404) proves it's up without touching the email module. */
async function waitUntilUp(): Promise<void> {
  const deadline = Date.now() + 180_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.status > 0) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(6_000);
  }
  throw new Error(`mailer never came up within the deadline: ${String(lastError)}`);
}

async function main(): Promise<void> {
  await waitUntilUp();

  const marker = `smoke-${Date.now()}@example.com`;
  let verificationId = '';
  let verifyLink = '';
  let welcomeId = '';

  await check('POST /signup (the mailer’s own endpoint) sends the verification email', async () => {
    const res = await fetch(`${baseUrl}/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: marker, name: 'Smoke Test' }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    const body = blindCast<{ id: string }, 'the mailer responds with the verification send’s id'>(
      await res.json(),
    );
    verificationId = body.id;
  });

  await check(
    'GET /emails/:id reads the stored verification body back and carries the rendered link',
    async () => {
      const res = await fetch(`${baseUrl}/emails/${verificationId}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const email = blindCast<
        { templateId: string; status: string; html: string },
        'the mailer proxies the outbox port’s email record unchanged'
      >(await res.json());
      assert(
        email.templateId === 'verification',
        `expected templateId "verification", got "${email.templateId}"`,
      );
      assert(
        email.status === 'stored',
        `expected status "stored" (mode none), got "${email.status}"`,
      );
      const link = email.html.match(/href="([^"]+)"/)?.[1] ?? '';
      assert(link.length > 0, `rendered body carried no link: ${email.html}`);
      verifyLink = link;
    },
  );

  await check(
    'following the rendered link (GET /verify) marks the user verified and sends the welcome email',
    async () => {
      const res = await fetch(verifyLink, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = blindCast<
        { verified: boolean; id: string },
        'the mailer responds with { verified, id }'
      >(await res.json());
      assert(body.verified === true, 'expected verified: true');
      welcomeId = body.id;
    },
  );

  await check('GET /emails/:id reads the welcome email back through the outbox port', async () => {
    const res = await fetch(`${baseUrl}/emails/${welcomeId}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const email = blindCast<
      { templateId: string; subject: string; status: string },
      'the mailer proxies the outbox port’s email record unchanged'
    >(await res.json());
    assert(
      email.templateId === 'welcome',
      `expected templateId "welcome", got "${email.templateId}"`,
    );
    assert(email.subject === 'Welcome, Smoke Test!', `unexpected subject: ${email.subject}`);
    assert(email.status === 'stored', `expected status "stored", got "${email.status}"`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
