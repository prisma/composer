# ADR-0022: Data deps carry a Prisma Next contract; deploys migrate to its ref

## Decision

A second data primitive joins bare `postgres()`: a Prisma Next-typed postgres
resource and dependency (working name `pnPostgres`, final name TBD), shipped
in `@prisma/compose-prisma-cloud` behind a dedicated subpath entry.

- The **resource end** takes two separate things: the **contract**, consumed
  as its emitted artifact (`contract.json` data + `contract.d.ts` types — pure
  data and types, no Prisma Next deploy machinery), and the app's
  `prisma-next.config.ts` **by path** (a plain string). The contract types and
  wires the resource; the config path is deploy-only metadata the migration
  step reads. The app build **never imports** `prisma-next.config.ts` —
  importing it would pull Prisma Next's CLI, migration engine, and
  source-providers into the user's bundle. One contract per database.
- The **dep end** requires the same `Contract` and resolves at `load()` to a
  typed Prisma Next client — `postgres<Contract>({ contractJson, url })` —
  constructed by the framework in hydrate. The binding just builds the client;
  there is **no runtime schema verification** (see below).
- Compile-time wiring is exact: the contract's branded `storageHash` literal
  makes assignability version-equality, and `satisfies()` mirrors it at Load
  as a hash check.
- The deploy lowering gains a migration step per Prisma Next postgres
  resource.

  A **ref** is the migration target: `{ hash, invariants }`. It comes from
  the resource's optional `targetRef` (naming a
  `migrations/app/refs/<name>.json` file), or defaults to the head — the
  emitted contract's hash with zero invariants. `invariants` are named
  postconditions established by `data`-class migration steps (for example a
  backfill); each one gets recorded on the live marker once its step runs,
  and that record only ever accumulates.

  At deploy time the step compares the marker against the ref and picks one
  of three paths:

  - **No-op.** The marker's `storageHash` equals the ref's hash and every
    invariant the ref requires is already on the marker. The database is
    already where it needs to be.
  - **`dbInit`.** The database is fresh and the ref requires no invariants.
    `dbInit` does additive-only synthesis and never runs data steps, which
    is exactly why it's unsafe to use when invariants are required — that
    case falls through to `migrate` instead.
  - **`migrate`.** Everything else: a different hash, a missing invariant
    (note a pure data change with no schema change is a self-edge from a
    hash to itself), or a fresh database whose ref does require invariants.
    This walks the **authored** migration graph. The deploy fails if no
    path exists, if a step is destructive without explicit opt-in, or if
    the runner itself fails.

  The tracked migration resource is keyed on the ref's identity (hash plus
  sorted invariants), so a data-only change still produces a distinct deploy
  step. Synthesized diff-and-apply (`dbUpdate`) is never used against a
  deployed database — only `migrate` is.

Bare `postgres()` is unchanged: the untyped escape hatch, the `any` of data
deps, the same role `http()` plays for communication.

## Reasoning

The design has promised this since the README was written — a data Input
carries "a Prisma Next description of exactly the tables and columns," and the
glossary defines the Data Contract as a hashable, deterministic schema slice —
but nothing in the code implements it: today's binding is `{ url }` and
`satisfies` compares kind only. Prisma Next's actual surface fits the promise
with almost no adaptation. Contracts are committed artifacts (`contract.json`
+ `contract.d.ts`) whose branded `storageHash` type puts the schema version in
the type system; the runtime is generic over the emitted type with no client
codegen and accepts an explicit connection string, which matches injected
bindings; the control API exposes exactly the marker-read/plan/migrate
operations the deploy step needs.

**The binding is a typed client, which amends ADR-0015 rather than violating
it.** ADR-0015's principle is that a binding is the most-derived thing the
contract alone can construct; it lands on `{ url }` for bare postgres because
constructing more would bless a driver. A dep that carries a Prisma Next
contract *can* construct the typed client from the contract alone — contract
plus URL is the client's entire input. "Data contracts are Prisma Next" is a
framework-level decision (README, guiding principles), so Prisma Next is
blessed the way rpc is, and this dep kind gets a client while bare postgres
keeps `{ url }`. The dependency cost is contained by packaging: the primitive
lives behind its own subpath entry, never re-exported from the index, so a
service that opts out never loads `@prisma-next/postgres` or `pg` at runtime.

**Consume the contract; locate the config.** The two things the resource
needs pull in opposite directions, so they enter by different doors. The
runtime and the type system only need to *consume* the contract — the emitted
`contract.json` (data hydrate hands the runtime) and `contract.d.ts` (types),
both lightweight, importable into the app build with no deploy machinery
attached. The deploy migration step needs to *locate* the config — the
`prisma-next.config.ts` from which Prisma Next resolves the migrations
directory — but it needs only the **path**, a string, read at deploy time.
Passing the config as a path rather than an import is what keeps Prisma Next's
CLI and migration engine out of the user's bundle while still giving the
deploy lowering what it needs. A single contract is Prisma Next's mainline
single-space model — no dependency on multi-space edge cases — and the user is
responsible for authoring one contract that serves all consuming modules.
Every consumer sees the full contract type; least-privilege slices are
deferred (see Alternatives).

**Schema checking is a build/deploy-time job, not a runtime one.** The
authoritative check is the deploy: `migrate` walks the authored graph from the
marker's state to the target ref, is resume-safe, and writes markers atomically
with apply, so a failed deploy leaves marker and database unchanged; a contract
with no authored path is a deploy failure surfaced before any DB change.
**The target must be a ref, not a bare hash.** Keying on `storageHash` alone
has two failure modes Prisma Next's own model rules out: a pure data-invariant
change is an A→A self-edge (same hash), which a hash-keyed deploy silently
skips; and `dbInit` is additive-only synthesis that never runs app-space data
steps, so first-applying a target that requires invariants through `dbInit`
would leave `marker.invariants` empty while claiming success. The ref decision
(hash equality plus invariant subset, mirroring Prisma Next's verifier) closes
both.
Synthesized plans are a dev-time convenience, never a production operation.
Because the deploy guarantees the live database is at the contract's hash, the
runtime binding does **no** schema verification — it just builds the client.
That is deliberate: it keeps schema correctness in the one place that can
actually enforce it, and it means a running service can never be crashed (nor
meaningfully warned) by a runtime marker check. The framework injects the
connection URL at hydrate (no-globals).

## Consequences

- Services get schema-typed data access with the schema version enforced at
  the type level, at Load, and at deploy — three checkpoints, same shape as
  rpc contracts.
- `@prisma/compose-prisma-cloud` takes `@prisma-next/postgres` (and transitively `pg`)
  as a dependency; install weight is shared by all users, runtime weight only
  by importers of the subpath.
- The deploy pipeline becomes schema-aware: contract changes without an
  authored migration path are deploy failures, surfaced before any DB change.
- v1 has no per-consumer data slices: shared databases expose the whole
  contract to every consumer. The topology still shows each data edge.
- The Prisma Next → Prisma Data rename will churn the primitive's name;
  accepted.
- ADR-0015 is amended as described; ADR-0012 (state store stays plain SQL) is
  untouched.

## Alternatives considered

- **Binding = `{ url, contractJson }`, client constructed app-side** — keeps
  ADR-0015 as written and packs driver-free, at the cost of the framework not
  constructing the least-privilege client it has every input for. Rejected:
  Prisma Next is framework-blessed, not an arbitrary driver.
- **Multi-contract resource declarations mapped to Prisma Next contract
  spaces** — the fuller model: the resource declares the set of contracts it
  hosts (the aggregate, in code), each consumer's slice is a contract space,
  disjointness is Prisma Next-verified, and the space id lives on the
  contract declaration (never derived from topology names, so renames don't
  read as conflicts). Deferred, not rejected: it depends on multi-peer-app-
  space support whose edges are unproven, and v1's single contract needs none
  of it. Recorded as the extension path.
- **Deriving a database's contract set from wiring** instead of declaring it —
  superseded by the single-contract cut; in the multi-contract extension the
  explicit declaration wins anyway (owner consent, visible edits).
- **`dbUpdate` (synthesized plans) at deploy** — rejected outright; authored
  migrations are the only production schema path.
- **A sibling npm package for the primitive** — cleanest isolation, rejected
  for package proliferation; the subpath entry achieves the isolation that
  matters.

## Related

- [ADR-0015](ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md) —
  amended: Prisma Next joins the protocol-owned kinds whose binding is a client.
- [ADR-0013](ADR-0013-resources-are-provisioned-by-modules-deps-are-declarations.md) —
  the slot model this plugs into.
- [ADR-0012](ADR-0012-the-state-store-speaks-sql-directly.md) — unaffected;
  the state store's deferral stands.
- `docs/design/03-domain-model/glossary.md` § Data Contract / Aggregate
  Contract — the promised semantics; the aggregate becomes real in the
  deferred multi-contract extension.
