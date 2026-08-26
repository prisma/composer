# ADR-0013: Resources are provisioned by modules; dependencies are uniform contract-checked slots

## Decision

A service says what it needs, not who supplies it. It declares a
**dependency**: a named slot asking for something able to speak a given
connection, hydrated into a given client type. The slot doesn't care whether
the eventual supplier is another service or a piece of infrastructure like a
database — both are wired in exactly the same way.

Wiring happens in the enclosing module. The module **provisions** the actual
producer — a database, another service — and passes a reference to it into
the slot:

```ts
// src/module.ts
import { module } from "@prisma/composer";
import { postgres } from "@prisma/composer-prisma-cloud";
import ingestService from "./ingest.ts";
import apiService from "./api.ts";

export default module("datahub", ({ provision }) => {
  const db = provision(rawPostgres({ name: "db" })); // provides rawPostgresContract
  provision(ingestService, { deps: { db } }); // ingest.deps.db requires it
  provision(apiService, { deps: { db } }); // api.deps.db requires it
});
```

One `provision` call creates the database; both services wire into the same
reference, so they read and write the same rows. A **resource** — the general
term for a stand-alone piece of infrastructure such as this database — exists
in exactly one place: wherever a module provisions it. A service can never
cause one to exist just by mentioning it.

## Reasoning

The module above has exactly one database, and that is the point, not an
incidental detail: both services need to see the same rows. Suppose instead
that a service could embed a resource directly in its own `deps`, and deploy
conjured a database into existence the moment it saw the mention. If the API
service wrote the same line as the ingestion service, a **second** database
would appear, because nothing about two separate mentions says "the same
one". Two things break at once. Infrastructure appears implicitly: mentioning
a dependency creates a stateful, billable thing, with no single place in the
code that says the database exists. And sharing becomes inexpressible:
identity by mention means one instance per mention, so the two services could
never see the same rows.

So what a service writes has to be a **declaration of need**, not a piece of
infrastructure — and that need has to be the same shape whether the eventual
supplier is another service or a resource: "I need something that speaks this
contract, hydrated into this client type." Formally, that is a
`DependencyEnd<C, Req>` — a slot carrying the connection face (its config
params, plus a `hydrate` function that turns them into a client) and the
`Contract` it requires. A `Contract` names a `kind` — a string identifying
what it is, `"postgres"` for example — and provides a `satisfies(required)`
check that decides whether it is an acceptable stand-in for a required
contract. A `DependencyEnd` provisions nothing on its own; it is pure
requirement.

What satisfies a slot is a provisioned producer, exactly as the example above
does it, and provisioning is the module's job. A module provisions a
resource — a `ResourceNode`, which carries the `Contract` it `provides`, its
routing `type` derived from `provides.kind` — or a service, and wires the
returned reference into each consumer's slot. `provision()` is the one way a
resource enters the graph at all: call it once, and there is one database;
wire the same reference into as many consumers as need it.

The graph records this uniformly: one resource node, and one `dependency`
edge per consumer, from the producer to the consumer — the same shape a
service-to-service edge has. Lowering (turning the graph into the actual
deploy plan) follows the graph, so the resource lowers exactly once no matter
how many services consume it, and each consumer's config resolves its slot
through its own `dependency` edge to the same outputs. Each service still
gets its own config keys (`INGEST_DB_URL`, `API_DB_URL`) carrying the same
value — the runtime side is untouched, because the slot hydrates through the
same connection machinery it always did.

Validity is the contract, checked once, uniformly. A `DependencyEnd`'s
`required` contract is compared against the wired reference's contract: plain
assignability at the `provision()` call site, and `ref.satisfies(required)`
again at Load — the point where the module body actually runs and the graph
gets built — as a runtime backstop. There is no branching on what kind of
thing produced the reference anywhere: a service's exposed port cannot fill a
postgres-requiring slot, not because Load special-cases kinds, but because no
service port carries a contract whose kind is `"postgres"`. `rawPostgresContract`
(the concrete Postgres contract) makes this precise: its `satisfies` compares
`kind`, not object identity, so a duplicated copy of the postgres package
elsewhere in a workspace still satisfies the same requirement.

The `rawPostgres()` factory has exactly two shapes, chosen by what you pass it.
`{ name }` returns the resource identity — the thing a module provisions,
providing `rawPostgresContract`. Called with no argument at all, it returns the
dependency — the thing a service declares in its own `deps`, requiring that
same contract; its binding is the typed connection config itself, and the app
builds its own client from it. The two shapes are mutually exclusive at the
type level: passing `{}` does not typecheck, since the only accepted argument
is `{ name: string }` or nothing.

A bare `ResourceNode` inside a service's `deps` is rejected — by the types,
since `deps` only admits `DependencyEnd` declarations, and by a targeted error
at Load if something slips past the types at runtime. A service cannot cause
infrastructure to exist by mentioning it, the same way it cannot conjure the
service it calls into existence. The composition rule falls out of the same
logic: a service deployed directly as the root can carry no dependency slot
at all, because nothing at the root wires or provisions for it — an unwired
slot is a Load-time error pointing at deploying the composing module instead.

## Consequences

- **Sharing is expressible and the default is honest.** One provision, N
  wirings. A second database is a second `provision` call — visible in review,
  never an accident of mention counting.
- **No implicit infrastructure.** Every stateful, billable thing traces to one
  `provision` line. The module body is the inventory.
- **One mechanism, one edge kind, one ref shape.** Wiring, the `DepBindings<D>`
  type, the `dependency` edge, `buildConfig`'s edge lookup, and the DAG check
  are each a single case. Community packs implement a resource by shipping a
  `Contract` and a `ResourceNode` that provides it; nothing bespoke in core.
- **The untyped `http()` slot accepts any provisioned ref** — a service port or
  a resource — because its `required` is `undefined`. This is inherent to
  uniformity and is the escape hatch that was never contract-checked to begin
  with; typed contracts are where validity lives, and a slot that wants a
  guarantee declares one.
- **A dependency declaration coupling the required contract to a client
  factory is an avoidable overreach.** A contract ideally shouldn't imply a
  client — the declaration ought to be pure need, with the client bound
  elsewhere.
  [ADR-0015](ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md)
  resolves this: `load()` returns the contract-determined binding (a derived
  client for protocol-owned kinds, the typed config for resources), and
  client construction moves into app code.
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
  a split wiring type, a `resource` edge beside the `connection` edge, and
  producer-kind branching in Load — to express what one contract-checked slot
  already expresses. A resource "type" and a service "contract" are the same
  question (does this producer satisfy this need?) wearing two coats. Collapsing
  them removes a whole parallel vocabulary and every place it forked.
- **The `Dependable` dual-form** — a value that is both a provisionable identity
  and, via a `toDependency()` conversion interface, a slot usable directly in
  `deps`, so a single-consumer app could write one `rawPostgres({ name, client })`.
  Rejected: it added a bespoke core primitive (a conversion interface,
  `service()` input normalization, a `NormalizedDeps` type) and a spread-built
  dual object — for a convenience no example actually needed once resources are
  module-provisioned, and the spread hack broke prototype/brand assumptions. The
  split `{ name }`/no-argument shapes say the two roles plainly; the module
  owning the identity is the honest picture anyway.
- **Two factory names** (`postgres` for the identity, `postgresDep` for the
  slot). Sound, but a second exported name per resource type where one factory
  with two argument shapes reads the same and keeps the vocabulary small.

## Related

- [`../10-domains/core-model.md`](../10-domains/core-model.md) — the type-level
  design this decision shapes (ResourceNode/`provides`, DependencyEnd, the one
  dependency-wiring mechanism, ModuleBuilder, lowering).
- [`ADR-0003`](ADR-0003-deploy-derives-everything-from-the-root-node.md) — the
  composing-module error surface this extends to dependency slots.
- [`ADR-0006`](ADR-0006-every-node-is-named.md) — node naming; a provisioned
  resource's address is its module provision id.
