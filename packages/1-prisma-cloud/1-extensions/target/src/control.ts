/**
 * The extension's control-plane entry (ADR-0017) — the only place
 * @internal/lowering is imported; loaded only by `prisma-composer.config.ts`.
 */

import type { ExtensionDescriptor } from '@internal/core/config';
import type { ProvisionerDescriptor } from '@internal/core/deploy';
import { blindCast } from '@internal/foundation/casts';
import * as Prisma from '@internal/lowering';
/** The Prisma Cloud–hosted deploy state store; its implementation lives in @internal/lowering. */
import { prismaState } from '@internal/lowering/state';
import { RPC_PEER_KEY } from '@internal/rpc';
import * as Output from 'alchemy/Output';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { computeDescriptor } from './descriptors/compute.ts';
import { postgresDescriptor } from './descriptors/postgres.ts';
import { prismaNextDescriptor } from './descriptors/prisma-next.ts';
import { s3CredentialsDescriptor } from './descriptors/s3-credentials.ts';
import { s3StoreDescriptor } from './descriptors/s3-store.ts';
import type { ProviderParam, ResolvedCloudOptions } from './descriptors/shared.ts';
import { PgWarmProvider } from './pg-warm-resource.ts';
import { PnMigrationProvider } from './pn-migration-resource.ts';
import { runPreflight } from './preflight.ts';
import { S3CredentialsProvider } from './s3-credentials-resource.ts';
import { RPC_ACCEPTED_KEYS_PARAM } from './service-keys.ts';
import { STREAMS_API_KEY, STREAMS_API_KEY_PARAM } from './streams-keys.ts';

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
 * RPC's reserved provider param (ADR-0030): the provider stores a SET — one
 * key per inbound edge — into the accepted-keys var `serve()` reads. Paired
 * with the provisioner above: mint per edge, aggregate every edge.
 *
 * Zero consumers still emits, and that is the whole point of #100: an ABSENT
 * var means "never provisioned" and passes every caller through, so a deployed
 * provider nobody wired must say "[]" — deny everything — rather than say
 * nothing. Written as a literal because `Output.all()` with no arguments has
 * nothing to resolve.
 */
const rpcAcceptedKeysParam: ProviderParam = {
  ...RPC_ACCEPTED_KEYS_PARAM,
  value: (refs) => (refs.length > 0 ? Output.all(...asKeyOutputs(refs)) : []),
};

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
 * Streams' reserved provider param: ONE value, not a set —
 * `@prisma/streams-server` authenticates a single `API_KEY`, which is why the
 * provisioner above mints per provider. That pairing is the invariant this
 * param depends on, so it asserts rather than trusts it: a future per-edge
 * flip without a paired accepted-set param here would otherwise ship
 * whichever key came first and leave every other consumer 401ing, silently.
 * The refs are lazy Outputs (not comparable at serialize time); inside
 * `Output.map` they are resolved strings, the same seam RPC's set aggregates
 * on.
 */
const streamsApiKeyParam: ProviderParam = {
  ...STREAMS_API_KEY_PARAM,
  // Zero consumers emits NOTHING — the streams counterpart to RPC's "[]".
  // @prisma/streams-server has no deny-all mode: it either authenticates a key
  // or runs --no-auth, so there is no value here that means "refuse everyone".
  // Writing no key is what fails closed — the entrypoint refuses to boot with
  // a named error rather than serve unauthenticated.
  value: (refs) => {
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
  },
};

export { prismaState };

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
 * that stores the minted values on the provider. Declared together so a
 * brand's two halves can never drift, and so this file stays the only place
 * a brand is named — `descriptors/compute.ts` just looks a provider param up
 * by brand.
 */
const PROVISIONERS: ReadonlyMap<symbol, ProvisionerDescriptor> = new Map([
  [RPC_PEER_KEY, serviceKeyProvisioner],
  [STREAMS_API_KEY, streamsApiKeyProvisioner],
]);

// Exported so `__tests__/provider-params.test.ts` can assert this registry
// names the same params as the boot-side `RESERVED_PROVIDER_PARAMS`
// (`provider-params.ts`) — the two lists must never drift apart.
export const PROVIDER_PARAMS: ReadonlyMap<symbol, ProviderParam> = new Map([
  [RPC_PEER_KEY, rpcAcceptedKeysParam],
  [STREAMS_API_KEY, streamsApiKeyParam],
]);

/**
 * Resolves the factory's env-or-option inputs, failing fast with the exact
 * variable name. `projectId`/`branchId` aren't required here — `prismaCloud()`
 * also runs in the CLI parent, before they're set; the required check lives in `application.provision`.
 */
function resolveOptions(opts: PrismaCloudOptions): ResolvedCloudOptions {
  const workspaceId = opts.workspaceId ?? process.env['PRISMA_WORKSPACE_ID'];
  if (workspaceId === undefined || workspaceId.length === 0) {
    throw new Error('prismaCloud(): environment variable PRISMA_WORKSPACE_ID is required.');
  }

  const projectId = process.env['PRISMA_PROJECT_ID'] || undefined;
  const branchId = process.env['PRISMA_BRANCH_ID'] || undefined;

  if (opts.region !== undefined) {
    return {
      workspaceId,
      region: opts.region,
      projectId,
      branchId,
      providerParams: PROVIDER_PARAMS,
    };
  }

  const region = process.env['PRISMA_REGION'];
  if (region === undefined || region.length === 0) {
    return { workspaceId, projectId, branchId, providerParams: PROVIDER_PARAMS };
  }
  if (!isComputeRegion(region)) {
    throw new Error(
      `prismaCloud(): environment variable PRISMA_REGION="${region}" is not a known region ` +
        `(expected one of: ${Prisma.COMPUTE_REGIONS.join(', ')}).`,
    );
  }
  return { workspaceId, region, projectId, branchId, providerParams: PROVIDER_PARAMS };
}

/** The Prisma Cloud extension descriptor — `prisma-composer.config.ts` lists it under `extensions`. */
export const prismaCloud = (opts: PrismaCloudOptions = {}): ExtensionDescriptor => {
  const o = resolveOptions(opts);

  return {
    id: '@prisma/composer-prisma-cloud',

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

    // Runs once per lowering, before any service: references the CLI-ensured
    // Project, with the poison DATABASE_URL variables written immediately so
    // nothing can ever rely on the platform default. Per-binding service keys
    // are no longer minted here (ADR-0031): core's provision phase invokes
    // `provisions` below, graph-wide, before any service lowers.
    application: {
      provision: () =>
        Effect.gen(function* () {
          const projectId = o.projectId;
          if (projectId === undefined || projectId.length === 0) {
            throw new Error(
              'prismaCloud(): environment variable PRISMA_PROJECT_ID is required (the CLI sets it — deploy via `prisma-composer deploy`).',
            );
          }
          for (const key of ['DATABASE_URL', 'DATABASE_URL_POOLED']) {
            yield* Prisma.EnvironmentVariable(`${key}-poison`, {
              projectId,
              key,
              // "-", not "": the API rejects empty env-var values with
              // "String must contain at least 1 character" (verified at the R4
              // deploy proof). Any garbage value fails a real connect loudly.
              value: '-',
              class: o.branchId ? 'preview' : 'production',
              ...(o.branchId !== undefined ? { branchId: o.branchId } : {}),
            });
          }

          return { outputs: { projectId } };
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
    },
  };
};
