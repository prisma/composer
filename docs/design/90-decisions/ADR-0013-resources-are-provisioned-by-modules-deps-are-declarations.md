# ADR-0013: Resources are provisioned by modules; dependencies are uniform contract-checked slots

## Decision

A service declares **dependencies** — one kind of slot, `DependencyEnd`,
whoever the producer turns out to be. You **provision** a service or a resource
that satisfies it, and pass the provisioned ref to fill the slot. **The
contract determines validity**: a `DependencyEnd` requires a `Contract`, a
provisioned producer carries one (a service's exposed port, or a resource's
`provides`), and wiring checks the ref against the requirement — at the
`provision` call site and again at Load via `satisfies()`. There is no
service-shaped mechanism and resource-shaped mechanism; there is one.

A resource exists in exactly one place: a module provisions it. `ResourceNode` is
an identity that carries the `Contract` it `provides`; its routing `type` is
derived from `provides.kind`. `h.provision(id, resource)` is the only way one
enters the graph, and it returns the provided contract as the ref (tagged with
the id) — the same shape a service port's ref has. A service never holds a
resource: `deps` admit only `DependencyEnd` declarations, so a service cannot
cause infrastructure to exist by mentioning it.

## Reasoning

Take two services sharing one database — an ingestion service that writes
readings into Postgres and an API service that reads them back out. The module
has **one** database; that is not an optimization but the point: both services
see the same rows.

Suppose a service could embed a resource in its own `deps` and deploy would
conjure a database out of the mention. If the API service writes the same line,
a **second** database appears, because nothing in two separate mentions says
"the same one". Two rules break at once. First, infrastructure appears
implicitly: mentioning a dependency creates a stateful, billable thing, with no
single place in the code that says the database exists. Second, sharing is
inexpressible: identity by mention means one instance per mention, so the
ingestion service and the API can never see the same rows.

So the thing a service writes must be a **declaration of need**, not a piece of
infrastructure. And that need is the same shape whether the thing that
satisfies it is another service or a provisioned resource: "I need something
that speaks this contract, hydrated into this client type." That is
`DependencyEnd<C, Req>` — a slot carrying the connection face (config params +
the `hydrate` client factory) and the `Contract` it requires. It provisions
nothing.

What satisfies a slot is a **provisioned producer**, and provisioning is the
module's job. A module provisions a resource — `ResourceNode`, which carries the
`Contract` it `provides` — or a service, and wires the returned ref into each
consumer's slot. The module body is the one place the shared database is legible:

```ts
export default module("datahub", (h) => {
  const db = h.provision("db", postgres({ name: "db" }))   // provides postgresContract
  h.provision("ingest", ingestService, { db })             // ingest.deps.db requires it
  h.provision("api", apiService, { db })                   // api.deps.db requires it
})
```

One `provision` call, one database; two wirings, two consumers. The graph
records it uniformly: one resource node and one `dependency` edge per consumer
(from the producer to the consumer, the same shape a service-to-service edge
has). Lowering follows the graph, so the resource lowers exactly once no matter
how many services consume it, and each consumer's `Config` resolves its slot
through its one `dependency` edge to the same outputs. Each service still gets
its own config keys (`INGEST_DB_URL`, `API_DB_URL`) carrying the same value —
the runtime side is untouched, because the slot hydrates through the same
connection machinery it always did.

Validity is **the contract, checked once, uniformly**. A `DependencyEnd`'s
`required` contract is compared against the wired ref's contract: plain
assignability at the `provision` call site, and `ref.satisfies(required)` at
Load as the runtime backstop. There is no producer-kind branching anywhere — a
service ref cannot fill a postgres-requiring slot not because Load special-cases
kinds, but because no service port carries a contract of kind `"postgres"`. The
`postgres` pack makes this concrete with `postgresContract`, whose `satisfies`
compares KIND rather than identity, so a pack module duplicated across a
workspace still satisfies (the same rationale as the `Symbol.for` node brand).

The `postgres()` factory then has exactly two shapes: `{ name }` returns the
identity providing `postgresContract`, `{ client }` returns the dependency
requiring it (the client type inferred from the factory). They are mutually
exclusive — `{ name, client }` and `{}` are compile errors and runtime throws.

A bare `ResourceNode` in `deps` is rejected by the types and a targeted
LoadError at runtime — a service cannot cause infrastructure to exist by
mentioning it, in the same way it cannot conjure the service it calls. And the
composition rule falls out: a service deployed directly as the root may carry
no dependency slot at all, because nothing at the root wires or provisions for
it; an unwired slot is a LoadError pointing at deploying the composing module.

## Consequences

- **Sharing is expressible and the default is honest.** One provision, N
  wirings. A second database is a second `provision` call — visible in review,
  never an accident of mention counting.
- **No implicit infrastructure.** Every stateful, billable thing traces to one
  `h.provision` line. The module body is the inventory.
- **One mechanism, one edge kind, one ref shape.** Wiring, the `Wiring<D>`
  type, the `dependency` edge, `buildConfig`'s edge lookup, and the DAG check
  are each a single case. Community packs implement a resource by shipping a
  `Contract` and a `ResourceNode` that provides it; nothing bespoke in core.
- **The untyped `http()` slot accepts any provisioned ref** — a service port or
  a resource — because its `required` is `undefined`. This is inherent to
  uniformity and is the escape hatch that was never contract-checked to begin
  with; typed contracts are where validity lives, and a slot that wants a
  guarantee declares one.
- **The dependency declaration still carries the client factory.** A contract
  ideally shouldn't imply a client — the declaration ought to be pure need,
  with the client bound elsewhere. That coupling predated this decision and was
  accepted at the time; it is **resolved by
  [ADR-0015](ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md)**,
  which makes `load()` return the contract-determined binding (a derived client
  for protocol-owned kinds, the typed config for resources) and moves client
  construction into app code.
- **Even a single-service app with a database needs a small module** to provision
  and wire it. Dependency-less services still deploy directly.
- **Lowering stays a graph walk.** The resource ctx `id` is the module provision
  id; targets need no dedup and no knowledge of consumers.

## Alternatives considered

- **Inline auto-create: keep resources in `deps` and provision one per
  mention.** Rejected: infrastructure appears implicitly, and two services can
  never share one instance — the failure modes that motivated the model.
  Merging mentions by name string would trade implicit creation for implicit
  aliasing.
- **Parallel resource-end machinery with type-literal matching** — a distinct
  `ResourceEnd<C, T>` slot and `ResourceRef<T>` ref beside the connection slot,
  matched by comparing a literal resource type (`"postgres"`) rather than a
  contract. Rejected: it is two of everything — two slot kinds, two ref kinds,
  a split `Wiring` type, a `resource` edge beside the `connection` edge, and
  producer-kind branching in Load — to express what one contract-checked slot
  already expresses. A resource "type" and a service "contract" are the same
  question (does this producer satisfy this need?) wearing two coats. Collapsing
  them removes a whole parallel vocabulary and every place it forked.
- **The `Dependable` dual-form** — a value that is both a provisionable identity
  and, via a `toDependency()` conversion interface, a slot usable directly in
  `deps`, so a single-consumer app could write one `postgres({ name, client })`.
  Rejected: it added a bespoke core primitive (a conversion interface,
  `service()` input normalization, a `NormalizedDeps` type) and a spread-built
  dual object — for a convenience no example actually needed once resources are
  module-provisioned, and the spread hack broke prototype/brand assumptions. The
  split `{ name }`/`{ client }` shapes say the two roles plainly; the module owning
  the identity is the honest picture anyway.
- **Two factory names** (`postgres` for the identity, `postgresDep` for the
  slot). Sound, but a second exported name per resource type where one factory
  with two argument shapes reads the same and keeps the vocabulary small.

## Related

- [`../10-domains/core-model.md`](../10-domains/core-model.md) — the type-level
  design this decision shapes (ResourceNode/`provides`, DependencyEnd, the one
  `Wiring`, ModuleBuilder, lowering).
- [`ADR-0003`](ADR-0003-deploy-derives-everything-from-the-root-node.md) — the
  composing-module error surface this extends to dependency slots.
- [`ADR-0006`](ADR-0006-every-node-is-named.md) — node naming; a provisioned
  resource's address is its module provision id.
