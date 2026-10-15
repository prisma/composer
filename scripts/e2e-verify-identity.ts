#!/usr/bin/env bun
/**
 * After a real deploy, checks that the stage Branch's App, Database and Bucket
 * rows carry the same `logicalId`s as the service and resource nodes of the
 * application topology the deploy submitted (ADR-0051). A mismatch would make
 * every Console lookup silently find nothing, so it fails here instead.
 *
 * Env: STACK_NAME (the `prisma deploy --name` value), PRISMA_SERVICE_TOKEN,
 * PRISMA_WORKSPACE_ID, and STAGE for a named stage (omit for the default one).
 */

import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import {
  layer,
  ManagementClient,
} from '../packages/1-prisma-cloud/0-lowering/lowering/src/client.ts';
import { resolveContainer } from '../packages/1-prisma-cloud/0-lowering/lowering/src/container.ts';
import { fromEnv } from '../packages/1-prisma-cloud/0-lowering/lowering/src/credentials.ts';
import { call, callOptional } from '../packages/1-prisma-cloud/0-lowering/lowering/src/http.ts';
import { collectPages } from '../packages/1-prisma-cloud/0-lowering/lowering/src/pagination.ts';
import { identityMismatches, type PlatformRow, type RowKind } from './platform-identity.ts';

const stackName = process.env['STACK_NAME'];
const workspaceId = process.env['PRISMA_WORKSPACE_ID'];
const stage = process.env['STAGE'] || undefined;
if (!stackName || !workspaceId) {
  console.error('STACK_NAME and PRISMA_WORKSPACE_ID are required');
  process.exit(1);
}

const program = Effect.gen(function* () {
  const container = yield* resolveContainer({
    workspaceId,
    appName: stackName,
    ensure: false,
    ...(stage === undefined ? {} : { stage }),
  });
  const { projectId } = container;
  const branchId = container.branchId ?? container.defaultBranchId;
  if (branchId === undefined) {
    return yield* Effect.fail(new Error(`project ${projectId} resolved no stage Branch`));
  }
  const client = yield* ManagementClient;

  const topology = yield* callOptional(() =>
    client.GET('/v1/projects/{projectId}/branches/{branchId}/application-topology', {
      params: { path: { projectId, branchId } },
    }),
  );
  if (topology === undefined || topology.data.nodes.length === 0) {
    return yield* Effect.fail(
      new Error(
        `branch ${branchId} has no application topology: the deploy did not submit one (its log shows a warning about failing to "record this deploy's application topology")`,
      ),
    );
  }

  type ListedRow = Omit<PlatformRow, 'kind'>;
  const query = (cursor: string | undefined) =>
    cursor === undefined ? { projectId } : { projectId, cursor };
  const apps: readonly ListedRow[] = yield* collectPages(`apps of project ${projectId}`, (cursor) =>
    call(() => client.GET('/v1/apps', { params: { query: query(cursor) } })),
  );
  const databases: readonly ListedRow[] = yield* collectPages(
    `databases of project ${projectId}`,
    (cursor) => call(() => client.GET('/v1/databases', { params: { query: query(cursor) } })),
  );
  const buckets: readonly ListedRow[] = yield* collectPages(
    `buckets of project ${projectId}`,
    (cursor) => call(() => client.GET('/v1/buckets', { params: { query: query(cursor) } })),
  );
  const rowsOf = (kind: RowKind, listed: readonly ListedRow[]): PlatformRow[] =>
    listed.map(({ id, branchId, logicalId }) => ({ kind, id, branchId, logicalId }));
  const rows = [
    ...rowsOf('app', apps),
    ...rowsOf('database', databases),
    ...rowsOf('bucket', buckets),
  ];

  const nodes = topology.data.nodes;
  console.log(`Topology on branch ${branchId}:`);
  for (const node of nodes) console.log(`  ${node.kind} ${node.logicalId}`);
  console.log(`Rows in project ${projectId}:`);
  for (const row of rows) {
    console.log(`  ${row.kind} ${row.id} branch=${row.branchId} logicalId=${row.logicalId}`);
  }

  const problems = identityMismatches(nodes, rows, branchId);
  if (problems.length > 0) {
    return yield* Effect.fail(new Error(`Platform identity mismatch:\n  ${problems.join('\n  ')}`));
  }
  console.log('Every service, database and bucket row carries its topology node logicalId.');
});

await Effect.runPromise(program.pipe(Effect.provide(layer().pipe(Layer.provideMerge(fromEnv())))));
