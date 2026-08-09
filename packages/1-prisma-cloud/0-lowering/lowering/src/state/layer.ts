import { blindCast } from '@internal/foundation/casts';
import { Stack, type StackServices } from 'alchemy';
import {
  makeHttpStateStore,
  type PersistedState,
  type ReplacedResourceState,
  State,
  type StateService,
} from 'alchemy/State';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest';
import * as client from '../client.ts';
import { resolveDefaultBranchId } from '../container.ts';
import * as credentials from '../credentials.ts';
import { failOnEmptyScopeWithLiveResources, scopeOccupied } from './empty-scope.ts';
import { hostedStateBootstrapError } from './errors.ts';
import {
  acquireDeployLease,
  heartbeatDeployLease,
  LEASE_HEADER,
  redactLeaseHeader,
  releaseDeployLease,
} from './lease.ts';
import { migrateLegacyResourceState } from './legacy-resources.ts';

/**
 * The hosted Alchemy state store: alchemy's stock HTTP state client pointed
 * at the platform state API
 * (`/v1/projects/{projectId}/branches/{branchId}/alchemy-state`). On layer
 * init (scoped, once per stack run): resolve the stage's Branch, acquire the
 * (stack, stage) deploy lease, fork its heartbeat, run the migration guard,
 * and build the stock store. Finalizers (reverse order): interrupt the
 * heartbeat, release the lease. The Management API plumbing
 * (`ManagementClient`, `PrismaCredentials`) and the store's `HttpClient` are
 * provided internally, so the returned layer's only requirements are the
 * ones alchemy itself already provides to every state store
 * (`StackServices`).
 *
 * Any bootstrap failure is wrapped into an operator-facing
 * `HostedStateBootstrapError` (naming the Project/Branch and the step that
 * failed — see `errors.ts`) before dying the layer (loud, immediate,
 * unrecoverable) rather than surfacing as a typed error — matching core's
 * `LowerOptions.state: Layer.Layer<State, never, StackServices>` contract
 * and alchemy's own convention (e.g. a missing state store is `Effect.die`
 * in `Stack.make`).
 */
export const prismaStateLayer = (ids: {
  readonly projectId: string;
  readonly branchId?: string;
  /** The project's default Branch id, when the deploy targets the default stage — skips re-resolving it. */
  readonly defaultBranchId?: string;
}): Layer.Layer<State, never, StackServices> =>
  // The origin comes from the same resolver upstream's providers use
  // (credentials.managementApiBaseUrl), so PRISMA_API_URL moves the state
  // client and the resource providers together, never one without the other.
  Layer.unwrap(
    credentials.managementApiBaseUrl().pipe(Effect.map((origin) => stateLayerAgainst(origin, ids))),
  ).pipe(Layer.orDie);

/**
 * The stock service with legacy Composer resource rows rewritten to the
 * upstream providers' shapes as they are read (see legacy-resources.ts) —
 * reads only; rows written by this version are already upstream-shaped.
 */
const migrateRowsOnRead = (service: StateService): StateService => ({
  ...service,
  get: (request) =>
    Effect.map(service.get(request), (value) =>
      value === undefined
        ? undefined
        : blindCast<
            PersistedState,
            'migrateLegacyResourceState only rewrites legacy Composer resource rows to the upstream field names; every other value passes through unchanged, so the PersistedState shape is preserved'
          >(migrateLegacyResourceState(value)),
    ),
  getReplacedResources: (request) =>
    Effect.map(service.getReplacedResources(request), (rows) =>
      rows.map((row) =>
        blindCast<
          ReplacedResourceState,
          'migrateLegacyResourceState only rewrites legacy Composer resource rows to the upstream field names; the replaced status and envelope shape are preserved'
        >(migrateLegacyResourceState(row)),
      ),
    ),
});

/** `prismaStateLayer` with the API origin injectable — split out so tests can point it at a fake state API. */
export const stateLayerAgainst = (
  apiOrigin: string,
  ids: {
    readonly projectId: string;
    readonly branchId?: string;
    readonly defaultBranchId?: string;
  },
): Layer.Layer<State, never, StackServices> => {
  const { projectId, branchId, defaultBranchId } = ids;
  const dependencies = client.layer({ apiOrigin }).pipe(Layer.provideMerge(credentials.fromEnv()));

  return Layer.effect(
    State,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const container = branchId === undefined ? projectId : `${projectId}/${branchId}`;
      const bootstrapError = (step: string) => (cause: unknown) =>
        hostedStateBootstrapError(container, step, cause);

      const mgmt = yield* client.ManagementClient;
      const { token } = yield* credentials.PrismaCredentials;

      // A named stage carries its branchId; production carries defaultBranchId —
      // re-resolved via the Management API only when neither is present.
      const stateBranchId =
        branchId ??
        defaultBranchId ??
        (yield* resolveDefaultBranchId(mgmt, projectId).pipe(
          Effect.mapError(bootstrapError('resolving the stage branch')),
        ));

      const scope = { projectId, branchId: stateBranchId, stack: stack.name, stage: stack.stage };

      const lease = yield* acquireDeployLease(mgmt, scope).pipe(
        Effect.mapError(bootstrapError('acquiring the deploy lease')),
      );
      yield* Effect.addFinalizer(() => releaseDeployLease(mgmt, scope, lease));
      yield* Effect.forkScoped(heartbeatDeployLease(mgmt, scope, lease));

      // Before the store exists — so the check precedes Alchemy's first state
      // read. An empty scope with live resources (apps, databases, buckets)
      // on the Branch means the stage predates the platform state API (or a
      // foreign deployment): refuse before Alchemy mutates any resource.
      const occupied = yield* scopeOccupied(mgmt, scope, lease).pipe(
        Effect.mapError(bootstrapError('probing the deploy state scope')),
      );
      if (!occupied) {
        yield* failOnEmptyScopeWithLiveResources(
          projectId,
          stateBranchId,
          stack.name,
          stack.stage,
        ).pipe(
          Effect.provideService(client.ManagementClient, mgmt),
          Effect.mapError(bootstrapError('checking the empty deploy state scope')),
        );
      }

      const service = yield* makeHttpStateStore({
        url: `${apiOrigin}/v1/projects/${projectId}/branches/${stateBranchId}/alchemy-state`,
        authToken: Redacted.value(token),
        transformClient: (req) =>
          HttpClientRequest.setHeader(req, LEASE_HEADER, Redacted.value(lease.leaseId)),
        id: 'prisma-postgres',
      }).pipe(Effect.provide(FetchHttpClient.layer));

      return Effect.succeed(migrateRowsOnRead(service));
    }).pipe(Effect.provide(dependencies)),
  ).pipe(Layer.orDie, Layer.merge(redactLeaseHeader));
};
