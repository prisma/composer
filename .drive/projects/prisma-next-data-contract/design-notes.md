# Design notes — Prisma Next data contract

Settled in an operator design session (2026-07-11). The ADR draft
(`docs/design/90-decisions/ADR-0022-*.md`) is the durable record; these notes
carry the working detail and the deferred extension design.

## Principles

- **Opt-out stays real.** Bare `postgres()` is untouched — the `any` of data
  deps, same role `http()` plays for communication. Prisma Next is a second,
  parallel primitive; a project or service that doesn't import it never loads
  `@prisma-next/*` or `pg` at runtime.
- **Schema checking is build/deploy-time, not runtime.** The deploy is the
  authoritative check (migrate to the contract hash or fail). The runtime
  binding does no schema verification — it just builds the client — so a
  running service can never be crashed by a marker check. Runtime marker
  verification is explicitly disabled, not warn-only.
- **Deploys never run synthesized plans.** The deploy step migrates along the
  authored migration graph only, and fails if the graph has no path to the
  target hash. `dbUpdate`-style diff-and-apply is not used against deployed
  databases.

## The model

Two ends, one contract:

```ts
// resource end — the owning system
import contractJson from './contract.json'          // consume: data
import type { Contract } from './contract.d'         // consume: types
const contract = pnContract<Contract>(contractJson)
const db = provision('database', pnPostgres({
  name: 'database',
  contract,
  config: './prisma-next.config.ts',                 // locate: a PATH string, deploy-only
}))

// dep end — each consumer
deps: { db: pnPostgres(contract) }                   // binding: PostgresClient<Contract>
```

- **Consume the contract; locate the config.** The resource carries two
  different things by two different doors. The **contract** enters as its
  emitted artifact (`contract.json` + `contract.d.ts`) — consumed by the
  runtime and the type system, lightweight, safe to bundle. The
  **`prisma-next.config.ts`** enters as a **path string** — the deploy
  migration step reads it to find the migrations directory. The app build
  **never imports** the config; importing it pulls PN's CLI / migration engine
  / source-providers into the bundle. `connection` is gone entirely — there is
  no config object to carry a connection on.
- **Single contract per database (v1).** The user authors one contract that
  serves all consuming systems. Every consumer sees the full contract type —
  no least-privilege slices yet.
- **Compile-time check:** the dep's `required` contract and the resource's
  provided contract are the same emitted `Contract` type; the branded
  `storageHash` literal makes assignability exact-version equality.
  `satisfies()` mirrors it at Load as a hash-equality check.
- **Binding is the typed client**, constructed in hydrate:
  `postgres<Contract>({ contractJson, url })` from
  `@prisma-next/postgres/runtime` — no `verifyMarker` (no runtime schema
  check). Lazy pool, rides node-postgres. This amends ADR-0015's "pack ships
  no driver" for this dep kind: Prisma Next is framework-blessed like rpc, so
  the contract alone *can* construct the client.
- **Type flow by authoring mode:** TS-authored contracts carry their own types
  through the config import; PSL-first passes the emitted `contract.d.ts` type
  explicitly as the type parameter. Support and document both.

## Deploy lowering

Per PN-postgres resource, after DB provisioning, an Alchemy resource:

1. `readMarker()` on the live DB → compare marker `storageHash` to the
   contract's.
2. Equal → no-op (idempotent redeploy).
3. Different → PN `migrate`: walk the authored migration graph from the
   marker's hash to the target hash. Resume-safe; marker writes are atomic
   with apply.
4. Fail the deploy on: no path through the graph, destructive step without
   explicit opt-in (`acceptDataLoss` stays off), or runner failure. A failed
   apply leaves marker and diff unchanged.

The plan-mode operation list is the Alchemy diff preview. Migration files are
read from disk relative to the config — deploys run from a machine/CI that has
the workspace, so the files are present where the lowering runs.

## Packaging

In `@prisma/app-cloud` behind a dedicated subpath entry
(`@prisma/app-cloud/prisma-next`), not re-exported from the index — so the
`@prisma-next/postgres` + `pg` dependency tree loads only when imported.
Install weight is shared; runtime weight isn't. (Operator: no new npm
packages. Folding `@prisma/app-rpc` into app-cloud is a separate move, out of
scope here.)

## Deferred: the multi-contract / contract-space model

Worked out in the design session; deferred because PN's multi-peer-app-space
support (ADR 212's "monorepo aggregator" case) has unproven edges. When picked
up:

- Resource declares the set of contracts it hosts:
  `pnPostgres({ name, contracts: [sales, auth] })` — the aggregate in code;
  the owner consents to each slice; wiring typechecks membership.
- Each consumer's slice maps to a PN **contract space**; disjointness is
  PN-verified (`STORAGE_ELEMENT_CONFLICT`); apply ordering is PN's.
- **Space id must live on the contract declaration, never derived from
  topology names** — the id is what links versions of a contract over time
  (marker at hash X is this contract's predecessor, not a stranger claiming
  overlapping tables). Deriving from a system/dep name makes renames read as
  conflicts.
- Prerequisite spike: confirm PN handles multiple peer app-authored spaces in
  one database end-to-end.

## Deferred: dev-time

Parked. Intended shape: `prisma dev` serves identical copies of the management
API locally; Alchemy then treats the local machine as one more deploy target
and the lowering doesn't change at all. Nothing to design in this project.

## Alternatives considered

- **Binding = `{ url, contractJson }`, app constructs the client** — keeps
  packs driver-free (ADR-0015 as written) at the cost of one line of app code
  and the framework not constructing the typed client. Rejected: "data
  contracts are Prisma Next" is a README-level framework decision; PN is
  blessed the way rpc is.
- **Sibling npm package for the primitive** — cleanest dependency isolation,
  rejected by operator (package proliferation); subpath entry achieves the
  runtime isolation that matters.
- **Deriving the aggregate from wiring** (no contracts on the resource
  declaration) — superseded by single-contract v1; in the multi-contract
  extension the explicit declaration wins anyway (owner consent, visible
  edits, lowering reads the node not the graph).
- **`dbUpdate` at deploy** — synthesized plans against production databases;
  rejected outright. Authored `migrate` only.

## Open questions

- Factory name. `pnPostgres` is a placeholder; PN becomes **Prisma Data** at
  GA, so the name will churn. Decide before slice 1 merges.
- `@prisma-next/*` is 0.x (0.14.0 on npm) and fast-moving — pinning strategy
  and breakage tolerance.
- Exact `verifyMarker` warn-only semantics — confirm PN's option supports
  warn-don't-throw, or wrap it.

## References

- ADR draft: `docs/design/90-decisions/ADR-0022-*.md`
- PN surfaces: `@prisma-next/postgres` `/contract-builder`, `/runtime`,
  `/control`, `/config`; contract spaces ADR 212; `migrate` /
  `readMarker` / `readLedger` in the control API.
- Framework surfaces: `packages/app-cloud/src/postgres.ts` (bare primitive),
  `packages/app-cloud/src/control.ts` (lowering), ADR-0013/0015 (dep model,
  bindings).
