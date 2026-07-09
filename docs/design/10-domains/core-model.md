# Core model — classes and data structures

The complete type-level design of `@makerkit/core` and the target-pack contract,
with `@makerkit/prisma-cloud` as the worked instance. This is the implementation
design under [`core-and-targets.md`](../03-domain-model/core-and-targets.md): that
doc says *what* the split is; this one says exactly *which types exist, what fields
they carry, and who imports what*. Scope: the current model — Services with
Resource inputs, service-to-service **Connections**, the minimal **Hex** that
wires them, and the **build adapter** that turns a service's app into a runnable
artifact; typed interfaces and full Hex composition are named extension points.

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
  the stash and returns the service's dependencies, hydrated and **typed**. No
  address, no environment keys, no framework knowledge.

Because the entry always runs inside `run()`'s process, `run()` executes first and
`load()` reads what it left — the two never coordinate through anything the app
author sees. MakerKit never bundles the app's code; it only produces a small
wrapper around the app's built entry and packages it for the target.

## Package and entry map

Six entry points, split by dependency weight. The split is enforced, not
aspirational (see § Invariants).

Entries map onto MakerKit's **four planes**. Entry names say *when you import
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
transforms when Hexes arrive), it carves out of `.` into `@makerkit/core/control`.
The boundary is decided; only the carve is deferred.

| Entry | Exports | Imports (weight) |
| --- | --- | --- |
| `@makerkit/core` | node factories (`service`, `resource`, `connectionEnd`, `hex`), `Load`, `configOf`, `hydrate`, `BuildAdapter` type, model types (incl. `Config`) | nothing |
| `@makerkit/core/deploy` | `lower()`, `lowering()`, `Target` types | `alchemy`, `effect` |
| `@makerkit/prisma-cloud` | `compute()` (declares a service; carries `run`/`load`), `postgres({ client })`, `http()` | `@makerkit/core` only |
| `@makerkit/prisma-cloud/target` | `prismaCloud()` | `@makerkit/prisma-alchemy`, `alchemy`, `effect` |
| `@makerkit/node` · `@makerkit/nextjs` (build adapters) | `node()` · `nextjs()` — the authoring **descriptor** (lean, rides in `service.ts`) | `@makerkit/core` only |
| `@makerkit/node/assemble` · `@makerkit/nextjs/assemble` | the deploy-side assembler (called by `package`) | `node:fs`/framework tooling — deploy machine only |

A build adapter splits exactly like a target pack: a **lean authoring descriptor**
that the service module carries (pure data — `{ kind, entry }`), and a **heavy
deploy-side assembler** invoked once at deploy on the build machine. The descriptor
rides into every bundle that imports `service.ts`; the assembler never does.

Per the [runtime-agnostic
principle](../01-principles/architectural-principles.md), no execution-plane entry
imports Bun or Node APIs — not even type-only. Runtime-specific code (the DB
driver, the server API) appears only in **app files**.

Who imports what, end to end:

- the **user's service module** (`service.ts`) imports `@makerkit/prisma-cloud`, a
  build-adapter descriptor (`@makerkit/node` / `@makerkit/nextjs`), and the app's
  own driver of choice (a DB client factory lives inline here). It exports the
  service node and **nothing runs on import**;
- the **user's entrypoint** (`server.ts`, or a Next page) imports the service
  module and calls `service.load()` for typed deps. The app author writes AND
  bundles this file (their bundler, or `next build`) — MakerKit never touches it;
- the **deploy entry is the app module itself** — there is no config file
  (ADR-0003). `makerkit deploy <entry>` imports it, infers the target pack from
  the nodes, and constructs the target from the environment via the pack's
  `/target` `fromEnv()` — the only place the heavy target import happens — then
  calls `@makerkit/core/deploy`'s `lower()` internally. The app author writes no
  stack file and no config file — `makerkit deploy` generates one at
  `.makerkit/alchemy.run.ts` per run and drives it; see
  [`deploy-cli.md`](deploy-cli.md).

At deploy, the build adapter's assembler produces a **normalized bundle dir**: the
app's built entry, plus a MakerKit **wrapper** (the service module bundled with
core inlined once — it carries `run`/`load`), plus any framework fixups. The
target pack's `package` then prints the bootstrap and wraps that dir in the target
envelope. The wrapper never contains Alchemy; the app's entry is never compiled by
MakerKit.

## Decision taken: Alchemy is core's provisioning substrate

`@makerkit/core/deploy` imports `alchemy`/`effect`. The architectural principle
forbids core knowledge of **deployment targets** (Prisma Cloud); Alchemy is not a
target — it is the provisioning plane [`layering.md`](../03-domain-model/layering.md)
already commits to (claim 3: MakerKit uses Alchemy's definition language *and*
engine). Putting the engine in core means every target pack supplies only data
(providers + lowerings) instead of re-implementing apply/state. The swap test still
holds: replacing `@makerkit/prisma-cloud` with another pack changes nothing in core.

## The three execution paths

Everything the system does happens on one of three paths. On every path **core is
the only actor**; the pack and the build adapter contribute tools that satisfy an
SPI and never see the graph, never sequence anything, never call another tool.

| Path | Where it executes | Core does (the actor) | Pack / adapter tools used |
| --- | --- | --- | --- |
| **provision** | deploy machine, via Alchemy | provision the application once (Project + poison vars), then walk the DAG realizing each service's host | `Target.application.provision`, then `ServiceLowering.provision` → identity (App) |
| **deploy** | deploy machine, via Alchemy | build each service's typed `Config`, have the pack encode it *first*, assemble via the build adapter, then ship the build | `ServiceLowering.serialize`, the **build adapter's `assemble`**, then `package` + `deploy` |
| **run** | inside the bundle, in the VM | provide `hydrate` (typed `Config` → clients); the node's `run` resolves + stashes config and boots the entry, the node's `load` hydrates on demand | the node's `run` / `load`, each connection's `hydrate` |

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
entry, `load()` reads the stash and hands back hydrated, typed dependencies. The
deploy path's `serialize` and the run path's deserialize use the pack's **one
shared serializer**, so writer and reader cannot drift.

## Core model types (`@makerkit/core`)

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
const NODE: unique symbol = Symbol.for("makerkit:node") as never

interface NodeBase {
  readonly [NODE]: true
  readonly kind: "service" | "resource" | "connection"
  readonly type: string                        // routing key, e.g. "prisma-cloud/postgres"
}
// HexNode is deliberately NOT a NodeBase: it has no routing `type` — it is
// transparent wiring, not a routable thing (see § Nodes).

// ——— Configuration model (core owns structure; the pack owns encoding) ———
//
// Split by ownership (see § Runtime):
//   · CORE — the config SHAPE (declarations: names + runtime type tags,
//     target-independent, no platform keys) and the typed `Config` VALUE it
//     builds from the graph at deploy and consumes (hydrate) at boot.
//   · PACK — encoding: serialize the typed Config into env strings at deploy,
//     deserialize the identical typed Config back at boot. The pack owns both
//     ends through one serializer, so writer and reader cannot drift; core never
//     sees a platform key or a string.

// Runtime-validatable param types. Curated; extended consciously.
type ParamType = "string" | "number"
type TypeOf<T extends ParamType> = T extends "string" ? string : number

// A declared config param — pure data. The declaration does double duty: the
// pack validates raw values against `type` at boot, and TypeScript derives the
// hydrate/load input types from it — the definition object ENFORCES the final
// param input types.
interface ConfigParam<T extends ParamType = ParamType> {
  readonly type: T
  readonly secret?: boolean                    // redacted in any introspection output
  readonly optional?: boolean
  readonly default?: TypeOf<T>
}
type Params = Record<string, ConfigParam>
type Values<P extends Params> = {              // what implementations receive
  readonly [K in keyof P]: TypeOf<P[K]["type"]>   // (| undefined when optional with no default)
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
// adapter and the built-entry location, RELATIVE to the service dir — never an
// absolute or machine path. The heavy ASSEMBLER (fs, framework tooling) is looked
// up by `kind` at deploy and never ships in a bundle (§ Lowering, § Extension).
interface BuildAdapter {
  readonly kind: string                        // "node" · "nextjs" — the assembler routing key
  readonly entry: string                       // built runnable, service-dir-relative (e.g. "dist/server.js")
}

// ——— Nodes ———

// A Resource a service depends on, carrying its connection face. C flows from
// the connection's hydrate return type into the loaded dependency.
interface ResourceNode<C = unknown> extends NodeBase {
  readonly kind: "resource"
  readonly connection: Connection<Params, C>
}

// A Service: inputs + its own declared params + how it is built. This IS the
// user's default export — inspectable (inputs/type/params/build), inert until run.
// It carries NO handler; the app's entry is the code that serves. The BASE node is
// not runnable: booting needs a target's environment knowledge, so the pack's
// factory returns a runnable/loadable subclass that adds `run`/`load` (§ Runtime).
interface ServiceNode<D extends Deps = Deps, P extends Params = Params> extends NodeBase {
  readonly kind: "service"
  readonly inputs: D
  readonly params: P                           // service-level config (e.g. port) — no special "context" concept
  readonly build: BuildAdapter                 // how the app's entry is built + assembled
}

// A service-to-service dependency end. Sits in a Deps slot like a ResourceNode,
// but nothing is provisioned FOR it — at deploy it becomes an EDGE to the
// producer service the enclosing hex wires it to; at run it hydrates a client
// through exactly the same Connection machinery as a resource. The consumer
// never learns HOW the producer's address reached it (written env var today;
// runtime name lookup later would change only pack internals).
interface ConnectionEnd<C = unknown> extends NodeBase {
  readonly kind: "connection"
  readonly connection: Connection<Params, C>
}

// Dependency map: name → what the service consumes. Loaded types are inferred
// from each entry's hydrate return type — identical mechanics for both kinds.
type Deps = Record<string, ResourceNode<any> | ConnectionEnd<any>>

// A Hex: transparent wiring, no code of its own. The body runs at Load (it is
// wiring, not user code) and provisions the services it owns, supplying a
// producer for every ConnectionEnd input. Minimal form — boundary ports and
// nesting arrive with full Hex composition (see § Extension points).
interface HexNode {
  readonly [NODE]: true
  readonly kind: "hex"
  readonly name: string
  body(h: HexBuilder): void
}
interface HexBuilder {
  // Registers an owned service under a stable id; `wiring` satisfies the
  // service's ConnectionEnd inputs with previously provisioned producers.
  provision(id: string, service: ServiceNode<any, any>,
            wiring?: Record<string, ProvisionedRef>): ProvisionedRef
}
type ProvisionedRef = { readonly id: string }   // opaque handle within the hex body

type Hydrated<N> =
  N extends ResourceNode<infer C> ? C : N extends ConnectionEnd<infer C> ? C : never
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
// @makerkit/core
function resource<P extends Params, C>(def: {
  type: string
  connection: Connection<P, C>
}): ResourceNode<C>

function service<D extends Deps, P extends Params>(def: {
  type: string
  inputs: D
  params: P
  build: BuildAdapter
}): ServiceNode<D, P>   // the pack wraps this and returns its runnable/loadable subclass

function connectionEnd<P extends Params, C>(def: {
  type: string
  connection: Connection<P, C>
}): ConnectionEnd<C>

function hex(name: string, body: (h: HexBuilder) => void): HexNode   // body runs at Load, not here
```

`service()` freezes `inputs`/`params`/`build`; `resource()` freezes the
connection's declared params. Both throw on an empty `type`. Nothing executes:
constructing nodes is pure. The pack's authoring factory (`compute()`) calls
`service()` and returns a subclass carrying `run` and `load`.

## Graph and Load (`@makerkit/core`)

```ts
type NodeId = string           // path-derived: root "hello", its input "hello.db"

interface GraphNode { readonly id: NodeId; readonly node: ServiceNode | ResourceNode }
interface Edge { readonly from: NodeId; readonly to: NodeId; readonly input: string }
                               // resource → service, labeled with the input name

interface Graph {
  readonly root: GraphNode
  readonly nodes: readonly GraphNode[]     // root + one per input, topo-ordered (deps first)
  readonly edges: readonly Edge[]
}

function Load(root: ServiceNode, opts?: { id?: NodeId }): Graph   // throws LoadError
class LoadError extends Error {}
```

Load accepts a service or a hex root. For a service it walks `root.inputs`, assigns
ids, builds edges. For a hex it **executes the body** (the body is wiring, not user
code — running it at Load is the designed exception to imports-run-nothing) with a
collector `HexBuilder`, producing the owned services and one **connection edge**
per wired ConnectionEnd input. Edges carry a kind: `input` (service consumes a
resource) or `connection` (service calls a service). Validation: every node
branded with a non-empty `type`; every ConnectionEnd input of a provisioned
service **wired to a provisioned producer** (dangling connection = LoadError); the
connection edges form a **DAG** (a cycle is a LoadError with the cycle named — a
consequence of address-at-deploy-time wiring: if A needs B's address to deploy and
B needs A's, neither can go first). A lone service Loaded outside any hex may have
unwired ConnectionEnds — connectedness is a topology-level check; booting it
unwired still fails loudly through the ordinary missing-config path. Load
executes nothing of the user's — the graph is data in memory to inspect or hand to
`lower` (or the node's `run`). A **topology view** — nodes as `{ id, kind, type }`
plus edges, function slots dropped — is `JSON.stringify`-able by construction; the
serialized-artifact emit step builds on this later.

## Lowering (`@makerkit/core/deploy`)

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
}

// The application's shared infrastructure: on Prisma Cloud, the one Project
// (the config namespace and lifecycle boundary) plus the poison DATABASE_URL
// variables. Its outputs (projectId) reach every later SPI call via
// LowerContext.application.
interface ApplicationLowering {
  provision(ctx: LowerContext): Effect.Effect<LoweredNode, unknown, unknown>
}

// The phased service SPI — the seam between the phases belongs to CORE.
interface ServiceLowering {
  // provision: make the target-specific thing that will host the service —
  // identity-bearing infrastructure only (the App), inside the application's
  // Project (ctx.application); no code runs.
  provision(ctx: LowerContext): Effect.Effect<LoweredNode, unknown, unknown>
  // serialize: encode the typed Config core built into the service's runtime
  // environment (on Prisma Cloud: EnvironmentVariables on the project), keyed by
  // the deployment address. The pack owns the encoding; run()'s deserialize
  // reverses it through the same serializer, so writer and reader cannot drift.
  // Leaf values are provisioning refs → the env writes depend on the
  // resources/producer (the ordering edges). Returns the env-var records so
  // `deploy` can reference them (the environment edge — see alchemy-lowering.md).
  serialize(ctx: LowerContext, provisioned: LoweredNode, config: Config):
    Effect.Effect<LoweredNode, unknown, unknown>
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
  // via the Deployment's environment prop (the edge). Returns the trustworthy URL.
  deploy(ctx: LowerContext, provisioned: LoweredNode, artifact: Artifact,
         serialized: LoweredNode): Effect.Effect<LoweredNode, unknown, unknown>
}

// package input: the build adapter's assembled output plus the address. The
// bootstrap the pack prints is the ONLY runnable MakerKit adds to the artifact.
// It imports the wrapper and calls run with the address AND a boot thunk that
// imports the app's built entry — a printed, literal dynamic import of a runtime
// path (never a bundled reference, so no bundler ever follows it):
//   import main from "./main.js"
//   await main.run("<address>", () => import("./server.js"))
// The entrypoint takes its deployment identity as a parameter; deploy is the
// caller. The pack owns the printer and the node owns run(), so any
// environment-specific data passes through this closed channel.
interface PackageInput {
  readonly assembled: AssembledBundle   // the build adapter's product (dir + entry)
  readonly address: string              // the node's graph address — baked into the bootstrap
}

// One node's realization. Runs inside the Alchemy stack effect; yields the
// pack's Alchemy resources. Core never looks inside.
type Lowering = (ctx: LowerContext) => Effect.Effect<LoweredNode, unknown, unknown>

interface LowerContext {
  readonly id: NodeId
  readonly address: string                              // the node's deployment address (graph position);
                                                        // the config-key namespace and the bootstrap parameter
  readonly node: ServiceNode | ResourceNode
  readonly graph: Graph
  readonly opts: LowerOptions
  readonly application: LoweredNode                     // the application provision's outputs
  readonly lowered: ReadonlyMap<NodeId, LoweredNode>    // already-lowered deps (topo order)
}

// What a lowering hands downstream — e.g. a deployed URL a later node's env
// wiring consumes. The inter-node config-wiring hook for Connections.
interface LoweredNode { readonly outputs: Readonly<Record<string, unknown>> }

interface LowerOptions {
  readonly name: string                                  // stack name (+ root id for a service root)
  // `makerkit deploy` runs each service's build-adapter assembler and writes
  // the resulting bundle dirs here, into the generated stack file it hands to
  // `lower()` — keyed by provision id (service root: `bundle`; hex root:
  // `bundles`). A hand-composed / mixed-stack caller (the escape hatch — see
  // § Lowering) supplies these itself.
  readonly bundle?: Bundle
  readonly bundles?: Record<string, Bundle>
  readonly stage?: string
  readonly state?: AlchemyStateLayer                     // default: localState(); the
                                                         // hosted-state store slots in here
}
interface Bundle { readonly dir: string }                            // an assembled bundle dir
interface AssembledBundle { readonly dir: string; readonly entry: string }  // adapter product: dir + runtime entry
interface Artifact { readonly path: string; readonly sha256: string }       // package()'s product

// Load → route each node through target.lower[node.type] → an Alchemy Stack
// (the default export the alchemy CLI consumes). Unknown type → LowerError
// naming the type and the target's known types.
function lower(root: ServiceNode, target: Target, opts: LowerOptions): AlchemyStack
class LowerError extends Error {}

// Composable form — for MIXED topologies: MakerKit-authored nodes beside
// hand-wired Alchemy resources in one stack. Runs the same Load → route walk
// inside the caller's stack effect and returns the root's LoweredNode, whose
// outputs (e.g. the deployed URL) hand-wired resources may consume.
// Error channel: LowerError from routing, PLUS whatever a pack lowering fails
// with (their error type is open) — a mixed-stack caller treats failures as
// deploy-fatal or inspects; it must not assume LowerError is the only inhabitant.
function lowering(root: ServiceNode, target: Target, opts: LowerOptions):
  Effect.Effect<LoweredNode, LowerError, unknown>
```

`lower()` is nothing but the whole-stack wrapper:
`Alchemy.Stack(opts.name, { providers: target.providers(), state: opts.state ?? localState() }, lowering(root, target, opts))`
— Alchemy requires a state layer; local state is the default and a hosted store is
config, not a code change. Two type-level notes the wrapper carries (both commented
at the single site): a `LowerError` is fatal at deploy (`Effect.orDie`), and the
effect's requirements channel is narrowed to what `Alchemy.Stack` accepts —
`lowering()` itself stays `unknown`-requirements for composability.
In the mixed case the hand-written stack supplies providers itself (including the
target's, via `target.providers()`), yields a `lowering(…)` per MakerKit-authored
service, and wires its own resources around the returned `outputs`.

**Core's deploy-path sequencing** — the control flow no pack can misorder.
First, `application.provision` runs once (the Project, with the poison
`DATABASE_URL` variables). Then walk services in topological order over the
connection edges (the DAG Load validated); for each service:

1. Lower its resource inputs via `Target.resources` (e.g. the service's own
   Database + Connection — outputs carry the url).
2. `provision` — the service now has identity (its App).
3. core **builds the typed `Config`** — each input's declared params matched by
   name to the lowered outputs: resource params from the resource lowering, and
   wired ConnectionEnd params from the **producer's deploy outputs** (the
   producer, earlier in topo order, is already fully deployed — its URL is real,
   not the create-time placeholder) — plus service-param defaults. Leaf values
   are provisioning refs, not strings.
4. `serialize(config)` — the pack encodes that typed Config into the service's
   runtime environment (Prisma Cloud: one env write per leaf, keyed by the
   pack's own naming from the address, value = the ref). Never the platform default.
5. `package({ assembled, address })` — the build adapter's assembler has produced
   the normalized bundle dir; the pack prints the bootstrap (address + boot import
   baked in, § below) and wraps it in the target envelope.
6. `deploy(artifact)` — the first version snapshots an environment that is already
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
graph position — never user-invented, so registry hexes with common internal
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
main.js                ← MakerKit wrapper: the service module bundled, core inlined ONCE. Inert on import.
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
module. Every byte is deterministic — the app's built entry, the MakerKit wrapper,
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
- **The app owns its entry; MakerKit owns the wrapper.** The app builds its own
  entry (`server.js` via its bundler; the Next standalone via `next build`); the
  build adapter's assembler normalizes it into a bundle dir alongside the MakerKit
  wrapper, and the pack's `package` prints the bootstrap and tars. Core still has
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
  knowledge; the app entry sees typed clients. Memoization means one client set per
  process (or per forked worker), created on first `load()`.
- **`configOf(root)`** and **core's `hydrate`** — the shape enumeration and the
  Config→clients step both `run` and `load` build on. Pure, target-independent.

```ts
// The enumerable config surface of a service — derivable from the graph alone,
// nothing booted, no platform keys. The introspection artifact (secrets marked,
// values absent). Physical locations are the pack's business.
interface ConfigDeclaration {
  readonly owner: "service" | { readonly input: string }
  readonly name: string              // "url" · "port"
  readonly type: ParamType
  readonly secret: boolean
  readonly optional: boolean
  readonly default?: string | number
}
function configOf(root: ServiceNode): readonly ConfigDeclaration[]   // in @makerkit/core (pure)

// Core's boot-side helper: given a service and a concrete typed Config, hydrate
// every input (connection.hydrate with its value slice) into typed clients. No
// environment read, no strings — the pack already reversed its own encoding into
// a typed Config. Used by the node's load().
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
or redact by the `secret` flag on the shape — and `configOf` keeps the config
surface enumerable without booting.

**Config validation is the pack's, because it is the pack reversing its own
serialization.** "Is this value present and the right type" is exactly the check
`deserialize` must pass to reconstruct the typed `Config` it once wrote; core
defines the shape that check is against. A missing or unparseable value is the
pack failing loudly at boot. `load()` called before `run()` has stashed (e.g. a
Next page prerendered at build time, with no `run()` in the process) fails loudly
too — pages that call `load()` opt out of build-time prerender (`force-dynamic`),
and local dev supplies the stash through a dev harness.

## The Prisma Cloud pack (`@makerkit/prisma-cloud`) — worked instance

Authoring entry — nodes carrying their connection/host knowledge; the driver is a
**parameter**, so the pack ships none and the client type is inferred:

```ts
import { resource, service, connectionEnd, configOf, hydrate,
  type BuildAdapter, type Config, type ConfigDeclaration, type Connection, type Deps,
  type Loaded, type ResourceNode, type ConnectionEnd, type RunnableServiceNode } from "@makerkit/core"

export interface PostgresConfig { readonly url: string }

// The app supplies the client factory; C is inferred from its return type.
export const postgres = <C>(opts: { client: (config: PostgresConfig) => C | Promise<C> }): ResourceNode<C> =>
  resource({
    type: "prisma-cloud/postgres",
    connection: {
      params: { url: { type: "string", secret: true } },
      hydrate: (v) => opts.client({ url: v.url }),   // v: { url: string } — enforced by the declaration
    },
  })

// A service-to-service dependency. Default client is a thin URL-anchored fetch
// wrapper (fetch is standard across runtimes — no driver, no runtime coupling);
// an app factory can replace it. The typed generated client arrives with the
// interface primitive (§ Extension points).
export interface HttpClient { readonly url: string; fetch(path: string, init?: RequestInit): Promise<Response> }
export const http = <C = HttpClient>(opts?: { client?: (cfg: { url: string }) => C }): ConnectionEnd<C> =>
  connectionEnd({
    type: "prisma-cloud/http",
    connection: {
      params: { url: { type: "string" } },
      hydrate: (v) => (opts?.client ?? defaultHttpClient)({ url: v.url }),
    },
  })

const computeParams = { port: { type: "number", default: 3000 } } as const

// compute() declares a service — deps + build — and returns the pack's RUNNABLE
// subclass carrying run()/load(). It takes NO handler: the app's entry is the
// code that serves. run() is the only environment reader in the pack; load()
// hydrates from the stash run() left.
export const compute = <D extends Deps>(def: {
  deps: D
  build: BuildAdapter
}): RunnableServiceNode<D, typeof computeParams> => {
  const node = service({
    type: "prisma-cloud/compute", inputs: def.deps, params: computeParams, build: def.build,
  })
  let loaded: Loaded<D, typeof computeParams> | undefined   // per-process memo for load()
  return Object.freeze({
    ...node,
    // Controller: resolve config from the address-keyed env, re-emit it under
    // address-free keys (the stash), then boot the app's entry.
    async run(address: string, boot: () => Promise<unknown>) {
      stash(deserialize(configOf(node), address))   // the pack's ONE env read + coercion → address-free env
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
const stash = (config: Config): void => { /* re-emit under address-free keys, the medium the framework's forks inherit */ }
```

Target entry — the lowering table (the only place `prisma-alchemy` is imported):

```ts
import * as Effect from "effect/Effect"
import * as Prisma from "@makerkit/prisma-alchemy"
import type { Target } from "@makerkit/core/deploy"

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
    // Each postgres input gets its own Database in the application's project.
    "prisma-cloud/postgres": ({ id, application }) =>
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
    "prisma-cloud/compute": {
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
          return { outputs: { environment: records } }   // → deploy's environment prop (the edge)
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
            port: 3000,
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
`postgres({ client })` requires it at authoring, at compile time.)

## The build adapter — worked instances

A build adapter is a two-piece package: a **lean authoring descriptor** carried on
the service node, and a **heavy deploy-side assembler** invoked at `package` time.
The assembler normalizes the app's own build output into a bundle dir with the
MakerKit wrapper, and reports the runtime entry path.

```ts
// @makerkit/node — the authoring descriptor (lean; rides in service.ts)
export default (opts: { entry: string }): BuildAdapter => ({ kind: "node", entry: opts.entry })

// @makerkit/nextjs — same shape; the app passes the built standalone server's
// path (relative to the assembled bundle dir)
export default (opts: { entry: string }): BuildAdapter => ({ kind: "nextjs", entry: opts.entry })

// @makerkit/<adapter>/assemble — the deploy-side assembler (heavy; deploy machine)
// Produces the normalized bundle dir + the runtime entry path for the bootstrap.
interface Assembler {
  assemble(input: {
    serviceDir: string          // where service.ts lives; anchors the descriptor's relative entry
    build: BuildAdapter         // the descriptor (entry, kind)
  }): Promise<AssembledBundle>  // { dir, entry }
}
```

`node`'s assembler is trivial: place the app's built entry and the MakerKit wrapper
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
// No handler.
import { compute, postgres } from "@makerkit/prisma-cloud"
import node from "@makerkit/node"
import { SQL } from "bun"                       // the APP's choice of client

const db = postgres({ name: "db", client: ({ url }) => new SQL({ url }) })
// typeof hydrated db = SQL — inferred from the factory, no phantom declaration

export default compute({
  name: "hello",                                // ADR-0006: every node named; at root this names the app
  url: import.meta.url,                         // ADR-0004: deploy-time anchor; inert at runtime
  deps: { db },
  build: node({ entry: "dist/server.js" }),     // where the APP's build puts the runnable
})

// src/server.ts — the app's OWN entrypoint. The app bundles this to dist/server.js
// (its own bundler). It pulls typed deps from the service and serves.
import service from "./service"

const { db, port } = service.load()             // db: SQL, port: number — inferred
Bun.serve({ port, hostname: "0.0.0.0",
  fetch: async () => Response.json(await db`select 1 as ok`) })

// There is no deploy config file (ADR-0003). The app builds itself first
// (its own bundler produces dist/server.js), then:
//
//   makerkit deploy src/service.ts
//
// The CLI infers the target pack from the nodes, constructs it from the
// environment (the pack's /target fromEnv() reads PRISMA_WORKSPACE_ID), runs
// each service's assembly, and drives Alchemy — no bundle map, no stack file.
```

`service.load()` is typed end to end by the chain `postgres({ client })` → `C =
SQL` → `compute({ deps: { db } })` captures `{ db: SQL }` → `load()` returns it.
The app never annotates a dependency type. Note where Bun appears: only in
`service.ts` (the `new SQL` factory) and `server.ts` (`Bun.serve`, the app's own
entry) — the app's choice, since it deploys to a Bun runtime. Switching the client
to node-postgres, or the app to a Node platform, changes these app lines and
nothing in MakerKit.

And note what a test needs: build the service with fake deps and call `load()` —
or, since `load()` reads the stash, hydrate directly against injected `Config`. No
environment, no cloud, no pack internals. That is the dependency inversion the
model promises. The config round-trip is proven separately at the pack level
(serialize → deserialize identity).

### Two services, connected — the hex (a framework-hosted consumer)

The storefront-auth shape: `auth` is a self-served Hono service (as above);
`storefront` is a **framework-hosted** Next.js service whose page pulls the `auth`
client via `load()`. This replaces the hand-written mixed stack — the URL plumbing,
the `requireStringOutput` guard, and the hand-named `EnvironmentVariable` all
disappear into core's sequencing.

```ts
// storefront/src/service.ts — declares the dependency; never learns how the URL arrives
import { compute, http } from "@makerkit/prisma-cloud"
import nextjs from "@makerkit/nextjs"
const auth = http({ name: "auth" })
export default compute({ name: "storefront", url: import.meta.url,
  deps: { auth }, build: nextjs() })

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

// app.ts — the app's hex: transparent wiring, runs at Load. Its name becomes
// the application (Project) name; each service's dir comes from its own `url`.
import authService from "./hexes/auth/src/service"
import storefrontService from "./hexes/storefront/src/service"
export default hex("storefront-auth", (h) => {
  const authRef = h.provision("auth", authService)
  h.provision("storefront", storefrontService, { auth: authRef })  // wires the edge
})

// No deploy config file (ADR-0003): build both apps, then
//   makerkit deploy app.ts
```

At deploy, core sequences: auth provision → auth deploy (URL now real) → storefront
provision → build the storefront's `Config` (auth's deploy URL fills the
`auth.url` leaf) → `serialize` (the pack encodes it under its address-prefixed
keys) → `nextjs` assembler → package → storefront deploy — the first VM boots with
its config present. At boot, `bootstrap.js` calls `main.run(address, () =>
import("./server.js"))`: `run` deserializes the storefront's env, re-emits it under
address-free stash keys, then boots the Next server; the page's `service.load()`
reads the stash and hydrates the `auth` leaf into a client exactly as the Hono
entry hydrates `db`. Neither entry can tell a connection from a resource.

## Invariants (enforced, not aspirational)

1. **Core has no target dependency**: `@makerkit/core`'s `package.json` depends on
   neither `@makerkit/prisma-alchemy` nor any `prisma-*` package — checked by a test.
2. **Authoring imports stay lean**: bundling a module that imports `@makerkit/core`,
   `@makerkit/prisma-cloud`, and a build-adapter descriptor (authoring entries
   only) contains no `alchemy`/`effect`/`prisma-alchemy`/`new SQL(`/`node:fs`
   tokens — the import-split guard test, extended to the pack and the adapters'
   descriptor entries. The adapters' `/assemble` entries are deploy-only and
   exempt.
3. **Importing runs nothing**: constructing nodes is pure; only the node's
   `run`/`load` and the alchemy CLI execute anything. This reaches the artifact:
   the service module is a pure declaration, the MakerKit wrapper is inert on
   import, and the pack-printed bootstrap is the only runnable MakerKit adds.
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
  Start, a cron access-pattern, a static site). Each is a package; nothing in core
  or the target pack changes to add one.
- **Framework-hosted DI is `load()`** — the Next page pulls its typed deps via
  `service.load()`, the same mechanism the Hono entry uses. No separate `use()`
  accessor is needed; the earlier framework-DI gap is closed by `load()`.
- **Typed connection interfaces + generated clients** — today `http()` hydrates to
  a plain URL-anchored client; the next step is declaring the interface of a
  connection (routes, request/response bodies), enforcing compatibility at Load,
  and hydrating a generated, strongly-typed client.
- **Full Hex composition** — the minimal hex wires services; boundary ports
  (a hex's own Inputs/Outputs), nesting, and forwarding per the authoring-surface
  design come next. Services stay opaque leaves.
- **Runtime name lookup** — if the platform gains service-name resolution, the
  pack's `serialize` becomes a no-op and its connection hydrate resolves by name;
  consumers are unchanged (they never learned how the address arrived).
- **Deterministic framework artifacts** — the single-service (tsdown) build is
  byte-deterministic; the Next standalone case embeds a per-build `BUILD_ID`, so a
  Next service may re-version on redeploy even when unchanged. A deterministic
  standalone assembly (fixed ids/mtimes) is the follow-up for a true no-op redeploy.
- **`ParamType` growth** — the tag set is `"string" | "number"`, curated; new tags
  (`"boolean"`, `"url"`, …) are added consciously with their validation.
- **Serialized topology** — the topology view of Graph is already JSON-safe; an emit
  step for external tooling is additive.

## Related

- [`../03-domain-model/core-and-targets.md`](../03-domain-model/core-and-targets.md) — the architectural split this implements.
- [`../03-domain-model/authoring-surface.md`](../03-domain-model/authoring-surface.md) — the developer-facing narrative.
- [`../03-domain-model/layering.md`](../03-domain-model/layering.md) — Alchemy as the provisioning plane (claim 3).
