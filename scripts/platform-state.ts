/**
 * Reads what a deployed environment has on Prisma Cloud straight from the
 * Management API, for the e2e checks: the application topology on the
 * environment's Branch, and every App, Database and Bucket row of its Project.
 *
 * Env: PRISMA_SERVICE_TOKEN, and PRISMA_MANAGEMENT_API_URL to point elsewhere.
 */

import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { ApplicationTopologyNodeBody } from '../packages/1-prisma-cloud/0-lowering/lowering/src/builds/application-topology.ts';
import {
  layer,
  ManagementClient,
} from '../packages/1-prisma-cloud/0-lowering/lowering/src/client.ts';
import { resolveContainer } from '../packages/1-prisma-cloud/0-lowering/lowering/src/container.ts';
import { fromEnv } from '../packages/1-prisma-cloud/0-lowering/lowering/src/credentials.ts';
import { call, callOptional } from '../packages/1-prisma-cloud/0-lowering/lowering/src/http.ts';
import { collectPages } from '../packages/1-prisma-cloud/0-lowering/lowering/src/pagination.ts';
import type { PlatformRow, RowKind } from './platform-identity.ts';

export interface PlatformState {
  readonly projectId: string;
  readonly branchId: string;
  readonly nodes: readonly ApplicationTopologyNodeBody[];
  readonly rows: readonly PlatformRow[];
}

export interface PlatformStateInput {
  readonly workspaceId: string;
  readonly appName: string;
  readonly environment: string;
}

const program = (input: PlatformStateInput) =>
  Effect.gen(function* () {
    const container = yield* resolveContainer({
      workspaceId: input.workspaceId,
      appName: input.appName,
      ensure: false,
      environment: input.environment,
    });
    const { projectId } = container;
    const branchId = container.branchId ?? container.defaultBranchId;
    if (branchId === undefined) {
      return yield* Effect.fail(
        new Error(
          `project ${projectId} resolved no Branch for the environment ${input.environment}`,
        ),
      );
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

    type ListedRow = Omit<PlatformRow, 'kind' | 'appEndpointDomain'>;
    const query = (cursor: string | undefined) =>
      cursor === undefined ? { projectId } : { projectId, cursor };
    const apps = yield* collectPages(`apps of project ${projectId}`, (cursor) =>
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
    const rows: PlatformRow[] = [
      ...apps.map(({ id, branchId, logicalId, appEndpointDomain }) => ({
        kind: 'app' as const,
        id,
        branchId,
        logicalId,
        appEndpointDomain,
      })),
      ...rowsOf('database', databases),
      ...rowsOf('bucket', buckets),
    ];
    const state: PlatformState = { projectId, branchId, nodes: topology.data.nodes, rows };
    return state;
  });

/** The environment's topology and rows; rejects when it has no Branch or no topology. */
export function readPlatformState(input: PlatformStateInput): Promise<PlatformState> {
  return Effect.runPromise(
    program(input).pipe(Effect.provide(layer().pipe(Layer.provideMerge(fromEnv())))),
  );
}

/** Prints the topology and the rows, so a failed check shows what the platform held. */
export function logPlatformState(state: PlatformState): void {
  console.log(`Topology on branch ${state.branchId}:`);
  for (const node of state.nodes) console.log(`  ${node.kind} ${node.logicalId}`);
  console.log(`Rows in project ${state.projectId}:`);
  for (const row of state.rows) {
    console.log(`  ${row.kind} ${row.id} branch=${row.branchId} logicalId=${row.logicalId}`);
  }
}
