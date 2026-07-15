# ADR-0015: Dependencies resolve to bindings; clients are constructed app-side

## Decision

`service.load()` returns each dependency's **binding** — the most-derived value
the dependency's contract alone can construct — never a user-supplied client. A
dependency declaration is a pure requirement: it names a contract and carries no
client factory.

Concretely, a service that depends on a database and another service writes this:

```ts
// service.ts — pure requirement: a contract, no driver, no factory
export default compute({
  deps: { db: postgres(), auth: rpc(authContract) },
  build: node({ module: import.meta.url, entry: "../dist/server.js" }),
});

// server.ts — the app's own entry constructs and owns its client
const { db, auth } = service.load();     // db: PostgresConfig ({ url }); auth: a typed rpc client
export const sql = new SQL({ url: db.url, max: 1, idleTimeout: 10 });
await auth.verify({ token });            // auth came back ready to call
```

Two cases follow from "what the contract alone can construct":

- A kind whose **protocol the framework owns** (rpc, http) resolves to a
  **client**: the contract plus our transport plus a runtime built-in fully
  determine it, with no driver to choose. `rpc(contract)` binds to a typed
  generated client; `http()` binds to a thin fetch wrapper.
- A **resource kind** (postgres) resolves to its **typed connection config** —
  `PostgresConfig`, i.e. `{ url }`. The app constructs its own client from that
  config, with its own driver, in app code.

So `postgres()` (no arguments) is the dependency, and `postgres({ name })` is the
provisionable identity. A declaration never carries a client factory; the
framework constructs only the clients it can choose.

## Reasoning

The heart of the decision is the asymmetry in that second code block: `auth`
comes back ready to call, while `db` comes back as `{ url }` and the app builds
the client itself. That asymmetry is not an inconsistency — it is exactly what
"the most-derived thing the contract can construct" means when the two contracts
differ in what they determine.

For `rpc` and `http`, the framework owns the protocol. An rpc contract plus our
network transport fully determines the client; there is no driver to pick, so the
most-derived thing the contract can produce *is* the client, and producing it is
the framework's job. Handing the app a ready client gives up nothing, because
there was never a choice to place.

Postgres is different. Its wire protocol is not ours, and the client is a driver
— `bun:sql`, `node-postgres`, `postgrejs`, a pool with specific options — whose
**type is the choice**. Putting a client factory in the declaration conflates two
separate things: *what the service requires* (a Postgres speaking this contract)
and *how this app consumes it* (this driver, these pool settings). The requirement
is provider-independent; the consumption is an app decision. Fold the second into
the first and the declaration — the thing the module wires against — carries
app-specific mechanics it has no business knowing, and the pack is pushed toward
blessing or shipping a driver it cannot choose correctly for every app.

So the declaration carries only what is irreducibly shared — the typed config the
contract describes — and the driver choice is placed where it honestly lives: in
app code, next to the app's other runtime choices. `load()` hands over
`PostgresConfig`; the app writes `new SQL({ url: db.url })`. Because that
construction never touches the dependency's contract, it cannot change which
providers wire — provider-independence is a structural property, not a convention
the app must remember to preserve.

Handing back config rather than a client keeps every property that matters:

- **DI is typed.** The binding is typed by the contract — `PostgresConfig` for
  postgres, `Client<C>` for rpc — so the app entry has full type information.
- **The entry is wiring-free** in the sense that matters: it never reads the
  environment, a key name, or the topology. `load()` hands it the binding and it
  goes.
- **Memoization is app-owned and trivial:** the client is a module-level
  `export const`, constructed once per process.

**Stipulating a specific driver presentation** — a consumer that wants, say, a
particular pool wrapper — is a plain `binding → client` function applied in app
code (`const sql = bunSql(db)`). It takes the binding and returns a client, never
touching the requirement's contract, so it cannot affect wiring. There is nothing
for the framework to model; it is ordinary app code.

## Consequences

- **A postgres dependency's `load()` value is `PostgresConfig`, not a client.**
  App code constructs the client — one `new SQL(...)` (or the app's driver of
  choice) at module scope. This is the visible obligation for app authors.
- **`load()`'s return type is mixed by design:** a derived client for
  protocol-owned kinds (rpc, http), a typed config for resource kinds (postgres).
  One uniform rule makes it coherent — "the most-derived thing the contract can
  construct" — even though the results differ in shape. Documentation states this
  directly rather than promising "typed clients".
- **The pack ships no driver and blesses none.** `@prisma/compose-prisma-cloud` has no
  `bun`/`pg` dependency and constructs no postgres client; the runtime-agnostic
  and driver-free invariants hold without exception.
- **`http()` derives its fetch wrapper** and takes no client argument, so the "no
  client factory in any declaration" rule is uniform across kinds. An app that
  needs a different http client wraps the binding app-side, the same as postgres.
- **A declaration is a pure requirement.** A `DependencyEnd` is
  `{ name?, required, connection: { params, hydrate } }`, where `hydrate` is a
  pack-derived client (rpc/http) or the identity (postgres).

A further simplification the design admits, not adopted here: the **contract
owning the config surface**, so the binding type becomes the contract's `Cmp` and
`DependencyEnd` narrows to `{ name, required }`, with `params`/`hydrate` moving
onto the contract. That is a larger reshape of `Contract` across every kind; this
decision stops short of it.

## Alternatives considered

- **A client factory in the declaration** (`postgres({ client })`). Rejected: it
  conflates requirement with consumption mechanics, and the driver choice is
  irreducible — a postgres client's type *is* the choice, so it can only be
  placed, and app code is its honest home. The same objection rejects **named
  adapters in the declaration** (`postgres({ driver: bunSql })`): keeping any
  stipulation out of `deps` is precisely what makes provider-independence
  structural rather than conventional.
- **A `clients` map on the service** (`compute({ deps, clients: { db: bunSql } })`).
  Validity-preserving (the wrap is applied after binding, never touching the
  contract) and typed. It layers onto the same hydrate slot without changing the
  binding model, so it remains a compatible addition if the app-side wrap proves
  noisy — but it is machinery the base model does not require, so the base model
  does without it.
- **Binding at `load()` / bind-time** (factories passed per `load()` call, or via
  a `service.bind(factories)`). Rejected: `load()` is called from multiple sites
  — every Next page, `serve()` — so per-call factories are either duplicated
  across those sites or order-dependent on a first "binding" call. The binding
  must be determined by the declaration and resolved once.
- **The module supplies the client.** Infeasible: the client factory must ship in
  the *consumer's* deployed bundle (it runs at that service's boot), and module
  wiring code does not travel into a service's bundle.
- **A kind-derived client for postgres** (the pack ships or blesses a driver, as
  it legitimately does for http). Rejected: unlike http, postgres's protocol is
  not ours and no single driver pick is right for every app — the client's type
  is the app's choice, so deriving one would violate the driver-free pack
  invariant and impose a decision the pack cannot make correctly.

## Related

- [`../10-domains/core-model.md`](../10-domains/core-model.md) — `load()` and the
  runtime path; the binding is what `load()` returns.
- [`connection-contracts.md`](../10-domains/connection-contracts.md) — the
  Contract that types each binding.
- [`ADR-0013`](ADR-0013-resources-are-provisioned-by-modules-deps-are-declarations.md)
  — the uniform dependency model this builds on.
