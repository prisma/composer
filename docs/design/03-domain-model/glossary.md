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
lifecycle — an API key, an external URL — is part of a node's **[Input](#input)**, not a node.

### Module

The unit of composition: a **bounded context** that wraps some Services,
Resources, and other Modules, **depends on** interfaces and **exposes** interfaces, and is
connected to other Modules only through them. A Module runs **no code of its own** — its behaviour is
the composition of what it wraps.

A Module **behaves like a Service**: stateless, reprovisionable, and equivalent to its
past incarnations, with typed dependencies and exposed interfaces. That shared behaviour is what
makes nesting work — a nested Module is wired exactly as a Service is. It stays a
distinct type, with composition behaviours a Service doesn't have.

- A Module is an *authoring/reasoning* unit. It is not a single deployed object — it
  lowers to a subgraph of hosting primitives (see `layering.md`).
- **Nesting.** A wrapped node's dependencies and exposed interfaces connect either to the
  parent Module's own or to a sibling (Service, Resource, or Module) inside the same Module; a
  wrapped node reaches outside the Module only through the parent's boundary.
- **Input.** A Module declares its [Input](#input) as one `input` Standard
  Schema, as a Service does, and whoever provisions it binds it. Its body
  receives one [value](#value) per input field and can only pass it on: into a `provision()`
  binding or as a `resolve()` dependency.
- **Composite, not atomic.** Where a Service is a leaf (opaque), a Module is
  transparent: the framework sees its dependencies and exposed interfaces *and* the internal topology it owns. The
  Module decides how the Services, Resources, and Modules it wraps connect; its
  knowledge ends at its boundary.
- **The App is the outermost Module.** The whole application is itself a Module —
  the outermost one, and what you deploy — owning the top-level topology: the
  Module-to-Module wiring and any shared Resources. A shared database, for instance,
  is owned by the outermost Module, which wires it to each consumer's data dependency (and
  owns its migration — see Aggregate Contract). There is no separate root construct;
  "App" names the outermost Module, it is not a distinct kind of node.

### Service

A **provisioned compute unit that runs your code** — an HTTP API, a web app, a
worker. It **depends on** typed interfaces and **exposes** typed interfaces — the same
boundary a Module has — but it is **atomic**: the framework sees that boundary and nothing
inside. Lowers to a
compute unit on the chosen deployment target — Prisma Compute on Prisma Cloud, or
another target's equivalent (Alchemy calls it a Platform).

### Resource

A **node whose lifecycle a provider manages**: the framework can create, update and
delete it. Most Resources hold **state**, such as a database, a bucket or a cache.
Surfaced as a typed **capability** (via an Alchemy Layer): the Resource exposes it as
an interface, a Module depends on one, and the wire is valid iff the exposed interface
satisfies the dependency. A Resource may expose nothing: a public URL offers a hostname
to the internet, which is outside the graph, so no node can depend on it.

The lifecycle can be implemented by cloud APIs *or* third-party/partner APIs, so a
provisioned third-party account is a Resource too — a Stripe product, a Tigris
bucket, a Prisma-brokered Mailchimp account. The test is whether something manages
its lifecycle, not whether it's first-party.

- **First-class**: Prisma **Postgres** (data, via Prisma ORM contracts) —
  the framework-native treatment.
- **BYO**: any Alchemy resource (object storage, cache, queue, provisioned
  third-party) exposed through a capability Layer. The Module depends on the
  capability, not the vendor — swap R2 for S3 by swapping the Layer.

A Resource may also declare dependency slots, wired when it is constructed, so
it can depend on the Service it serves: a public URL is one, a Resource by kind
and a driver by role ([ADR-0060](../90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md),
amended 2026-10-29). A Resource node that is wired carries references from the
module body that built it, so it can only be provisioned there. A Resource's
configuration that may hold a Value goes in `props`; Load resolves Values there
and nowhere else on a Resource.

Not Resources: **Compute** is what a Service lowers to (one per deployment target
— Prisma Compute on Prisma Cloud); a **Stream** is a connection style; a service
you call but don't provision is part of the caller's **Input**, not a Resource.

See `layering.md` → Resources: first-class vs BYO.

### Driver

A node that depends on what it sends work to and that nothing calls. Cron and a
public URL are drivers ([ADR-0020](../90-decisions/ADR-0020-scheduled-work-is-a-driver-not-a-resource.md)).
Elsewhere in these docs, "driver" also means a database client library.

### Input

What a Service or a Module needs, per environment, from whoever provisions
it, other than its dependencies: values that are **not themselves nodes**.
The node declares its input as one Standard Schema, `input`
([ADR-0042](../90-decisions/ADR-0042-service-input-is-one-standard-schema.md),
[ADR-0061](../90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)),
and whoever provisions it binds that input with
`provision(node, { input: { … } })`, an object that mirrors the schema. The
framework checks the binding with the schema and injects the result; user
code never reads the environment (no-globals). Each key of a binding takes:

- a **literal**: the author writes the data, and it travels in the
  service's input document;
- a [value](#value): `environment.name`, a `resolve()` result, or a field of
  the provisioning module's own input;
- a **source**: target-provided logic that turns what the author supplies
  into data. A source is a value too. Prisma Cloud's:
  - **`envParam(NAME)`** — the author supplies an environment-variable name.
    Where the value goes depends on where it is bound. In a service's input,
    the deploy reads `NAME` from its [config pool](#config-pool) and writes
    the value into the service's input document, so every deploy reads it
    again. In a service's per-key params, the deploy writes a pointer row to
    a platform variable, and the service reads that variable at boot. Either
    way it varies by environment, not by deployment logic.
  - **`envSecret(NAME)`** — the author supplies a name; the target reads the
    platform's secret store. The value **never enters deploy state**, and it
    is **redacted**. **This is the only thing the framework calls a
    secret.**
  - **`generatedParam(...)`** — the author supplies generation parameters;
    the **target generates the value at deploy** and **persists it in deploy
    state**, stable across redeploys. A generated value can act as
    asymmetric knowledge (an rpc service key, an instance signing key) but
    it is **not a secret** — it is config the system produces and owns.
  - **`serviceOrigin(address)`** — the public origin of another service in
    the environment being deployed, which exists only once the deploy has
    created that service.

A field typed `secretString()` takes only a secret: a secret box, or the
secret pointer of `envSecret()` or a redacted `generatedParam()`. A
[wrapped field](#field) also takes a plain pointer, from `serviceOrigin()`
or a plain `generatedParam()`. A plain field takes neither: at deploy a
schema checks each value known only at boot as its pointer, so a plain
field bound to one fails the deploy.

The older form of input is a service's per-key `params`, each bound to a
literal or a source
([ADR-0032](../90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)).

Two properties fall out of the source, and neither is its own category:

- **Persistence follows the source.** Environment sources re-resolve per
  environment. `envSecret` never enters deploy state; `envParam` is read again
  on every deploy into a service's input document, or at boot through a
  param's pointer row.
  Generated and literal values live in the deployment. Persistence is a
  *consequence* of where the value comes from, not a flag.
- **Redaction is an orthogonal facet** — whether a value is printed in the
  deploy report and logs, or masked. `envSecret` is always redacted; a
  generated param may be redacted (a signing key) or plain (a generated id).
  Redaction is about *display*; it does not make a value a secret. A value is a
  secret only when it is *externally sourced and never in state* — `envSecret`.

**The framework never produces a secret.** It resolves environment sources
(carrying only the name), and it generates config params (which it may store).
The only secret in the system is one the author wired from the environment with
`envSecret`. Much of what the framework writes is neither — it is
**graph-materialized** config (a connection or resource address computed from
the topology); a wire's change is a graph event, detected by provenance, never
by inspecting the value.

To pull an unmanaged external dependency *into* the topology as a reproducible node,
provision it (making it a Resource) or wrap it in a Service that exposes your domain
interface.

### Value

An opaque stand-in, in a module body, for data that is known later: by the
end of Load for a deploy-time value, or only on the platform for a
[runtime value](#runtimevalue). The body can pass a value wherever data of
its type is accepted. It cannot read the data: turning a value into text or
a number, serializing it or listing its keys fails the deploy. It can branch
on a value with a truthiness check or `typeof`, but a value is always an
object, so the branch always goes the same way, in every environment, and
cannot vary the graph. That is what keeps the graph's structure the same
whatever inputs Composer is given
([ADR-0062](../90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)).
The data a value stands for is its **real value**.

- **Provided or computed.** A provided value is handed to the module body:
  `environment.name` is one, a deploy-time fact of the environment, and each
  field of a module's `input` is another, whose real value is read from the
  module's input after its schema has validated it. A root's input is the
  config pool. A computed
  value is what `resolve(dependencies, fn)` returns; Load runs `fn` with its
  dependencies' real values after every module body has run, with `provision`
  disabled. `resolve()` declares a computed value; Load resolves every value.
- **Deploy-time or runtime.** A deploy-time value has its real value by the
  end of Load: `environment.name`, a `resolve()` result, `envParam()`, whose
  real value is the variable's value at deploy, and a module input field
  bound to one of these. `envSecret()`, `generatedParam()` and
  `serviceOrigin()` give [runtime values](#runtimevalue): the platform holds
  the data, or the deploy creates it later, so Load holds a pointer in its
  place. A `resolve()` function that lists a runtime value receives the
  pointer and may return it unchanged; `isRuntimeValue(x)` is true for it.
- **Sources are values.** `envParam()`, `envSecret()`, `generatedParam()` and
  `serviceOrigin()` each return one object that is a value and the deploy
  target's source. Where a service's binding takes a source, the target
  receives that object.

In code the type is `Value<T>`, and `RealValuesOf<D>` is the tuple of
real-value types `fn` receives for a dependency tuple `D`. A source's type is
the source and a value at once, such as `SecretSource & RuntimeValue<SecretString>`
for `envSecret()`.
A value is not a node: it has no lifecycle and no address. Elsewhere
in this glossary "value" in lower case keeps its ordinary meaning, plain data
such as a param's value.

### RuntimeValue

A [value](#value) whose data exists only on the platform the app is
deployed to: the service reads it at boot. `envSecret()`, `generatedParam()`
and `serviceOrigin()` give one. In code a runtime value is
`RuntimeValue<T>`, which is `Value<Pointer<T>>`.

At deploy its real value is a **pointer**: an object that names the
platform variable holding the data. The deploy writes the pointer into the
service's input document, and the service reads the variable at boot. A
pointer has one of two kinds, which it records in its data:

- a **secret pointer**, typed `Pointer<SecretString>`, from `envSecret()`
  and a redacted `generatedParam()`;
- a **plain pointer**, typed `Pointer<string>`, from `serviceOrigin()` and
  a plain `generatedParam()`.

A pointer is typed by the variable's text, so every plain pointer is a
`Pointer<string>`. `isSecretPointer(x)` and `isPlainPointer(x)` from
`@prisma/composer` tell the kinds apart. A schema may return a copy of a
pointer: ArkType copies its input when a transform runs in it or when it
deletes undeclared keys. The copy keeps the pointer's kind and the variable
it names, and Composer treats it as the same pointer. A pointer throws when
code turns it into text or a number.

### `field()`

`field(inner)`, from `@prisma/composer/arktype` or `@prisma/composer/zod`,
wraps the schema of one leaf field of an input schema. A **wrapped field**
accepts what `inner` accepts and a plain pointer, so it also takes a runtime
value with a plain pointer. Its input type is `In | Pointer<In>` and its
output type `Out | Pointer<In>`, where `In` and `Out` are `inner`'s. A
**plain field** is written without `field()`: the author's request for
deploy-time data, and the kind of field a `resolve()` computes with, since a
wrapped field's real value may be a pointer. A secret field is
`secretString()`, which accepts a secret box or a secret pointer and needs no
`field()`. `field()` wraps leaves only: an object field stays a plain object
schema whose leaves are wrapped. For another Standard Schema library,
`@prisma/composer` exports `Pointer`, `isPlainPointer()` and
`isSecretPointer()`, with which an author writes the same two helpers. A service reads a wrapped field as `Out`: `service.input()` returns the schema's output with every pointer removed, because at boot each pointer has been replaced by the text of the variable it names.

### Config pool

The merged values the `config` adapters return for the environment being
deployed, a later adapter winning by top-level key. It is the root module's
input, validated by the root's schema, and what an `envParam('NAME')` reads
`NAME` from, wherever it sits. With no `config` list in the `composer` section
it is the process environment. In code it is `LoadOptions.configPool`, and the
name a source reads is its **pool key** (`paramSource()`'s `poolKey` option).
Composer reads it in the CLI and again in the deploy engine's process. It holds
whatever the adapters return, which by default is the whole process
environment, secrets included, so only the root's fields that its body passes
on one by one reach the graph; Load refuses the root's whole input.

### Secrets pool

The merged values the `secrets` adapters return, text only. Deploy preflight
fills a missing `envSecret()` platform variable from it, and `prisma dev` gives
a service its secrets from it. Composer never passes it to Load or a schema,
and never writes its values to a file, a report, an error or deploy state.
With no `secrets` list it is the process environment.

### Config adapter

A function in the `config` or `secrets` list of the `composer` section. It
receives the environment's name and the directory of `prisma.config.ts`, and
returns that environment's values. `environmentVariables()` and `dotenv()` ship
with Composer. An adapter is a mechanism, not a setting: the values stay
wherever it reads them
([ADR-0062](../90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)).

### Topology

The graph of Modules and Resources wired together through their dependencies and exposed interfaces.
The framework infers it from TypeScript and emits it as a static artifact for the
platform to provision.

Every node in the topology has a managed lifecycle — which is exactly what lets the
whole graph be recreated in a fresh environment and reproduced in the local
emulator (see the [goals](../00-purpose/goals.md)). Anything without a lifecycle is
part of a node's [Input](#input), not a node.

### Address and logical ID

A node's **address** is its identity: the path of provision IDs starting at the root, assigned by Load (`shop`, `shop.catalog`, `shop.auth.api`). The root's address is the deployed app name, so every address starts with it. A provision ID is the node's name unless `provision()` sets an `id`, so a node's name is, by default, part of its identity. The app name starts with a letter or digit and contains only letters, digits, `-` and `_`; below the root, provision IDs contain only letters and digits. Every platform **name** Composer writes (an App's display name, a Connection's, Bucket's or access key's `name`) is the address too; it is a label, never identity. On the platform a Connection's name is the address followed by `-` and a 12-character token that upstream adds. On Prisma Cloud the address is the node's **logical ID** (`logicalId`): Composer writes it, byte for byte, on the node's topology entry and on the node's one platform row (Project, App, Database or Bucket). The same node on two branches has the same logical ID. A **display name** is a label only and never identity. An **Alchemy resource ID** names one of the resources a node lowers to: the address for the node's main resource (`shop.catalog`), and the address plus `.` and a role for its other pieces (`shop.catalog.connection`, `shop.web.deployment`). Alchemy's own docs call it a "logical ID"; it is a different field from the platform's `logicalId`. Composer's environment variable keys are `COMPOSER_` plus the address upper-cased, with `.` and `-` turned into `_` (`COMPOSER_SHOP_WEB_…`). Changing a node's address, including by changing its name, makes it a different entity; it is not a rename. See [ADR-0057](../90-decisions/ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md).

## Connections

A **connection** is an edge that wires one node's **dependency** to another node's
**exposed interface**. Every node — Module, Service, or Resource — depends on
interfaces and exposes interfaces, and the wiring rule is uniform at every level: a
dependency must be connected to an exposed interface that satisfies it — a
sibling's, a Resource's, or one the enclosing Module forwards in from its own
boundary. There are two families of connection.

### Interface

The typed thing a connection carries: an RPC contract, a raw HTTP connection, a
data contract. In code it is a `Contract`, a value with a `kind` and a
`satisfies()` check. An interface in Composer's terms is what the ports-and-adapters
literature calls a port: it can be exposed, or required as a dependency, by any
node. That is the one place the word is used; Composer does not say "port" for
an interface, because it has HTTP and TCP ports too
([ADR-0063](../90-decisions/ADR-0063-a-node-depends-on-an-interface-or-exposes-one.md)).

### Dependency

A node's need for an interface, declared with `deps`. Either a *communication*
dependency (on another node's exposed interface) or a *data* dependency (on a
Resource's exposed data contract). A dependency is wired at `provision()` for a
service or a module, and at construction for a resource that has one.

### Exposed interface

An interface a node offers for others to depend on, declared with `expose` on a
service or a module; a Resource exposes the one interface it `provides`.
Communication interfaces are exposed by Services and Modules; data interfaces by
Resources. A node may expose nothing.

### Communication connection — style: request/response | stream

A Module-to-Module connection — or, at the boundary, public **ingress**. Its **style**
is declared by its contract: a contract may declare `style`, and a connection's style
is the style of the exposed interface's contract. A contract may also declare none.

- **request-response** — synchronous. Service RPC declares it.
- **stream** — asynchronous, durable events.
- **none** — raw HTTP declares no style, because an arbitrary HTTP server may do
  either.

The application topology labels each communication edge with the exposed interface's
declared style, and leaves the style off when there is none.

The communication style is *not* mediated by a Resource; the underlying transport
(durable stream infra, etc.) is a lowering detail, never a modeled node.

### Data connection — method: TCP | HTTP

A Module consuming a Postgres Resource.

- A **data dependency** (on a Module) = a **connection method** (`TCP` — direct Postgres
  wire; `HTTP` — PostgREST-style) plus a **Data Contract** it must satisfy.
- A Postgres Resource's **exposed data interface** = the set of **contract hashes** the
  Resource is provisioned (and verifiable) to satisfy.
- The wire is valid iff the exposed interface's offered hashes satisfy the dependency's contract.
- The concrete connection (URL) is injected when wired — never embedded in the Module
  (no-globals).

### Ingress / Egress

**Ingress** = a service's exposed HTTP interface made reachable from the public (e.g.
the website) — a real edge at the topology's public boundary. It is authored as a
`publicUrl()` node: a resource, a driver by role, that depends on the HTTP interface
a service exposes and exposes nothing, serving a named
hostname or one the platform generates
([ADR-0060](../90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md)).
**Egress** = a Service's declared
**outbound dependency** on something outside the topology (an external URL/API).
Egress is *not* an edge to a node — the far end isn't in the graph; it's a property
of the Service plus the Input (URL + credentials) it carries. To represent
that external thing as a node, provision it (a Resource) or wrap it in a Service.

## Contracts

### Data Contract

A **Prisma ORM** contract — a deterministic, hashable description of the schema
slice a Module may access (identified by its `storageHash`). A Module's data dependency
declares the contract it requires; this is also the per-Module least-privilege scope.

Whoever **owns** a database owns the migration that makes it satisfy the contract —
*who owns the wiring owns the migration*. A database that belongs to no Module has no
migration owner, which is why every database is owned by exactly one Module (the
implicit root Module when it is shared; see Aggregate Contract).

### Aggregate Contract

A database has exactly **one owning Module** — the Module it lives inside, or, when it is
shared, the enclosing **implicit root Module** that wires it to its consumers. The
owner owns the schema and the migration; each consumer connects via a data dependency
declaring the contract slice it needs. The owner's schema must satisfy the
**aggregate** — the union of every consumer's contract — and consumer slices must
not overlap (a Prisma ORM concept). The cloud can verify the live DB satisfies the
aggregate via the marker/ledger.

## Planes & process

### Authoring / Provisioning / Hosting planes

The three layers the framework spans: what you write (the framework), how it's wired and
provisioned (Alchemy/Effect), what runs (Prisma Cloud). See `layering.md`.
The deploy report calls a thing on the hosting plane a **Deployment entity**
(`DeployedEntity`).

### Lowering

The compilation from one plane to the next: authoring topology → provisioning
resource graph → hosting primitives. Analogous to Prisma ORM lowering a contract
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
reference plus its declared dependencies. The execution-plane handle for a
Service.

### Environment (formerly Stage)

A place the app runs: `production`, `staging`, a preview such as `pr-42`, or
`dev` on a developer's machine. Chosen with `--environment`, never authored in
the topology — the same graph deploys to any environment. Every environment has
a name and none is special: `prisma deploy` defaults to `production` and
`prisma dev` to `dev`. `dotenv()` reads `.env.<environment>` for the
environment being deployed. Under `prisma dev`, each environment is a separate local
copy of the app, with its own services, databases, buckets and ports. On Prisma Cloud, `production` resolves to the Project's
default **Branch** and any other environment to the Branch whose `gitName` is
its name. "Stage" is the old word for the same concept, and "branch" is Prisma
Cloud's; Composer uses neither
([ADR-0059](../90-decisions/ADR-0059-a-deployment-environment-is-called-an-environment.md)). See
[ADR-0023](../90-decisions/ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md)
and
[ADR-0024](../90-decisions/ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md). In a module body, `environment` holds the deploy's facts as Values (`environment.name`) and never environment variables, which user code never reads.

### Container — Project / Branch

The two Prisma Cloud objects an environment resolves to before Alchemy runs:
the app's **Project** (one per application, found by name or created) and that
environment's **Branch** (the Project's default Branch for `production`;
otherwise found by `gitName` or created). The
deploy CLI resolves and ensures both; Alchemy provisions only the resources
inside them and never creates or destroys a container itself.

## Authoring surface — the next layer

How a developer actually writes the [Core nouns](#core-nouns). The concrete
vocabulary — `compute` (a Service), `postgres` (a Resource) — comes from a **target
pack**; `@prisma/composer` is a target-agnostic router beneath it. Service-to-service
connection kinds (service RPC, raw HTTP) are target-agnostic and ship with
`@prisma/composer`. See [`core-and-targets.md`](core-and-targets.md) for that split and
[`authoring-surface.md`](authoring-surface.md) for the full narrative.

### Target pack

A pack (e.g. `@prisma/composer-prisma-cloud`) that supplies the concrete vocabulary for one
deployment platform as **data**: `compute` (a Service), `postgres` (a Resource).
Each is an ergonomic constructor returning a plain object whose
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
manifest): inspectable (the control plane reads its dependencies and exposed interfaces) and runnable (the runtime
invokes it), but importing runs nothing. The Service body is opaque to the framework (a
**black box**); the framework sees only its boundary.

### module

The library function that defines a **Module** — the same wiring surface as
`service`, but transparent (the framework sees the internal topology) and with
`provision` in scope. Its body wires the nodes it owns; it runs no code of its own.
It is the single authoring primitive; the App is the outermost `module()`, picked
out only by being the one you deploy.

### Direction by position

The single wiring mechanic. A node declares what it depends on and what it exposes
(see [Connections](#connections)), and the authoring surface infers which is which
from **position** — a [connection type](#connection-type) named in `deps` is a
dependency (it arrives hydrated), one named in `expose` is an exposed interface
(the body implements it). No explicit direction markers; the same rule holds for
Services and Modules.

### Connection type

A neutral, direction-agnostic value describing one end of a connection — its kind
(`rpc`, `http`, `data`) and its named interface — e.g. `Auth =
http(AuthInterface)`. Not a raw TypeScript interface. Because either side may author
it, the interface can be declared on the **consumer** side and the provider made to
conform (dependency inversion).

### provision

The Module-scoped operator that turns a dependency descriptor into an **owned
Resource** (`provision(rawPostgres())`) or instantiates and wires an owned node
(`provision(svc, { db })`). Ownership and provisioning are a Module concern; a
Service only *requires*. Forwarding is just passing a Module's dependencies down and
returning owned nodes' exposed interfaces up.

### run — the boot loop

The boot method the platform runs, carried on the pack's runnable service node
(`main.run(address)`, called by the deploy-printed bootstrap). **Core owns
structure, the pack owns encoding.** Core enumerates the config shape (semantic
names + type tags — no platform keys in the graph) via `configOf`; the pack's
`run` **deserializes** the platform environment into a typed `Config` by its own
serializer (keyed from the address), the single sanctioned environment read; then
core's `hydrate` turns each dependency's typed values into a client — with the
app-supplied driver factory — and calls the handler. Config validation is the
pack reversing its own serialization (present, right type), failing loudly. A
framework server (Next.js) is wired in as an exposed HTTP interface, its deps reached via a
DI accessor (`use(…)`), never the environment. Env vars carry config into the VM
but **terminate at hydration** — user code is dependency-injection only.

### Load / Hydrate

The two-phase lifecycle. Running a `define` **Loads** an in-memory graph (a graph of
streams, request/response being the bounded case) and the framework validates its
integrity — every dependency satisfied, interfaces compatible, nothing dangling — with
nothing executed but module bodies, `resolve()` functions and module input schemas. **Hydrate** attaches adapters and pushes data through the dependencies
and out of the exposed interfaces. One graph serves both a test harness (a fake
substituted at any dependency) and a real deployment.

## Provisioning plane — the compile target (Alchemy / Effect)

The exact substrate the authoring nouns lower **down to**, grounded in what our providers already use (`packages/alchemy`, `alchemy@2.0.0-beta.78`, `effect@4.0.0-rc.115`). Building the next layer of abstraction means defining each authoring noun as *the compile-target terms it emits*. Two families: Alchemy's IaC definition language, and the Effect primitives Alchemy is itself built on.

For each term: what it is, and — where it applies — `→` the the framework authoring
noun that lowers onto it. The reverse table (authoring → provisioning → hosting)
is in `layering.md`; this is the term-by-term catalogue.

### Alchemy — definition language

- **Stack** — the root of an Alchemy program; a set of Resources deployed as a
  unit. `Alchemy.Stack(name, { providers, state }, Effect.gen(…))`. `lower()`
  emits one Stack for the whole app; `prisma deploy` drives it over the
  app module the config's `entry` names (no hand-written stack file — ADR-0003).
  `→` **Topology / implicit root Module**.
- **Resource\<Type, Props, Attributes>** — a managed entity with a string type
  tag, desired-input **Props**, and cloud-returned **Attributes**. Declared, then
  `yield*`-ed. Composer binds upstream alchemy's: `Prisma.Project`, `Database`,
  `Connection`, `App`, `Deployment`, `EnvironmentVariable`.
  `→` a **Service** lowers to `App` + `Deployment` (+ `EnvironmentVariable`); a
  first-class **Resource** (Postgres) lowers to `Database` + `Connection`.
- **Props** — the desired configuration passed at declare time; diffed against
  the last deploy to detect change. (A rebuild registers as a change because the
  artifact is content-addressed: new bytes, new `artifactPath`.) `→` a node's **dependencies** +
  **Input**.
- **Attributes / Output\<T>** — values the cloud returns (`appEndpointDomain`,
  `deploymentId`, ids); lazy references that flow into other Resources' Props.
  Resource-to-resource wiring is Output → Props. `→` a node's **exposed interfaces**; a
  **connection** (exposed interface→dependency) lowers to Output→Props, plus an
  `EnvironmentVariable` when the consumer reads it at runtime (what `AUTH_URL`
  does today).
- **Provider** — implements a Resource type's lifecycle; an Effect `Layer`. We
  author one per Prisma resource with `Provider.effect(Resource, reconcile)`,
  bundled via `Provider.collection([…])` into a `Provider.ProviderCollection`
  (`Prisma.providers()`). The framework reuses these unchanged — the next layer sits
  *above* providers, not inside them.
- **Stage** — an isolated instance of a Stack (`dev`, `staging`, `prod`,
  `pr-42`) with its own state and physical names. `→` **Environment**.
- **State store** — persists each Resource's state per stack+stage so the engine can diff the next deploy. `prismaCloud()` defaults every deploy to platform-hosted state behind the Management API, scoped to the stage's Branch (`@internal/lowering/state`, ADR-0045); an explicit state layer always overrides it. Control-plane infra, never a topology node.

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
  Worker, AWS Lambda, Container). Alchemy's `Prisma.Compute` is one, but
  Composer lowers to the **ordinary Resources** (`App` + `Deployment` +
  artifact) instead — see the compute-family decision in the adoption notes:
  a service's own origin is an input to its own environment, which one
  composite resource cannot express.
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
  `→` a **capability provider** (a Resource's exposed interface) is a Layer.
- **Context.Tag** — the typed service key that names a capability. `→` a
  **capability** (`Database`, `AuthApi`); a Service's **dependency** is a Tag in its
  `R` channel; a **connection** type-checks as "provided Layer satisfies required
  Tag".
- **Config** (`effect/Config`) — reads env/secret values at the boundary. `→`
  **Input**; the host shim builds each binding's Layer from Config.
- **Redacted** (`effect/Redacted`) — wraps a secret so it doesn't print. `→`
  a secret field of a node's **Input** (e.g. `DATABASE_URL`).
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
- **The set of interface kinds** — deliberate and curated, added consciously; not an
  open plugin surface, but not sealed forever either.

## Superseded terms

- **Input** and **Output** (as the two ends of a connection) → **dependency** and
  **exposed interface**. The dataflow and ports-and-adapters traditions give the
  same two ends opposite names, so the words were ambiguous; see
  [ADR-0063](../90-decisions/ADR-0063-a-node-depends-on-an-interface-or-exposes-one.md).
  "Input" still names a service's or module's configuration document (`input`). **Input** now names what a node's `input` schema declares ([Input](#input)).
- **System** (and its predecessor **Hex**) → use **Module** (the unit of
  composition). "System" and "Hex" were earlier working names; see
  [ADR-0025](../90-decisions/ADR-0025-name-the-unit-of-composition-module.md),
  which supersedes the unit noun in
  [ADR-0014](../90-decisions/ADR-0014-one-authoring-primitive.md).
- **App** is no longer superseded: it names the **outermost Module** — the whole
  application you build and deploy. Use **Topology** for the wired graph and
  **Module** for a unit; **App** for the composed whole.
- **Descriptor** → an internal/substrate term; avoid in the authoring vocabulary
  (and note Prisma ORM uses "Descriptor" for its own components).
- **Durable Stream as "the backbone"** → streams are *one of two* transports
  (alongside request/response), not the universal substrate. See the streaming
  reconciliation note in the decisions log.
