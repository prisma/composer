# Core model — classes and data structures

The complete type-level design of `@prisma/composer` and the target-pack contract,
with `@prisma/composer-prisma-cloud` as the worked instance. This is the implementation
design under [`core-and-targets.md`](../03-domain-model/core-and-targets.md): that
doc says *what* the split is; this one says exactly *which types exist, what fields
they carry, and who imports what*. Scope: the current model — Services declaring
**dependency slots** (one mechanism, whoever the producer is), the minimal
**Module** that provisions the Resources and services and wires every slot, and
the **build adapter** that turns a service's app into a runnable artifact;
typed interfaces and full Module composition are named extension points.

## The service is declarations; the app owns its entry

The one idea the rest of the document elaborates: **a service is a description,
not a program.** `compute({ deps, build })` declares what a service depends on and
how it is built — nothing more. It has no handler. The code that actually serves
requests is the app's own **entrypoint** (a Hono `server.ts`, a Next.js app),
which the app author writes *and bundles themselves*, exactly as they already do.

Two methods hang off the service node and bridge the two:

- **`run(address, boot)`** — the process controller. At boot it resolves the
  service's config from the environment, stashes it under process-local keys, then
  calls `boot()` to start the app's entry. It is what the deployed artifact runs.
- **`load()`** — called from *inside* the app's entry (or a Next page). It reads
  the stash and returns each dependency's **binding** — the most-derived value
  its contract can construct (ADR-0015): a derived client for a protocol-owned
  kind (rpc, http), the typed connection config for a resource (postgres →
  `{ url }`, from which the app builds its own client). Typed either way. No
  address, no environment keys, no framework knowledge.

Because the entry always runs inside `run()`'s process, `run()` executes first and
`load()` reads what it left — the two never coordinate through anything the app
author sees. The framework never bundles the app's code; it only produces a small
wrapper around the app's built entry and packages it for the target.

## Package and entry map

Six entry points, split by dependency weight. The split is enforced, not
aspirational (see § Invariants).

Entries map onto the framework's **four planes**. Entry names say *when you import
them*; mechanism terms stay on the functions (`lower()`/`lowering()` — the
glossary's Lowering — live in `/deploy`):

| Plane | What it covers | Home today |
| --- | --- | --- |
| **authoring** | write the model — node factories, model types, build-adapter descriptors | `.` (usually reached through a pack's vocabulary) |
| **control** | load / interrogate / mutate the model at build time — `Load`, `configOf`, the topology view | also `.` — see below |
| **deploy** | convert the model to Alchemy for deployment — `lower()`, `lowering()`, `Target`; assemble the artifact (build adapters' deploy side) | `/deploy`, each adapter's `/assemble` |
| **execution** | run it — the node's `run`/`load`, core's `hydrate` | rides on the node (pack authoring entry) |

**`/control` is reserved as the settled design direction**: today the control
surface is two pure, lean functions, too little to justify its own entry — but
the moment it grows (the queryable-topology emit, config-declaration tooling, graph
transforms when Modules arrive), it carves out of `.` into `@prisma/composer/control`.
The boundary is decided; only the carve is deferred.

| Entry | Exports | Imports (weight) |
| --- | --- | --- |
| `@prisma/composer` | node factories (`service`, `resource`, `dependency`, `module`), `Load`, `configOf`, `hydrate`, `BuildAdapter` type, model types (incl. `Config`) | nothing |
| `@prisma/composer/deploy` | `lower()`, `lowering()`, `Target` types, `Bundle`/`AssembleInput` (the assembler seam's contract, defined once here) | `alchemy`, `effect` |
| `@prisma/composer-prisma-cloud` | `compute()` (declares a service; carries `run`/`load`), `postgres()` (`{ name }` identity or `{ client }` dependency, by argument shape) + `postgresContract`, `http()` | `@prisma/composer` only |
| `@prisma/composer/rpc` | the RPC Contract kind — `contract()`, `rpc()`, `serve()`, the typed client binding (see [`connection-contracts.md`](connection-contracts.md)) | `@prisma/composer` + a Standard Schema validator |
| `@prisma/composer-prisma-cloud/cron` | cron as a driver (see [ADR-0020](../90-decisions/ADR-0020-scheduled-work-is-a-driver-not-a-resource.md)) — `defineSchedule`, `serveSchedule`, `cronScheduler`, `cron()`, `triggerContract` | `@prisma/composer` + `app-node` + `app-rpc` |
| `@prisma/composer-prisma-cloud/storage` | S3-compatible object storage as a module (S3 wire protocol on Compute + Postgres `bytea`; see [`README`](../../../packages/1-prisma-cloud/2-shared-modules/storage/README.md)) — `storage()`, `s3()` + `s3Contract`/`S3Config`, `storageService`; `/storage/testing` adds the `createPgStore` + `startStorageServer` local stand-in | `@prisma/composer` + `app-node` + `@prisma/composer-prisma-cloud` |
| `@prisma/composer-prisma-cloud/target` | `prismaCloud()` | `@internal/lowering`, `alchemy`, `effect` |
| `@prisma/composer/node` · `@prisma/composer/nextjs` (build adapters) | `node()` · `nextjs()` — the authoring **descriptor** (lean, rides in `service.ts`), stamped with the adapter's own `pack` | `@prisma/composer` only |
| `@prisma/composer/node/assemble` · `@prisma/composer/nextjs/assemble` | the deploy-side assembler (called by `package`) | `node:fs`/framework tooling — deploy machine only |
| `@internal/assemble` | `assembleServices()` — routes each service to its adapter's `/assemble` via `${build.pack}/assemble` (entry-anchored), the wrapper-inlining policy, `AssembleError` | `node:fs`/`node:module` — deploy machine only; consumed by `@internal/cli` and the future programmatic deploy API |

A build adapter splits exactly like a target pack: a **lean authoring descriptor**
that the service module carries (pure data — `{ kind, pack, module, entry }`,
`pack` being the adapter's own package name, baked in by its factory), and a
**heavy deploy-side assembler** invoked once at deploy on the build machine,
resolved from `pack` (`${build.pack}/assemble`) the same entry-anchored way a
target pack's `/target` is. The descriptor rides into every bundle that
imports `service.ts`; the assembler never does.

`@prisma/composer-prisma-cloud/cron` is a **subpath**, not its own package: Prisma Cloud's common Modules each get one entry point under `@prisma/composer-prisma-cloud` (`/cron` today, more later), so an app that never imports `/cron` never bundles it (tree-shakable by subpath). A Module's runnable entries (`scheduler-service.mjs`, `scheduler-entrypoint.mjs`) ship as self-contained dist files that only its own build descriptors reference by path — never imported by the subpath's own authoring barrel.

Per the [runtime-agnostic
principle](../01-principles/architectural-principles.md), no execution-plane entry
imports Bun or Node APIs — not even type-only. Runtime-specific code (the DB
driver, the server API) appears only in **app files**.

Who imports what, end to end:

- the **user's service module** (`service.ts`) imports `@prisma/composer-prisma-cloud`, a
  build-adapter descriptor (`@prisma/composer/node` / `@prisma/composer/nextjs`), and the app's
  own driver of choice (a DB client factory lives inline here). It exports the
  service node and **nothing runs on import**;
- the **user's entrypoint** (`server.ts`, or a Next page) imports the service
  module and calls `service.load()` for typed deps. The app author writes AND
  bundles this file (their bundler, or `next build`) — the framework never touches it;
- the **deploy entry is the app module itself** — there is no config file
  (ADR-0003). `prisma-composer deploy <entry>` imports it, infers the target pack from
  the nodes, and constructs the target from the environment via the pack's
  `/target` `fromEnv()` — the only place the heavy target import happens — then
  calls `@prisma/composer/deploy`'s `lower()` internally. The app author writes no
  stack file and no config file — `prisma-composer deploy` generates one at
  `.prisma-composer/alchemy.run.ts` per run and drives it; see
  [`deploy-cli.md`](deploy-cli.md).

At deploy, the build adapter's assembler produces a **normalized bundle dir**: the
app's built entry, plus the framework's **wrapper** (the service module bundled
with core inlined once — it carries `run`/`load`), plus any framework fixups.
The target pack's `package` then prints the bootstrap and wraps that dir in the
target envelope. The wrapper never contains Alchemy; the app's entry is never
compiled by the framework.

## Decision taken: Alchemy is core's provisioning substrate

`@prisma/composer/deploy` imports `alchemy`/`effect`. The architectural principle
forbids core knowledge of **deployment targets** (Prisma Cloud); Alchemy is not a
target — it is the provisioning plane [`layering.md`](../03-domain-model/layering.md)
already commits to (claim 3: the framework uses Alchemy's definition language *and*
engine). Putting the engine in core means every target pack supplies only data
(providers + lowerings) instead of re-implementing apply/state. The swap test still
holds: replacing `@prisma/composer-prisma-cloud` with another pack changes nothing in core.

## The three execution paths

Everything the module does happens on one of three paths. On every path **core is
the only actor**; the pack and the build adapter contribute tools that satisfy an
SPI and never see the graph, never sequence anything, never call another tool.

| Path | Where it executes | Core does (the actor) | Pack / adapter tools used |
| --- | --- | --- | --- |
| **provision** | deploy machine, via Alchemy | provision the application once (Project + poison vars), then walk the DAG realizing each service's host | `Target.application.provision`, then `ServiceLowering.provision` → identity (App) |
| **deploy** | deploy machine, via Alchemy | build each service's typed `Config`, have the pack encode it *first*, assemble via the build adapter, then ship the build | `ServiceLowering.serialize`, the **build adapter's `assemble`**, then `package` + `deploy` |
| **run** | inside the bundle, in the VM | provide `hydrate` (typed `Config` → each dependency's binding); the node's `run` resolves + stashes config and boots the entry, the node's `load` hydrates on demand | the node's `run` / `load`, each connection's `hydrate` |

**provision vs deploy** is the line between "the service exists" and "its code is
running": provision creates identity-bearing infrastructure that changes only when
the topology changes; deploy ships a specific build (keyed by artifact hash) and
changes on every push. The seam between them is the only window where connection
config can land — an environment variable needs the consumer's projectId (exists
after provision) and is read at version start, never after (PRO-211: so it must
exist before deploy). Core sequences `provision → serialize → package → deploy`
for every service, which **eliminates the fresh-deploy config race by
construction**, for every target pack ever written. One producer-side asymmetry: a
producer's real URL is trustworthy only after its *deploy* completes (the
create-time endpoint domain is a placeholder — PRO-200), so core runs a producer
through both phases before touching its consumers' config. (The phase boundary is a
claim about platforms — "identity vs running code" is crisp on Prisma Cloud and
most targets, and the SPI assumes it.)

The **run path** is a separate process, entirely inside the deployed artifact:
`run(address, boot)` deserializes this service's environment into a typed `Config`
(the pack's single sanctioned environment read), re-emits it under stable
process-local keys, then calls `boot()` to start the app's entry. Inside that
entry, `load()` reads the stash and hands back each dependency's typed binding. The
deploy path's `serialize` and the run path's deserialize use the pack's **one
shared serializer**, so writer and reader cannot drift.

## Core model types (`@prisma/composer`)

All nodes are **plain, frozen, serializable data** — with exactly **two sanctioned
behavior slots** hanging off the graph as data: a Connection's `hydrate` (typed
values → client), and the build adapter's descriptor (pure data — its heavy
assembler is looked up at deploy, never carried). The Service node carries **no
handler**: it is a description. Booting behavior (`run`/`load`) is added by the
target pack's factory, which needs the target's environment knowledge. Config
*declarations* are pure data; core builds a **typed `Config`** from the graph and
the pack encodes it to/from the environment (§ Runtime). Core reads no environment.
The topology view simply drops the function slots. A node's `type` is its routing
key at deploy; core never interprets it beyond lookup.

```ts
// Brand — set by the factories below; how Load tells a node from junk.
// Symbol.for so the check survives duplicated module instances in a workspace.
const NODE: unique symbol = Symbol.for("prisma:node") as never

interface NodeBase {
  readonly [NODE]: true
  readonly kind: "service" | "resource" | "dependency"
  readonly type: string                        // the node's OWN routing key, unqualified — e.g. "postgres", "compute"
}
// ModuleNode is deliberately NOT a NodeBase: it has no routing `type` — it is
// transparent wiring, not a routable thing (see § Nodes).

// Shared base for pack-authored nodes (service + resource): the pack's package
// name, e.g. "@prisma/composer-prisma-cloud" — deploy tooling reads it off the graph
// to resolve `${pack}/target` (ADR-0003). DependencyEnd stays pack-less.
// Deploy tooling routes on the (pack, type) pair: `pack` selects the target,
// `type` selects that target's lowering-table entry within it — `type` never
// carries a pack prefix itself.
interface PackAuthoredNode extends NodeBase {
  readonly pack: string
}

// ——— Configuration model (core owns structure; the pack owns encoding) ———
//
// Split by ownership (see § Runtime):
//   · CORE — the config SHAPE (declarations: names + a caller-owned schema per
//     param, target-independent, no platform keys) and the typed `Config`
//     VALUE it builds from the graph at deploy and consumes (hydrate) at boot.
//   · PACK — encoding: serialize the typed Config into env strings at deploy,
//     deserialize the identical typed Config back at boot. The pack owns both
//     ends through one serializer, so writer and reader cannot drift; core never
//     sees a platform key or a string.

// A declared config param — pure data: a caller-owned Standard Schema
// (ADR-0018) plus a few framework facets. The pack validates raw values
// against `schema` at boot, and TypeScript infers the hydrate/load input types
// from it — there is no framework enum of permitted types. A param is never
// secret — a secret is its own forwardable slot, declared with secret() and
// read with secrets() (ADR-0029).
interface ConfigParam<S extends StandardSchemaV1 = StandardSchemaV1> {
  readonly schema: S
  readonly optional?: boolean
  readonly default?: StandardSchemaV1.InferOutput<S>
}
type Params = Record<string, ConfigParam>
type Values<P extends Params> = {              // what implementations receive
  readonly [K in keyof P]: StandardSchemaV1.InferOutput<P[K]["schema"]>   // (| undefined when optional with no default)
}

// The connection face of a dependency: declared params (data) and how validated
// values become a client (the hydrate behavior slot). Both P and C are INFERRED —
// the declaration types hydrate's input; the factory types the loaded dep.
interface Connection<P extends Params = Params, C = unknown> {
  readonly params: P
  hydrate(values: Values<P>): C | Promise<C>
}

// The resolved, typed configuration of one service — what crosses the core→pack
// boundary. Core builds it at deploy (leaf values are provisioning refs, so the
// env writes depend on the resources/producer — the ordering edges); the pack
// serializes it, and at boot reconstructs the identical structure with concrete
// values. Both forms conform to the shape from configOf. Core never stringifies.
interface Config {
  readonly service: Readonly<Record<string, unknown>>                        // service-param values
  readonly inputs: Readonly<Record<string, Readonly<Record<string, unknown>>>> // input → its connection-param values
}

// ——— Build adapter ———
//
// How a service's app becomes a runnable artifact. The DESCRIPTOR is pure data
// the service node carries (rides in service.ts, into every bundle); it names the
// adapter, the authoring module, and the built-entry location. `entry` (and any
// other kind-specific path, e.g. nextjs's `appDir`) resolves relative to
// `dirname(module)` — exactly like an import specifier (ADR-0004) — never an
// absolute or machine path. `module` is the one sanctioned exception: deploy-time
// metadata only, and bundlers preserve it as an expression, so it re-evaluates
// inside the deploy artifact instead of baking in a dev-machine path. The heavy
// ASSEMBLER (fs, framework tooling) is resolved from `pack` (`${pack}/assemble`,
// entry-anchored) at deploy and never ships in a bundle (§ Lowering, § Extension).
interface BuildAdapter {
  readonly kind: string                        // "node" · "nextjs" — the resolved module's own discriminant
  readonly pack: string                        // the adapter's package name, e.g. "@prisma/composer/node" — baked in by node()/nextjs(); resolves `${pack}/assemble`
  readonly module: string                      // the authoring module's import.meta.url — the anchor every other path resolves against
  readonly entry: string                       // built runnable, resolved relative to dirname(module) (e.g. "../dist/server.js")
}

// ——— Nodes ———

// A Resource's identity: the ONE place a piece of infrastructure exists. A module
// provisions it (`h.provision("db", postgres({ name: "db" }))`) and wires the
// returned ref into each consumer's dependency slot — a resource is never
// created because a service mentioned it. `provides` is the Contract it offers
// (its single port); the routing `type` is DERIVED as `provides.kind`, so a
// slot requiring that contract is satisfied — at compile time and at Load —
// through exactly the machinery a service port uses.
interface ResourceNode<C extends Contract<any, any> = Contract<any, any>> extends PackAuthoredNode {
  readonly kind: "resource"
  readonly type: C["kind"]
  readonly provides: C
}

// A Service: inputs + its own declared params + how it is built. This IS the
// user's default export — inspectable (inputs/type/params/build), inert until run.
// It carries NO handler; the app's entry is the code that serves. The BASE node is
// not runnable: booting needs a target's environment knowledge, so the pack's
// factory returns a runnable/loadable subclass that adds `run`/`load` (§ Runtime).
// No `url`/anchor field here — the service's build adapter carries its own
// authoring module (BuildAdapter.module, ADR-0004).
interface ServiceNode<D extends Deps = Deps, P extends Params = Params> extends PackAuthoredNode {
  readonly kind: "service"
  readonly inputs: D
  readonly params: P                           // service-level config (e.g. port) — no special "context" concept
  readonly build: BuildAdapter                 // how the app's entry is built + assembled
}

// THE dependency slot a service declares, whoever the producer is. Nothing is
// provisioned FOR it: at Load the enclosing module wires a provisioned producer's
// ref into it (a service's exposed port, or a resource — the contract
// determines validity, never the producer's kind), and at deploy it becomes an
// EDGE from that producer to the consumer. At run it hydrates its binding through
// the Connection machinery; the consumer never learns HOW the producer's
// address reached it. `Req` is the required Contract — `unknown` for an untyped
// end (`http()`, the escape hatch that accepts anything); `required` carries it
// as a value so Load can call `satisfies()` as the backstop.
interface DependencyEnd<C = unknown, Req = unknown> extends NodeBase {
  readonly kind: "dependency"
  readonly connection: Connection<Params, C>
  readonly required: Req | undefined
}

// Dependency map: name → the slot the service declares. Only declarations are
// admitted — a concrete ResourceNode never sits in deps, so a service cannot
// cause infrastructure to exist by mentioning it. Loaded types are inferred
// from each entry's hydrate return type.
type Deps = Record<string, DependencyEnd<any, any>>

// A Module: transparent wiring, no code of its own. The body runs at Load (it is
// wiring, not user code) and provisions the services it owns, supplying a
// producer for every dependency input. Minimal form — boundary ports and
// nesting arrive with full Module composition (see § Extension points).
interface ModuleNode {
  readonly [NODE]: true
  readonly kind: "module"
  readonly name: string
  body(h: ModuleBuilder): void
}
interface ModuleBuilder {
  // Provisions an owned resource under a stable id — the ONE place it exists.
  // Returns the ref (the provided contract, tagged with the id) a later
  // provision() wires into a consumer's dependency slot.
  provision<C extends Contract<any, any>>(id: string, resource: ResourceNode<C>):
    { readonly id: string } & RefPort<C>
  // Registers an owned service under a stable id; `wiring` supplies a producer
  // ref for each dependency slot, checked against the slot's required contract
  // (an untyped slot's Req is `unknown`, so it accepts anything).
  provision(id: string, service: ServiceNode<any, any>,
            wiring?: Record<string, RefPort<Contract<any, any>>>): ProvisionedRef
}
// One ref shape: a stable id plus one ref-port per exposed contract (a service
// with `expose`, or a resource's single provided port flattened onto the ref).
type ProvisionedRef = { readonly id: string }
type RefPort<C extends Contract<any, any>> = C & { readonly __providerId: string }

type Hydrated<N> = N extends DependencyEnd<infer C, any> ? C : never
type HydratedDeps<D extends Deps> = { readonly [K in keyof D]: Hydrated<D[K]> }

// What load() returns: the hydrated deps and the service's resolved params, merged
// for ergonomics (`const { db, port } = service.load()`). Deps and param names are
// expected distinct; the merge is the surface the app entry consumes.
type Loaded<D extends Deps, P extends Params> = HydratedDeps<D> & Values<P>
```

### Node factories

Target packs do not hand-roll node objects — they call core's factories, which brand,
validate, and freeze. This is the whole "framework provides / pack wraps" contract:

```ts
// @prisma/composer
function resource<C extends Contract<any, any>>(def: {
  name: string
  pack: string
  provides: C                      // the routing `type` is derived as provides.kind
}): ResourceNode<C>

function dependency<P extends Params, C, Req = unknown>(def: {
  name?: string                    // diagnostic only; falls back to `type`
  type: string
  connection: Connection<P, C>
  required?: Req                   // the Contract this slot requires (undefined = untyped)
}): DependencyEnd<C, Req>

function service<D extends Deps, P extends Params>(def: {
  type: string
  inputs: D
  params: P
  build: BuildAdapter
}): ServiceNode<D, P>   // the pack wraps this and returns its runnable/loadable subclass

function module(name: string, body: (h: ModuleBuilder) => void): ModuleNode   // body runs at Load, not here
```

`service()` freezes `inputs`/`params`/`build`; `dependency()` freezes the
connection's declared params; `resource()` derives `type` from `provides.kind`.
All throw on an empty `type`; `service()` and `dependency()` also reject an
input or param name containing `_`, and a module's `provision()` rejects an id
containing `_` or `.` — the pack's config-key serializer joins address segments
and names with `_` (node ids join path segments with `.`), so either character
inside a name would collide with that separator. Nothing executes: constructing
nodes is pure. The pack's authoring factory (`compute()`) calls `service()` and
returns a subclass carrying `run` and `load`.

## Graph and Load (`@prisma/composer`)

```ts
type NodeId = string           // path-derived: root "hello", its input "hello.db"

interface GraphNode { readonly id: NodeId
                      readonly node: ServiceNode | ResourceNode | DependencyEnd | ModuleNode }
interface Edge { readonly from: NodeId; readonly to: NodeId; readonly input: string
                 readonly kind: "input" | "dependency" }

interface Graph {
  readonly root: GraphNode
  readonly nodes: readonly GraphNode[]     // root + the provisioned/declared nodes, topo-ordered (deps first)
  readonly edges: readonly Edge[]
}

function Load(root: ServiceNode | ModuleNode, opts?: { id?: NodeId }): Graph   // throws LoadError
class LoadError extends Error {}
```

Load accepts a service or a module root. For a service it walks `root.inputs`, assigns
ids, builds edges. For a module it **executes the body** (the body is wiring, not user
code — running it at Load is the designed exception to imports-run-nothing) with a
collector `ModuleBuilder`, producing the owned resources and services and one
**dependency edge** per wired slot. Edges carry a kind: `input` (a service
consumes its own declared slot) or `dependency` (a service consumes a
provisioned producer — a service port OR a resource, the one mechanism), the
latter running from the producer to the consumer, labeled with the consumer's
input name. Validation: every node branded with a non-empty `type`; every
dependency slot of a provisioned service **wired to a provisioned producer**,
and when the slot declares a required contract the wired ref must `satisfies()`
it (dangling or unsatisfied = LoadError) — no producer-kind branching, a
service ref cannot satisfy a postgres-requiring slot because no service port
carries that contract kind; a concrete ResourceNode found inside `deps` is a
targeted LoadError — a resource is provisioned by the composing module, never
created by mention; the dependency edges form a **DAG** (a cycle is a LoadError
with the cycle named — a consequence of address-at-deploy-time wiring: if A
needs B's address to deploy and B needs A's, neither can go first; resources
take no wiring, so only service-to-service edges can cycle). A service Loaded
directly as the root may carry no dependency slot at all — nothing at the root
wires or provisions for it — so an unwired slot is a LoadError naming the input
and pointing at deploying the composing module instead. Load executes nothing of the user's — the graph is data
in memory to inspect or hand to `lower` (or the node's `run`). A **topology view** — nodes as `{ id, kind, type }`
plus edges, function slots dropped — is `JSON.stringify`-able by construction; the
serialized-artifact emit step builds on this later.

## Lowering (`@prisma/composer/deploy`)

The router. Core's only job at deploy: Load, then look up each node's `type` in the
target's lowering table and run what it finds, deps before dependents.

```ts
import type { Layer } from "effect"
import type { Effect } from "effect"

// What a target pack's /target entry produces — data + per-type SPI functions.
// The pack is never the actor: these are tools core invokes at moments core
// chooses; none sees the graph, sequences anything, or calls another.
interface Target {
  readonly name: string
  providers(): Layer.Layer<never>                       // the pack's Alchemy providers
  readonly application: ApplicationLowering             // once per lowering, before anything else
  readonly resources: Record<string, Lowering>          // resource type id → one-shot lowering
  readonly services: Record<string, ServiceLowering>    // service type id → phased SPI
  readonly state: () => AlchemyStateLayer               // the target's default state backend — every target
                                                        // supplies one; explicit opts.state always wins
}

// The application's shared infrastructure: on Prisma Cloud, the one Project
// (the config namespace and lifecycle boundary) plus the poison DATABASE_URL
// variables. Its product (e.g. { projectId }) reaches every later SPI call of
// the SAME extension via LowerContext.application. Core declares it `unknown`
// and never reads it — the extension narrows with its own guard (ADR-0033).
interface ApplicationLowering {
  provision(ctx: LowerContext): Effect.Effect<unknown, unknown, unknown>
}

// The phased service SPI. P and S are the DESCRIPTOR's own handoff types —
// provision's product consumed by serialize/deploy, and serialize's product
// consumed by deploy. Core threads them through without inspection; only the
// descriptor that writes them reads them (ADR-0033). Method syntax is required:
// the heterogeneous registry assigns through TypeScript's method bivariance.
interface ServiceLowering<P = unknown, S = unknown> {
  // provision: make the target-specific thing that will host the service —
  // identity-bearing infrastructure only (the App), inside the application's
  // Project (ctx.application); no code runs. P may hold unresolved Output<T>
  // references — the whole stack effect runs before Alchemy applies anything.
  provision(ctx: LowerContext): Effect.Effect<P, unknown, unknown>
  // serialize: encode the typed Config core built into the service's runtime
  // environment (on Prisma Cloud: EnvironmentVariables on the project), keyed by
  // the deployment address. The pack owns the encoding; run()'s deserialize
  // reverses it through the same serializer, so writer and reader cannot drift.
  // Leaf values are provisioning refs → the env writes depend on the
  // resources/producer (the ordering edges). Returns the env-var records so
  // `deploy` can reference them (the environment edge — see alchemy-lowering.md).
  serialize(ctx: LowerContext, provisioned: P, config: Config):
    Effect.Effect<S, unknown, unknown>
  // package: assemble the deployable artifact from the build adapter's normalized
  // bundle dir and print the bootstrap (address + the boot import baked in). The
  // envelope is target vocabulary and the pack's business (Compute: bootstrap.js +
  // compute.manifest.json + tar.gz). MUST be byte-deterministic (fixed tar
  // mtimes/ordering): identical inputs yield an identical hash, so an unchanged
  // service noops on redeploy.
  package(ctx: LowerContext, input: PackageInput):
    Effect.Effect<Artifact, unknown, unknown>
  // deploy: ship the packaged artifact into the provisioned thing and run it
  // (version → upload → start → promote). Consumes `serialized`'s env records
  // via the Deployment's environment prop (the edge). Returns the node's
  // outputs — what dependent nodes' connection params resolve against — plus
  // the entities it became on the deployment target, for the deploy report.
  deploy(ctx: LowerContext, provisioned: P, artifact: Artifact,
         serialized: S): Effect.Effect<LoweredResult, unknown, unknown>
}

// What a node's final lowering phase produces: outputs for dependents,
// entities for the deploy report (ADR-0033).
interface LoweredResult {
  readonly outputs: Outputs
  readonly entities: readonly Input<DeployedEntity>[]
}

// package input: the build adapter's assembled output plus the address. The
// bootstrap the pack prints is the ONLY runnable code the framework adds to the artifact.
// It imports the wrapper and calls run with the address AND a boot thunk that
// imports the app's built entry — a printed, literal dynamic import of a runtime
// path (never a bundled reference, so no bundler ever follows it):
//   import main from "./main.js"
//   await main.run("<address>", () => import("./server.js"))
// The entrypoint takes its deployment identity as a parameter; deploy is the
// caller. The pack owns the printer and the node owns run(), so any
// environment-specific data passes through this closed channel.
interface PackageInput {
  readonly assembled: Bundle            // the build adapter's product (dir + entry)
  readonly address: string              // the node's graph address — baked into the bootstrap
}

// One node's realization. Runs inside the Alchemy stack effect; yields the
// pack's Alchemy resources. Core never looks inside.
type Lowering = (ctx: LowerContext) => Effect.Effect<LoweredResult, unknown, unknown>

interface LowerContext {
  readonly id: NodeId
  readonly address: string                              // the node's deployment address (graph position);
                                                        // the config-key namespace and the bootstrap parameter
  readonly node: ServiceNode | ResourceNode
  readonly graph: Graph
  readonly opts: LowerOptions
  readonly application: unknown                         // the owning extension's application product;
                                                        // undefined when it declares no hook. Core never
                                                        // reads it; the extension narrows it (ADR-0033)
  readonly lowered: ReadonlyMap<NodeId, Outputs>        // already-lowered deps (topo order)
}

// The values a node provides to its dependents — e.g. a deployed URL a later
// node's env consumes; what a consumer's declared connection params
// resolve against. Name-keyed and unknown-valued of necessity: core cannot
// know extension types, and which producer feeds which consumer is decided by
// the user's graph at runtime. The connection declaration is the contract
// (ADR-0033).
type Outputs = Readonly<Record<string, unknown>>

interface LowerOptions {
  readonly name: string                                  // stack name (+ Load's root id override)
  // `prisma-composer deploy` runs each service's build-adapter assembler and writes
  // the resulting bundle dirs here, into the generated stack file it hands to
  // `lower()` — one bundle per provision id (the deploy root is always a
  // module). A hand-composed / mixed-stack caller (the escape hatch — see
  // § Lowering) supplies these itself.
  readonly bundles: Record<string, Bundle>
  readonly stage?: string
  readonly state?: AlchemyStateLayer                     // explicit override — wins over the target's own
                                                         // default (Target.state)
}
interface Bundle { readonly dir: string; readonly entry: string }          // the ONE assembled-bundle shape (assembler product; defined once, here)
interface Artifact { readonly path: string; readonly sha256: string }       // package()'s product

// Load → route each node through target.lower[node.type] → an Alchemy Stack
// (the default export the alchemy CLI consumes). Unknown type → LowerError
// naming the type and the target's known types. root must be a module — a bare
// service is not independently deployable.
function lower(root: ModuleNode, target: Target, opts: LowerOptions): AlchemyStack
class LowerError extends Error {}

// Composable form — for MIXED topologies: framework-authored nodes beside
// hand-wired Alchemy resources in one stack. Runs the same Load → route walk
// inside the caller's stack effect. Resolves to `undefined`: the root module
// has no outputs of its own (boundary ports are future work), and returning
// nothing keeps Alchemy from printing and persisting a stack-output dump —
// Apply.apply short-circuits on a falsy plan output (ADR-0033).
// Error channel: LowerError from routing, PLUS whatever a pack lowering fails
// with (their error type is open) — a mixed-stack caller treats failures as
// deploy-fatal or inspects; it must not assume LowerError is the only inhabitant.
function lowering(root: ModuleNode, target: Target, opts: LowerOptions):
  Effect.Effect<undefined, LowerError, unknown>
```

`lower()` is nothing but the whole-stack wrapper:
`Alchemy.Stack(opts.name, { providers: target.providers(), state: opts.state ?? target.state() }, lowering(root, target, opts))`
— Alchemy requires a state layer; every target supplies its own default (prisma-cloud
defaults to a Prisma-hosted store), and an explicit `opts.state` always wins. Two
type-level notes the wrapper carries (both commented at the single site): a
`LowerError` is fatal at deploy (`Effect.orDie`), and the effect's requirements
channel is narrowed to what `Alchemy.Stack` accepts — `lowering()` itself stays
`unknown`-requirements for composability.
In the mixed case the hand-written stack supplies providers itself (including the
target's, via `target.providers()`), yields a `lowering(…)` per framework-authored
service, and wires its own resources around the returned `outputs`.

**Core's deploy-path sequencing** — the control flow no pack can misorder.
First, `application.provision` runs once (the Project, with the poison
`DATABASE_URL` variables). Then walk the graph in topological order (the module
body's provision order; the dependency DAG Load validated). Each module-provisioned
**resource** lowers exactly once via `Target.resources` (e.g. one Database +
Connection — outputs carry the url), no matter how many services consume it;
dependency-slot nodes are edges only and never lower. Then for each service:

1. `provision` — the service now has identity (its App).
2. core **builds the typed `Config`** — each input's declared params matched by
   name to its producer's lowered outputs through the one `dependency` edge:
   whatever the module wired in — a resource's lowered outputs (shared by every
   consumer wired to it) or a producer service's deploy outputs (the producer,
   earlier in topo order, is already fully deployed — its URL is real, not the
   create-time placeholder) — plus service-param defaults. Leaf values are
   provisioning refs, not strings.
3. `serialize(config)` — the pack encodes that typed Config into the service's
   runtime environment (Prisma Cloud: one env write per leaf, keyed by the
   pack's own naming from the address, value = the ref). Never the platform default.
4. `package({ assembled, address })` — the build adapter's assembler has produced
   the normalized bundle dir; the pack prints the bootstrap (address + boot import
   baked in, § below) and wraps it in the target envelope.
5. `deploy(artifact)` — the first version snapshots an environment that is already
   complete.

**How the ordering is actually enforced:** our walk only *assembles* Alchemy
resource descriptions — Alchemy executes them in dependency order and runs
unordered resources concurrently; declaration order is never consulted. So core
realizes the sequence as **dependency edges**: most arise naturally from value flow
(the env var consumes the project id and the producer's URL), and the one that
doesn't — deploy-after-serialize — exists because the `Deployment` resource
declares the environment records it boots with as a prop, which is PDP's own
dataflow restored (the version-create call literally contains the materialized env
map). See the lowering graphs in
[`../05-prisma-cloud/alchemy-lowering.md`](../05-prisma-cloud/alchemy-lowering.md).
This is what makes the fresh-deploy config race (PRO-211) structurally impossible
on every target — the edge's **ordering** job. Its second job, **propagating** a
wire whose value genuinely changes, is not yet wired: the env-var resource exposes
only `{ id, key }`, so a changed value doesn't diff the consumer's `Deployment`.
The fix is provenance-based (the consumer depends on the *source node's* version,
never on the value or a hash of it) and is a deferred follow-up — narrow in
practice, since promoted service endpoints are stable across producer redeploys.
Secrets are platform-sourced and rotate through the platform, not this edge (see
the [config/secret glossary](../03-domain-model/glossary.md#configuration--config-and-secrets)).

**Deployment identity — address, bootstrap, and why.** A node's identity is its
**address**: the path of provision ids from the app root, assigned by Load from
graph position — never user-invented, so registry modules with common internal
names (`db`, `service`) cannot collide; the address qualifies them. Identity
cannot travel through the environment: every App in a Project boots a
byte-identical env (ConfigVariables are project+branch-scoped and snapshotted at
version create — see the [PDP data model](../05-prisma-cloud/pdp-data-model.md)),
so any "who am I" variable is one shared key, last write wins. The only
per-service channel is the artifact itself. Hence the bootstrap: the artifact's
entrypoint takes identity as a parameter, and deploy is the caller. The Compute
artifact the pack assembles:

```
server.js              ← the app's OWN built entry (Hono bundle / Next standalone). Calls service.load().
main.js                ← framework wrapper: the service module bundled, core inlined ONCE. Inert on import.
bootstrap.js           ← pack-printed: `import main from "./main.js"; await main.run("<address>", () => import("./server.js"))`
compute.manifest.json  ← pack-written envelope; entrypoint = bootstrap.js
```

The node carries its own runner: the pack's service node has `run(address, boot)`
and `load()` (§ Runtime), so the wrapper already contains the boot loop — the
bootstrap is a two-line sliver that imports `./main.js` and dynamically imports the
app's entry, and the artifact holds a single copy of core. There is **no import
cycle**: the app's entry imports the service module (for `load()`), and the
bootstrap imports the wrapper and dynamically imports the entry — nothing imports
the bootstrap, and the serve code lives in the app's entry, never in the service
module. Every byte is deterministic — the app's built entry, the framework's wrapper,
the printed bootstrap — so unchanged services hash identically and noop, once the
app's build is itself deterministic (the Next standalone case is a named
follow-up). Because the same Load walk feeds both `serialize`'s env keys and the
bootstrap's address (and the pack derives config keys from that address on both
sides), the config writer and the boot-time reader cannot drift. An address changes
only when the graph position changes (e.g. a rename), which correctly cascades: new
keys, new bootstrap, new version.

Notes:

- **Target-specific identity** (workspace id, region) never appears in
  `LowerOptions` — it is captured by the pack's target constructor
  (`prismaCloud({ workspaceId })`). Core's options are target-neutral.
- **The app owns its entry; the framework owns the wrapper.** The app builds its own
  entry (`server.js` via its bundler; the Next standalone via `next build`); the
  build adapter's assembler normalizes it into a bundle dir alongside the
  framework's wrapper, and the pack's `package` prints the bootstrap and tars.
  Core still has
  no build step — printing a bootstrap and bundling a service-module wrapper is
  assembly, not compiling app code.

## Runtime: booting a service (`run`, `load`, core's shape and hydrate)

At boot, the deployed artifact runs the bootstrap, which calls the node's
`run(address, boot)`. The split is **core owns structure, the pack owns encoding**:

- **`run(address, boot)`** — the process controller, on the pack's service node.
  It deserializes this service's environment into a typed `Config` (its own
  encoding, keyed from the address the bootstrap passed — the pack's single
  sanctioned environment read), re-emits that config under stable, address-free
  **process-local keys** (the *stash* — env is the default medium because it is
  inherited by any worker or child the app's framework forks), then calls `boot()`
  to start the app's entry. `run` never hydrates and never calls app code — it sets
  up the process and hands off.
- **`load()`** — on the same node, called from *inside* the app's entry. It reads
  the stash into the typed `Config`, hydrates every input (`connection.hydrate`
  with its value slice) via core's `hydrate`, **memoizes** the result per process,
  and returns the merged `{ ...deps, ...params }`. No address, no framework
  knowledge; the app entry sees each dependency's typed binding — a derived
  client for a protocol-owned kind, or the typed config for a resource, from
  which the app constructs its own client (ADR-0015). Memoization means one
  binding set per process (or per forked worker), created on first `load()`.
- **`configOf(root)`** and **core's `hydrate`** — the shape enumeration and the
  Config→binding step both `run` and `load` build on. Pure, target-independent.

```ts
// The enumerable config surface of a service — derivable from the graph alone,
// nothing booted, no platform keys. The introspection artifact (values absent).
// `schema` is a data-only projection of the param's Standard Schema (its vendor
// tag, never the schema's own `validate`) — a structured param reports its real
// shape instead of a `type` enum. Physical locations are the pack's business.
// Secrets are not here — they live on their own slot (ADR-0029).
interface ConfigDeclaration {
  readonly owner: "service" | { readonly input: string }
  readonly name: string              // "url" · "port"
  readonly schema: Readonly<Record<string, unknown>>
  readonly optional: boolean
  readonly default: unknown
}
function configOf(root: ServiceNode): readonly ConfigDeclaration[]   // in @prisma/composer (pure)

// Core's boot-side helper: given a service and a concrete typed Config, hydrate
// every input (connection.hydrate with its value slice) into its binding. No
// environment read, no strings — the pack already reversed its own encoding into
// a typed Config. Used by the node's load(). The binding is what the kind's
// hydrate yields: a derived client (rpc/http) or the typed config (postgres).
function hydrate(root: ServiceNode, config: Config): Promise<HydratedDeps<Deps>>

// The pack's runnable/loadable service node (what compute() returns). run() is
// the process controller; load() hydrates on demand from the stash run() left.
interface RunnableServiceNode<D extends Deps, P extends Params> extends ServiceNode<D, P> {
  run(address: string, boot: () => Promise<unknown>): Promise<unknown>
  load(): Loaded<D, P>
}
```

Core and user code contain **zero** direct environment reads: the pack's `run` and
`load` are the single sanctioned readers for its platform (both through the one
serializer), and a local test injects fakes and never touches an environment
(below). The typed `Config` is core's interception point — a harness can inspect it
directly — and `configOf` keeps the config surface enumerable without booting.

**Config validation is the pack's, because it is the pack reversing its own
serialization.** "Is this value present and the right type" is exactly the check
`deserialize` must pass to reconstruct the typed `Config` it once wrote; core
defines the shape that check is against. A missing or unparseable value is the
pack failing loudly at boot. `load()` called before `run()` has stashed (e.g. a
Next page prerendered at build time, with no `run()` in the process) fails loudly
too — pages that call `load()` opt out of build-time prerender (`force-dynamic`),
and local dev supplies the stash through a dev harness.

## The Prisma Cloud pack (`@prisma/composer-prisma-cloud`) — worked instance

Authoring entry — nodes carrying their connection/host knowledge; the pack ships
no driver, and a resource dependency's binding is its typed config (the app
builds its own client — ADR-0015):

```ts
import { resource, dependency, service, configOf, hydrate, string, number,
  type BuildAdapter, type Config, type ConfigDeclaration, type Connection,
  type Contract, type Deps, type DependencyEnd, type Loaded, type ResourceNode,
  type RunnableServiceNode } from "@prisma/composer"

export interface PostgresConfig { readonly url: string }

// The contract a Postgres provides AND its consumers require. satisfies()
// compares KIND, not identity — a pack module can be duplicated across a
// workspace (same rationale as the Symbol.for node brand), and every
// duplicate's contract must still satisfy.
export const postgresContract: Contract<"postgres", PostgresConfig> = Object.freeze({
  kind: "postgres", __cmp: { url: "" },
  satisfies: (required) => required.kind === "postgres",
})

// ONE postgres factory, two shapes. { name }: the identity a module provisions —
// the ONE place the database exists, providing postgresContract. postgres()
// (no args): the consumer's dependency requiring it. No client factory — the
// dependency's BINDING is the typed config PostgresConfig itself (hydrate is
// the identity on its values); the app builds its own client from { url } in
// app code (ADR-0015).
export function postgres(opts: { name: string }): ResourceNode<typeof postgresContract>
export function postgres(): DependencyEnd<PostgresConfig, typeof postgresContract>
export function postgres(opts?: { name: string }): unknown {
  if (opts?.name !== undefined) return resource({ name: opts.name, pack: "@prisma/composer-prisma-cloud", provides: postgresContract })
  return dependency({
    type: "postgres",
    connection: { params: { url: string() }, hydrate: (v) => v },
    required: postgresContract,
  })
}

// A service-to-service dependency. Its binding is a DERIVED client — a thin
// URL-anchored fetch wrapper (fetch is standard across runtimes — no driver,
// no runtime coupling). http() is a protocol-owned kind (the framework owns the
// transport), so the client is kind-canonical and derived from the contract,
// with no user client in the declaration (ADR-0015). Untyped (required
// undefined) — the escape hatch; typed generated clients arrive with the
// interface primitive (§ Extension points).
export interface HttpClient { readonly url: string; fetch(path: string, init?: RequestInit): Promise<Response> }
export const http = (opts: { name: string }): DependencyEnd<HttpClient> =>
  dependency({
    name: opts.name,
    type: "http",
    connection: {
      params: { url: string() },
      hydrate: (v) => defaultHttpClient({ url: v.url }),
    },
  })

const computeParams = { port: number({ default: 3000 }) }

// compute() declares a service — deps + build — and returns the pack's RUNNABLE
// subclass carrying run()/load(). It takes NO handler: the app's entry is the
// code that serves. run() is the only environment reader in the pack; load()
// hydrates from the stash run() left.
export const compute = <D extends Deps>(def: {
  deps: D
  build: BuildAdapter
}): RunnableServiceNode<D, typeof computeParams> => {
  const node = service({
    pack: "@prisma/composer-prisma-cloud", type: "compute", inputs: def.deps, params: computeParams, build: def.build,
  })
  let loaded: Loaded<D, typeof computeParams> | undefined   // per-process memo for load()
  return Object.freeze({
    ...node,
    // Controller: resolve config from the address-keyed env, re-emit it under
    // address-free keys (the stash), then boot the app's entry.
    async run(address: string, boot: () => Promise<unknown>) {
      const shape = configOf(node)
      stash(shape, deserialize(shape, address))   // the pack's ONE env read + coercion → address-free env
      return boot()
    },
    // Hydrate on demand from the stash; memoize per process.
    load() {
      if (loaded === undefined) {
        const config = deserialize(configOf(node), "")   // address-free stash keys
        loaded = { ...(hydrateSync(node, config)), ...(config.service as never) } as never
      }
      return loaded
    },
  }) as RunnableServiceNode<D, typeof computeParams>
}

// The pack's config serializer — the semantic↔physical mapping, private to the pack,
// SHARED by serialize (deploy), run() (re-key), and load() (read) so no reader or
// writer drifts. Keys are UPPER_SNAKE(address ▸ owner ▸ name): the address prefix
// makes them unique per service within the shared project namespace (auth's db.url
// ↔ AUTH_DB_URL); an empty address yields the address-free stash keys run() writes
// and load() reads (DB_URL). The platform's DATABASE_URL is never among them — it
// is forbidden and poisoned at project provision (see alchemy-lowering.md).
export const configKey = (address: string, d: ConfigDeclaration): string => /* UPPER_SNAKE(address ▸ owner ▸ name) */

// Boot readers/writers — process.env is touched ONLY here in the pack.
const deserialize = (shape: readonly ConfigDeclaration[], address: string): Config => { /* read + coerce */ }
const stash = (shape: readonly ConfigDeclaration[], config: Config): void => { /* re-emit under address-free keys, the medium the framework's forks inherit */ }
```

Target entry — the lowering table (the only place `prisma-alchemy` is imported):

```ts
import * as Effect from "effect/Effect"
import * as Prisma from "@internal/lowering"
import type { Target } from "@prisma/composer/deploy"

export interface PrismaCloudOptions {
  workspaceId: string
  region?: Prisma.ComputeRegion   // the pack imports prisma-alchemy freely — use its union
}

export const prismaCloud = (o: PrismaCloudOptions): Target => ({
  name: "prisma-cloud",
  // One commented cast: prisma-alchemy's providers() satisfies Stack's provider
  // requirements at runtime but not structurally (pre-existing upstream typings
  // gap; same error exists untypechecked in the hand-written examples). The cast
  // lives here in the pack — never in core — until fixed in prisma-alchemy.
  providers: () => Prisma.providers() as unknown as Layer.Layer<never>,

  // Runs ONCE per lowering, before any service: the application's Project, with
  // the poison DATABASE_URL/DATABASE_URL_POOLED variables written immediately so
  // nothing can ever rely on the platform default.
  application: {
    provision: ({ opts }) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project(`${opts.name}-project`, {
          workspaceId: o.workspaceId, name: opts.name,
        })
        for (const key of ["DATABASE_URL", "DATABASE_URL_POOLED"]) {
          yield* Prisma.EnvironmentVariable(`${key}-poison`, {
            projectId: project.id, key, value: "-", class: "production",  // "-": the API rejects "" (verified at the deploy proof)
          })
        }
        return { outputs: { projectId: project.id } }
      }),
  },

  resources: {
    // One Database per module-provisioned postgres resource — `id` is the module
    // provision id (e.g. "db"), so a resource shared by several services is
    // created exactly once.
    postgres: ({ id, application }) =>
      Effect.gen(function* () {
        const db = yield* Prisma.Database(`${id}-db`, {
          projectId: application.outputs.projectId, name: id,
        })
        // The Connection's DSN is under endpoints.direct.connectionString — the
        // top-level `url` is an API self-link (PRO-212).
        const conn = yield* Prisma.Connection(`${id}-conn`, { databaseId: db.id })
        return { outputs: { url: conn.endpoints.direct.connectionString } }
      }),
  },

  services: {
    compute: {
      // The service as a PLACE inside the application's Project: the App,
      // identity-bearing only, no code runs.
      provision: ({ id, application }) =>
        Effect.gen(function* () {
          const svc = yield* Prisma.ComputeService(`${id}-svc`, {
            projectId: application.outputs.projectId,
            name: id, region: o.region ?? "us-east-1",
          })
          return { outputs: { serviceId: svc.id, projectId: application.outputs.projectId } }
        }),

      // Encode the typed Config into the runtime environment — one env var per
      // leaf, keyed by the SAME serializer run() reads with at boot. Values are
      // the provisioning refs core built the Config from, so each env var depends
      // on its resource/producer — the ordering edges. The platform default is
      // never written.
      serialize: ({ address, node }, provisioned, config) =>
        Effect.gen(function* () {
          const records = []
          for (const d of configOf(node)) {
            const value = d.owner === "service" ? config.service[d.name] : config.inputs[d.owner.input]?.[d.name]
            records.push(yield* Prisma.EnvironmentVariable(`${configKey(address, d)}-var`, {
              projectId: provisioned.outputs.projectId,
              key: configKey(address, d),
              value: typeof value === "number" ? String(value) : (value as never),
              class: "production",
            }))
          }
          // The listen port the app binds is the service's own `port` param
          // (already encoded above); carry it to deploy() through serialize's
          // outputs, the phase that already holds the typed Config.
          const port = typeof config.service.port === "number" ? config.service.port : 3000
          return { outputs: { environment: records, port } }   // → deploy's environment prop and Deployment.port (the edges)
        }),

      // Print the bootstrap (address + boot import baked in) and assemble the
      // deployable artifact from the build adapter's normalized bundle dir:
      // bootstrap.js + compute.manifest.json beside the app's entry + wrapper,
      // deterministic tar.gz. The whole envelope is the pack's — target vocabulary.
      package: ({ id }, { assembled, address }) =>
        Effect.gen(function* () {
          // bootstrap.js: `import main from "./main.js"; await main.run(${JSON.stringify(address)}, () => import(${JSON.stringify(assembled.entry)}))`
          return { path: `…/${id}.tar.gz`, sha256: "…" }
        }),

      // A specific BUILD into the place: version → upload → start → promote. The
      // environment prop references serialize's env-var records, so the version
      // depends on them (the edge that kills PRO-211). deployedUrl is read
      // post-promote — the create-time domain is a placeholder (PRO-200).
      deploy: ({ id }, provisioned, artifact, serialized) =>
        Effect.gen(function* () {
          const deploy = yield* Prisma.Deployment(`${id}-deploy`, {
            computeServiceId: provisioned.outputs.serviceId,
            artifactPath: artifact.path,
            artifactHash: artifact.sha256,
            environment: serialized.outputs.environment,
            // Route to the port the app actually binds (resolved by serialize),
            // not a hardcoded constant.
            port: typeof serialized.outputs.port === "number" ? serialized.outputs.port : 3000,
          })
          return { outputs: { url: deploy.deployedUrl, projectId: provisioned.outputs.projectId } }
        }),
    },
  },
})
```

There is **no public runtime entry**: the boot loop rides on the node itself
(`compute()` returns the runnable subclass; `.run(address, boot)` + `.load()` are
the whole thing), so the wrapper bundle carries the runtime with a single copy of
core and the bootstrap needs nothing but `./main.js` and a dynamic import of the
app's entry. (A missing client factory is impossible by construction —
the dependency shapes of `postgres()` require `client` at compile time.)

## The build adapter — worked instances

A build adapter is a two-piece package: a **lean authoring descriptor** carried on
the service node, and a **heavy deploy-side assembler** invoked at `package` time.
The assembler normalizes the app's own build output into a bundle dir with the
framework wrapper, and reports the runtime entry path.

```ts
// @prisma/composer/node — the authoring descriptor (lean; rides in service.ts). `entry`
// resolves relative to dirname(module) — exactly like an import specifier.
// `pack` is baked in by this factory, not passed by the caller — the same
// uniform rule a node's own `pack` follows (ADR-0003).
export default (opts: { module: string; entry: string }): BuildAdapter =>
  ({ kind: "node", pack: "@prisma/composer/node", module: opts.module, entry: opts.entry })

// @prisma/composer/nextjs — carries an extra `appDir` (the Next app's root, the
// standalone layout root), also resolved relative to dirname(module). `entry`
// is a bare filename inside the standalone output dir.
export default (opts: { module: string; appDir: string; entry: string }): NextjsBuildAdapter =>
  ({ kind: "nextjs", pack: "@prisma/composer/nextjs", module: opts.module, appDir: opts.appDir, entry: opts.entry })

// @internal/assemble — routes each service to its adapter's `/assemble` via
// `${build.pack}/assemble` (entry-anchored, same resolver the pack CLI seam
// uses for `${pack}/target`) — never a hardcoded kind→package map.
// @prisma/composer-<adapter>/assemble — the deploy-side assembler (heavy; deploy machine)
// Produces the normalized bundle dir + the runtime entry path for the bootstrap.
// No serviceDir/serviceModule input: the descriptor's own `module` is the anchor.
interface Assembler {
  assemble(input: AssembleInput): Promise<Bundle>  // { build } → { dir, entry } — @prisma/composer/deploy's shared seam contract
}
```

`node`'s assembler is trivial: place the app's built entry and the framework's wrapper
(`service.ts` bundled to `main.mjs`, core inlined, entry left to a runtime dynamic
import) in one dir; report the entry. `nextjs`'s assembler does the Next-standalone
fixups — copy the hoisted `node_modules`, `.next/static`, `public`, and a
`bunfig.toml` that disables bun's runtime auto-install (PRO-213) — then the same
wrapper placement. Both share the identical runtime shape:
`run(address, () => import(entry))`; only the assembly differs. New frameworks or
access patterns (cron, static, queue consumer) are new adapters here, and nothing
on the service node or in core changes.

## The app, end to end

A plain (self-served) service — Hono on Bun. The service module is declarations
only; the app writes and bundles its own entry:

```ts
// src/service.ts — the authored service: name + deps + build + where it lives.
// No handler, no driver. `db` is a DEPENDENCY (a slot): `postgres()` requires
// postgresContract and never provisions anything — the composing module owns the
// database and wires its ref in. Its binding is `PostgresConfig` ({ url }); the
// app builds its own client in server.ts (ADR-0015).
import { compute, postgres } from "@prisma/composer-prisma-cloud"
import node from "@prisma/composer/node"

const db = postgres()

export default compute({
  name: "hello",                                // ADR-0006: every node named
  deps: { db },
  // ADR-0004: module anchors entry's resolution — dirname(module) is src/, so
  // "../dist/server.js" reaches the app's build output. Inert at runtime.
  build: node({ module: import.meta.url, entry: "../dist/server.js" }),
})

// src/module.ts — the app root: the module OWNS the database. It provisions the
// identity `postgres({ name })` and wires its ref into the service's slot (the
// contract matches); its name names the app (ADR-0006).
import { module } from "@prisma/composer"
import { postgres } from "@prisma/composer-prisma-cloud"
import service from "./service.ts"

export default module("hello", (h) => {
  const db = h.provision("db", postgres({ name: "db" }))
  h.provision("hello", service, { db })
})

// src/server.ts — the app's OWN entrypoint. The app bundles this to dist/server.js
// (its own bundler). It pulls the bindings from the service and builds its
// client from the postgres binding (ADR-0015), with its own driver.
import { SQL } from "bun"                        // the APP's choice of client
import service from "./service"

const { db, port } = service.load()             // db: PostgresConfig ({ url }); port: number
const sql = new SQL({ url: db.url })             // module-scoped: one pool per process
Bun.serve({ port, hostname: "0.0.0.0",
  fetch: async () => Response.json(await sql`select 1 as ok`) })

// There is no deploy config file (ADR-0003). The app builds itself first
// (its own bundler produces dist/server.js), then:
//
//   prisma-composer deploy src/module.ts
//
// The CLI infers the target pack from the nodes, constructs it from the
// environment (the pack's /target fromEnv() reads PRISMA_WORKSPACE_ID), runs
// each service's assembly, and drives Alchemy — no bundle map, no stack file.
```

`service.load()` is typed end to end by the chain `postgres()` →
`PostgresConfig` → `compute({ deps: { db } })` captures `{ db: PostgresConfig }` →
`load()` returns it, and the app types its own `sql` from `db.url`. The app never
annotates a dependency type. Note where Bun appears: only in `server.ts` (the
`new SQL` client and `Bun.serve`, the app's own entry) — the app's choice, since
it deploys to a Bun runtime. Switching the client to node-postgres, or the app to
a Node platform, changes these app lines and nothing in the framework.

And note what a test needs: build the service with fake deps and call `load()` —
or, since `load()` reads the stash, hydrate directly against injected `Config`. No
environment, no cloud, no pack internals. That is the dependency inversion the
model promises. The config round-trip is proven separately at the pack level
(serialize → deserialize identity).

### Two services, connected — the module (a framework-hosted consumer)

The storefront-auth shape: `auth` is a self-served Hono service shaped like the
one above — its `db` is a `postgres()` dependency whose binding is the config
its own server builds a client from, while the composing module below owns and
provisions the database; `storefront` is a **framework-hosted**
Next.js service whose page pulls the `auth`
client via `load()`. This replaces the hand-written mixed stack — the URL plumbing,
the `requireStringOutput` guard, and the hand-named `EnvironmentVariable` all
disappear into core's sequencing.

```ts
// storefront/src/service.ts — declares the dependency; never learns how the URL arrives
import { compute, http } from "@prisma/composer-prisma-cloud"
import nextjs from "@prisma/composer/nextjs"
const auth = http({ name: "auth" })
export default compute({ name: "storefront",
  deps: { auth },
  build: nextjs({ module: import.meta.url, appDir: "..", entry: "server.js" }) })

// storefront/app/page.tsx — the app's own Next code; `next build` bundles it.
// It pulls the typed auth client via load() — the SAME mechanism the Hono entry
// uses. force-dynamic keeps it out of build-time prerender (no run() then).
import service from "../src/service"
export const dynamic = "force-dynamic"
export default async function Home() {
  const { auth } = service.load()               // auth: HttpClient — inferred
  const res = await auth.fetch("/verify")
  return <p>Auth /verify says: {res.status} {await res.text()}</p>
}

// app.ts — the app's module: transparent wiring, runs at Load. It owns the shared
// Postgres — provisioned once here, wired into auth's slot. Its name becomes
// the application (Project) name; each service's build adapter carries its own
// authoring module (BuildAdapter.module), so a module can compose services that
// live in entirely different directories.
import { postgres } from "@prisma/composer-prisma-cloud"
import authService from "./modules/auth/src/service"
import storefrontService from "./modules/storefront/src/service"
export default module("storefront-auth", (h) => {
  const db = h.provision("db", postgres({ name: "db" }))
  const authRef = h.provision("auth", authService, { db })         // db→auth dependency edge
  h.provision("storefront", storefrontService, { auth: authRef })  // auth→storefront dependency edge
})

// No deploy config file (ADR-0003): build both apps, then
//   prisma-composer deploy app.ts
```

At deploy, core sequences: the db resource (lowered once) → auth provision →
auth deploy (URL now real) → storefront
provision → build the storefront's `Config` (auth's deploy URL fills the
`auth.url` leaf) → `serialize` (the pack encodes it under its address-prefixed
keys) → `nextjs` assembler → package → storefront deploy — the first VM boots with
its config present. At boot, `bootstrap.js` calls `main.run(address, () =>
import("./server.js"))`: `run` deserializes the storefront's env, re-emits it under
address-free stash keys, then boots the Next server; the page's `service.load()`
reads the stash and hydrates the `auth` leaf — a protocol-owned kind, so its
binding IS a client (ADR-0015), unlike the Hono entry's `db`, whose binding is
the typed config it builds its own client from. Neither entry can tell a service
producer from a resource — one mechanism.

## Invariants (enforced, not aspirational)

1. **Core has no target dependency**: `@prisma/composer`'s `package.json` depends on
   neither `@internal/lowering` nor any `prisma-*` package — checked by a test.
2. **Authoring imports stay lean**: bundling a module that imports `@prisma/composer`,
   `@prisma/composer-prisma-cloud`, and a build-adapter descriptor (authoring entries
   only) contains no `alchemy`/`effect`/`prisma-alchemy`/`new SQL(`/`node:fs`
   tokens — the import-split guard test, extended to the pack and the adapters'
   descriptor entries. The adapters' `/assemble` entries are deploy-only and
   exempt.
3. **Importing runs nothing**: constructing nodes is pure; only the node's
   `run`/`load` and the alchemy CLI execute anything. This reaches the artifact:
   the service module is a pure declaration, the framework's wrapper is inert on
   import, and the pack-printed bootstrap is the only runnable code the
   framework adds.
4. **Core and user code contain zero direct environment reads.** The pack's `run`
   (deserialize + stash) and `load` (read stash) are the single sanctioned readers
   for its platform — `process.env` appears only inside the pack's config
   serializer; a local test injects fakes and reads nothing. Core's shape,
   Config-building, and `hydrate` never touch an environment.
5. **No runtime coupling**: neither core nor a target pack nor a build-adapter
   descriptor imports Bun or Node APIs — even type-only — in its shipped surface
   (the [runtime-agnostic principle](../01-principles/architectural-principles.md)).
   Drivers and server APIs enter only from app files; the adapters' `/assemble`
   entries may use `node:fs` (deploy machine only); the import-guard test extends
   to `"bun"`/`node:` tokens for every execution-plane entry.

## Extension points (designed for, not yet built)

- **Build-adapter ecosystem** — `node` and `nextjs` are the first two; the
  descriptor/assembler split is the seam for community adapters (Nuxt, TanStack
  Start, a cron access-pattern, a static site). Each is a package; nothing in
  core, the target pack, `@internal/assemble`, or the CLI changes to add one —
  the assembler seam resolves `${build.pack}/assemble` from the descriptor
  itself (deploy-cli.md § Contracts), the same way the pack CLI seam resolves
  `${pack}/target`.
- **Framework-hosted DI is `load()`** — the Next page pulls its typed deps via
  `service.load()`, the same mechanism the Hono entry uses. No separate `use()`
  accessor is needed; the earlier framework-DI gap is closed by `load()`.
- **Typed connection interfaces — shipped as Contracts.** A service-to-service
  dependency is declared against a Contract (`@prisma/composer/rpc`'s `contract()` +
  `rpc()`), compatibility is checked at the wiring site, at Load
  (`satisfies()`), and per call, and the consumer's `load()` returns a typed
  client. `http()` remains the untyped escape hatch. The mechanism — including
  `expose` on the service node, ref-ports on `provision()`'s return, and
  `serve()` — is documented in
  [`connection-contracts.md`](connection-contracts.md); this document's type
  sketches predate it and show the pre-contract shapes.
- **Full Module composition** — the minimal module wires services; boundary ports
  (a module's own Inputs/Outputs), nesting, and forwarding per the authoring-surface
  design come next. Services stay opaque leaves.
- **Runtime name lookup** — if the platform gains service-name resolution, the
  pack's `serialize` becomes a no-op and its connection hydrate resolves by name;
  consumers are unchanged (they never learned how the address arrived).
- **Deterministic framework artifacts** — the single-service (tsdown) build is
  byte-deterministic; the Next standalone case embeds a per-build `BUILD_ID`, so a
  Next service may re-version on redeploy even when unchanged. A deterministic
  standalone assembly (fixed ids/mtimes) is the follow-up for a true no-op redeploy.
- **Serialized topology** — the topology view of Graph is already JSON-safe; an emit
  step for external tooling is additive.

## Related

- [`../03-domain-model/core-and-targets.md`](../03-domain-model/core-and-targets.md) — the architectural split this implements.
- [`../03-domain-model/authoring-surface.md`](../03-domain-model/authoring-surface.md) — the developer-facing narrative.
- [`../03-domain-model/layering.md`](../03-domain-model/layering.md) — Alchemy as the provisioning plane (claim 3).
- [`config-params.md`](config-params.md) — the config param model this document sketches, in full, resting on
  [ADR-0018](../90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md) and
  [ADR-0019](../90-decisions/ADR-0019-the-target-owns-config-serialization.md).
