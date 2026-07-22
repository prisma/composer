/** Helpers shared by the per-node-kind descriptors under `src/descriptors/` and the extension factory in `control.ts`. */

import type * as Prisma from '@internal/lowering';
import type * as Output from 'alchemy/Output';
import type { ProviderParamEntry } from '../serializer.ts';

/**
 * The provider-side reserved param for one brand's minted values (ADR-0031:
 * "the provisioner owns mint, size, **aggregation**, stability, and
 * rotation", and ADR-0019: the physical encoding is the target's). `value`
 * is deploy-side: given every inbound edge's minted ref for one provider
 * (possibly empty), it returns the typed value to store, or `undefined` to
 * write no row. The returned value is encoded through the serializer's
 * normal service-own literal path (JSON) — the same path any declared param
 * takes — never a brand-invented wire format.
 *
 * This is the seam that keeps `descriptors/compute.ts` brand-blind: a
 * `ProviderParam` is registered beside its brand's provisioner in
 * `control.ts`; the descriptor asks every registered entry about every
 * exposing service and writes whatever comes back.
 */
export interface ProviderParam extends ProviderParamEntry {
  /**
   * Every inbound edge's minted ref for this provider — POSSIBLY EMPTY. A
   * provider with no wired consumers is still asked, because "no edges" and
   * "no var" mean different things at boot: an absent var reads as "never
   * provisioned" (local dev, tests). What an empty set means is this param's
   * own call — deny everything, or emit nothing and let its reader fail closed.
   */
  readonly value: (refs: readonly unknown[]) => Output.Output<unknown> | unknown | undefined;
}

/**
 * The slice of compute's provisioned handoff a service-derived provider param
 * may read. A minimal structural type, not `ComputeProvisioned` itself:
 * shared.ts sits below `descriptors/compute.ts` in the import graph, so
 * naming the full type here would invert it.
 */
export interface ServiceProvisionedAttributes {
  readonly endpointDomain: Output.Output<string | undefined>;
}

/**
 * A reserved provider param whose value derives from the provider service's
 * OWN provisioned attributes rather than its inbound edges — the
 * service-derived sibling of `ProviderParam` (e.g. the service's own origin).
 * Asked for EVERY compute service, exposing or not: a service needs no
 * consumers to have an origin, so the descriptor's expose check applies only
 * to edge-derived entries. Like `ProviderParam.value`, the return is encoded
 * through the serializer's normal service-own literal path (JSON) by the
 * descriptor's generic loop, never here.
 */
export interface ServiceProviderParam extends ProviderParamEntry {
  readonly valueForService: (
    provisioned: ServiceProvisionedAttributes,
    address: string,
  ) => Output.Output<unknown> | unknown | undefined;
}

/**
 * The factory's resolved options each node descriptor closes over. Deploy
 * identity (`projectId`/`branchId`) is no longer here — it comes from the
 * resolved container, read via `cloudApplicationOf(ctx.application)`.
 */
export interface ResolvedCloudOptions {
  readonly workspaceId: string;
  readonly region?: Prisma.ComputeRegion;
  /**
   * This extension's reserved provider params, keyed by need brand —
   * edge-derived (`ProviderParam`) or service-derived (`ServiceProviderParam`).
   * The edge-derived side mirrors the `provisions` registry core resolves
   * mints through. Passed as data so the descriptors never import a brand's
   * module (and so control.ts, which owns both registries, stays the only
   * place a brand is named).
   */
  readonly providerParams: ReadonlyMap<symbol, ProviderParam | ServiceProviderParam>;
}

/** Where a resource lands when the deploy names no region. */
export const DEFAULT_REGION: Prisma.ComputeRegion = 'us-east-1';

// Prisma's Connection create constrains `name` to 3–65 chars (Management API:
// POST /v1/connections); applied here to every id-derived resource name as the
// tightest of the API's name-length rules.
const PRISMA_NAME_MIN = 3;
const PRISMA_NAME_MAX = 65;

export function validateName(value: string, source: string): void {
  if (value.length < PRISMA_NAME_MIN || value.length > PRISMA_NAME_MAX) {
    throw new Error(
      `prisma-cloud: ${source} "${value}" (${value.length} characters) is not a valid Prisma ` +
        `resource name — Prisma requires ${PRISMA_NAME_MIN}–${PRISMA_NAME_MAX} characters. ` +
        'Rename the provision id (or the deploy --name) to fit.',
    );
  }
}

/** What prisma-cloud's application hook produces; its own descriptors are the only consumers. */
export interface CloudApplication {
  readonly projectId: string;
  readonly branchId: string | undefined;
}

export function isCloudApplication(value: unknown): value is CloudApplication {
  // `in` narrows without a cast — TS carries the key through to the read.
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'branchId' in value &&
    (value.branchId === undefined || typeof value.branchId === 'string')
  );
}

/** Narrows `ctx.application`, which core hands over as `unknown`, to this extension's own product; throws naming the hook when it hasn't run. */
export function cloudApplicationOf(application: unknown): CloudApplication {
  if (!isCloudApplication(application)) {
    throw new Error(
      "prisma-cloud: ctx.application is not this extension's application product — " +
        'the prismaCloud() application hook must run before any node lowers.',
    );
  }
  return application;
}

export function projectIdOf(application: unknown): string {
  return cloudApplicationOf(application).projectId;
}
