#!/usr/bin/env bun
/**
 * Verifies a DEPLOYED env-param example: resolves the echo service's URL via
 * the Management API (state is hosted, not local files), polls it until it
 * responds, and asserts three things about what arrived:
 *
 * - the greeting it serves is exactly the value the target environment's platform
 *   var carries (the param round trip),
 * - the environment it serves is "deployed to <environment>", which Load
 *   computed from the environment's name, and
 * - GET /logo.svg serves the asset that sits beside the entry in the built
 *   directory (the build adapter's directory form — proving assemble copied
 *   the whole tree, not just the entry).
 *
 *   EXPECTED_GREETING=… [ENV_PARAM_ENVIRONMENT=…] [ENV_PARAM_STACK_NAME=…] bun scripts/smoke.ts
 *
 * ENV_PARAM_ENVIRONMENT defaults to production, the Project's default Branch;
 * any other name resolves the Branch with that gitName and its app.
 * Requires PRISMA_SERVICE_TOKEN (run via `pnpm smoke:deployed`, which
 * sources the deploy env file).
 */

import { blindCast } from '@prisma/composer/casts';

const api = 'https://api.prisma.io/v1';
const token = process.env['PRISMA_SERVICE_TOKEN'];
if (token === undefined || token === '') {
  throw new Error('PRISMA_SERVICE_TOKEN is required to resolve the deployed URL');
}
const expected = process.env['EXPECTED_GREETING'];
if (expected === undefined || expected === '') {
  throw new Error(
    'EXPECTED_GREETING must carry the greeting the deployed environment should serve',
  );
}
const stack = process.env['ENV_PARAM_STACK_NAME'] ?? 'env-param-example';
const environment = process.env['ENV_PARAM_ENVIRONMENT'] || 'production';

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

const project = rows(await get('/projects?limit=100')).find((p) => p['name'] === stack);
if (project === undefined) throw new Error(`no project named "${stack}" in the workspace`);
const projectId = asId(project['id'], 'project.id');

const branches = rows(await get(`/projects/${projectId}/branches?limit=100`));
const branch =
  environment === 'production'
    ? branches.find((b) => b['isDefault'] === true)
    : branches.find((b) => b['gitName'] === environment);
if (branch === undefined) {
  throw new Error(
    environment === 'production'
      ? 'project has no default branch'
      : `project has no branch with gitName "${environment}"`,
  );
}
const branchId = asId(branch['id'], 'branch.id');

// App names are unique per Branch, so the project-level list holds an "echo" app for
// every environment — each row carries its branchId, which picks the
// right one.
const candidates = rows(await get(`/apps?projectId=${projectId}&limit=100`)).filter(
  (s) => s['name'] === 'echo',
);
const service = candidates.find((s) => s['branchId'] === branchId);
if (service === undefined) {
  throw new Error(
    `no "echo" app in the environment "${environment}" ` + `(candidates: ${candidates.length})`,
  );
}
const domain = service['appEndpointDomain'];
if (typeof domain !== 'string' || domain === '')
  throw new Error('service has no endpoint domain yet');
const url = domain.startsWith('http') ? domain : `https://${domain}/`;
console.log(`echo URL (${environment}): ${url}`);

/** The marker inside src/assets/logo.svg — served only if the asset shipped beside the entry. */
const assetMarker = 'prisma-composer-env-param-asset';
const assetUrl = new URL('/logo.svg', url).href;

// Poll: a version cold-starts after deploy (PRO-200).
const deadline = Date.now() + 180_000;
let last = '';
while (Date.now() < deadline) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    last = await res.text();
    const body = blindCast<
      { greeting?: string; environment?: string },
      'the echo service serves { greeting, environment }'
    >(JSON.parse(last));
    if (res.ok && body.greeting === expected) {
      console.log(`ok - ${environment} serves greeting ${JSON.stringify(expected)}`);

      if (body.environment !== `deployed to ${environment}`) {
        console.error(
          `FAIL - ${environment} serves environment ${JSON.stringify(body.environment)}, expected "deployed to ${environment}"`,
        );
        process.exit(1);
      }
      console.log(`ok - ${environment} serves environment "deployed to ${environment}"`);

      // The tree, not just the entry: fetch the entry's sibling asset. Only
      // checked once the service is up, so a cold start can't read as a
      // missing asset.
      const assetRes = await fetch(assetUrl, { signal: AbortSignal.timeout(30_000) });
      const asset = await assetRes.text();
      if (!assetRes.ok || !asset.includes(assetMarker)) {
        console.error(
          `FAIL - ${assetUrl} did not serve the asset that sits beside the entry ` +
            `(status ${assetRes.status}). The built directory did not arrive whole. ` +
            `Body: ${asset.slice(0, 500)}`,
        );
        process.exit(1);
      }
      console.log(`ok - ${assetUrl} serves the entry's sibling asset — the whole tree arrived`);
      process.exit(0);
    }
  } catch {
    // not up yet — retry
  }
  await Bun.sleep(6_000);
}
console.error(
  `FAIL - never served greeting ${JSON.stringify(expected)} within the deadline. Last body: ${last.slice(0, 500)}`,
);
process.exit(1);
