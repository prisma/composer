import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import { ManagementClient } from '../client.ts';
import { call, callOptional, callVoid } from '../http.ts';

export type ComputeRegion =
  | 'us-east-1'
  | 'us-west-1'
  | 'eu-west-3'
  | 'eu-central-1'
  | 'ap-northeast-1'
  | 'ap-southeast-1';

export interface ComputeServiceProps {
  /** The project that will own this compute service. */
  projectId: string;
  name: string;
  region?: ComputeRegion;
}

export interface ComputeServiceAttributes {
  id: string;
  name: string;
  endpointDomain?: string;
}

export type ComputeService = Resource<
  'Prisma.ComputeService',
  ComputeServiceProps,
  ComputeServiceAttributes
>;

/** A Prisma **Compute service** — the stable app identity behind a project. */
export const ComputeService = Resource<ComputeService>('Prisma.ComputeService');

export const ComputeServiceProvider = () =>
  Provider.effect(
    ComputeService,
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      return {
        stables: ['id'],
        list: () => Effect.succeed([] as ComputeServiceAttributes[]),
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — a compute service is only findable by its saved id.
          const observed = output?.id
            ? yield* callOptional(() =>
                client.GET('/v1/compute-services/{computeServiceId}', {
                  params: { path: { computeServiceId: output.id } },
                }),
              )
            : undefined;
          if (observed) {
            return {
              id: observed.data.id,
              name: observed.data.name,
              endpointDomain: observed.data.serviceEndpointDomain,
            };
          }

          // Ensure — create it in the target project.
          const created = yield* call(() =>
            client.POST('/v1/projects/{projectId}/compute-services', {
              params: { path: { projectId: news.projectId } },
              body: { displayName: news.name, ...(news.region && { regionId: news.region }) },
            }),
          );
          return {
            id: created.data.id,
            name: created.data.name,
            endpointDomain: created.data.serviceEndpointDomain,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* callVoid(() =>
            client.DELETE('/v1/compute-services/{computeServiceId}', {
              params: { path: { computeServiceId: output.id } },
            }),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          const s = yield* callOptional(() =>
            client.GET('/v1/compute-services/{computeServiceId}', {
              params: { path: { computeServiceId: output.id } },
            }),
          );
          return s
            ? { id: s.data.id, name: s.data.name, endpointDomain: s.data.serviceEndpointDomain }
            : undefined;
        }),
      };
    }),
  );
