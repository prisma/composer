/**
 * The extension's control-plane entry (ADR-0017) — the only place
 * @internal/lowering is imported; loaded only by `prisma-composer.config.ts`.
 */

import type { ExtensionDescriptor } from '@internal/core/config';
import type { ProvisionerDescriptor } from '@internal/core/deploy';
import * as Prisma from '@internal/lowering';
/** The Prisma Cloud–hosted deploy state store; its implementation lives in @internal/lowering. */
import { prismaState } from '@internal/lowering/state';
import { RPC_PEER_KEY } from '@internal/rpc';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { computeDescriptor } from './descriptors/compute.ts';
import { postgresDescriptor } from './descriptors/postgres.ts';
import { prismaNextDescriptor } from './descriptors/prisma-next.ts';
import { s3CredentialsDescriptor } from './descriptors/s3-credentials.ts';
import { s3StoreDescriptor } from './descriptors/s3-store.ts';
import type { ResolvedCloudOptions } from './descriptors/shared.ts';
import { PgWarmProvider } from './pg-warm-resource.ts';
import { PnMigrationProvider } from './pn-migration-resource.ts';
import { runPreflight } from './preflight.ts';
import { S3CredentialsProvider } from './s3-credentials-resource.ts';

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

  if (opts.region !== undefined) return { workspaceId, region: opts.region, projectId, branchId };

  const region = process.env['PRISMA_REGION'];
  if (region === undefined || region.length === 0) {
    return { workspaceId, projectId, branchId };
  }
  if (!isComputeRegion(region)) {
    throw new Error(
      `prismaCloud(): environment variable PRISMA_REGION="${region}" is not a known region ` +
        `(expected one of: ${Prisma.COMPUTE_REGIONS.join(', ')}).`,
    );
  }
  return { workspaceId, region, projectId, branchId };
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
    provisions: new Map([[RPC_PEER_KEY, serviceKeyProvisioner]]),

    nodes: {
      postgres: postgresDescriptor(o),
      'prisma-next': prismaNextDescriptor(o),
      compute: computeDescriptor(o),
      credentials: s3CredentialsDescriptor(o),
      's3-store': s3StoreDescriptor(o),
    },
  };
};
