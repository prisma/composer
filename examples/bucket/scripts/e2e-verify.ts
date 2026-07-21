#!/usr/bin/env bun
/**
 * Resolves the bucket example's blobs service URL via the Management API,
 * then verifies an S3 round trip: PUT a test object, GET it back, assert the
 * body matches. Non-zero exit on any failure.
 * Requires PRISMA_SERVICE_TOKEN; STACK_NAME overrides the project name.
 */

import { createManagementApiClient } from '@prisma/management-api-sdk';

const POLL_DEADLINE_MS = 180_000;
const POLL_INTERVAL_MS = 6_000;

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
const service = services.data.find((s) => s.name === 'blobs');
const domain = service?.appEndpointDomain;
if (domain === undefined || domain.length === 0) {
  fail(`Project ${projectId} has no 'blobs' app with an endpoint domain.`);
}

const url = /^https?:\/\//.test(domain) ? domain.replace(/\/$/, '') : `https://${domain}`;
console.log(`Bucket blobs URL: ${url}`);

const testKey = `e2e-verify-${Date.now()}`;
const testBody = `round-trip-${Date.now()}`;
const deadline = Date.now() + POLL_DEADLINE_MS;
let lastError = '';

while (Date.now() < deadline) {
  try {
    // PUT the test object
    const putRes = await fetch(`${url}/blobs/${testKey}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: testBody,
      signal: AbortSignal.timeout(30_000),
    });
    if (!putRes.ok) {
      lastError = `PUT /blobs/${testKey} returned ${putRes.status}`;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    // GET it back and assert equality
    const getRes = await fetch(`${url}/blobs/${testKey}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!getRes.ok) {
      lastError = `GET /blobs/${testKey} returned ${getRes.status}`;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    const gotBody = await getRes.text();
    if (gotBody !== testBody) {
      fail(
        `Round trip body mismatch: expected ${JSON.stringify(testBody)}, got ${JSON.stringify(gotBody)}`,
      );
    }
    console.log(`Round trip OK — PUT then GET /blobs/${testKey} returned the expected body.`);

    // Not required for destroy (bucket deletion cascades to its contents),
    // but exercising DELETE keeps the verify a full CRUD round trip.
    const delRes = await fetch(`${url}/blobs/${testKey}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(30_000),
    });
    if (!delRes.ok) {
      fail(`DELETE /blobs/${testKey} returned ${delRes.status} — bucket destroy would fail.`);
    }
    console.log('Cleanup OK — test object deleted; bucket is empty for destroy.');
    process.exit(0);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
console.error(`Round trip never succeeded within the deadline. Last error: ${lastError}`);
process.exit(1);
