#!/usr/bin/env bun
/**
 * Polls the deployed storefront until it renders the storefront -> auth round
 * trip: `auth.verify()` returns true, and `auth.sign()` returns the
 * HMAC-SHA256 of a random challenge keyed with AUTH_SIGNING_SECRET. A correct
 * signature proves the platform variable reached the auth service.
 *
 * Finds the storefront URL through the Management API, or takes it from
 * STOREFRONT_URL (for example a local `prisma dev` run).
 * Env: AUTH_SIGNING_SECRET; PRISMA_SERVICE_TOKEN unless STOREFRONT_URL is set;
 * STACK_NAME overrides the project name (default storefront-auth).
 */

import { createHmac, randomBytes } from 'node:crypto';
import { type } from 'arktype';

const API = 'https://api.prisma.io/v1';
const POLL_DEADLINE_MS = 180_000;
const POLL_INTERVAL_MS = 6_000;

const Projects = type({ data: type({ id: 'string', name: 'string' }).array() });
const Apps = type({
  data: type({ logicalId: 'string', 'appEndpointDomain?': 'string | null' }).array(),
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) fail(`${name} is required`);
  return value;
}

async function getJson(path: string, token: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) fail(`GET ${path} failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function storefrontUrl(): Promise<string> {
  const override = process.env['STOREFRONT_URL'];
  if (override !== undefined && override.length > 0) return override;

  const token = requiredEnv('PRISMA_SERVICE_TOKEN');
  const stack = process.env['STACK_NAME'] ?? 'storefront-auth';
  const projects = Projects.assert(await getJson('/projects?limit=100', token));
  const project = projects.data.find((p) => p.name === stack);
  if (project === undefined) fail(`No project named '${stack}' in the workspace.`);

  const apps = Apps.assert(await getJson(`/apps?projectId=${project.id}&limit=100`, token));
  const domain = apps.data.find((a) => a.logicalId === `${stack}.storefront`)?.appEndpointDomain;
  if (domain === undefined || domain === null || domain.length === 0) {
    fail(`Project ${project.id} has no '${stack}.storefront' app with an endpoint domain.`);
  }
  return /^https?:\/\//.test(domain) ? domain : `https://${domain}/`;
}

const signingSecret = requiredEnv('AUTH_SIGNING_SECRET');
const challenge = randomBytes(16).toString('hex');
const expectedSignature = createHmac('sha256', signingSecret).update(challenge).digest('hex');

const baseUrl = await storefrontUrl();
console.log(`Storefront URL: ${baseUrl}`);
const url = new URL(baseUrl);
url.searchParams.set('challenge', challenge);

const deadline = Date.now() + POLL_DEADLINE_MS;
let lastBody = '';
while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    lastBody = (await response.text()).replaceAll('<!-- -->', '');
    if (
      lastBody.includes('Auth /verify says: true') &&
      lastBody.includes(`Auth /sign says: ${expectedSignature}`)
    ) {
      console.log(
        'Round trip OK: auth.verify() returned true and auth.sign() signed the challenge with AUTH_SIGNING_SECRET.',
      );
      process.exit(0);
    }
  } catch (error) {
    lastBody = error instanceof Error ? error.message : String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}
console.error(
  "The storefront never rendered 'Auth /verify says: true' and the expected signature within the deadline. Last body:",
);
console.error(lastBody.slice(0, 3000));
process.exit(1);
