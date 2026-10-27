import * as Effect from 'effect/Effect';
import type { ApplicationTopologyNodeBody } from './builds/application-topology.ts';
import { type ManagementApiClient, ManagementClient } from './client.ts';
import { resolveContainer } from './container.ts';
import { call, callOptional } from './http.ts';
import { collectPages } from './pagination.ts';

export interface ReadDeployedInput {
  readonly workspaceId: string;
  readonly appName: string;
  /** A named stage; omit for production. */
  readonly stage?: string | undefined;
}

export interface DeployedRow {
  readonly id: string;
  readonly logicalId: string | null;
}

export interface DeployedServiceRow extends DeployedRow {
  readonly appEndpointDomain: string;
}

/** What one stage has on Prisma Cloud: its application topology and the platform rows on its Branch. */
export interface DeployedStage {
  readonly projectId: string;
  readonly branchId: string;
  readonly nodes: readonly Pick<
    ApplicationTopologyNodeBody,
    'logicalId' | 'parentLogicalId' | 'kind' | 'type'
  >[];
  readonly services: readonly DeployedServiceRow[];
  readonly databases: readonly DeployedRow[];
  readonly buckets: readonly DeployedRow[];
}

const program = (input: ReadDeployedInput) =>
  Effect.gen(function* () {
    const container = yield* resolveContainer({
      workspaceId: input.workspaceId,
      appName: input.appName,
      ensure: false,
      ...(input.stage === undefined ? {} : { stage: input.stage }),
    });
    const { projectId } = container;
    const branchId = container.branchId ?? container.defaultBranchId;
    if (branchId === undefined) return undefined;
    const client = yield* ManagementClient;

    const topology = yield* callOptional(() =>
      client.GET('/v1/projects/{projectId}/branches/{branchId}/application-topology', {
        params: { path: { projectId, branchId } },
      }),
    );
    if (topology === undefined || topology.data.nodes.length === 0) return undefined;

    const query = (cursor: string | undefined) =>
      cursor === undefined ? { projectId, branchId } : { projectId, branchId, cursor };
    const services = yield* collectPages(`services of branch ${branchId}`, (cursor) =>
      call(() => client.GET('/v1/services', { params: { query: query(cursor) } })),
    );
    const databases = yield* collectPages(`databases of branch ${branchId}`, (cursor) =>
      call(() => client.GET('/v1/databases', { params: { query: query(cursor) } })),
    );
    const buckets = yield* collectPages(`buckets of branch ${branchId}`, (cursor) =>
      call(() => client.GET('/v1/buckets', { params: { query: query(cursor) } })),
    );

    const stage: DeployedStage = {
      projectId,
      branchId,
      nodes: topology.data.nodes.map(({ logicalId, parentLogicalId, kind, type }) => ({
        logicalId,
        parentLogicalId,
        kind,
        ...(type === undefined ? {} : { type }),
      })),
      services: services.map(({ id, logicalId, appEndpointDomain }) => ({
        id,
        logicalId,
        appEndpointDomain,
      })),
      databases: databases.map(({ id, logicalId }) => ({ id, logicalId })),
      buckets: buckets.map(({ id, logicalId }) => ({ id, logicalId })),
    };
    return stage;
  });

/**
 * Reads what a stage has deployed: its Project and Branch by the same
 * find-only lookup `destroy` uses, the application topology the last deploy
 * wrote, and the Branch's services, databases and buckets. `undefined` when
 * there is no Project, no Branch, or no topology. Rejects on any other
 * Management API failure.
 */
export async function readDeployedStage(
  client: ManagementApiClient,
  input: ReadDeployedInput,
): Promise<DeployedStage | undefined> {
  return Effect.runPromise(
    program(input).pipe(
      Effect.catchTag('ContainerNotFoundError', () => Effect.succeed(undefined)),
      Effect.catchTag('PrismaApiError', (error) =>
        Effect.fail(new Error(`Prisma Management API error: ${error.message}.`)),
      ),
      Effect.provideService(ManagementClient, client),
    ),
  );
}
