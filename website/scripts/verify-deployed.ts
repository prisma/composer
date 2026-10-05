#!/usr/bin/env bun
/**
 * Resolves the deployed docs site's URL and proves it actually serves.
 *
 * Two reasons this exists rather than trusting the deploy's exit code. A green
 * deploy does not mean a serving site (PRO-200: a compute service can report a
 * successful deploy and a permanently 404ing domain). And the URL is a
 * generated service id, so without printing it a CI run gives no way to tell
 * where it just published.
 *
 * The project and service names are read off module.ts / src/service.ts rather
 * than repeated here as strings, so each name has one definition instead of a
 * second copy to keep in sync.
 */
import { appendFile } from 'node:fs/promises';
import { createManagementApiClient } from '@prisma/management-api-sdk';
import app from '../module.ts';
import siteService from '../src/service.ts';

const POLL_DEADLINE_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const token = process.env['PRISMA_SERVICE_TOKEN'];
if (token === undefined || token.length === 0) {
  fail('PRISMA_SERVICE_TOKEN is required (in CI it is mapped from CI_SITE_DEPLOY_TOKEN).');
}

const client = createManagementApiClient({ token });

async function findProjectId(name: string): Promise<string | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const { data, error } = await client.GET('/v1/projects', {
      params: { query: cursor === undefined ? {} : { cursor } },
    });
    if (error !== undefined || data === undefined) {
      fail(`GET /v1/projects failed: ${JSON.stringify(error)}`);
    }
    const match = data.data.find((p) => p.name === name);
    if (match !== undefined) return match.id;
    if (!data.pagination.hasMore || data.pagination.nextCursor === null) return undefined;
    cursor = data.pagination.nextCursor;
  }
}

const projectId = await findProjectId(app.name);
if (projectId === undefined) {
  fail(`No project named '${app.name}' in this workspace — nothing has been deployed here.`);
}

const { data: services, error } = await client.GET('/v1/apps', {
  params: { query: { projectId } },
});
if (error !== undefined || services === undefined) {
  fail(`GET /v1/apps?projectId=${projectId} failed: ${JSON.stringify(error)}`);
}

let matches = services.data.filter((s) => s.name === siteService.name);
if (matches.length === 0) {
  fail(`Project '${app.name}' has no '${siteService.name}' app.`);
}
if (matches.length > 1) {
  // Same-named apps on other Branches are stage deploys; production is the
  // one on the project's default Branch.
  const { data: branches, error: branchesError } = await client.GET(
    '/v1/projects/{projectId}/branches',
    { params: { path: { projectId } } },
  );
  if (branchesError !== undefined || branches === undefined) {
    fail(`GET /v1/projects/${projectId}/branches failed: ${JSON.stringify(branchesError)}`);
  }
  const defaultBranchId = branches.data.find((b) => b.isDefault)?.id;
  matches = matches.filter((s) => s.branchId === defaultBranchId);
  if (matches.length !== 1) {
    fail(
      `Project '${app.name}' has ${matches.length} '${siteService.name}' apps on its default ` +
        'Branch, so production cannot be identified. Tear down the stray stage(s) ' +
        '(`DOCS_STAGE=<name> pnpm run destroy` in website/) and re-run.\n' +
        matches.map((s) => `  - ${s.id} ${s.appEndpointDomain}`).join('\n'),
    );
  }
}

const domain = matches[0]?.appEndpointDomain;
if (domain === undefined || domain.length === 0) {
  fail(`The '${siteService.name}' app has no endpoint domain yet.`);
}

// appEndpointDomain may arrive with or without the scheme; tolerate either.
const url = /^https?:\/\//.test(domain) ? domain.replace(/\/$/, '') : `https://${domain}`;
console.log(`Docs site: ${url}`);

/** Returns undefined when the route is healthy, else why it isn't. */
async function probe(path: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return `${path} -> HTTP ${res.status}`;
    const body = await res.text();
    // Every page carries this in its <title>, meta description and footer —
    // all from template.ts's shell, never from a guide's markdown, so editing
    // the docs cannot break this check. Its absence means something other than
    // the site answered: an edge 404 page, or a placeholder region (PRO-200).
    if (!body.includes('Prisma Composer')) return `${path} -> 200 but did not serve the docs`;
    return undefined;
  } catch (err) {
    return `${path} -> ${err instanceof Error ? err.message : String(err)}`;
  }
}

const deadline = Date.now() + POLL_DEADLINE_MS;
let last = '';
for (;;) {
  // The landing page and a guide route exercise both of the server's routes.
  const problems = (await Promise.all([probe('/'), probe('/guides/getting-started')])).filter(
    (p): p is string => p !== undefined,
  );

  if (problems.length === 0) {
    console.log('Smoke check passed — the landing page and a guide route both serve the docs.');
    const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
    if (summaryFile !== undefined && summaryFile.length > 0) {
      await appendFile(summaryFile, `### Docs site deployed\n\n<${url}>\n`);
    }
    process.exit(0);
  }

  last = problems.join('; ');
  if (Date.now() >= deadline) break;
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

fail(`The site did not serve within ${POLL_DEADLINE_MS / 1000}s. Last attempt: ${last}`);
