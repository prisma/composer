# ADR-0022: Data deps carry a Prisma Next contract; deploys migrate to its ref

## Decision

A second data primitive joins bare `postgres()`: `pnPostgres`, a
Prisma Next-typed Postgres resource and dependency, shipped in
`@prisma/composer-prisma-cloud` behind its own subpath entry
(`@prisma/composer-prisma-cloud/prisma-next`). **Prisma Next** is Prisma's
schema-and-migration engine; its unit is a **contract** — a deterministic,
hashable description of a database schema, emitted as `contract.json` (data) and
`contract.d.ts` (types).

The same `pnPostgres` factory serves both ends of a data edge — a resource to
provision, and a dependency that resolves to a typed client:

```ts
// contract.ts — wrap Prisma Next's emitted artifact into the framework's kind.
// contract.json is pure data; Contract is its emitted, branded type. Neither
// pulls in Prisma Next's CLI or migration engine.
import { pnContract } from '@prisma/composer-prisma-cloud/prisma-next';
import type { Contract } from '../contract.d.ts';
import contractJson from '../contract.json' with { type: 'json' };
export const widgetContract = pnContract<Contract>(contractJson);

// service.ts — the DEPENDENCY end. load() hands back a typed Prisma Next
// client, built by the framework from the contract plus the injected URL.
export default compute({
  name: 'widgets',
  deps: { db: pnPostgres(widgetContract) },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
});

// server.ts — the client is ready to query, typed by the contract:
const { db } = service.load();
await db.orm.public.Widget.create({ label });

// module.ts — the RESOURCE end. It takes the contract AND the
// prisma-next.config.ts PATH — a plain string the deploy reads, never imported.
export default module('pn-widgets', ({ provision }) => {
  const db = provision(
    pnPostgres({ name: 'database', contract: widgetContract, config: './prisma-next.config.ts' }),
    { id: 'database' },
  );
  provision(widgetsService, { id: 'widgets', deps: { db } });
});
```

The two ends of the resource pull in opposite directions, so they enter by
different doors. The **contract** is *consumed*: it types and wires the resource
and gives the deploy the schema version to migrate to. The
**`prisma-next.config.ts`** is *located*, by path only — deploy-only metadata
the migration step reads to find the migrations directory. The app build never
imports it, because importing it would pull Prisma Next's CLI, migration engine,
and source providers into the user's bundle. One contract per database.

At deploy, the lowering gains a migration step per `pnPostgres` resource. Its
target is a **ref** — `{ hash, invariants }` — and the live database carries a
**marker** recording its current `{ storageHash, invariants }`. An **invariant**
is a named postcondition established by a `data`-class migration step (a
backfill, say), recorded on the marker once its step runs. The step compares
marker to ref and takes one of two paths:

```text
marker at ref.hash, and ref.invariants ⊆ marker.invariants  → no-op   (already there)
otherwise                                                    → migrate (replay the authored graph)
```

- **No-op.** The marker's `storageHash` equals the ref's hash and every invariant the ref requires is already on the marker. The database is where it needs to be.
- **`migrate`.** Everything else — a different hash, a missing invariant (a pure data change with no schema change is a self-edge from a hash to itself), or a fresh database, whose start point is simply empty. This replays the **authored** migration graph. The deploy fails if no path exists, if a step is destructive without explicit opt-in, or if the runner itself fails. The no-path failure is a structured refusal naming the two exits: iterating locally, bring the database along with `prisma db update`; shipping, author the migration path (`prisma contract emit && prisma migration plan --name <slug>`, baseline first if the graph is empty) and commit `migrations/`.

**The pipeline replays what was authored; it never authors.** Synthesizing schema directly from the contract (`dbInit`, `dbUpdate`) is an authoring-time activity that belongs to the ORM's dev commands (`db init`/`db update`), held by the user or their agent. The deploy pipeline's entire schema job is the decision above.

> **Revision (2026-08-25).** As first recorded, this ADR gave the first deploy of a fresh database a third path: no marker and no required invariants → `dbInit`, additive-only synthesis from the contract, signing the marker. That is reversed. Two reasons, the second observed in the field:
>
> 1. Synthesis at deploy time runs unreviewed schema operations in production — the one thing the rest of this ADR exists to prevent.
> 2. The synthesized first deploy signs the marker without any authored migration existing, so the *first contract change* strands the user behind `MIGRATION_PATH_NOT_FOUND`: the graph has no edge from the marker's hash because no edge was ever authored. This was a verified field failure, not a hypothetical.
>
> Replay-only makes the trap structurally impossible: a marker can only carry a hash the authored graph reaches, and production only ever runs committed, reviewed migration artifacts. The replay cost for long histories has an answer inside the authored model: an authored squash edge (empty→Hn) is a legal graph edge, and shortest-path selection picks it — no pipeline support needed. Databases created by the old synthesis path carry accurate marker signatures; the retrofit (set a ref to the marker's hash and plan against it) is a documented recipe, not a command.

The ref comes from the resource's optional `targetRef` (naming a
`migrations/app/refs/<name>.json` file), or defaults to the head: the emitted
contract's hash with zero invariants. The tracked migration resource is keyed on
the ref's identity (hash plus sorted invariants), so a data-only change still
produces a distinct deploy step. Synthesized diff-and-apply (`dbUpdate`) is never
run against a deployed database — only `migrate` is.

Bare `postgres()` is unchanged: the untyped escape hatch, the `any` of data
deps, the same role `http()` plays for communication.

## Reasoning

Prisma Next's surface fits this shape with almost no adaptation. Its contracts
are committed artifacts (`contract.json` + `contract.d.ts`) whose branded
`storageHash` type puts the schema version in the type system; its runtime is
generic over the emitted type with no client codegen and accepts an explicit
connection string, which matches how the framework injects bindings; and its
control API exposes exactly the marker-read, plan, and migrate operations the
deploy step needs.

**The binding is a typed client, which amends
[ADR-0015](ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md)
rather than violating it.** ADR-0015's principle is that a binding is the
most-derived thing the contract alone can construct; it lands on `{ url }` for
bare postgres because constructing more would bless a driver. A dependency that
carries a Prisma Next contract *can* construct the typed client from the contract
alone — contract plus URL is the client's entire input. Because "data contracts
are Prisma Next" is a framework-level decision, Prisma Next is blessed the way
RPC is: this dependency kind gets a client, while bare postgres keeps `{ url }`.
The dependency cost is contained by packaging — the primitive lives behind its
own subpath entry, never re-exported from the index — so a service that opts out
never loads `@prisma/orm-postgres` or `pg` at runtime.

**Consume the contract; locate the config.** The runtime and the type system
only need to *consume* the contract: `contract.json` (the data the framework
hands the runtime at *hydrate* — the boot-time step that builds each
dependency's client) and `contract.d.ts` (types), both lightweight and
importable into the app build with no deploy machinery attached. The deploy migration step needs to
*locate* the config — the `prisma-next.config.ts` from which Prisma Next resolves
the migrations directory — but it needs only the **path**, a string, read at
deploy time. Passing the config as a path rather than an import is what keeps
Prisma Next's CLI and migration engine out of the user's bundle while still
giving the deploy lowering what it needs. A single contract is Prisma Next's
mainline single-space model, so the user authors one contract that serves every
consuming module. Each consumer sees the full contract type; per-consumer
least-privilege slices are the deferred multi-contract extension (see
Alternatives).

**Schema checking is a build/deploy-time job, not a runtime one.** The
authoritative check is the deploy. `migrate` walks the authored graph from the
marker's state to the target ref, is resume-safe, and writes the marker
atomically with each apply, so a failed deploy leaves marker and database
unchanged; a contract with no authored path is a deploy failure surfaced before
any DB change. Because the deploy guarantees the live database is at the
contract's hash, the runtime binding does **no** schema verification — it just
builds the client. That is deliberate: it keeps schema correctness in the one
place that can actually enforce it, and it means a running service can never be
crashed (nor meaningfully warned) by a runtime marker check. The framework
injects the connection URL at hydrate, so user code never reads the environment.

**The target must be a ref, not a bare hash.** A marker's invariants only ever accumulate — a step's postcondition, once recorded, is never removed. Keying the migration on `storageHash` alone would silently skip a pure data-invariant change: it is an A→A self-edge (the same hash), which a hash-keyed deploy reads as "already there". Making the target a ref — hash equality plus invariant subset, mirroring Prisma Next's own verifier — closes this. (Before the replay-only revision, the ref also ruled `dbInit` out for invariant-bearing targets, since additive-only synthesis never runs the data steps that establish invariants; with synthesis gone, replay covers that case by construction.)

## Consequences

- Services get schema-typed data access with the schema version enforced at the
  type level, at Load, and at deploy — three checkpoints, the same shape as RPC
  contracts.
- `@prisma/composer-prisma-cloud` requires the application to install the Prisma
  Next facade (and transitively `pg`); runtime weight is carried only by
  importers of the subpath. How that requirement is expressed — a peer
  dependency at one exact version — is [ADR-0046](ADR-0046-the-orm-facade-is-a-peer-dependency.md).
- The deploy pipeline becomes schema-aware: contract changes without an authored
  migration path are deploy failures, surfaced before any DB change.
- A shared database exposes the whole contract to every consumer; per-consumer
  data slices are the deferred multi-contract extension. The topology still shows
  each data edge.
- ADR-0015 is amended as described; ADR-0012 (the state store stays plain SQL) is
  untouched.

## Alternatives considered

- **Binding = `{ url, contractJson }`, client constructed app-side** — keeps
  ADR-0015 as written and packs driver-free, at the cost of the framework not
  constructing the least-privilege client it has every input for. Rejected:
  Prisma Next is framework-blessed, not an arbitrary driver.
- **Multi-contract resource declarations mapped to Prisma Next contract
  spaces** — the fuller model: the resource declares the set of contracts it
  hosts (the aggregate, in code), each consumer's slice is a contract space,
  disjointness is Prisma Next-verified, and the space id lives on the contract
  declaration (never derived from topology names, so renames don't read as
  conflicts). Deferred, not rejected: it depends on multi-peer contract-space
  support whose edges are unproven, and a single contract needs none of it.
  Recorded as the extension path.
- **Deriving a database's contract set from wiring** instead of declaring it —
  superseded by the single-contract model; in the multi-contract extension the
  explicit declaration wins anyway (owner consent, visible edits).
- **`dbUpdate` (synthesized plans) at deploy** — rejected outright; authored migrations are the only production schema path.
- **`dbInit` (additive synthesis) on the first deploy of a fresh database** — adopted in the first version of this ADR, reversed by the 2026-08-25 revision above: it ran unreviewed operations in production and stranded users at their first contract change.
- **A sibling npm package for the primitive** — cleanest isolation, rejected for
  package proliferation; the subpath entry achieves the isolation that matters.

## Related

- [ADR-0015](ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md) —
  amended: Prisma Next joins the protocol-owned kinds whose binding is a client.
- [ADR-0013](ADR-0013-resources-are-provisioned-by-modules-deps-are-declarations.md) —
  the slot model this plugs into.
- [ADR-0012](ADR-0012-the-state-store-speaks-sql-directly.md) — unaffected; the
  state store's deferral stands.
- `docs/design/03-domain-model/glossary.md` § Data Contract / Aggregate
  Contract — the semantics; the aggregate becomes real in the deferred
  multi-contract extension.
