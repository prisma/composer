import * as Effect from 'effect/Effect';
import type { ApplicationTopologyNodeBody } from './builds/application-topology.ts';
import { type ManagementApiClient, ManagementClient } from './client.ts';
import { resolveContainer } from './container.ts';
import { call, callOptional } from './http.ts';
import { collectPages } from './pagination.ts';

export interface ReadDeployedInput {
  readonly workspaceId: string;
  readonly appName: string;
  /** The environment to read. */
  readonly environment: string;
}

export interface DeployedRow {
  readonly id: string;
  readonly logicalId: string | null;
}

export interface DeployedServiceRow extends DeployedRow {
  readonly appEndpointDomain: string;
}

/** What one environment has on Prisma Cloud: its application topology and the platform rows on its Branch. With no topology (none written, or no nodes) every list is empty. */
export interface DeployedEnvironment {
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
      environment: input.environment,
    });
    const { projectId } = container;
    const branchId = container.branchId ?? container.defaultBranchId;
    if (branchId === undefined) {
      return yield* Effect.die(new Error(`project ${projectId} resolved no Branch`));
    }
    const client = yield* ManagementClient;

    const topology = yield* callOptional(() =>
      client.GET('/v1/projects/{projectId}/branches/{branchId}/application-topology', {
        params: { path: { projectId, branchId } },
      }),
    );
    if (topology === undefined || topology.data.nodes.length === 0) {
      const empty: DeployedEnvironment = {
        projectId,
        branchId,
        nodes: [],
        services: [],
        databases: [],
        buckets: [],
      };
      return empty;
    }

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

    const deployed: DeployedEnvironment = {
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
    return deployed;
  });

/**
 * Reads what an environment has deployed: its Project and Branch by the same
 * find-only lookup `destroy` uses, the application topology the last deploy
 * wrote, and the Branch's services, databases and buckets. `undefined` when
 * there is no Project or no Branch. Rejects on any other Management API
 * failure.
 */
export async function readDeployedEnvironment(
  client: ManagementApiClient,
  input: ReadDeployedInput,
): Promise<DeployedEnvironment | undefined> {
  return Effect.runPromise(
    program(input).pipe(
      Effect.catchTag('ContainerNotFoundError', () => Effect.succeed(undefined)),
      Effect.catchTag('DefaultBranchUnderAnotherNameError', (error) =>
        Effect.fail(new Error(error.message)),
      ),
      Effect.catchTag('PrismaApiError', (error) =>
        Effect.fail(new Error(`Prisma Management API error: ${error.message}.`)),
      ),
      Effect.provideService(ManagementClient, client),
    ),
  );
}
