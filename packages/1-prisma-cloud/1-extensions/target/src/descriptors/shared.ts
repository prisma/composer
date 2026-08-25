/** Helpers shared by the per-node-kind descriptors under `src/descriptors/` and the extension factory in `control.ts`. */

import * as Output from 'alchemy/Output';
import * as Prisma from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import type { PointerUpdatedAt } from '../control/pointer-timestamps.ts';
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
  readonly region?: Prisma.Types.PrismaRegionId;
  /**
   * This extension's reserved provider params, keyed by need brand —
   * edge-derived (`ProviderParam`) or service-derived (`ServiceProviderParam`).
   * The edge-derived side mirrors the `provisions` registry core resolves
   * mints through. Passed as data so the descriptors never import a brand's
   * module (and so control.ts, which owns both registries, stays the only
   * place a brand is named).
   */
  readonly providerParams: ReadonlyMap<symbol, ProviderParam | ServiceProviderParam>;
  /**
   * When a platform variable a row POINTS at was last written, by name — the
   * out-of-band rotation signal the compute deploy hook folds into its
   * environment fingerprint. The deploy preflight supplies the times (it
   * already reads exactly these names off the platform) and transports them to
   * the alchemy process. Always present: a run with no times to offer — every
   * `prisma-composer dev` run, which talks to no platform — supplies a lookup
   * that answers "unknown" for every name, so no caller has to.
   */
  readonly pointerUpdatedAt: PointerUpdatedAt;
}

/** Where a resource lands when the deploy names no region. */
export const DEFAULT_REGION: Prisma.Types.PrismaRegionId = 'us-east-1';

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
  /** The named stage's Branch id; `undefined` on the default (production) stage. */
  readonly branchId: string | undefined;
  /** The project's default Branch id; a deploy carries exactly one of `branchId`/`defaultBranchId`. */
  readonly defaultBranchId: string | undefined;
  /** Set only by the dev container, which resolves no Branches. */
  readonly branchless: boolean;
}

export function isCloudApplication(value: unknown): value is CloudApplication {
  // `in` narrows without a cast — TS carries the key through to the read.
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'branchId' in value &&
    (value.branchId === undefined || typeof value.branchId === 'string') &&
    'defaultBranchId' in value &&
    (value.defaultBranchId === undefined || typeof value.defaultBranchId === 'string') &&
    'branchless' in value &&
    typeof value.branchless === 'boolean'
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

/**
 * The Branch a database attaches to. Upstream treats an omitted branch as
 * desired-unassigned (`branchId` PATCHed back to `null` on reconcile), so a
 * deploy container carrying neither id is a broken transport; only a
 * `branchless` (dev) container returns `undefined`.
 */
export function attachmentBranchIdOf(application: unknown, id: string): string | undefined {
  const app = cloudApplicationOf(application);
  const branchId = app.branchId ?? app.defaultBranchId;
  if (branchId === undefined && !app.branchless) {
    throw new Error(
      `prisma-cloud: cannot attach database "${id}" to a Branch — the resolved container ` +
        "carries neither a stage Branch id nor the project's default Branch id. Container " +
        'resolution (ADR-0019) always provides one for a deploy; this is a bug in the ' +
        'container transport.',
    );
  }
  return branchId;
}

/**
 * Upstream refuses an explicit display name combined with branch attachment
 * at create (create-then-attach, no idempotency key), so attached databases
 * take the generated physical name; only the branchless (dev) container takes
 * the `name` arm. The returned `url` is direct, not pooled — PgWarm and the
 * migration flows need a direct connection.
 */
export const stageDatabase = ({
  id,
  application,
  region,
}: {
  readonly id: string;
  readonly application: unknown;
  readonly region: Prisma.Types.PrismaRegionId | undefined;
}) =>
  Effect.gen(function* () {
    const branchId = attachmentBranchIdOf(application, id);
    const db = yield* Prisma.Database(`${id}-db`, {
      project: projectIdOf(application),
      region: region ?? DEFAULT_REGION,
      ...(branchId !== undefined ? { branchId } : { name: id }),
    });
    const conn = yield* Prisma.Connection(`${id}-conn`, { database: db, name: id });
    const url = Output.map(conn.directConnectionString, (value) => {
      if (value === undefined) {
        throw new Error(
          `prisma-cloud: connection "${id}-conn" returned no direct connection string.`,
        );
      }
      return Redacted.value(value);
    });
    return { db, url };
  });
