#!/usr/bin/env bun
/**
 * Deletes ONE project, by exact name, from the workspace the token belongs
 * to — live compute torn down first. This is the destroy-then-redeploy
 * cutover step for a deployment whose state predates ADR-0034 (deploy state
 * in the stage's Branch): the old workspace-level state is unreadable to the
 * current CLI, so the leftover resources are removed wholesale and the next
 * deploy recreates them under fresh state.
 *
 * Exits 0 when the project is gone — including when it never existed, so a
 * re-run after a partial failure is safe.
 */

import { deleteProjectDeep, type HttpCall, PROTECTED_PROJECT_NAMES } from './ci-cleanup-utils.ts';

const API = 'https://api.prisma.io/v1';

const token = process.env['PRISMA_SERVICE_TOKEN'];
if (token === undefined || token.length === 0) {
  console.error('PRISMA_SERVICE_TOKEN is required');
  process.exit(1);
}

const [name, extra] = process.argv.slice(2);
if (name === undefined || name.length === 0 || extra !== undefined) {
  console.error('Usage: delete-project.ts <exact-project-name>');
  process.exit(1);
}
if (PROTECTED_PROJECT_NAMES.includes(name)) {
  console.error(`"${name}" is a protected project name — refusing to delete it.`);
  process.exit(1);
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null;
}

async function findProjectByName(target: string): Promise<ProjectRow | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor !== undefined) query.set('cursor', cursor);
    const response = await fetch(`${API}/projects?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`GET /projects failed: ${response.status} ${await response.text()}`);
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body['data'])) return undefined;
    for (const entry of body['data']) {
      if (!isRecord(entry)) continue;
      const { id, name: rowName } = entry;
      if (typeof id === 'string' && rowName === target) return { id, name: target };
    }
    const pagination = isRecord(body['pagination']) ? body['pagination'] : undefined;
    const nextCursor = pagination?.['nextCursor'];
    if (pagination?.['hasMore'] !== true || typeof nextCursor !== 'string') return undefined;
    cursor = nextCursor;
  }
}

const http: HttpCall = async (method, path) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, ok: response.ok, body: await response.text() };
};

const project = await findProjectByName(name);
if (project === undefined) {
  console.log(`No project named "${name}" in this workspace — nothing to delete.`);
  process.exit(0);
}

console.log(`Deleting project "${project.name}" (${project.id})…`);
const deleted = await deleteProjectDeep(http, project, {
  log: (line) => console.error(line),
});
if (!deleted) {
  console.error(`Could not delete "${project.name}".`);
  process.exit(1);
}
console.log(`Deleted "${project.name}".`);
