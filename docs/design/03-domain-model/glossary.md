# Glossary (ubiquitous language)

The shared terms used across MakerKit's design docs. This is the **authoring
plane** vocabulary — what a developer writes and thinks in. For how these lower
to the provisioning and hosting planes, see `layering.md`.

The **compile target** — the Alchemy/Effect terms these authoring nouns lower
*down to* — is catalogued in "[Provisioning plane — the compile
target](#provisioning-plane--the-compile-target-alchemy--effect)" below. That
section is the substrate the next layer of abstraction is built on; the broader
Alchemy research write-up lives in `../04-inspirations/Alchemy/glossary.md`.

## Core nouns

Every element MakerKit provisions carries a **managed lifecycle** — it can be
recreated in a fresh environment and stood up in the local emulator. Two kinds
carry that lifecycle: **Services** (your code) and **Resources** (managed
dependencies); **Hexes** group them into bounded contexts. Anything without a
lifecycle — an API key, an external URL — is **Configuration**, not a node.

### Hex (Subsystem)

The unit of composition: a **bounded context** that wraps some Services,
Resources, and other Hexes, exposes **Inputs** and **Outputs**, and is connected to
other Hexes only through them. A Hex runs **no code of its own** — its behaviour is
the composition of what it wraps.

A Hex **behaves like a Service**: stateless, reprovisionable, and equivalent to its
past incarnations, with typed Inputs and Outputs. That shared behaviour is what
makes nesting work — a nested Hex is wired exactly as a Service is. It stays a
distinct type, with composition behaviours a Service doesn't have.

- "Hex" is the working name; **Subsystem** is the literal fallback.
- A Hex is an *authoring/reasoning* unit. It is not a single deployed object — it
  lowers to a subgraph of hosting primitives (see `layering.md`).
- **Nesting.** A wrapped node's Inputs/Outputs connect either to the parent Hex's
  Inputs/Outputs or to a sibling (Service, Resource, or Hex) inside the same Hex; a
  wrapped node reaches outside the Hex only through the parent's boundary.
- **Composite, not atomic.** Where a Service is a leaf (opaque), a Hex is
  transparent: MakerKit sees its ports *and* the internal topology it owns. The Hex
  decides how the Services, Resources, and Hexes it wraps connect; its knowledge
  ends at its boundary.
- **The implicit root Hex.** The whole system is itself a Hex — the implicit root —
  that owns the top-level topology: the Hex-to-Hex wiring and any shared Resources.
  A shared database, for instance, is owned by the root Hex, which wires it to each
  consumer's Data Input (and owns its migration — see Aggregate Contract).

### Service

A **provisioned compute unit that runs your code** — an HTTP API, a web app, a
worker. It exposes typed **Inputs** and **Outputs** — the same ports a Hex has —
but it is **atomic**: MakerKit sees those ports and nothing inside. Lowers to a
compute unit on the chosen deployment target — Prisma Compute on Prisma Cloud, or
another target's equivalent (Alchemy calls it a Platform).

### Resource

A **provisioned dependency with a managed lifecycle** — MakerKit, through a
provider, can create, update, and delete it. Its defining characteristic is the
**state** it holds: a database, a bucket, a cache. Surfaced as a typed
**capability** (via an Alchemy Layer): a Resource's Output provides it, a Hex's
Input requires one, and the wire is valid iff provided satisfies required.

The lifecycle can be implemented by cloud APIs *or* third-party/partner APIs, so a
provisioned third-party account is a Resource too — a Stripe product, a Tigris
bucket, a Prisma-brokered Mailchimp account. The test is whether something manages
its lifecycle, not whether it's first-party.

- **First-class**: Prisma **Postgres** (data, via Prisma Next contracts) —
  MakerKit-native treatment.
- **BYO**: any Alchemy resource (object storage, cache, queue, provisioned
  third-party) exposed through a capability Layer. The Hex depends on the
  capability, not the vendor — swap R2 for S3 by swapping the Layer.

Not Resources: **Compute** is what a Service lowers to (one per deployment target
— Prisma Compute on Prisma Cloud); a **Stream** is a connection style; a service
you call but don't provision is **Configuration**, not a Resource.

See `layering.md` → Resources: first-class vs BYO.

### Configuration

Per-environment values an element needs but that MakerKit does **not** provision —
API keys, connection URLs, secrets for an unmanaged external service. Configuration
is **not a node**: it parameterises Services and Resources, is injected at the
boundary (no-globals), and is supplied afresh per environment. This is where a
genuinely unmanaged external dependency lives — you hold a key to a shared account
nobody provisions. Lowers to Alchemy's `effect/Config` (secrets via
`Config.redacted`), bound to the running environment. To pull such a dependency
*into* the topology as a reproducible node, either provision it (making it a
Resource) or wrap it in a Service that exposes your domain interface.

### Topology

The graph of Hexes and Resources wired together through their Inputs and Outputs.
MakerKit infers it from TypeScript and emits it as a static artifact for the
platform to provision.

Every node in the topology has a managed lifecycle — which is exactly what lets the
whole graph be recreated in a fresh environment and reproduced in the local
emulator (see the [goals](../00-purpose/goals.md)). Anything without a lifecycle is
Configuration, not a node.

## Connections

A **connection** is an edge that wires one node's **Output** to another node's
**Input**. Every node — Hex, Service, or Resource — carries typed Inputs and
Outputs, and the wiring rule is uniform at every level: an Input must be connected
to something that satisfies it — a sibling's Output, a Resource's Output, or the
enclosing Hex's boundary Input. There are two families of connection.

### Input

A connection point where a node **requires** something. Either a *communication*
Input (consumes another node's Output) or a *Data* Input (consumes a Resource's
Data Output).

### Output

A connection point where a node **provides** something. Communication Outputs are
served by Services and Hexes; Data Outputs are served by Resources.

### Communication connection — style: request/response | stream

A Hex-to-Hex connection — or, at the boundary, public **ingress**. Its **style** is
a property of the connection:

- **request/response** — synchronous. Contract = the API/RPC signatures.
- **stream** — asynchronous, durable events. Contract = the payload schema.

The communication style is *not* mediated by a Resource; the underlying transport
(durable stream infra, etc.) is a lowering detail, never a modeled node.

### Data connection — method: TCP | HTTP

A Hex consuming a Postgres Resource.

- A **Data Input** (on a Hex) = a **connection method** (`TCP` — direct Postgres
  wire; `HTTP` — PostgREST-style) plus a **Data Contract** it must satisfy.
- A **Data Output** (on a Postgres Resource) = the set of **contract hashes** the
  Resource is provisioned (and verifiable) to satisfy.
- The wire is valid iff the Output's offered hashes satisfy the Input's contract.
- The concrete connection (URL) is injected when wired — never embedded in the Hex
  (no-globals).

### Ingress / Egress

**Ingress** = a request/response Output exposed to the public (e.g. the website) —
a real edge at the topology's public boundary. **Egress** = a Service's declared
**outbound dependency** on something outside the topology (an external URL/API).
Egress is *not* an edge to a node — the far end isn't in the graph; it's a property
of the Service plus the Configuration (URL + credentials) it carries. To represent
that external thing as a node, provision it (a Resource) or wrap it in a Service.

## Contracts

### Data Contract

A **Prisma Next** contract — a deterministic, hashable description of the schema
slice a Hex may access (identified by its `storageHash`). A Hex's Data Input
declares the contract it requires; this is also the per-Hex least-privilege scope.

Whoever **owns** a database owns the migration that makes it satisfy the contract —
*who owns the wiring owns the migration*. A database that belongs to no Hex has no
migration owner, which is why every database is owned by exactly one Hex (the
implicit root Hex when it is shared; see Aggregate Contract).

### Aggregate Contract

A database has exactly **one owning Hex** — the Hex it lives inside, or, when it is
shared, the enclosing **implicit root Hex** that wires it to its consumers. The
owner owns the schema and the migration; each consumer connects via a Data Input
declaring the contract slice it needs. The owner's schema must satisfy the
**aggregate** — the union of every consumer's contract — and consumer slices must
not overlap (a Prisma Next concept). The cloud can verify the live DB satisfies the
aggregate via the marker/ledger.

## Planes & process

### Authoring / Provisioning / Hosting planes

The three layers MakerKit spans: what you write (MakerKit), how it's wired and
provisioned (Alchemy/Effect), what runs (Prisma Cloud). See `layering.md`.

### Lowering

The compilation from one plane to the next: authoring topology → provisioning
resource graph → hosting primitives. Analogous to Prisma Next lowering a contract
to a plan.

### Control plane / Execution plane

Two MakerKit modes. **Control plane**: import the topology, validate, build the
graph, emit the artifact, drive provisioning/inspection. **Execution plane**:
instantiate implementations, satisfy the graph, inject dependencies, run
entrypoints. Kept as separate import surfaces to avoid drift (and for
tree-shaking).

### Entrypoint

An addressable unit the platform can execute (by id/kind), defined by an artifact
reference plus its declared required Inputs. The execution-plane handle for a
Service.

## Authoring surface — the next layer

How a developer actually writes the [Core nouns](#core-nouns). The concrete
vocabulary — `compute` (a Service), `postgres` (a Resource), connection types like
`http` — comes from a **target pack**; `@makerkit/core` is a target-agnostic router
beneath it. See [`core-and-targets.md`](core-and-targets.md) for that split and
[`authoring-surface.md`](authoring-surface.md) for the full narrative.

### Target pack

A pack (e.g. `@makerkit/prisma-cloud`) that supplies the concrete vocabulary for one
deployment platform as **data**: `compute` (a Service), `postgres` (a Resource),
`http` (a Connection). Each is an ergonomic constructor returning a plain object whose
metadata routes it to an Alchemy Stack/Provider (and, for a Resource, a runtime
hydrator). Core imports no target; swap the pack and core is untouched.

### Lowering — routing

Core's whole job at deploy: **Load** the graph, then for each node instantiate the
Alchemy object its metadata references (a Service → its `host` provider, a Resource →
its `provider`). No per-target branch, no provisioning logic in core — it follows
references the target handed it. See [`core-and-targets.md`](core-and-targets.md).

### service

The abstract **Service** kind. The concrete constructor is target-provided —
`compute(deps, handler)` on Prisma Cloud — and returns a plain data object (the
manifest): inspectable (the control plane reads its ports) and runnable (the runtime
invokes it), but importing runs nothing. The Service body is opaque to MakerKit (a
**black box**); MakerKit sees only its ports.

### hex

The library function that defines a **Hex** — the same wiring surface as
`service`, but transparent (MakerKit sees the internal topology) and with
`provision` in scope. Its body wires the nodes it owns; it runs no code of its own.

### Port — Input / Output by position

The single wiring mechanic. Every node declares typed **Input** and **Output**
ports (see [Connections](#connections)); direction is inferred from **position** —
a [connection type](#connection-type) named as a dependency is an **Input** (arrives
hydrated as an argument), one that is returned is an **Output** (the body
implements it). No explicit direction markers. `Input → arguments, Output → return`
holds for both Services and Hexes.

### Connection type

A neutral, direction-agnostic value describing one end of a connection — its kind
(`http`, `data`, `stream`) and its named interface — e.g. `Auth =
http(AuthInterface)`. Not a raw TypeScript interface. Because either side may author
it, the interface can be declared on the **consumer** side and the provider made to
conform (dependency inversion).

### provision

The Hex-scoped operator that turns a dependency descriptor into an **owned
Resource** (`provision(postgres())`) or instantiates and wires an owned node
(`provision(svc, { db })`). Ownership and provisioning are a Hex concern; a
Service only *requires*. Forwarding is just passing a Hex's Inputs down and
returning owned nodes' Outputs up.

### Runtime loop (host) — the config pipeline

The boot [entrypoint](#entrypoint) the platform runs, over the code the app bundled
(MakerKit does not bundle). **Core owns config management**: it enumerates the
config fields the service's Inputs declare, resolves them via the service type's
addressing data (e.g. env key names — the pack declares *where*, core does the
reading), validates before hydrating, applies overrides (the interception point for
tests and introspection), then lets each connection hydrate its client from the
resolved values — with the app-supplied driver factory. A framework server (Next.js) is
wired in as an HTTP Output, its deps reached via a DI accessor (`use(…)`), never the
environment. Env vars carry config into the VM but **terminate at hydration** — user
code is dependency-injection only.

### Load / Hydrate

The two-phase lifecycle. Running a `define` **Loads** an in-memory graph (a graph of
streams, request/response being the bounded case) and MakerKit validates its
integrity — every Input satisfied, interfaces compatible, nothing dangling — with
nothing executed. **Hydrate** attaches adapters and pushes data through the Inputs
and out of the Outputs. One graph serves both a test harness (a fake Output
substituted at any Input) and a real deployment.

## Provisioning plane — the compile target (Alchemy / Effect)

The exact substrate the authoring nouns lower **down to**, grounded in what our
providers already use (`packages/prisma-alchemy`, `alchemy@2.0.0-beta.59`,
`effect@4-beta`). Building the next layer of abstraction means defining each
authoring noun as *the compile-target terms it emits*. Two families: Alchemy's
IaC definition language, and the Effect primitives Alchemy is itself built on.

For each term: what it is, and — where it applies — `→` the MakerKit authoring
noun that lowers onto it. The reverse table (authoring → provisioning → hosting)
is in `layering.md`; this is the term-by-term catalogue.

### Alchemy — definition language

- **Stack** — the root of an Alchemy program; a set of Resources deployed as a
  unit. `Alchemy.Stack(name, { providers, state }, Effect.gen(…))`. Our whole
  example emits one Stack (`examples/storefront-auth/alchemy.run.ts`).
  `→` **Topology / implicit root Hex** (today hand-written; MakerKit will
  generate it).
- **Resource\<Type, Props, Attributes>** — a managed entity with a string type
  tag, desired-input **Props**, and cloud-returned **Attributes**. Declared, then
  `yield*`-ed. Ours: `Prisma.Project`, `Database`, `Connection`,
  `ComputeService`, `Deployment`, `EnvironmentVariable`.
  `→` a **Service** lowers to `ComputeService` + `Deployment` (+
  `EnvironmentVariable`); a first-class **Resource** (Postgres) lowers to
  `Project` + `Database` + `Connection`.
- **Props** — the desired configuration passed at declare time; diffed against
  the last deploy to detect change. (We put the artifact's `artifactHash` in
  Props so a rebuild registers as a change.) `→` a node's **Inputs** +
  **Configuration**.
- **Attributes / Output\<T>** — values the cloud returns (`deployedUrl`,
  `versionId`, ids); lazy references that flow into other Resources' Props.
  Resource-to-resource wiring is Output → Props. `→` a node's **Outputs**; a
  **connection** (Output→Input) lowers to Output→Props, plus an
  `EnvironmentVariable` when the consumer reads it at runtime (what `AUTH_URL`
  does today).
- **Provider** — implements a Resource type's lifecycle; an Effect `Layer`. We
  author one per Prisma resource with `Provider.effect(Resource, reconcile)`,
  bundled via `Provider.collection([…])` into a `Provider.ProviderCollection`
  (`Prisma.providers()`). MakerKit reuses these unchanged — the next layer sits
  *above* providers, not inside them.
- **Stage** — an isolated instance of a Stack (`dev`, `staging`, `prod`,
  `pr-42`) with its own state and physical names. `→` **Environment**.
- **State store** — persists each Resource's state per stack+stage so the engine
  can diff the next deploy. `localState()` today; `layering.md` Step 1 is a
  Prisma-hosted, workspace-scoped store. Control-plane infra, never a topology
  node.

### Alchemy — engine verbs (provider lifecycle)

- **reconcile / delete / diff / read** — the convergent lifecycle the engine
  drives in dependency order (`read`+`diff` to plan, `reconcile`/`delete` to
  apply). We implement them inside `Provider.effect` (observe → ensure →
  return). Author-facing only for provider authors; the next layer never calls
  them directly.

### Deliberately **not** our compile target

These two Alchemy concepts exist but our stack does not use them — and that gap
is where MakerKit's own binding layer gets built.

- **Platform** — Alchemy's Resource-that-carries-runtime-code (Cloudflare
  Worker, AWS Lambda, Container). We model Prisma Compute as **ordinary
  Resources** (`ComputeService` + `Deployment` + artifact) instead, because
  Compute isn't an Alchemy-native platform.
- **Binding** (`bind()`) — Alchemy's "the binding *is* the client" for a
  Platform: one call emits permissions + env and hands back a typed SDK client.
  We do **not** use it. MakerKit's binding/DI (capability `Tag` + `Layer` +
  execution-plane host shim) is **our own** layer precisely because our compute
  is plain Resources, not a Platform. `→` this is the seam for **binding
  injection** and the **execution-plane host**.

### Effect substrate (what Alchemy is built on)

- **Effect\<A, E, R>** — the effect type; `Effect.gen`, `fail`/`die`/`flatMap`.
  Every term above is expressed as Effects.
- **Layer\<ROut, E, RIn>** — builds services; both Providers and capabilities are
  Layers (`Layer.effect`, `mergeAll`, `provide`, `provideMerge`, `orDie`).
  `→` a **capability provider** (a Resource's Output) is a Layer.
- **Context.Tag** — the typed service key that names a capability. `→` a
  **capability** (`Database`, `AuthApi`); a Service's **Input** is a Tag in its
  `R` channel; a **connection** type-checks as "provided Layer satisfies required
  Tag".
- **Config** (`effect/Config`) — reads env/secret values at the boundary. `→`
  **Configuration**; the host shim builds each binding's Layer from Config.
- **Redacted** (`effect/Redacted`) — wraps a secret so it doesn't print. `→`
  secret **Configuration** (e.g. `DATABASE_URL`).
- **Schedule** (`effect/Schedule`) — retry/poll policy (we poll a compute
  version until `running` before promoting).
- **Data.TaggedError** (`effect/Data`) — typed, tagged errors (our
  `PrismaApiError`). `→` the error channel of a provider/binding.
- **Scope** — resource lifetime for a Layer (`Layer.scoped` + finalizers). `→`
  where a binding owns its connection pool and teardown (the idle-connection fix,
  FT-5219, belongs here — written once).
- **ManagedRuntime** — builds a runtime from a composed Layer once, so clients
  are memoized. `→` the **execution-plane host** runs each request handler on it.

## Deferred / open

- **Connection-method taxonomy** — only `TCP` and `HTTP` for now. "Pooled" is a
  URL param on TCP, not its own method; WebSocket and others are deferred until we
  work more examples.
- **Encapsulation as convention** — "a Hex never exposes raw data to peers (front
  it behind communication)" is a *convention/policy* we may layer on, not an
  enforced primitive. (That every database has exactly one owning Hex is now
  settled, driven by migration ownership — see Aggregate Contract.)
- **Input/Output type set** — deliberate and curated, added consciously; not an
  open plugin surface, but not sealed forever either.

## Superseded terms

- **App** → use **Topology** (the wired graph) or **Hex** (a unit).
- **Descriptor** → an internal/substrate term; avoid in the authoring vocabulary
  (and note Prisma Next uses "Descriptor" for its own components).
- **Durable Stream as "the backbone"** → streams are *one of two* transports
  (alongside request/response), not the universal substrate. See the streaming
  reconciliation note in the decisions log.
