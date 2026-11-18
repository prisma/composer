#!/usr/bin/env bun
/**
 * ONE-OFF cutover for an app whose production environment was deployed by a
 * Composer version that kept deploy state elsewhere. Remove this script and
 * its workflow step once the docs deploy is green.
 *
 * `prisma deploy` refuses such an environment, and the documented remedy is
 * to delete it, which takes the app down. This keeps the app serving instead:
 * it renames the old Project, so the next deploy finds no Project for the app
 * and creates a fresh one beside it. The old Project keeps serving at its own
 * URL until someone deletes it.
 *
 * A deploy finds its Project by logical id first and by name second. Only a
 * Project with the app's name and no logical id is renamed; a Project that
 * carries the app's logical id is the fresh one and is left alone, so a
 * re-run changes nothing.
 */

const API = 'https://api.prisma.io/v1';

const token = process.env['PRISMA_SERVICE_TOKEN'];
if (token === undefined || token.length === 0) {
  console.error('PRISMA_SERVICE_TOKEN is required');
  process.exit(1);
}

const [appName, extra] = process.argv.slice(2);
if (appName === undefined || appName.length === 0 || extra !== undefined) {
  console.error('Usage: retire-legacy-project.ts <app-name>');
  process.exit(1);
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly logicalId: string | null;
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null;
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function listProjects(): Promise<readonly ProjectRow[]> {
  const projects: ProjectRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor !== undefined) query.set('cursor', cursor);
    const body = await request('GET', `/projects?${query}`);
    if (!isRecord(body) || !Array.isArray(body['data'])) return projects;
    for (const entry of body['data']) {
      if (!isRecord(entry)) continue;
      const { id, name, logicalId } = entry;
      if (typeof id !== 'string' || typeof name !== 'string') continue;
      projects.push({ id, name, logicalId: typeof logicalId === 'string' ? logicalId : null });
    }
    const pagination = isRecord(body['pagination']) ? body['pagination'] : undefined;
    const nextCursor = pagination?.['nextCursor'];
    if (pagination?.['hasMore'] !== true || typeof nextCursor !== 'string') return projects;
    cursor = nextCursor;
  }
}

async function retireLegacyProjects(name: string): Promise<void> {
  const projects = await listProjects();

  const fresh = projects.find((project) => project.logicalId === name);
  if (fresh !== undefined) {
    console.log(`Project ${fresh.id} carries the logical id "${name}". Nothing to retire.`);
    return;
  }

  const legacy = projects.filter((project) => project.name === name);
  if (legacy.length === 0) {
    console.log(`No project named "${name}" in this workspace. Nothing to retire.`);
    return;
  }

  for (const project of legacy) {
    const retiredName = `${name}-retired-${project.id.slice(-6)}`;
    await request('PATCH', `/projects/${project.id}`, { name: retiredName });
    console.log(`Renamed project ${project.id} from "${name}" to "${retiredName}".`);
  }
}

retireLegacyProjects(appName).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
