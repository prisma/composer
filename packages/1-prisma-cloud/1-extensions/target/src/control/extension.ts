/**
 * The extension's control-plane entry (ADR-0017) — the only place
 * @internal/lowering is imported; loaded only by `prisma-composer.config.ts`.
 */

import type { ExtensionDescriptor, StateDescriptor } from '@internal/core/config';
import type { ProvisionerDescriptor } from '@internal/core/deploy';
import { blindCast } from '@internal/foundation/casts';
import * as Prisma from '@internal/lowering';
/** The Prisma Cloud–hosted deploy state store; its implementation lives in @internal/lowering. */
import { prismaStateLayer } from '@internal/lowering/state';
import { RPC_PEER_KEY } from '@internal/service-rpc';
import * as Output from 'alchemy/Output';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import {
  containerDescriptor,
  PRISMA_CLOUD_EXTENSION_ID,
  prismaCloudContainerOf,
} from '../container.ts';
import { bucketDescriptor } from '../descriptors/bucket.ts';
import { computeDescriptor } from '../descriptors/compute.ts';
import { postgresDescriptor } from '../descriptors/postgres.ts';
import { prismaNextDescriptor } from '../descriptors/prisma-next.ts';
import { s3CredentialsDescriptor } from '../descriptors/s3-credentials.ts';
import { s3StoreDescriptor } from '../descriptors/s3-store.ts';
import type {
  CloudApplication,
  ProviderParam,
  ResolvedCloudOptions,
  ServiceProviderParam,
} from '../descriptors/shared.ts';
import { SELF_ORIGIN } from '../origin-key.ts';
import { PgWarmProvider } from '../pg-warm-resource.ts';
import { PnMigrationProvider } from '../pn-migration-resource.ts';
import { runPreflight } from '../preflight.ts';
import { RESERVED_PROVIDER_PARAMS } from '../provider-params.ts';
import { S3CredentialsProvider } from '../s3-credentials-resource.ts';
import type { ProviderParamEntry } from '../serializer.ts';
import { STREAMS_API_KEY } from '../streams-keys.ts';
import { runTeardown } from '../teardown.ts';

/**
 * ADR-0031's registered provisioner for RPC_PEER_KEY: mints one `ServiceKey`
 * resource per edge (ADR-0030) and forwards its value as the opaque ref core
 * writes into the consumer's `serviceKey` param. The resource id keeps the
 * `servicekey-${edgeId}` scheme byte-identical to slice 2's, so an existing
 * deploy's keys are found, not re-minted. Defined here, not in service-keys.ts:
 * that module is also reachable from the runtime/authoring side, which must
 * never import `@internal/lowering` or `effect`.
 */
const serviceKeyProvisioner: ProvisionerDescriptor = {
  provision: (edge) =>
    Effect.gen(function* () {
      const key = yield* Prisma.ServiceKey(`servicekey-${edge.edgeId}`, {});
      return key.value;
    }),
};

/**
 * `ctx.provisioned`'s refs are typed `unknown` — core forwards a provisioner's
 * ref without inspecting it. Each provider param below is the sole reader of
 * its own provisioner's output, so the shape is asserted here, once, rather
 * than checked.
 */
const asKeyOutputs = (refs: readonly unknown[]): Output.Output<string>[] =>
  refs.map((ref) =>
    blindCast<
      Output.Output<string>,
      "the ref is keyed by an edge provisionedEdges matched on this param's own brand, and the provisioner registered beside it is that brand's sole registrant — it returns a ServiceKey resource's `value`, an Output<string>"
    >(ref),
  );

/**
 * RPC's deploy-side `value(refs)` (ADR-0030): the provider stores a SET — one
 * key per inbound edge — into the accepted-keys var `serve()` reads. Paired
 * with the provisioner above: mint per edge, aggregate every edge.
 *
 * Zero consumers still emits, and that is the whole point of #100: an ABSENT
 * var means "never provisioned" and passes every caller through, so a deployed
 * provider nobody wired must say "[]" — deny everything — rather than say
 * nothing. Written as a literal because `Output.all()` with no arguments has
 * nothing to resolve.
 */
const rpcAcceptedKeysValue: ProviderParam['value'] = (refs) =>
  refs.length > 0 ? Output.all(...asKeyOutputs(refs)) : [];

/**
 * ADR-0031's registered provisioner for STREAMS_API_KEY — the same `ServiceKey`
 * mint, keyed PER PROVIDER instead of per edge: the resource id is the
 * provider's address, so every consumer edge of one streams module resolves to
 * the same resource and therefore the same stable value. That is what
 * `@prisma/streams-server` requires (it authenticates a single `API_KEY`), and
 * cardinality is exactly what ADR-0031 leaves to the provisioner. Making it
 * per-edge later is this id's shape plus an accepted-set provider param — no
 * new resource, no core change.
 */
const streamsApiKeyProvisioner: ProvisionerDescriptor = {
  provision: (edge) =>
    Effect.gen(function* () {
      const key = yield* Prisma.ServiceKey(`streamskey-${edge.providerAddress}`, {});
      return key.value;
    }),
};

/**
 * Streams' deploy-side `value(refs)`: ONE value, not a set —
 * `@prisma/streams-server` authenticates a single `API_KEY`, which is why the
 * provisioner above mints per provider. That pairing is the invariant this
 * param depends on, so it asserts rather than trusts it: a future per-edge
 * flip without a paired accepted-set param here would otherwise ship
 * whichever key came first and leave every other consumer 401ing, silently.
 * The refs are lazy Outputs (not comparable at serialize time); inside
 * `Output.map` they are resolved strings, the same seam RPC's set aggregates
 * on.
 *
 * Zero consumers emits NOTHING — the streams counterpart to RPC's "[]".
 * `@prisma/streams-server` has no deny-all mode: it either authenticates a key
 * or runs --no-auth, so there is no value here that means "refuse everyone".
 * Writing no key is what fails closed — the entrypoint refuses to boot with
 * a named error rather than serve unauthenticated.
 */
const streamsApiKeyValue: ProviderParam['value'] = (refs) => {
  if (refs.length === 0) return undefined;
  return Output.map(Output.all(...asKeyOutputs(refs)), (vals) => {
    const distinct = [...new Set(vals)];
    if (distinct.length > 1) {
      throw new Error(
        `a streams provider was provisioned ${distinct.length} distinct keys across its ` +
          `${refs.length} inbound bindings, but it can only be given one ` +
          '(@prisma/streams-server authenticates a single API_KEY). Its provisioner must mint ' +
          'per provider, not per edge — or this param must store an accepted-key set, once ' +
          'the server accepts one.',
      );
    }
    return distinct[0] ?? '';
  });
};

/**
 * Origin's deploy-side value function (service-derived): the provisioned
 * service's own `endpointDomain`, verbatim — `https://…`, no trailing slash,
 * no normalization. Every compute service gets this row, exposing or not.
 * The undefined guard is a deploy-time invariant check, not a policy: the
 * Management API always reports an endpoint domain post-PRO-200, so a missing
 * one means the platform predates the fix — fail the deploy loudly rather
 * than write a row origin() would trust. The raw string is JSON-encoded by
 * the descriptor's generic loop, like every other reserved provider param.
 */
const selfOriginValue: ServiceProviderParam['valueForService'] = (provisioned, address) =>
  Output.map(provisioned.endpointDomain, (v) => {
    if (v === undefined) {
      throw new Error(
        `ComputeService for "${address}" reported no endpointDomain at provision — cannot resolve the service's own origin (Management API predates the PRO-200 fix?)`,
      );
    }
    return v;
  });

/** The user-facing state descriptor: `state: prismaState()` in `prisma-composer.config.ts` (ADR-0017). */
export const prismaState = (): StateDescriptor => ({
  extension: PRISMA_CLOUD_EXTENSION_ID,
  create: (container) => {
    const { projectId, branchId } = prismaCloudContainerOf(container);
    return prismaStateLayer(branchId !== undefined ? { projectId, branchId } : { projectId });
  },
});

export interface PrismaCloudOptions {
  /** Defaults to the PRISMA_WORKSPACE_ID environment variable. */
  workspaceId?: string;
  /** Defaults to the PRISMA_REGION environment variable when set. */
  region?: Prisma.ComputeRegion;
}

// Prisma.COMPUTE_REGIONS is the runtime source of truth ComputeRegion is
// derived from, so this can never fall behind — no hand-maintained list, no
// exhaustiveness gymnastics to keep it honest.
const KNOWN_REGION_SET: ReadonlySet<string> = new Set(Prisma.COMPUTE_REGIONS);

function isComputeRegion(value: string): value is Prisma.ComputeRegion {
  return KNOWN_REGION_SET.has(value);
}

/** Prisma.providers()'s ProviderCollection doesn't structurally unify with Alchemy's inferred providers Layer (a @internal/lowering typings gap); it satisfies it at runtime. */
function asProvidersLayer<A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<never> {
  return layer as unknown as Layer.Layer<never>;
}

/**
 * This extension's brands, each with the two halves ADR-0031 splits: the
 * PROVISIONER core resolves a mint through, and the reserved PROVIDER PARAM
 * that stores the minted values on the provider. So this file stays the only
 * place a brand is named — `descriptors/compute.ts` just looks a provider
 * param up by brand.
 *
 * `__tests__/provider-params.test.ts` asserts this map's brands are exactly
 * `PROVIDER_PARAMS`'s edge-derived brands (a service-derived param like the
 * origin mints nothing, so it has no provisioner): a brand minted here with no provider param
 * below would leave the value it mints written to consumers while no
 * provider ever stores an accepted-keys row for it — `serve()` (or the
 * equivalent runtime reader) then sees an absent var and passes every caller
 * through.
 */
const PROVISIONERS: ReadonlyMap<symbol, ProvisionerDescriptor> = new Map([
  [RPC_PEER_KEY, serviceKeyProvisioner],
  [STREAMS_API_KEY, streamsApiKeyProvisioner],
]);

/**
 * One brand's deploy-side value registration: edge-derived (`value(refs)`,
 * fed by the provider's inbound edges) or service-derived
 * (`valueForService(provisioned, address)`, fed by the service's own
 * provisioned attributes).
 */
export type ProviderParamValue =
  | Pick<ProviderParam, 'value'>
  | Pick<ServiceProviderParam, 'valueForService'>;

/**
 * Every brand's deploy-side value function — the only per-brand thing this
 * file still holds directly. `PROVIDER_PARAMS` below is built by mapping
 * `RESERVED_PROVIDER_PARAMS` (`provider-params.ts`, the boot-side list) onto
 * this map, so a param can exist on the deploy side only if it already
 * exists on the boot side: `RESERVED_PROVIDER_PARAMS` is the single source of
 * which reserved provider params exist at all, closing the drift the old
 * name-comparison test only detected after the fact.
 */
const PROVIDER_PARAM_VALUES: ReadonlyMap<symbol, ProviderParamValue> = new Map<
  symbol,
  ProviderParamValue
>([
  [RPC_PEER_KEY, { value: rpcAcceptedKeysValue }],
  [STREAMS_API_KEY, { value: streamsApiKeyValue }],
  [SELF_ORIGIN, { valueForService: selfOriginValue }],
]);

/**
 * Builds the deploy-side registry from the boot-side list, keyed by brand —
 * throws if a boot-side entry has no registered deploy-side value function,
 * so `RESERVED_PROVIDER_PARAMS` stays the single source of which reserved
 * provider params exist: deploy can no longer write a row boot never
 * stashes. Exported (rather than inlined into `PROVIDER_PARAMS` below) so
 * `__tests__/provider-params.test.ts` can drive it directly with a
 * deliberately incomplete value map and watch it throw.
 */
export function buildProviderParams(
  entries: readonly ProviderParamEntry[],
  values: ReadonlyMap<symbol, ProviderParamValue>,
): ReadonlyMap<symbol, ProviderParam | ServiceProviderParam> {
  return new Map<symbol, ProviderParam | ServiceProviderParam>(
    entries.map((entry): [symbol, ProviderParam | ServiceProviderParam] => {
      const value = values.get(entry.brand);
      if (value === undefined) {
        throw new Error(
          `prisma-cloud: reserved provider param "${entry.name}" (provider-params.ts) has no ` +
            "registered deploy-side value() in control.ts's PROVIDER_PARAM_VALUES — every param " +
            'in RESERVED_PROVIDER_PARAMS must have one.',
        );
      }
      return [entry.brand, { ...entry, ...value }];
    }),
  );
}

export const PROVIDER_PARAMS: ReadonlyMap<symbol, ProviderParam | ServiceProviderParam> =
  buildProviderParams(RESERVED_PROVIDER_PARAMS, PROVIDER_PARAM_VALUES);

/**
 * Resolves the factory's env-or-option inputs, failing fast with the exact
 * variable name.
 */
function resolveOptions(opts: PrismaCloudOptions): ResolvedCloudOptions {
  const workspaceId = opts.workspaceId ?? process.env['PRISMA_WORKSPACE_ID'];
  if (workspaceId === undefined || workspaceId.length === 0) {
    throw new Error('prismaCloud(): environment variable PRISMA_WORKSPACE_ID is required.');
  }

  if (opts.region !== undefined) {
    return { workspaceId, region: opts.region, providerParams: PROVIDER_PARAMS };
  }

  const region = process.env['PRISMA_REGION'];
  if (region === undefined || region.length === 0) {
    return { workspaceId, providerParams: PROVIDER_PARAMS };
  }
  if (!isComputeRegion(region)) {
    throw new Error(
      `prismaCloud(): environment variable PRISMA_REGION="${region}" is not a known region ` +
        `(expected one of: ${Prisma.COMPUTE_REGIONS.join(', ')}).`,
    );
  }
  return { workspaceId, region, providerParams: PROVIDER_PARAMS };
}

/** The Prisma Cloud extension descriptor — `prisma-composer.config.ts` lists it under `extensions`. */
export const prismaCloud = (opts: PrismaCloudOptions = {}): ExtensionDescriptor => {
  const o = resolveOptions(opts);

  return {
    id: PRISMA_CLOUD_EXTENSION_ID,

    container: containerDescriptor(),

    providers: () =>
      asProvidersLayer(
        Layer.mergeAll(
          Prisma.providers(),
          PgWarmProvider(),
          PnMigrationProvider(),
          S3CredentialsProvider(),
          Prisma.ServiceKeyProvider(),
        ),
      ),

    // Deploy-time prerequisite check (ADR-0029): verify every pointer secret in
    // the provision manifest exists for the resolved stage, filling absent-but-
    // in-shell names via a direct API POST — before any stack file or Alchemy.
    preflight: (input) => runPreflight(input),

    // Destroy-time cleanup (ADR-0034): remove the stage's deploy-state
    // database, once alchemy destroy has finished reading it and before the
    // CLI removes the Branch/Project.
    teardown: (input) => runTeardown(input),

    // Runs once per lowering, before any service: references the CLI-ensured
    // Project, with the poison DATABASE_URL variables written immediately so
    // nothing can ever rely on the platform default. Per-binding service keys
    // are no longer minted here (ADR-0031): core's provision phase invokes
    // `provisions` below, graph-wide, before any service lowers.
    application: {
      provision: (ctx) =>
        Effect.gen(function* () {
          const { projectId, branchId } = prismaCloudContainerOf(ctx.container);
          for (const key of ['DATABASE_URL', 'DATABASE_URL_POOLED']) {
            yield* Prisma.EnvironmentVariable(`${key}-poison`, {
              projectId,
              key,
              // "-", not "": the API rejects empty env-var values with
              // "String must contain at least 1 character" (verified at the R4
              // deploy proof). Any garbage value fails a real connect loudly.
              value: '-',
              class: branchId ? 'preview' : 'production',
              ...(branchId !== undefined ? { branchId } : {}),
            });
          }

          return { projectId, branchId } satisfies CloudApplication;
        }),
    },

    // ADR-0031: this extension's param provisioners, keyed by need brand.
    // Core resolves a provisioned param's `need.brand` against the CONSUMER
    // node's extension — the same registry this one is.
    provisions: PROVISIONERS,

    nodes: {
      postgres: postgresDescriptor(o),
      'prisma-next': prismaNextDescriptor(o),
      compute: computeDescriptor(o),
      credentials: s3CredentialsDescriptor(o),
      's3-store': s3StoreDescriptor(o),
      // A resource node routes by its contract's kind (resource() sets type =
      // provides.kind), and a real bucket provides the 's3' contract — so the
      // bucket descriptor registers under 's3', not 'bucket'.
      s3: bucketDescriptor(o),
    },
  };
};
