# ADR-0009: Resources are provisioned by hexes; a service's deps are declarations

## Status

Accepted

## Decision

A resource exists in exactly one place: a hex provisions it. `ResourceNode` is
an identity — `{ name, pack, type }`, constructed by a pack factory like
`postgres({ name })` — and the only way one enters the graph is
`h.provision(id, resource)`, which returns a typed `ResourceRef`. A service
never holds a resource: its `deps` admit only **declarations** — `ResourceEnd`
(a resource slot, from a pack factory like `postgresDep({ client })`) and
`ConnectionEnd`. The hex wires the one provisioned resource into each
consumer's slot, and the wiring is type-checked against the slot's declared
resource type at the `provision` call site and re-checked at Load.

## Reasoning

Take two services sharing one database — an ingestion service that writes
readings into Postgres and an API service that reads them back out. The system
has **one** database; that is not an optimization but the point: both services
see the same rows.

Suppose instead a service could embed a resource in its own `deps`:

```ts
export default compute({
  name: "ingest",
  deps: { db: postgres({ name: "db", client: ... }) },
  ...
})
```

Deploy would have to conjure a database out of that mention — and if the API
service writes the same line, a **second** database, because nothing in two
separate mentions says "the same one". Two rules break at once. First,
infrastructure appears implicitly: mentioning a dependency creates a stateful,
billable thing, with no single place in the code that says the database exists.
Second, sharing is inexpressible: identity by mention means one instance per
mention, so the ingestion service and the API can never see the same rows.
Sharing by *name coincidence* (two mentions with the same `name` string merge)
would fix the second problem by making the first worse — now a typo forks your
data, and a match silently aliases it.

The fix is to separate the two things the embedded resource was conflating:

- **What a service needs** is a declaration: "a Postgres, hydrated into this
  client type." That is `ResourceEnd` — a slot in `deps`, exactly parallel to
  the `ConnectionEnd` a service declares for another service. It carries the
  connection face (config params + the `hydrate` client factory) and provisions
  nothing.
- **What exists** is an identity: `ResourceNode`, owned by whoever composes the
  system. Only a hex may provision one, under a stable id, and the returned
  `ResourceRef` is the only handle that can fill a slot.

The hex body is then the one place the shared database is legible:

```ts
export default hex("datahub", (h) => {
  const db = h.provision("db", postgres({ name: "db" }))
  h.provision("ingest", ingestService, { db })
  h.provision("api", apiService, { db })
})
```

One `provision` call, one database; two wirings, two consumers. The graph
records it the same way: one resource node, and one `resource` edge per
consumer (from the resource to the service, labeled with the consumer's input
name) — the same producer-to-consumer shape a `connection` edge has. Lowering
follows the graph, so the resource lowers exactly once no matter how many
services consume it, and each consumer's `Config` resolves its slot through its
own edge to the same outputs. Each service still gets its own config keys
(`INGEST_DB_URL`, `API_DB_URL`) carrying the same value — the runtime side is
untouched, because a `ResourceEnd` hydrates through exactly the machinery the
embedded resource used.

The slot's `type` is a literal (`"postgres"`), carried on both the end and the
ref, so wiring a slot to a resource of another type is rejected by the compiler
at the `provision` call site; Load re-checks the same relation at runtime, as a
backstop against casts. And because `Deps` admits only ends, a concrete
`ResourceNode` in `deps` is unrepresentable in the types and a targeted
LoadError at runtime — a service cannot cause infrastructure to exist by
mentioning it, in the same way it cannot conjure the service it calls.

The composition rule falls out: a service deployed directly as the root may
carry no dependency slot at all, because nothing at the root wires or
provisions for it. The error points at deploying the composing hex — the same
rule, and the same message shape, that unwired connection inputs always had.

## Consequences

- **Sharing is expressible and the default is honest.** One provision, N
  wirings. A second database is a second `provision` call — visible in review,
  never an accident of mention counting.
- **No implicit infrastructure.** Every stateful, billable thing traces to one
  `h.provision` line. The hex body is the inventory.
- **A pack ships two factories per resource type** (identity + dep — e.g.
  `postgres` and `postgresDep`) instead of one. The seam is also where the
  client type lives: the dep factory takes the client, since hydration belongs
  to the consumer.
- **Even a single-service app with a database needs a small hex** to provision
  and wire it. Dependency-less services still deploy directly.
- **Lowering stays a graph walk.** The resource ctx `id` is the hex provision
  id; targets need no dedup and no knowledge of consumers.

## Alternatives considered

- **Inline auto-create: keep resources in `deps` and provision one per
  mention.** Rejected: infrastructure appears implicitly, and two services can
  never share one instance — the failure modes that motivated the change.
  Merging mentions by name string would trade implicit creation for implicit
  aliasing.
- **Reuse the ConnectionEnd/Contract machinery for resources.** The slot shape
  is deliberately parallel, but the checking is not the same thing: a resource
  type is a routing key (`"postgres"`), not a contract with a `satisfies()`
  relation — there is no interface to be width-compatible against. And the
  producers differ in kind: a connection's producer is a service whose outputs
  exist only after *deploy*, while a resource is lowered by the target's
  resource table before any consumer. Folding them together would force both
  differences through one mechanism that fits neither.
- **One overloaded `postgres()` for both roles** — `postgres({ name })` returns
  the identity, `postgres({ name, client })` the slot. Rejected: passing or
  omitting `client` would silently flip the node kind, turning a forgotten
  argument into a different graph shape instead of a compile error. Two
  factories make the two roles two words.

## Related

- [`../10-domains/core-model.md`](../10-domains/core-model.md) — the type-level
  design this decision shapes (ResourceNode/ResourceEnd, HexBuilder, lowering).
- [`ADR-0003`](ADR-0003-deploy-derives-everything-from-the-root-node.md) — the
  composing-hex error surface this extends to resource slots.
- [`ADR-0006`](ADR-0006-every-node-is-named.md) — node naming; a provisioned
  resource's address is its hex provision id.
