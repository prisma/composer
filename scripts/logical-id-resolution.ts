#!/usr/bin/env bun
/**
 * E2E proof that logical-id resolution works against real infrastructure.
 *
 * Scenario 1 — rename-proof adoption: creates a project with a unique
 * logical id, renames its display name to something unrelated, then runs
 * resolveContainer with the original logical id and asserts the same project
 * id is returned. Only logical-id matching can pass — the display-name
 * fallback would miss and create a duplicate.
 *
 * Scenario 2 — duplicate rejection: verifies the platform enforces logical-id
 * uniqueness per workspace (409 on a second project with the same logical id).
 *
 * Cleanup runs in a finally block regardless of outcome.
 */

import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { layer as managementClientLayer } from '../packages/1-prisma-cloud/0-lowering/lowering/src/client.ts';
import { resolveContainer } from '../packages/1-prisma-cloud/0-lowering/lowering/src/container.ts';
import { fromEnv } from '../packages/1-prisma-cloud/0-lowering/lowering/src/credentials.ts';
import { deleteProjectDeep, type HttpCall } from './ci-cleanup-utils.ts';

const API = 'https://api.prisma.io/v1';

const token = process.env['PRISMA_SERVICE_TOKEN'];
const workspaceId = process.env['PRISMA_WORKSPACE_ID'];
if (!token || !workspaceId) {
  console.error('PRISMA_SERVICE_TOKEN and PRISMA_WORKSPACE_ID are required');
  process.exit(1);
}

const runId = process.env['GITHUB_RUN_ID'] ?? `local-${process.pid}`;
const logicalId = `resolver-ci-${runId}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function apiJson(
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  const json: unknown = await res.json();
  const data = isRecord(json) ? json['data'] : undefined;
  if (!isRecord(data))
    throw new Error(`${method} ${path} returned unexpected body: ${JSON.stringify(json)}`);
  return data;
}

async function apiRaw(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${API}${path}`, init);
}

async function countWorkspaceProjects(): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor !== undefined) query.set('cursor', cursor);
    const res = await fetch(`${API}/projects?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GET /projects failed: ${res.status} ${await res.text()}`);
    const json: unknown = await res.json();
    if (!isRecord(json) || !Array.isArray(json['data'])) break;
    count += (json['data'] as unknown[]).length;
    const pagination = isRecord(json['pagination']) ? json['pagination'] : undefined;
    const nextCursor = pagination?.['nextCursor'];
    if (pagination?.['hasMore'] !== true || typeof nextCursor !== 'string') break;
    cursor = nextCursor;
  }
  return count;
}

const http: HttpCall = async (method, path) => {
  const res = await apiRaw(method, path);
  return { status: res.status, ok: res.ok, body: await res.text() };
};

let createdProjectId: string | undefined;

try {
  console.log(`Creating project — logicalId="${logicalId}"…`);
  const created = await apiJson('POST', '/projects', {
    name: logicalId,
    workspaceId,
    createDatabase: false,
    logicalId,
  });
  const projectId = created['id'];
  if (typeof projectId !== 'string') throw new Error('POST /projects returned no id');
  createdProjectId = projectId;
  console.log(`  created: ${projectId}`);

  const renamedName = `renamed-ci-${runId}`;
  console.log(`Renaming display name to "${renamedName}" so it no longer matches the logical id…`);
  await apiJson('PATCH', `/projects/${projectId}`, { name: renamedName });
  console.log('  renamed.');

  // Scenario 1: logical-id match survives a display-name change.
  console.log('Scenario 1: resolving by logical id after display-name rename…');
  const countBefore = await countWorkspaceProjects();

  const layers = managementClientLayer().pipe(Layer.provideMerge(fromEnv()));
  const resolved = await Effect.runPromise(
    resolveContainer({ workspaceId, appName: logicalId }).pipe(Effect.provide(layers)),
  );

  if (resolved.projectId !== projectId) {
    throw new Error(
      `Scenario 1 FAILED: resolver returned "${resolved.projectId}", expected "${projectId}". ` +
        'The display-name fallback was used instead of the logical-id match, or a new project was created.',
    );
  }
  const countAfter = await countWorkspaceProjects();
  if (countAfter !== countBefore) {
    throw new Error(
      `Scenario 1 FAILED: project count changed from ${countBefore} to ${countAfter}. ` +
        'The resolver created a new project instead of adopting the renamed one by logical id.',
    );
  }
  console.log(`  PASS: resolved to ${resolved.projectId}, no new project created.`);

  // Scenario 2: the platform rejects a second project with the same logical id.
  console.log(`Scenario 2: creating a duplicate with logicalId="${logicalId}"…`);
  const dupRes = await apiRaw('POST', '/projects', {
    name: `dup-ci-${runId}`,
    workspaceId,
    createDatabase: false,
    logicalId,
  });
  if (dupRes.status !== 409) {
    throw new Error(
      `Scenario 2 FAILED: expected 409 but got ${dupRes.status}. ` +
        'The platform did not reject a duplicate logical id.',
    );
  }
  console.log('  PASS: platform returned 409 for duplicate logicalId.');

  console.log('All scenarios passed.');
} finally {
  if (createdProjectId !== undefined) {
    console.log(`Cleaning up project ${createdProjectId}…`);
    await deleteProjectDeep(
      http,
      { id: createdProjectId, name: logicalId },
      {
        log: (line) => console.error(line),
      },
    );
    console.log('  cleanup done.');
  }
}
