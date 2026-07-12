import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';
import { ManagementClient } from '../client.ts';
import { call, callOptional, callVoid, type PrismaApiError } from '../http.ts';

/**
 * Stopping a deployment before the compute service that owns it can be
 * deleted is asynchronous on the platform's side: DELETE can 409 with this
 * message while the deployment is still winding down. Retrying blindly on
 * every API error would mask real failures (bad auth, a genuinely conflicting
 * state, etc.), so this only matches the platform's specific "not delete-safe
 * yet" wording — everything else fails immediately, as before.
 */
export const isDeleteNotSafeYet = (error: PrismaApiError): boolean =>
  error.message.includes('did not reach a delete-safe state');

/**
 * Backs off exponentially from 2s, capped at 5 minutes total — long enough
 * for the platform to finish stopping the deployment, short enough to still
 * fail loudly (rather than hang forever) if it never does.
 */
export const deleteSafeRetrySchedule = Schedule.both(
  Schedule.exponential('2 seconds', 2),
  Schedule.during('5 minutes'),
);

/** Every region Prisma Compute serves — the runtime source of truth; `ComputeRegion` is derived from it so the two can never drift. */
export const COMPUTE_REGIONS = [
  'us-east-1',
  'us-west-1',
  'eu-west-3',
  'eu-central-1',
  'ap-northeast-1',
  'ap-southeast-1',
] as const;

export type ComputeRegion = (typeof COMPUTE_REGIONS)[number];

export interface ComputeServiceProps {
  /** The project that will own this compute service. */
  projectId: string;
  name: string;
  region?: ComputeRegion;
  /** When set, the Branch this compute service is attached to (named-stage deploys). */
  branchId?: string;
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

          // Create on the target Branch via the create body — NOT a later PATCH.
          // Compute-service names are unique per Branch, so a project-scoped create
          // lands on the default Branch and collides with the same-named production
          // service there (a live-deploy find).
          const created = yield* call(() =>
            client.POST('/v1/projects/{projectId}/compute-services', {
              params: { path: { projectId: news.projectId } },
              body: {
                displayName: news.name,
                ...(news.region && { regionId: news.region }),
                ...(news.branchId !== undefined && { branchId: news.branchId }),
              },
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
          ).pipe(Effect.retry({ schedule: deleteSafeRetrySchedule, while: isDeleteNotSafeYet }));
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
