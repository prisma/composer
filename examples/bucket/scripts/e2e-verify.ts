#!/usr/bin/env bun
/**
 * Resolves the bucket example's blobs service URL via the Management API,
 * checks `GET /health`, then verifies an S3 round trip: PUT a test object, GET
 * it back, assert the body matches. Every request is logged with its status and
 * timing. On failure the message names the hop that failed: Prisma Cloud
 * routing to the service, or the service's call to its bucket.
 * Requires PRISMA_SERVICE_TOKEN; STACK_NAME overrides the project name.
 */

import { createManagementApiClient } from '@prisma/management-api-sdk';

const POLL_DEADLINE_MS = 180_000;
const POLL_INTERVAL_MS = 6_000;
const HEALTH_TIMEOUT_MS = 10_000;
// Above the service's worst case: two storage attempts of 3 s connect + 5 s request.
const REQUEST_TIMEOUT_MS = 25_000;

const token = process.env['PRISMA_SERVICE_TOKEN'];
if (token === undefined || token.length === 0) {
  console.error('PRISMA_SERVICE_TOKEN is required');
  process.exit(1);
}
const stack = process.env['STACK_NAME'] ?? 'bucket-example';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const client = createManagementApiClient({ token });

async function findProjectId(name: string): Promise<string | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const { data: page, error } = await client.GET('/v1/projects', {
      params: { query: cursor === undefined ? {} : { cursor } },
    });
    if (error !== undefined || page === undefined) {
      fail(`GET /v1/projects failed: ${JSON.stringify(error)}`);
    }
    const match = page.data.find((p) => p.name === name);
    if (match !== undefined) return match.id;
    if (!page.pagination.hasMore || page.pagination.nextCursor === null) return undefined;
    cursor = page.pagination.nextCursor;
  }
}

const projectId = await findProjectId(stack);
if (projectId === undefined) fail(`No project named '${stack}' in the workspace.`);

const { data: services, error } = await client.GET('/v1/apps', {
  params: { query: { projectId } },
});
if (error !== undefined || services === undefined) {
  fail(`GET /v1/apps?projectId=${projectId} failed: ${JSON.stringify(error)}`);
}
const service = services.data.find((s) => s.logicalId === `${stack}.blobs`);
const domain = service?.appEndpointDomain;
if (domain === undefined || domain.length === 0) {
  fail(`Project ${projectId} has no '${stack}.blobs' app with an endpoint domain.`);
}

const url = /^https?:\/\//.test(domain) ? domain.replace(/\/$/, '') : `https://${domain}`;
console.log(`Bucket blobs URL: ${url}`);

type Attempt =
  | { kind: 'response'; res: Response; text: string; ms: number }
  | { kind: 'no-response'; error: string; ms: number };

async function attempt(
  method: string,
  path: string,
  timeoutMs: number,
  body?: string,
): Promise<Attempt> {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${url}${path}`, {
      method,
      ...(body !== undefined ? { body, headers: { 'content-type': 'text/plain' } } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const ms = Date.now() - startedAt;
    console.log(`${method} ${path} -> ${res.status} in ${ms} ms`);
    return { kind: 'response', res, text, ms };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.log(`${method} ${path} -> no response after ${ms} ms (${error})`);
    return { kind: 'no-response', error, ms };
  }
}

function describe(path: string, result: Attempt, serviceIsHealthy: boolean): string {
  if (result.kind === 'response') {
    const hop =
      result.res.status === 502 || result.res.status === 504 ? 'the storage call' : 'the service';
    return `${path} returned ${result.res.status} (failed hop: ${hop}): ${result.text.slice(0, 500)}`;
  }
  const hop = serviceIsHealthy
    ? 'the service answered /health but not this request, so the service or its storage call hung'
    : 'Prisma Cloud routing to the service';
  return `${path} got no response after ${result.ms} ms (failed hop: ${hop}): ${result.error}`;
}

const sleep = () => new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
const deadline = Date.now() + POLL_DEADLINE_MS;
let lastError = '';

let healthy = false;
while (!healthy && Date.now() < deadline) {
  const health = await attempt('GET', '/health', HEALTH_TIMEOUT_MS);
  healthy = health.kind === 'response' && health.res.ok;
  if (!healthy) {
    lastError = describe('GET /health', health, false);
    await sleep();
  }
}
if (!healthy)
  fail(`The service never answered /health within the deadline. Last error: ${lastError}`);

const testKey = `e2e-verify-${Date.now()}`;
const testBody = `round-trip-${Date.now()}`;
const objectPath = `/blobs/${testKey}`;

while (Date.now() < deadline) {
  const put = await attempt('PUT', objectPath, REQUEST_TIMEOUT_MS, testBody);
  if (put.kind === 'no-response' || !put.res.ok) {
    lastError = describe(`PUT ${objectPath}`, put, true);
    await sleep();
    continue;
  }

  const get = await attempt('GET', objectPath, REQUEST_TIMEOUT_MS);
  if (get.kind === 'no-response' || !get.res.ok) {
    lastError = describe(`GET ${objectPath}`, get, true);
    await sleep();
    continue;
  }
  if (get.text !== testBody) {
    fail(
      `Round trip body mismatch: expected ${JSON.stringify(testBody)}, got ${JSON.stringify(get.text)}`,
    );
  }
  console.log(`Round trip OK — PUT then GET ${objectPath} returned the expected body.`);

  // Not required for destroy (bucket deletion cascades to its contents),
  // but exercising DELETE keeps the verify a full CRUD round trip.
  const del = await attempt('DELETE', objectPath, REQUEST_TIMEOUT_MS);
  if (del.kind === 'no-response' || !del.res.ok) fail(describe(`DELETE ${objectPath}`, del, true));
  console.log('Cleanup OK — test object deleted; bucket is empty for destroy.');
  process.exit(0);
}
console.error(`Round trip never succeeded within the deadline. Last error: ${lastError}`);
process.exit(1);
