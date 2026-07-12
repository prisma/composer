# Connection contracts — typed service-to-service interfaces

A service-to-service dependency is described by a **Contract**: a value both the
consumer and the provider import. A Contract is parametric over its **kind**; the
first — and today only — kind is **RPC**. Compatibility between consumer and provider
is checked in three places — plain TypeScript assignability where the two are wired, a
runtime `satisfies()` check at Load, and per-call input/output validation at Run.

This replaces the untyped `http()` Connection from
[core-model.md](core-model.md), which hydrated to a URL-anchored `fetch` wrapper
where nothing checked that the provider answered what the consumer expected.

The rest of this document builds the idea up from a worked example, explains how
the compile-time check actually works, and ends with the alternatives we weighed.

## A worked example

The `storefront-auth` app: an `auth` service exposes a `verify` method; a
`storefront` service depends on it. The Contract is defined once and imported by
both sides.

```ts
// auth/contract.ts — the shared Contract value. Its identity is the Load-time key.
export const authContract = contract({
  verify: rpc({ input: type({ token: "string" }), output: type({ ok: "boolean" }) }),
})

// auth/service.ts — the provider DECLARES what it exposes. `expose` is a record of
// named output ports, each its own contract.
export default compute({
  build: node({ entry: "server.js" }),
  expose: { rpc: authContract },
})

// auth/server.ts — the provider IMPLEMENTS it. serve() reads the service's `expose`
// and forces an exhaustive, correctly-typed handler map; it generates the server and
// calls load() for the deps, passing them to each handler.
import service from "./service"
export default serve(service, {
  rpc: { verify: async ({ token }, { db }) => ({ ok: await check(db, token) }) },
})

// storefront/service.ts — the consumer REQUIRES the contract: rpc(contract), not http().
export default compute({
  deps: { auth: rpc(authContract) },
  build: nextjs({ entry: "server.js" }),
})

// storefront/page.tsx — the consumer USES the derived typed client.
const { auth } = service.load()
await auth.verify({ token })          // input {token}, output {ok}, both typed

// the module — WIRING is where the provider is checked against the consumer.
// authRef carries auth's exposed ports; pick one for the consumer's slot.
module("storefront-auth", (h) => {
  const authRef = h.provision("auth", authService)
  h.provision("storefront", storefront, { auth: authRef.rpc })   // TS: rpc port must satisfy the slot
})
```

Each piece carries the type that makes the wiring check itself:

- **`rpc(contract)`** on the consumer's dependency carries the *required* contract
  and hydrates to `Client<C>` (`{ verify(input): Promise<output> }`). RPC is a
  protocol the framework owns, so a dependency's binding IS a derived client — the
  most-derived thing the contract can construct; a resource kind (postgres)
  instead binds to its typed config and the app builds its own client
  ([ADR-0015](../90-decisions/ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md)).
- **`expose`** on the provider service carries the *exposed* contracts, keyed by
  output-port name.
- **`provision(id, service)`** returns a `ProvisionedRef` whose named members
  (`authRef.rpc`) each carry their port's contract.
- **`provision(id, consumer, wiring)`** types `wiring` so each slot demands a ref
  whose contract is assignable to the slot's required contract.

This is the hexagonal shape made concrete: a service has typed **input ports** (its
deps, consumed via `load()`) and typed **output ports** (its `expose`, served via
`serve()`); the module connects an output port to an input port.

## What a Contract is

A **Contract** is the declared interface at a dependency boundary: a value, owned by
neither side, that both the consumer and the provider refer to. It is **parametric
over its kind** — one abstraction, one set of checks, spanning different kinds of
dependency:

- a service dependency → an **RPC Contract** (methods and their input/output shapes);
- a data dependency → a **Data Contract** (the data shape a consumer depends on,
  plus migration compatibility).

The prose name of a kind is its `kind` brand plus "Contract" — `Contract<'rpc'>` is an
*RPC Contract*, `Contract<'data'>` a *Data Contract*. **Bare "Contract" always means
the abstraction, never a specific kind**; RPC gets no default privilege. Today RPC is
the only implemented kind. Data Contract is Prisma's existing concept (see PDL below);
naming it a sibling kind rather than a loose analogy is deliberate — it makes our
taxonomy and Prisma's the same one.

The core is **parametric over the Contract**: it holds contract *values*, carries
their *types* (TypeScript does the compile-time compatibility), and calls their
`satisfies()` method (runtime compatibility). It never inspects the kind or the
comparison mechanics. So the kind (RPC first; gRPC, WebSocket, or GraphQL as
later ecosystem packages), the comparison mechanics (RPC compares by identity now,
structural later),
and the number of outputs are all open without the core changing.

## A Connection is a port

The Contract is the port; the code on either side is an adapter. The provider's
server and the consumer's client are both generated from the contract by the same
target pack, so the wire format between them is private to the pack — not a
framework concern.

Because the consumer holds a client generated from the contract, **the binding does
not have to be a network hop.** Which adapter sits behind the client is a wiring
decision:

- a co-deployed remote provider → a **network** adapter (a URL client);
- a co-located provider → an **in-memory** adapter (call the handler directly);
- a test → a **mock**.

Consumer code — `auth.verify(input)` — is identical across all three. That one idea
covers test mocks, the dependency-inversion swap, local dev with no deploy, and
wrapping a legacy server. A Connection is a port; *where* the provider runs is a
wiring decision the consumer never sees.

## How compatibility is checked

Enforcement happens in three places:

1. **Authoring (TypeScript) — the primary check.** Assignability at the wiring site
   rejects an incompatible provider before anything runs.
2. **Load — the contract's own `satisfies()`.** The framework calls
   `providerPort.satisfies(consumerSlot)` and does not know the mechanism — each kind's
   contract implements its own. Today the RPC contract compares by **identity** (same
   contract value), so a structurally-equivalent-but-distinct contract does not match.
   That is the RPC contract's current implementation, not a rule the framework or the
   Contract abstraction imposes.
3. **Run (per call) — validate input and output against the contract's schemas.**
   Catches a provider that is typed-compatible but lies at runtime: a bug, drift, or
   a legacy server wrapped in a Service that TypeScript never saw.

### The compile-time check is plain TypeScript assignability

The framework holds a `Contract` as a **kind** brand plus an **opaque
comparison type** `Cmp`, and a runtime `satisfies()` method:

```ts
interface Contract<Kind extends string, Cmp> {
  readonly kind: Kind                                    // "rpc" · "grpc" · … (the brand)
  readonly __cmp: Cmp                                    // opaque to the core
  satisfies(required: Contract<Kind, unknown>): boolean  // runtime mirror of the compile check
}
```

`provision` requires each wired contract to be assignable to the consumer's required
slot, with `NoInfer` on the brand so the `kind` is checked rather than co-inferred
into a union:

```ts
declare function provision<Deps extends Record<string, Contract<any, any>>>(
  id: string, consumer: Consumer<Deps>, wiring: { [K in keyof Deps]: NoInfer<Deps[K]> },
): void
```

The core never inspects `Cmp`. Correctness comes from the **kind**, which builds
`Cmp` so that plain assignability means the right thing. For RPC, `Cmp` is a
**concrete function map**: `rpc()` returns a concrete `(input: I) => Promise<O>`, so
`contract()`'s `Cmp` is `{ verify: (input) => Promise<output>, … }`:

```ts
declare function rpc<I, O>(m: { input: Schema<I>; output: Schema<O> }): (input: I) => Promise<O>
declare function contract<Fns extends Record<string, (i: any) => Promise<any>>>(fns: Fns): Contract<"rpc", Fns>
type Client<C> = C extends Contract<any, infer Cmp> ? Cmp : never
```

Because `Cmp` is a concrete function map, TypeScript applies real function variance
to `provided extends required` — **contravariant input, covariant output**, plus
width. A provider may expose extra methods and return richer outputs; a provider
that requires an input field the consumer never sends is rejected; a wrong-kind
provider is rejected by the brand.

The comparison type **must** be a concrete function map, not a mapped type over the
schema. If the contract were parameterised by its schema map `M` and the client
derived as a mapped type over `M`, comparing two instantiations would relate the
`M`s covariantly — silently dropping input-contravariance and accepting a provider
that demands an input the consumer never sends. Materialising `Cmp` as concrete
functions in the kind's builder is what makes plain assignability sound. (See
`@prisma/compose-rpc`'s `contract-satisfaction.test-d.ts` for the full accept/reject
matrix, typechecked in CI.)

Schemas are **Standard Schema** (arktype is the canonical authoring library; any
Standard-Schema validator works, so an Effect provider and a plain consumer
interoperate over one contract). They carry the runtime validators and drive the
published spec; the *type* the core compares is the function map.

### Growing the runtime check

Growing the RPC contract's `satisfies()` from identity to **structural** later is
backward-compatible: it would accept "same value **or** structurally compatible,"
which is purely additive — everything that passes today still passes. Because the
mechanism is encapsulated behind `satisfies()`, the change stays inside the RPC
contract and never touches the framework.

Structural comparison earns its keep in the distributed case: when the provider is a
*separately deployed* service whose TypeScript the local build cannot see,
compatibility is checked by comparing the consumer's contract against the provider's
**published spec** (the contract compiled to OpenAPI / JSON-RPC). That is the same
engine as the Data Contract migration check — "a newly deployed provider must still
satisfy every existing consumer." The in-build Module is fully covered by the
three layers above.

## Implementing — why the handler cannot skip the contract

`serve(service, handlers)` derives the required handler map from the service's
`expose`, so an incomplete or mistyped implementation does not compile:

```ts
function serve<S extends ServiceNode>(service: S, handlers: Handlers<ExposeOf<S>>): Server

type Handlers<E> = {
  [Port in keyof E]: { [M in keyof E[Port]]: (input: In<E[Port][M]>, deps: Deps) => Promise<Out<E[Port][M]>> }
}
```

The contract lives once, on the definition; the implementation is *handed* that
definition and cannot compile unless it satisfies it. The import points
definition-ward only (`server.ts` → `service.ts`, never the reverse), so bundling
`service.ts` into the runtime wrapper never pulls in the entry's app code — the
acyclic bundle shape from core-model.md is preserved.

The type system forces `serve(...)` to be complete and correct, but cannot force the
entry to *call* `serve` at all. `serve` is strictly the easier path (fill handlers,
no transport), and a deploy-time probe (call each method against the started server,
check the shape) can close that gap at runtime if a hard guarantee is ever wanted.

## Ownership

The Contract is a standalone value; where it lives is code organisation. The
framework owns the builder and the type, never the location:

- a third-party Module ships the Contract *with* the provider; alternative
  implementations and mocks import it;
- a first-party app puts the Contract beside the Service; mocks import it;
- a dependency-inverted app puts the Contract with the consumer or in a central
  package, and implementer Modules depend on it.

All three are "both sides import one Contract value," which is also why the RPC
contract's identity-based `satisfies()` is enough today.

## Alternatives considered

- **RPC first, not REST.** HTTP is still the transport; the choice is the interface
  style on top of it. RPC drops REST's semantic surface (resources, verbs, status
  codes) so a contract collapses to `method → { input, output }`, which is trivial to
  compare and to generate. A legacy REST endpoint is not modelled directly — wrap it
  in a Service that satisfies an RPC contract.
- **Identity comparison first, not structural** — in the RPC contract's `satisfies()`.
  Comparing by value identity is enough while both sides import one contract, and it is
  the simplest thing that is correct. Structural comparison is additive (above) and only
  *required* for the distributed case, so the RPC contract defers it.
- **Errors deferred** from the first contract shape (`{ input, output }` only).
  Adding an `error` schema later is backward-compatible (an optional field).
- **Wire format private to the target pack**, which owns both adapters — rather than
  a framework-fixed wire format.
- **PDL as a later authoring surface.** A Contract is a value today (Standard Schema
  in TypeScript). Later it can be authored in Prisma Definition Language and compiled
  to the same value — the Data Contract is the natural first PDL output, the RPC
  Contract a later one. PDL changes the ergonomics, not the runtime.
- **New kinds** (gRPC, WebSocket, GraphQL) as ecosystem packages: each
  provides its own `contract()`/`serve()`/client-binding and slots in, because the
  framework only asks TypeScript "assignable?" and the contract "satisfies?".

## Related

- [`core-model.md`](core-model.md) — the Connection primitive (`http()`,
  `DependencyEnd`, the Module) this types.
- [`../03-domain-model/authoring-surface.md`](../03-domain-model/authoring-surface.md) — ports, direction-from-position.
