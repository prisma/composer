#!/usr/bin/env bun
/**
 * Resolves the orm-demo service's deployed URL via the typed Management API
 * client, then polls it until it returns `{"ok":true,...}` — a live round trip
 * through the Prisma ORM typed client against the migrated schema.
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
const stack = process.env['STACK_NAME'] ?? 'orm-demo';

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

// The post-promote endpoint domain is the servable one; by the time this runs,
// deploy + promote have completed, so the app read returns the real domain.
const { data: services, error } = await client.GET('/v1/apps', {
  params: { query: { projectId } },
});
if (error !== undefined || services === undefined) {
  fail(`GET /v1/apps?projectId=${projectId} failed: ${JSON.stringify(error)}`);
}
const service = services.data.find((s) => s.name === 'widgets');
const domain = service?.appEndpointDomain;
if (domain === undefined || domain.length === 0) {
  fail(`Project ${projectId} has no 'widgets' app with an endpoint domain.`);
}

// appEndpointDomain may arrive WITH the https:// scheme; tolerate either.
const url = /^https?:\/\//.test(domain) ? domain : `https://${domain}/`;
console.log(`orm-demo URL: ${url}`);

const deadline = Date.now() + POLL_DEADLINE_MS;
let lastBody = '';
while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    lastBody = await response.text();
    if (lastBody.includes('"ok":true')) {
      console.log('Round trip OK — the typed Prisma ORM client inserted + read a Widget:');
      console.log(lastBody);
      process.exit(0);
    }
  } catch (error) {
    lastBody = error instanceof Error ? error.message : String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}
console.error('Round trip never returned {"ok":true} within the deadline. Last body:');
console.error(lastBody.slice(0, 3000));
process.exit(1);
