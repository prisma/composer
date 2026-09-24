import { createManagementApiClient } from '@prisma/management-api-sdk';

const token = process.env['PRISMA_SERVICE_TOKEN'];
const stackName = process.env['STACK_NAME'];
if (!token || !stackName) throw new Error('PRISMA_SERVICE_TOKEN and STACK_NAME are required.');

const client = createManagementApiClient({ token });
let cursor: string | undefined;
let projectId: string | undefined;
do {
  const { data, error } = await client.GET('/v1/projects', {
    params: { query: cursor ? { cursor } : {} },
  });
  if (error || !data) throw new Error(`Could not list projects: ${JSON.stringify(error)}`);
  projectId = data.data.find((project) => project.name === stackName)?.id;
  cursor = data.pagination.hasMore ? (data.pagination.nextCursor ?? undefined) : undefined;
} while (!projectId && cursor);
if (!projectId) throw new Error(`Deployed project ${stackName} was not found.`);

const { data: apps, error } = await client.GET('/v1/apps', {
  params: { query: { projectId } },
});
if (error || !apps) throw new Error(`Could not list apps: ${JSON.stringify(error)}`);
const domain = apps.data.find((app) => app.name === 'web')?.appEndpointDomain;
if (!domain) throw new Error(`Project ${stackName} has no web endpoint.`);
const origin = /^https?:\/\//.test(domain) ? domain.replace(/\/$/, '') : `https://${domain}`;

const deadline = Date.now() + 120_000;
let lastError = '';
while (Date.now() < deadline) {
  try {
    const [page, health] = await Promise.all([
      fetch(origin, { signal: AbortSignal.timeout(15_000) }),
      fetch(`${origin}/health`, { signal: AbortSignal.timeout(15_000) }),
    ]);
    if (
      page.ok &&
      (await page.text()).includes('Composer framework adapter') &&
      health.ok &&
      (await health.text()).trim() === 'ok'
    ) {
      console.log(`Framework Vite page and health passed at ${origin}`);
      process.exit(0);
    }
    lastError = `page=${page.status}, health=${health.status}`;
  } catch (cause) {
    lastError = cause instanceof Error ? cause.message : String(cause);
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
throw new Error(`Framework Vite did not become healthy: ${lastError}`);
