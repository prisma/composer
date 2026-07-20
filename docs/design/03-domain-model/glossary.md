# Glossary (ubiquitous language)

The shared terms used across the framework's design docs. This is the **authoring
plane** vocabulary — what a developer writes and thinks in. For how these lower
to the provisioning and hosting planes, see `layering.md`.

The **compile target** — the Alchemy/Effect terms these authoring nouns lower
*down to* — is catalogued in "[Provisioning plane — the compile
target](#provisioning-plane--the-compile-target-alchemy--effect)" below. That
section is the substrate the next layer of abstraction is built on; the broader
Alchemy research write-up lives in `../04-inspirations/Alchemy/glossary.md`.

## Core nouns

Every element the framework provisions carries a **managed lifecycle** — it can be
recreated in a fresh environment and stood up in the local emulator. Two kinds
carry that lifecycle: **Services** (your code) and **Resources** (managed
dependencies); **Modules** group them into bounded contexts. Anything without a
lifecycle — an API key, an external URL — is **Configuration**, not a node.

### Module

The unit of composition: a **bounded context** that wraps some Services,
Resources, and other Modules, exposes **Inputs** and **Outputs**, and is connected to
other Modules only through them. A Module runs **no code of its own** — its behaviour is
the composition of what it wraps.

A Module **behaves like a Service**: stateless, reprovisionable, and equivalent to its
past incarnations, with typed Inputs and Outputs. That shared behaviour is what
makes nesting work — a nested Module is wired exactly as a Service is. It stays a
distinct type, with composition behaviours a Service doesn't have.

- A Module is an *authoring/reasoning* unit. It is not a single deployed object — it
  lowers to a subgraph of hosting primitives (see `layering.md`).
- **Nesting.** A wrapped node's Inputs/Outputs connect either to the parent Module's
  Inputs/Outputs or to a sibling (Service, Resource, or Module) inside the same Module; a
  wrapped node reaches outside the Module only through the parent's boundary.
- **Composite, not atomic.** Where a Service is a leaf (opaque), a Module is
  transparent: the framework sees its ports *and* the internal topology it owns. The
  Module decides how the Services, Resources, and Modules it wraps connect; its
  knowledge ends at its boundary.
- **The App is the outermost Module.** The whole application is itself a Module —
  the outermost one, and what you deploy — owning the top-level topology: the
  Module-to-Module wiring and any shared Resources. A shared database, for instance,
  is owned by the outermost Module, which wires it to each consumer's Data Input (and
  owns its migration — see Aggregate Contract). There is no separate root construct;
  "App" names the outermost Module, it is not a distinct kind of node.

### Service

A **provisioned compute unit that runs your code** — an HTTP API, a web app, a
worker. It exposes typed **Inputs** and **Outputs** — the same ports a Module has —
but it is **atomic**: the framework sees those ports and nothing inside. Lowers to a
compute unit on the chosen deployment target — Prisma Compute on Prisma Cloud, or
another target's equivalent (Alchemy calls it a Platform).

### Resource

A **provisioned dependency with a managed lifecycle** — the framework, through a
provider, can create, update, and delete it. Its defining characteristic is the
**state** it holds: a database, a bucket, a cache. Surfaced as a typed
**capability** (via an Alchemy Layer): a Resource's Output provides it, a Module's
Input requires one, and the wire is valid iff provided satisfies required.

The lifecycle can be implemented by cloud APIs *or* third-party/partner APIs, so a
provisioned third-party account is a Resource too — a Stripe product, a Tigris
bucket, a Prisma-brokered Mailchimp account. The test is whether something manages
its lifecycle, not whether it's first-party.

- **First-class**: Prisma **Postgres** (data, via Prisma Next contracts) —
  the framework-native treatment.
- **BYO**: any Alchemy resource (object storage, cache, queue, provisioned
  third-party) exposed through a capability Layer. The Module depends on the
  capability, not the vendor — swap R2 for S3 by swapping the Layer.

Not Resources: **Compute** is what a Service lowers to (one per deployment target
— Prisma Compute on Prisma Cloud); a **Stream** is a connection style; a service
you call but don't provision is **Configuration**, not a Resource.

See `layering.md` → Resources: first-class vs BYO.

### Configuration — config and secrets

Per-environment values a node needs at runtime but that are **not themselves
nodes**: injected at the boundary (no-globals — user code never reads the
environment; the framework injects), supplied per environment. Two kinds, distinguished
by sensitivity (the `secret` flag on a config param):

**Config** (non-secret) — endpoints, ports, feature flags, plain settings. Most of
what the framework writes is **graph-materialized**: a connection or resource address it
computes from the topology and writes to the platform. The "env vars" a service
boots with are mostly these **wires**, not user input; a wire's change is a graph
event (a node rewired or re-provisioned), detected by the source's provenance,
never by inspecting the value.

**Secret** — a sensitive credential (API key, token, password, a connection string
carrying credentials). A secret is **always sourced from the platform's secret
store**; the framework never computes it into the graph and never persists its value in
deployment state. The platform secret may come from the user directly or from a
third-party manager (e.g. **Doppler**) integrated at the platform — the framework doesn't
care which. The framework's only job is the last hop: **wire the platform secret to the
consumer's DI**. A credential the framework itself provisions (a database URL) is written
to the platform secret store transiently during provisioning and thereafter treated
as a platform secret — wired by reference, its value never persisted.

To pull an unmanaged external dependency *into* the topology as a reproducible node,
provision it (making it a Resource) or wrap it in a Service that exposes your domain
interface.

### Topology

The graph of Modules and Resources wired together through their Inputs and Outputs.
The framework infers it from TypeScript and emits it as a static artifact for the
platform to provision.

Every node in the topology has a managed lifecycle — which is exactly what lets the
whole graph be recreated in a fresh environment and reproduced in the local
emulator (see the [goals](../00-purpose/goals.md)). Anything without a lifecycle is
Configuration, not a node.

## Connections

A **connection** is an edge that wires one node's **Output** to another node's
**Input**. Every node — Module, Service, or Resource — carries typed Inputs and
Outputs, and the wiring rule is uniform at every level: an Input must be connected
to something that satisfies it — a sibling's Output, a Resource's Output, or the
enclosing Module's boundary Input. There are two families of connection.

### Input

A connection point where a node **requires** something. Either a *communication*
Input (consumes another node's Output) or a *Data* Input (consumes a Resource's
Data Output).

### Output

A connection point where a node **provides** something. Communication Outputs are
served by Services and Modules; Data Outputs are served by Resources.

### Communication connection — style: request/response | stream

A Module-to-Module connection — or, at the boundary, public **ingress**. Its **style** is
a property of the connection:

- **request/response** — synchronous. Contract = the API/RPC signatures.
- **stream** — asynchronous, durable events. Contract = the payload schema.

The communication style is *not* mediated by a Resource; the underlying transport
(durable stream infra, etc.) is a lowering detail, never a modeled node.

### Data connection — method: TCP | HTTP

A Module consuming a Postgres Resource.

- A **Data Input** (on a Module) = a **connection method** (`TCP` — direct Postgres
  wire; `HTTP` — PostgREST-style) plus a **Data Contract** it must satisfy.
- A **Data Output** (on a Postgres Resource) = the set of **contract hashes** the
  Resource is provisioned (and verifiable) to satisfy.
- The wire is valid iff the Output's offered hashes satisfy the Input's contract.
- The concrete connection (URL) is injected when wired — never embedded in the Module
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
slice a Module may access (identified by its `storageHash`). A Module's Data Input
declares the contract it requires; this is also the per-Module least-privilege scope.

Whoever **owns** a database owns the migration that makes it satisfy the contract —
*who owns the wiring owns the migration*. A database that belongs to no Module has no
migration owner, which is why every database is owned by exactly one Module (the
implicit root Module when it is shared; see Aggregate Contract).

### Aggregate Contract

A database has exactly **one owning Module** — the Module it lives inside, or, when it is
shared, the enclosing **implicit root Module** that wires it to its consumers. The
owner owns the schema and the migration; each consumer connects via a Data Input
declaring the contract slice it needs. The owner's schema must satisfy the
**aggregate** — the union of every consumer's contract — and consumer slices must
not overlap (a Prisma Next concept). The cloud can verify the live DB satisfies the
aggregate via the marker/ledger.

## Planes & process

### Authoring / Provisioning / Hosting planes

The three layers the framework spans: what you write (the framework), how it's wired and
provisioned (Alchemy/Effect), what runs (Prisma Cloud). See `layering.md`.
The deploy report calls a thing on the hosting plane a **Deployment entity**
(`DeployedEntity`).

### Lowering

The compilation from one plane to the next: authoring topology → provisioning
resource graph → hosting primitives. Analogous to Prisma Next lowering a contract
to a plan.

### Control plane / Execution plane

Two the framework modes. **Control plane**: import the topology, validate, build the
graph, emit the artifact, drive provisioning/inspection. **Execution plane**:
instantiate implementations, satisfy the graph, inject dependencies, run
entrypoints. Kept as separate import surfaces to avoid drift (and for
tree-shaking).

Refined into **four import planes** — **authoring** (write the model),
**control** (load/interrogate/mutate it at build time), **deploy** (convert it to
Alchemy), **execution** (run it) — mapped to concrete package entries in
[`core-model.md`](../10-domains/core-model.md#package-and-entry-map).
`@prisma/composer/control` is reserved as the control surface's home once it
outgrows the core root.

### Entrypoint

An addressable unit the platform can execute (by id/kind), defined by an artifact
reference plus its declared required Inputs. The execution-plane handle for a
Service.

### Stage

A deploy-time **environment** name, chosen with `--stage` and never authored in
the topology — the same graph deploys to any stage. The **default stage** (no
`--stage`) is production, at the Project level; a **named stage** resolves to a
Prisma Cloud **Branch**, its `gitName` set to the stage name. See
[ADR-0023](../90-decisions/ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md)
and
[ADR-0024](../90-decisions/ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md).

### Container — Project / Branch

The two Prisma Cloud objects a stage resolves to before Alchemy runs: the
app's **Project** (one per application, found by name or created) and, for a
named stage, that stage's **Branch** (found by `gitName` or created). The
deploy CLI resolves and ensures both; Alchemy provisions only the resources
inside them and never creates or destroys a container itself.

## Authoring surface — the next layer

How a developer actually writes the [Core nouns](#core-nouns). The concrete
vocabulary — `compute` (a Service), `postgres` (a Resource), connection types like
`http` — comes from a **target pack**; `@prisma/composer` is a target-agnostic router
beneath it. See [`core-and-targets.md`](core-and-targets.md) for that split and
[`authoring-surface.md`](authoring-surface.md) for the full narrative.

### Target pack

A pack (e.g. `@prisma/composer-prisma-cloud`) that supplies the concrete vocabulary for one
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
invokes it), but importing runs nothing. The Service body is opaque to the framework (a
**black box**); the framework sees only its ports.

### module

The library function that defines a **Module** — the same wiring surface as
`service`, but transparent (the framework sees the internal topology) and with
`provision` in scope. Its body wires the nodes it owns; it runs no code of its own.
It is the single authoring primitive; the App is the outermost `module()`, picked
out only by being the one you deploy.

### Port — Input / Output by position

The single wiring mechanic. Every node declares typed **Input** and **Output**
ports (see [Connections](#connections)); direction is inferred from **position** —
a [connection type](#connection-type) named as a dependency is an **Input** (arrives
hydrated as an argument), one that is returned is an **Output** (the body
implements it). No explicit direction markers. `Input → arguments, Output → return`
holds for both Services and Modules.

### Connection type

A neutral, direction-agnostic value describing one end of a connection — its kind
(`http`, `data`, `stream`) and its named interface — e.g. `Auth =
http(AuthInterface)`. Not a raw TypeScript interface. Because either side may author
it, the interface can be declared on the **consumer** side and the provider made to
conform (dependency inversion).

### provision

The Module-scoped operator that turns a dependency descriptor into an **owned
Resource** (`provision(postgres())`) or instantiates and wires an owned node
(`provision(svc, { db })`). Ownership and provisioning are a Module concern; a
Service only *requires*. Forwarding is just passing a Module's Inputs down and
returning owned nodes' Outputs up.

### run — the boot loop

The boot method the platform runs, carried on the pack's runnable service node
(`main.run(address)`, called by the deploy-printed bootstrap). **Core owns
structure, the pack owns encoding.** Core enumerates the config shape (semantic
names + type tags — no platform keys in the graph) via `configOf`; the pack's
`run` **deserializes** the platform environment into a typed `Config` by its own
serializer (keyed from the address), the single sanctioned environment read; then
core's `hydrate` turns each Input's typed values into a client — with the
app-supplied driver factory — and calls the handler. Config validation is the
pack reversing its own serialization (present, right type), failing loudly. A
framework server (Next.js) is wired in as an HTTP Output, its deps reached via a
DI accessor (`use(…)`), never the environment. Env vars carry config into the VM
but **terminate at hydration** — user code is dependency-injection only.

### Load / Hydrate

The two-phase lifecycle. Running a `define` **Loads** an in-memory graph (a graph of
streams, request/response being the bounded case) and the framework validates its
integrity — every Input satisfied, interfaces compatible, nothing dangling — with
nothing executed. **Hydrate** attaches adapters and pushes data through the Inputs
and out of the Outputs. One graph serves both a test harness (a fake Output
substituted at any Input) and a real deployment.

## Provisioning plane — the compile target (Alchemy / Effect)

The exact substrate the authoring nouns lower **down to**, grounded in what our
providers already use (`packages/alchemy`, `alchemy@2.0.0-beta.59`,
`effect@4-beta`). Building the next layer of abstraction means defining each
authoring noun as *the compile-target terms it emits*. Two families: Alchemy's
IaC definition language, and the Effect primitives Alchemy is itself built on.

For each term: what it is, and — where it applies — `→` the the framework authoring
noun that lowers onto it. The reverse table (authoring → provisioning → hosting)
is in `layering.md`; this is the term-by-term catalogue.

### Alchemy — definition language

- **Stack** — the root of an Alchemy program; a set of Resources deployed as a
  unit. `Alchemy.Stack(name, { providers, state }, Effect.gen(…))`. `lower()`
  emits one Stack for the whole app; `prisma-composer deploy <entry>` drives it over the
  app module directly (no hand-written stack file, no config file — ADR-0003).
  `→` **Topology / implicit root Module**.
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
  (`Prisma.providers()`). The framework reuses these unchanged — the next layer sits
  *above* providers, not inside them.
- **Stage** — an isolated instance of a Stack (`dev`, `staging`, `prod`,
  `pr-42`) with its own state and physical names. `→` **Environment**.
- **State store** — persists each Resource's state per stack+stage so the engine
  can diff the next deploy. `prismaCloud()` defaults every deploy to a
  Prisma-hosted, workspace-scoped store (`@internal/lowering/state`); an
  explicit state layer always overrides it. Control-plane infra, never a
  topology node.

### Alchemy — engine verbs (provider lifecycle)

- **reconcile / delete / diff / read** — the convergent lifecycle the engine
  drives in dependency order (`read`+`diff` to plan, `reconcile`/`delete` to
  apply). We implement them inside `Provider.effect` (observe → ensure →
  return). Author-facing only for provider authors; the next layer never calls
  them directly.

### Deliberately **not** our compile target

These two Alchemy concepts exist but our stack does not use them — and that gap
is where the framework's own binding layer gets built.

- **Platform** — Alchemy's Resource-that-carries-runtime-code (Cloudflare
  Worker, AWS Lambda, Container). We model Prisma Compute as **ordinary
  Resources** (`ComputeService` + `Deployment` + artifact) instead, because
  Compute isn't an Alchemy-native platform.
- **Binding** (`bind()`) — Alchemy's "the binding *is* the client" for a
  Platform: one call emits permissions + env and hands back a typed SDK client.
  We do **not** use it. The framework's binding/DI (capability `Tag` + `Layer` +
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
- **Encapsulation as convention** — "a Module never exposes raw data to peers (front
  it behind communication)" is a *convention/policy* we may layer on, not an
  enforced primitive. (That every database has exactly one owning Module is now
  settled, driven by migration ownership — see Aggregate Contract.)
- **Input/Output type set** — deliberate and curated, added consciously; not an
  open plugin surface, but not sealed forever either.

## Superseded terms

- **System** (and its predecessor **Hex**) → use **Module** (the unit of
  composition). "System" and "Hex" were earlier working names; see
  [ADR-0025](../90-decisions/ADR-0025-name-the-unit-of-composition-module.md),
  which supersedes the unit noun in
  [ADR-0014](../90-decisions/ADR-0014-one-authoring-primitive.md).
- **App** is no longer superseded: it names the **outermost Module** — the whole
  application you build and deploy. Use **Topology** for the wired graph and
  **Module** for a unit; **App** for the composed whole.
- **Descriptor** → an internal/substrate term; avoid in the authoring vocabulary
  (and note Prisma Next uses "Descriptor" for its own components).
- **Durable Stream as "the backbone"** → streams are *one of two* transports
  (alongside request/response), not the universal substrate. See the streaming
  reconciliation note in the decisions log.
