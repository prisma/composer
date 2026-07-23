/**
 * The required-pack-head vocabulary — compose's own claim that a wired pn
 * database carries an extension pack at a given contract-space head. In its
 * own module so a module's authoring surface (e.g. `@internal/auth`'s
 * `authDb()`) can import it from the MAIN barrel without dragging
 * `./prisma-next`'s runtime dependencies (`@prisma-next/postgres/runtime`,
 * `pg` — both carrying `node:` imports) into a runtime bundle. Deliberately
 * self-contained — invariant 7 keeps every `prisma-next`/`@prisma-next`
 * import specifier (type-only included) out of the main barrel's reachable
 * graph, so the cmp shape is declared here rather than imported; it is
 * assignable to `PnPostgresContract`'s `PnCmp` by construction, and
 * `prisma-next.ts` re-exports everything here so the `./prisma-next` surface
 * carries the full vocabulary in one place.
 */
import type { Contract } from '@internal/core';

/** A dependency's claim that its pn database carries extension pack `packId` at contract-space head `headHash` (the head ref's storage hash). */
export interface RequiredPackHead {
  readonly packId: string;
  readonly headHash: string;
}

/**
 * The `__cmp` shape a required-pack-head contract is typed with —
 * structurally `PnCmp` (prisma-next.ts) minus its `_contract` anchor, and
 * with the SAME optionality: typed wiring assigns a provider's `PnCmp` TO
 * this shape, so a required `requiredPackHead` here would reject every real
 * `pnContract()` provider. The runtime value always carries the claim.
 */
export interface RequiredPackHeadCmp {
  readonly contractJson: unknown;
  readonly requiredPackHead?: RequiredPackHead;
}

/**
 * A `prisma-next`-kind required contract carrying a pack-head claim instead
 * of a contract value. Wireable to any `pnContract()` provider (wireability
 * only); the deploy preflight enforces that the wired resource's PN config
 * lists the pack at the required head.
 */
export function requiredPackHead(
  req: RequiredPackHead,
): Contract<'prisma-next', RequiredPackHeadCmp> {
  const value: Contract<'prisma-next', RequiredPackHeadCmp> = {
    kind: 'prisma-next',
    __cmp: { contractJson: undefined, requiredPackHead: req },
    // A requirement never provides; core only calls `satisfies` on the
    // provider side of a wiring. Answer honestly anyway: another requirement
    // for the exact same pack head is the only thing this value could stand
    // in for.
    satisfies: (required) => {
      const other = requiredPackHeadOf(required);
      return other !== undefined && other.packId === req.packId && other.headHash === req.headHash;
    },
  };
  return Object.freeze(value);
}

/** Reads `__cmp.requiredPackHead` off a Contract, defensively — `__cmp` is opaque to core, so nothing guarantees its shape without a runtime check. */
export function requiredPackHeadOf(
  contract: Contract<string, unknown> | undefined,
): RequiredPackHead | undefined {
  if (contract === undefined) return undefined;
  const cmp = contract.__cmp;
  if (typeof cmp !== 'object' || cmp === null || !('requiredPackHead' in cmp)) return undefined;
  const req = cmp.requiredPackHead;
  if (typeof req !== 'object' || req === null) return undefined;
  if (!('packId' in req) || typeof req.packId !== 'string') return undefined;
  if (!('headHash' in req) || typeof req.headHash !== 'string') return undefined;
  return { packId: req.packId, headHash: req.headHash };
}
