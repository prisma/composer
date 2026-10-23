/** Helpers shared by the per-node-kind descriptors under `src/descriptors/` and the extension factory in `control.ts`. */

import type { ProjectRegion } from '@internal/lowering';
import { adopt } from 'alchemy/AdoptPolicy';
import * as Output from 'alchemy/Output';
import * as Prisma from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import type { PointerUpdatedAt } from '../control/pointer-timestamps.ts';
import { fromLegacyId, legacyNodeResourceId } from '../legacy-resource-ids.ts';
import { resourceId } from '../resource-ids.ts';
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
  readonly region?: ProjectRegion;
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
   * `prisma dev` run, which talks to no platform — supplies a lookup
   * that answers "unknown" for every name, so no caller has to.
   */
  readonly pointerUpdatedAt: PointerUpdatedAt;
}

/**
 * The longest address each kind of row can be named by. The platform allows 65 characters in a
 * Connection name, but upstream appends `-` and a 12-character token to every one and cuts what
 * does not fit, so 52 keeps the whole address.
 */
const PLATFORM_NAME_LIMITS = { App: 256, Connection: 52, Bucket: 100 } as const;

/**
 * Checks that the platform can hold the node's address as the name of its `kind` row (ADR-0057).
 * Fails naming the address; a name is never shortened.
 */
export function validatePlatformName(
  kind: keyof typeof PLATFORM_NAME_LIMITS,
  address: string,
): void {
  const limit = PLATFORM_NAME_LIMITS[kind];
  if (address.length > limit) {
    throw new Error(
      `prisma-cloud: the node "${address}" is ${address.length} characters long, but Prisma ` +
        `allows at most ${limit} characters in a ${kind} name, and every platform name is the ` +
        "node's address. Shorten the app name or a provision id. Changing the address makes the " +
        "node a different entity: a database's or bucket's data is not carried over.",
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

/** The `logicalId` prop of a node's App, Database or Bucket: its full address on every platform deploy, none in branchless dev (ADR-0057). */
export function logicalIdProp(
  application: unknown,
  address: string,
): { readonly logicalId?: string } {
  return cloudApplicationOf(application).branchless ? {} : { logicalId: address };
}

/**
 * Declares one of the app's own App, Database, Bucket or `COMPOSER_` variable rows. On the app's
 * Project and branch, the row holding a node's logicalId (or a variable's key) is that node's row,
 * so a deploy resuming an interrupted create uses it instead of refusing it (ADR-0057). Only for
 * resources declared with their identity: `logicalIdProp` on App, Database and Bucket, a
 * `COMPOSER_` key on variables. Without one, upstream falls back to matching by display name.
 */
export const asOwnRow = adopt(true);

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
  address,
  app,
  application,
  region,
}: {
  readonly id: string;
  readonly address: string;
  readonly app: string;
  readonly application: unknown;
  readonly region: ProjectRegion | undefined;
}) =>
  Effect.gen(function* () {
    const branchId = attachmentBranchIdOf(application, id);
    // 'inherit' resolves to the project's default region on the platform.
    const db = yield* Prisma.Database(resourceId(address), {
      project: projectIdOf(application),
      region: region ?? 'inherit',
      ...(branchId !== undefined ? { branchId } : { name: address }),
      ...logicalIdProp(application, address),
    }).pipe(asOwnRow, fromLegacyId(legacyNodeResourceId(app, address, 'db')));
    const conn = yield* Prisma.Connection(resourceId(address, 'connection'), {
      database: db,
      name: address,
    }).pipe(fromLegacyId(legacyNodeResourceId(app, address, 'conn')));
    const url = Output.map(conn.directConnectionString, (value) => {
      if (value === undefined) {
        throw new Error(
          `prisma-cloud: connection "${resourceId(address, 'connection')}" returned no direct connection string.`,
        );
      }
      return Redacted.value(value);
    });
    return { db, url };
  });
