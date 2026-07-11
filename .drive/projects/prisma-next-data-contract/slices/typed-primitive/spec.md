# Slice 1 spec — typed pnPostgres primitive

**Linear:** TML-3009 · **Project:** prisma-next-data-contract

## Outcome

A Prisma Next-typed postgres primitive exists in `@prisma/app-cloud` behind a
dedicated subpath entry, with its static surface and its runtime hydrate both
proven — unit/type tests plus a live local-Postgres round trip. ADR-0022 ships
in the same PR.

## Scope

**In:**
- `packages/app-cloud/src/prisma-next.ts` — the new module: a
  `Contract<'prisma-next', …>` kind, the `pnPostgres` factory (resource +
  dependency overloads, mirroring `rpc.ts`), hydrate constructing the Prisma
  Next client with no runtime schema verification (checks are deploy-time).
- `packages/app-cloud/package.json` — add `@prisma-next/postgres` dependency
  and a `./prisma-next` subpath export; `tsdown.config.ts` — add the entry.
- Test fixtures: a small Prisma Next contract + its `prisma-next.config.ts`
  and emitted artifacts (or TS no-emit contract), under the package's test
  tree.
- Unit + type tests; one integration test against the repo's local-Postgres
  harness.

**Out:**
- The deploy lowering in `control.ts` (slice 2).
- Any example-app conversion (slice 2).
- Bare `postgres()` — untouched.
- Multi-contract / contract-space support.

## Design decisions locked (operator, post-D1r1)

- **Resource shape: `pnPostgres({ name, contract })`.** The contract is the
  *consumed* emitted artifact. The `prisma-next.config.ts` **path** (which the
  deploy migration step needs) is **not** part of D1 — it rides on the resource
  in slice 2, alongside the lowering that reads it (the `ResourceNode` has no
  metadata slot today; that mechanism is a slice-2 decision). Never import the
  config into the app build.
- **No runtime schema verification.** Hydrate builds the client with no
  `verifyMarker` — schema checking is build/deploy-time only. A running
  service can't be crashed by a marker check because there is no marker check.

## Slice DoD

- [ ] `pnPostgres` resource (`{ name, contract }`) + dependency overloads
      typecheck; the dependency's binding is the Prisma Next client typed by
      the contract.
- [ ] Type test: a consumer requiring contract vX is assignable to a resource
      providing vX, and a different `storageHash` is a type error.
- [ ] Unit test: `satisfies()` returns true for equal `storageHash`, false
      otherwise **including the missing/malformed-hash paths** (reviewer
      finding — these branches are correct but untested); factory returns
      correct `ResourceNode` / `DependencyEnd` shapes.
- [ ] Integration test (local Postgres): the hydrated client round-trips a
      query against a DB migrated to the contract. (No mismatched-marker case —
      there is no runtime check.)
- [ ] `@prisma/app-cloud` index import does not pull in `@prisma-next/*`/`pg`
      (verified: the symbol lives only behind `./prisma-next`).
- [ ] Bare `postgres()` unit/type tests unchanged and green.
- [ ] Validation gate green (below).

## Validation gate

- `pnpm --filter @prisma/app-cloud typecheck`
- `pnpm --filter @prisma/app-cloud test` (bun test)
- `pnpm --filter @prisma/app-cloud test:types` (vitest --typecheck)
- Integration test command for the local-Postgres test (implementer confirms
  the harness invocation; the state-store harness self-spawns `postgresql@15`
  or reads `STATE_TEST_DATABASE_URL`).

## Open questions carried from the project spec

- Factory name (`pnPostgres` is the working name; do not block on it — the
  operator settles it before merge).
- ~~Runtime `verifyMarker` semantics~~ — **resolved / moot.** The operator
  ruled out runtime schema verification entirely (checks are build/deploy-time
  only). Hydrate carries no `verifyMarker`.

## Dispatch plan

### D1 — primitive + unit/type proof

**Outcome:** `pnPostgres` compiles and is unit/type-proven without a live DB —
package wired, contract kind + factory + hydrate implemented, subpath export
in place, bare-postgres path untouched.

**Builds on:** — · **Hands to:** a compiling, unit-proven primitive whose
hydrate constructs the PN client (lazy — no connection yet).

**Focus:** structure mirrors `packages/app-rpc/src/rpc.ts`. The PN client is
lazy (pool on first query), so hydrate is fully implementable and unit-testable
without Postgres. Resolve the `verifyMarker` open question here.

**Completed when:** typecheck + `bun test` + `vitest --typecheck` green for
`@prisma/app-cloud`; type test proves storageHash-exact assignability; unit
test proves `satisfies` + node shapes; index import free of `@prisma-next/*`.

### D1r2 — reshape + coverage (batched: operator steer + reviewer finding)

**Outcome:** the primitive matches the locked design — resource is
`{ name, contract }`, hydrate has no `verifyMarker`, and the `satisfies`
missing/malformed-hash branches are tested.

**Builds on:** D1r1. · **Hands to:** D2.

**Completed when:** resource overload is `{ name, contract }` (no
`PnPostgresConfig`/`connection`); hydrate builds the client with no
`verifyMarker`; new unit cases cover `satisfies` on missing-hash /
malformed-`__cmp` both directions; module doc updated; full gate green.

### D2 — live integration proof

**Outcome:** the hydrated client is proven against a real local Postgres —
round-trips a query on a DB migrated to the contract.

**Builds on:** D1r2's primitive. · **Hands to:** slice DoD; slice 2's lowering.

**Focus:** use the repo's local-Postgres harness. Needs the fixture contract
migrated into the DB (apply it via PN's control client in test setup, or seed
the schema directly). Prove the round-trip only — there is no runtime marker
check to exercise.

**Completed when:** integration test green against a real DB (round-trip);
full validation gate green.
