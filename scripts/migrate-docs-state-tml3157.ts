#!/usr/bin/env bun
/**
 * ONE-OFF migration for the docs site's deploy state (TML-3157). Remove this
 * script and its workflow step once the docs deploy is green.
 *
 * v0.6.0 scopes deploy state by the target Branch's id; the docs site's
 * existing state sits under the pre-0.6.0 scope (Alchemy's dev_${USER}
 * default), so the empty-scope guard stops the deploy. This performs the
 * remedy the guard's message prescribes: re-stage the docs stack's rows to
 * the default Branch's id, in that Branch's prisma-composer-state database.
 *
 * Idempotent: if the branch-id scope already holds the stack's rows, exits 0
 * without touching anything, so re-runs of the workflow stay green.
 */
import { createManagementApiClient } from '@prisma/management-api-sdk';
import postgres from 'postgres';

const PROJECT_NAME = 'composer-docs';
const STACK = 'composer-docs';
const STATE_DATABASE_NAME = 'prisma-composer-state';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const token = process.env['PRISMA_SERVICE_TOKEN'];
const workspaceId = process.env['PRISMA_WORKSPACE_ID'];
if (!token || !workspaceId) fail('PRISMA_SERVICE_TOKEN and PRISMA_WORKSPACE_ID must be set');

const client = createManagementApiClient({ token });

const projects = await client.GET('/v1/projects', { params: { query: { workspaceId } } });
if (projects.error) fail(`listing projects failed: ${JSON.stringify(projects.error)}`);
const project = projects.data.data.find((p) => p.name === PROJECT_NAME);
if (!project) fail(`no project named "${PROJECT_NAME}" in this workspace`);

const branches = await client.GET('/v1/projects/{projectId}/branches', {
  params: { path: { projectId: project.id } },
});
if (branches.error) fail(`listing branches failed: ${JSON.stringify(branches.error)}`);
const defaultBranch = branches.data.data.find((b) => b.isDefault);
if (!defaultBranch) fail(`project ${project.id} has no default Branch`);
const newStage = defaultBranch.id;

const databases = await client.GET('/v1/databases', {
  params: { query: { projectId: project.id, branchId: defaultBranch.id } },
});
if (databases.error) fail(`listing databases failed: ${JSON.stringify(databases.error)}`);
const stateDb = databases.data.data.find((d) => d.name === STATE_DATABASE_NAME);
if (!stateDb) fail(`no database named "${STATE_DATABASE_NAME}" on branch ${defaultBranch.id}`);

const created = await client.POST('/v1/databases/{databaseId}/connections', {
  params: { path: { databaseId: stateDb.id } },
  body: { name: `tml3157-migration-${Date.now()}` },
});
if (created.error) fail(`creating a connection failed: ${JSON.stringify(created.error)}`);
const connectionId = created.data.data.id;
const dsn = created.data.data.endpoints.direct?.connectionString;
if (!dsn) fail('connection has no direct connection string');

const sql = postgres(dsn, { max: 1, onnotice: () => {} });
try {
  const scopes = await sql`
    SELECT stack, stage, count(*)::int AS rows FROM (
      SELECT stack, stage FROM alchemy_resource_state
      UNION ALL
      SELECT stack, stage FROM alchemy_stack_output
    ) AS both_tables GROUP BY stack, stage ORDER BY stack, stage`;
  console.log('scopes present:', JSON.stringify(scopes));

  const stackScopes = scopes.filter((r) => r.stack === STACK);
  if (stackScopes.some((r) => r.stage === newStage)) {
    console.log(`scope "${newStage}" already holds "${STACK}" rows — nothing to migrate`);
  } else if (stackScopes.length === 0) {
    console.log(`no "${STACK}" rows in either table — nothing to migrate`);
  } else if (stackScopes.length > 1) {
    fail(
      `multiple legacy scopes for "${STACK}": ${stackScopes.map((r) => r.stage).join(', ')} — ` +
        'refusing to guess; clean up manually per the deploy guard message.',
    );
  } else {
    const oldStage = stackScopes[0]?.stage;
    if (typeof oldStage !== 'string') fail('unreachable: single legacy scope has no stage value');
    await sql.begin(async (tx) => {
      const a =
        await tx`UPDATE alchemy_resource_state SET stage = ${newStage} WHERE stack = ${STACK} AND stage = ${oldStage}`;
      const b =
        await tx`UPDATE alchemy_stack_output SET stage = ${newStage} WHERE stack = ${STACK} AND stage = ${oldStage}`;
      console.log(
        `migrated "${STACK}" from scope "${oldStage}" to "${newStage}": ` +
          `${a.count} resource row(s), ${b.count} output row(s)`,
      );
    });
  }
} finally {
  await sql.end();
  await client.DELETE('/v1/connections/{id}', { params: { path: { id: connectionId } } });
}
