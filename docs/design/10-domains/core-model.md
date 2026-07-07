# Core model — classes and data structures

The complete type-level design of `@makerkit/core` and the target-pack contract,
with `@makerkit/prisma-cloud` as the worked instance. This is the implementation
design under [`core-and-targets.md`](../03-domain-model/core-and-targets.md): that
doc says *what* the split is; this one says exactly *which types exist, what fields
they carry, and who imports what*. Scope: the current model — Services with
Resource inputs, service-to-service **Connections**, and the minimal **Hex** that
wires them; typed interfaces and full Hex composition are named extension points.

## Package and entry map

Five entry points, split by dependency weight. The split is enforced, not
aspirational (see § Invariants).

Entries map onto MakerKit's **four planes**. Entry names say *when you import
them*; mechanism terms stay on the functions (`lower()`/`lowering()` — the
glossary's Lowering — live in `/deploy`):

| Plane | What it covers | Home today |
| --- | --- | --- |
| **authoring** | write the model — node factories, model types | `.` (usually reached through a pack's vocabulary) |
| **control** | load / interrogate / mutate the model at build time — `Load`, `configOf`, the topology view | also `.` — see below |
| **deploy** | convert the model to Alchemy for deployment — `lower()`, `lowering()`, `Target` | `/deploy` |
| **execution** | run it — the pack node's `run`, core's `hydrate` | rides on the node (pack authoring entry) |

**`/control` is reserved as the settled design direction**: today the control
surface is two pure, lean functions, too little to justify its own entry — but
the moment it grows (the queryable-topology emit, config-declaration tooling, graph
transforms when Hexes arrive), it carves out of `.` into `@makerkit/core/control`.
The boundary is decided; only the carve is deferred.

| Entry | Exports | Imports (weight) |
| --- | --- | --- |
| `@makerkit/core` | node factories (`service`, `resource`, `connectionEnd`, `hex`), `Load`, `configOf`, `hydrate`, model types (incl. `Config`) | nothing |
| `@makerkit/core/deploy` | `lower()`, `Target` types | `alchemy`, `effect` |
| `@makerkit/prisma-cloud` | `compute()` (runnable node — carries `run`), `postgres({ client })`, `http()` | `@makerkit/core` only |
| `@makerkit/prisma-cloud/target` | `prismaCloud()` | `@makerkit/prisma-alchemy`, `alchemy`, `effect` |

There is no `@makerkit/core/runtime` entry: the boot loop rides on the node (the
pack's runnable subclass carries `run`), so it is inlined into the app bundle
once by the app's own bundler. Per the [runtime-agnostic
principle](../01-principles/architectural-principles.md), no entry imports Bun or
Node APIs — not even type-only. Runtime-specific code (the DB driver, the server
API) appears only in **app files**. The pack splits into just authoring (lean —
carries `run`) and target (heavy, deploy-only).

Who imports what, end to end:

- the **user's service module** imports `@makerkit/prisma-cloud` and the app's
  own driver of choice (a DB client factory lives inline here);
- the **deploy config** (`makerkit.config.ts`) imports the app (service or hex) +
  `@makerkit/prisma-cloud/target` (heavy — deploy-time only). `makerkit deploy`
  reads it and calls `@makerkit/core/deploy`'s `lower()` internally; the app
  author writes no stack file (the CLI is a named extension point — until it
  lands, examples use an interim `alchemy.run.ts` calling `lower()` directly);
- the **runtime bundle entry** (`main.ts`, app-owned) re-exports the service
  module's node — nothing else, and nothing runs on import. The boot call lives
  in the **bootstrap** the pack prints at deploy (§ Lowering): a two-line,
  zero-dependency file that imports only `./main.js` and calls `main.run(address)`.
  The node carries its own `run`, so the runtime is already in the bundle (one
  copy of core); the bootstrap adds no code.

The runtime bundle never contains Alchemy. One accepted consequence: because
connections close over the app's client factory, the deploy config *loads* (never
uses) the driver when it imports the app module — fine under Bun, and mitigable
with a lazy import inside the factory if it ever matters.

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
the only actor**; the pack contributes tools that satisfy an SPI and never sees the
graph, never sequences anything, never calls another tool.

| Path | Where it executes | Core does (the actor) | Pack tools used |
| --- | --- | --- | --- |
| **provision** | deploy machine, via Alchemy | provision the application once (Project + poison vars), then walk the DAG realizing each service's host | `Target.application.provision`, then `ServiceLowering.provision` → identity (App) |
| **deploy** | deploy machine, via Alchemy | build each service's typed `Config`, have the pack encode it *first*, then ship the build | `ServiceLowering.serialize` in the seam, then `package` + `deploy` (version → upload → start → promote) |
| **run** | inside the bundle, in the VM | provide `hydrate` (typed `Config` → clients) and the handler; the pack's `run` drives it | the node's `run` (deserialize env), each connection's `hydrate` |

**provision vs deploy** is the line between "the service exists" and "its code is
running": provision creates identity-bearing infrastructure that changes only when
the topology changes; deploy ships a specific build (keyed by artifact hash) and
changes on every push. The seam between them is the only window where connection
config can land — an environment variable needs the consumer's projectId (exists
after provision) and is read at version start, never after (PRO-211: so it must
exist before deploy). Core sequences `provision → serialize → package → deploy`
for every service, which **eliminates the fresh-deploy config race by
construction**, for every target pack ever written. One producer-side asymmetry: a producer's real URL
is trustworthy only after its *deploy* completes (the create-time endpoint domain
is a placeholder — PRO-200), so core runs a producer through both phases before
touching its consumers' config. (The phase boundary is a claim about platforms —
"identity vs running code" is crisp on Prisma Cloud and most targets, and the SPI
assumes it.)

The paths map onto the entry taxonomy: provision + deploy are reached through
`@makerkit/core/deploy` (one import moment, several SPI phases, different cadence);
run is the node's own `run`, inlined into the app bundle — a separate process. The
deploy path's `serialize` and the run path's `deserialize` use the pack's **one
shared serializer**, so writer and reader cannot drift.

## Core model types (`@makerkit/core`)

All nodes are **plain, frozen, serializable data** — with exactly **three
sanctioned behavior slots** hanging off the graph: the Service node's handler
(`invoke`), a Connection's `hydrate` (typed values → client), and — on the target
pack's runnable service subclass — `run` (the boot loop). Config *declarations*
are pure data; core builds a **typed `Config`** from the graph and the pack
encodes it to/from the environment (§ Runtime). Core reads no environment. The
topology view simply drops the function slots. A node's `type` is its routing key
at deploy; core never interprets it beyond lookup.

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

// A declared config param — pure data. The declaration does double duty: core
// validates raw values against `type` at boot, and TypeScript derives the
// hydrate/handler input types from it — the definition object ENFORCES the
// final param input types.
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
// the declaration types hydrate's input; the factory types the handler's dep.
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

// ——— Nodes ———

// A Resource a service depends on, carrying its connection face. C flows from
// the connection's hydrate return type into the handler's parameter.
interface ResourceNode<C = unknown> extends NodeBase {
  readonly kind: "resource"
  readonly connection: Connection<Params, C>
}

// A Service: inputs + its own declared params + the opaque handler (`invoke`).
// This IS the user's default export — inspectable (inputs/type/params), inert
// until invoked. The BASE node is not runnable: booting needs a target's
// environment knowledge, so the pack's factory returns a runnable subclass that
// adds `run(address)` (§ Runtime). There is no separate handle type: the node is
// the handle.
interface ServiceNode<D extends Deps = Deps, P extends Params = Params> extends NodeBase {
  readonly kind: "service"
  readonly inputs: D
  readonly params: P                           // service-level config (e.g. port) — no special "context" concept
  invoke(deps: HydratedDeps<D>, ctx: Values<P>): unknown   // the handler; core's boot path calls this last
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

// Dependency map: name → what the service consumes. Handler types are inferred
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

// ctx is nothing special: the service's own resolved params, typed by its
// declaration. On Prisma Cloud, compute() declares { port: number } — so
// handlers receive ({ db }, { port }).
type ServiceHandler<D extends Deps, P extends Params> =
  (deps: HydratedDeps<D>, ctx: Values<P>) => unknown
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
  handler: ServiceHandler<D, P>
}): ServiceNode<D, P>   // the pack wraps this and returns its runnable subclass

function connectionEnd<P extends Params, C>(def: {
  type: string
  connection: Connection<P, C>
}): ConnectionEnd<C>

function hex(name: string, body: (h: HexBuilder) => void): HexNode   // body runs at Load, not here
```

`service()` stores `handler` as the node's `invoke` and freezes `inputs`/`params`;
`resource()` freezes the connection's declared params. Both throw on an empty
`type`. Nothing executes: constructing nodes is pure. The pack's authoring
factory (`compute()`) calls `service()` and returns a subclass carrying `run`.

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
per wired ConnectionEnd input. Edges now carry a kind: `input` (service consumes a
resource) or `connection` (service calls a service). Validation: every node
branded with a non-empty `type`; every ConnectionEnd input of a provisioned
service **wired to a provisioned producer** (dangling connection = LoadError); the
connection edges form a **DAG** (a cycle is a LoadError with the cycle named — a
consequence of address-at-deploy-time wiring: if A needs B's address to deploy and
B needs A's, neither can go first). A lone service Loaded outside any hex may have
unwired ConnectionEnds — connectedness is a topology-level check; booting it
unwired still fails loudly through the ordinary missing-config path. Load
executes nothing of the user's — the graph
is data in memory to inspect or hand to `lower` (or the node's `run`). A **topology view** —
nodes as `{ id, kind, type }` plus edges, function slots dropped — is
`JSON.stringify`-able by construction; the serialized-artifact emit step builds on
this later.

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
  // environment (on Prisma Cloud: EnvironmentVariables on the project). The pack
  // owns the encoding; its boot-side deserialize (run) reverses it through the
  // same serializer, so writer and reader cannot drift. Leaf values are provisioning
  // refs → the env writes depend on the resources/producer (the ordering edges).
  // Returns the env-var records so `deploy` can reference them (the environment
  // edge — see § sequencing and alchemy-lowering.md).
  serialize(ctx: LowerContext, provisioned: LoweredNode, config: Config):
    Effect.Effect<LoweredNode, unknown, unknown>
  // package: print the bootstrap (address baked in — the whole per-instance
  // deployment parameter) and assemble the deployable artifact from the
  // app-built bundle. The envelope is target vocabulary and the pack's business
  // (Compute: bootstrap.js + compute.manifest.json + tar.gz). MUST be
  // byte-deterministic (fixed tar mtimes/ordering): identical inputs yield an
  // identical hash, so an unchanged service noops on redeploy.
  package(ctx: LowerContext, input: PackageInput):
    Effect.Effect<Artifact, unknown, unknown>
  // deploy: ship the packaged artifact into the provisioned thing and run it
  // (version → upload → start → promote). Consumes `serialized`'s env records
  // via the Deployment's environment prop (the edge). Returns the trustworthy URL.
  deploy(ctx: LowerContext, provisioned: LoweredNode, artifact: Artifact,
         serialized: LoweredNode): Effect.Effect<LoweredNode, unknown, unknown>
}

// The bootstrap the pack prints is the ONLY runnable in the artifact and has
// zero imports beyond the bundle entry — the node carries its own run():
//   import main from "./main.js"
//   await main.run("<address>")
// The entrypoint takes its deployment identity as a parameter; deploy is the
// caller. The pack owns both the printer and run(), so it can pass any
// environment-specific data through this closed channel.
interface PackageInput {
  readonly bundle: Bundle          // app-built, from LowerOptions
  readonly address: string         // the node's graph address — baked into the bootstrap
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
  // Bundles are app-built (MakerKit does not bundle app code). A bundle's entry
  // is a pure module default-exporting the ServiceNode — nothing runs on import.
  // Service root: one bundle. Hex root: one per provisioned service, keyed by
  // provision id. Packaging bundle → artifact is the pack's job (see package).
  readonly bundle?: Bundle
  readonly bundles?: Record<string, Bundle>
  readonly stage?: string
  readonly state?: AlchemyStateLayer                     // default: localState(); the
                                                         // hosted-state store slots in here
}
interface Bundle { readonly dir: string; readonly entry?: string }   // entry default: main.js|main.mjs
interface Artifact { readonly path: string; readonly sha256: string } // package()'s product

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
   pack's own naming, value = the ref). Never the platform default.
5. `package({ bundle, address })` — the pack prints the bootstrap (address baked
   in, § below) and assembles the deployable artifact from the app-built bundle.
6. `deploy(artifact)` — the first version snapshots an environment that is already
   complete. **How the ordering is actually enforced:** our walk only
*assembles* Alchemy resource descriptions — Alchemy executes them in dependency
order and runs unordered resources concurrently; declaration order is never
consulted. So core realizes the sequence as **dependency edges**: most arise
naturally from value flow (the env var consumes the project id and the
producer's URL), and the one that doesn't — deploy-after-serialize — exists
because the `Deployment` resource declares the environment records it boots
with as a prop, which is PDP's own dataflow restored (the version-create call
literally contains the materialized env map). See the lowering graphs in
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
main.js                ← app-built bundle: exports the Service node, core inlined ONCE, inert on import
bootstrap.js           ← pack-printed: `import main from "./main.js"; await main.run("<address>")`
compute.manifest.json  ← pack-written envelope; entrypoint = bootstrap.js
```

The node carries its own runner: the pack's service node has a `run(address)`
method (§ Runtime), so the app bundle already contains the boot loop — the
bootstrap is a two-line sliver with one import and zero core, and the artifact
holds a single copy of core. Every byte is deterministic — bundle from the app's
build, bootstrap from the address — so unchanged services hash identically and
noop. Because the same Load walk feeds both `serialize`'s env keys and the
bootstrap's address (and the pack derives config keys from that address on both
sides), the config writer and the boot-time reader cannot drift. An address
changes only when the graph position changes (e.g. a rename), which correctly
cascades: new keys, new bootstrap, new version.

Notes:

- **Target-specific identity** (workspace id, region) never appears in
  `LowerOptions` — it is captured by the pack's target constructor
  (`prismaCloud({ workspaceId })`). Core's options are target-neutral.
- **The bundle is the input; the artifact is the pack's product.** The app
  bundles (tsdown, Bun.build, whatever) and passes a directory; the pack's
  `package` prints the bootstrap and wraps the bundle in the target envelope,
  and its hash is what makes a rebuild register as a change. Core still has no
  build step — printing a two-line bootstrap is assembly, not bundling; app code
  is never compiled by MakerKit.

## Runtime: booting a service (the pack's `run`, core's shape and hydrate)

At boot, three things have to happen: reconstruct this service's config, turn it
into clients, and call the handler. The split is **core owns structure, the pack
owns encoding**:

- **the shape** — `configOf(root)` enumerates what config the service needs
  (semantic names + type tags, no platform keys). Pure, derivable from the graph
  without booting; this is the enumeration/visibility surface.
- **the pack's `run`** — the boot loop, on the pack's runnable service subclass.
  It **deserializes** the platform environment into a typed `Config` (its own
  encoding, keyed from the address the bootstrap passed) and hands it to core.
  This is the pack's single sanctioned environment read.
- **core's `hydrate`** — given the typed `Config`, call each input's
  `connection.hydrate` with its typed slice, then the handler (`invoke`). A
  resource dep and a connection dep hydrate through identical machinery.

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
// every input (connection.hydrate with its value slice) and call the handler.
// The pack's run() = deserialize(env) → hydrate → invoke. No environment read,
// no strings — the pack already reversed its own encoding into a typed Config.
function hydrate(root: ServiceNode, config: Config): Promise<HydratedDeps<Deps>>

// The pack's runnable service node (what compute() returns). run() is the whole
// boot loop; address is what the bootstrap baked in.
interface RunnableServiceNode<D extends Deps, P extends Params> extends ServiceNode<D, P> {
  run(address: string, opts?: unknown): Promise<unknown>
}
```

Core and user code contain **zero** environment reads: the pack's `run` is the
single sanctioned reader for its platform, and a local test injects fakes and
never touches an environment (below). The typed `Config` is core's interception
point — a harness can inspect it or redact by the `secret` flag on the shape —
and `configOf` keeps the config surface enumerable without booting.

**Config validation is the pack's, because it is the pack reversing its own
serialization.** "Is this value present and the right type" is exactly the check
`deserialize` must pass to reconstruct the typed `Config` it once wrote; core
defines the shape that check is against. A missing or unparseable value is the
pack failing loudly at boot.

## The Prisma Cloud pack (`@makerkit/prisma-cloud`) — worked instance

Authoring entry — nodes carrying their connection/host knowledge; the driver is a
**parameter**, so the pack ships none and the client type is inferred:

```ts
import { resource, service, connectionEnd, configOf, hydrate,
  type Config, type ConfigDeclaration, type Connection, type Deps,
  type ServiceHandler, type ResourceNode, type ConnectionEnd, type RunnableServiceNode } from "@makerkit/core"

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

// compute() returns the pack's RUNNABLE subclass — the base node plus run(),
// the boot loop. run() is the only environment reader in the pack.
export const compute = <D extends Deps>(
  deps: D,
  handler: ServiceHandler<D, typeof computeParams>,   // ctx: { port: number }
): RunnableServiceNode<D, typeof computeParams> => {
  const node = service({ type: "prisma-cloud/compute", inputs: deps, params: computeParams, handler })
  return Object.freeze({
    ...node,
    async run(address: string) {
      const config = deserialize(configOf(node), address)   // the pack's ONE env read + coercion
      return node.invoke(await hydrate(node, config) as never, config.service as never)
    },
  }) as RunnableServiceNode<D, typeof computeParams>
}

// The pack's config serializer — the semantic↔physical mapping, private to the pack,
// SHARED by run() (boot) and the /target serialize (deploy) so writer and reader
// cannot drift. Keys are unique per service within the shared project namespace:
// the serializer prefixes them with the deployment address (its segments after the
// app root, which is project-constant), so auth's db.url ↔ AUTH_DB_URL. The
// platform's DATABASE_URL is never among them — it is forbidden and poisoned at
// project provision (see 05-prisma-cloud/alchemy-lowering.md).
export const configKey = (address: string, d: ConfigDeclaration): string => /* UPPER_SNAKE(address ▸ owner ▸ name) */

// Boot: read each declared param from env by its key, coerce to its type (the
// pack reversing its own serialization — missing/unparseable fails loudly),
// assemble the typed Config. process.env is touched ONLY here in the pack.
const deserialize = (shape: readonly ConfigDeclaration[], address: string): Config => { /* … */ }
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

  // Runs ONCE per lowering, before any service: the application's Project,
  // with the poison DATABASE_URL/DATABASE_URL_POOLED variables written
  // immediately so nothing can ever rely on the platform default.
  application: {
    provision: ({ opts }) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project(`${opts.name}-project`, {
          workspaceId: o.workspaceId, name: opts.name,
        })
        for (const key of ["DATABASE_URL", "DATABASE_URL_POOLED"]) {
          yield* Prisma.EnvironmentVariable(`${key}-poison`, {
            projectId: project.id, key, value: "", class: "production",  // "" preferred; "-" if the API rejects empty
          })
        }
        return { outputs: { projectId: project.id } }
      }),
  },

  resources: {
    // Each postgres input gets its own Database in the application's project.
    // The url output fills the service's db.url Config leaf and is encoded by
    // serialize under the service's own named key — never the platform default.
    "prisma-cloud/postgres": ({ id, application }) =>
      Effect.gen(function* () {
        const db = yield* Prisma.Database(`${id}-db`, {
          projectId: application.outputs.projectId, name: id,
        })
        const conn = yield* Prisma.Connection(`${id}-conn`, { databaseId: db.id })
        return { outputs: { url: conn.url } }
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
      // leaf, keyed by the SAME serializer run() reads with at boot (the pack's
      // serializer module, env-free, both directions). Values are the provisioning refs core built
      // the Config from, so each env var depends on its resource/producer — the
      // ordering edges. class production; the platform default is never written.
      serialize: ({ address, node }, provisioned, config) =>
        Effect.gen(function* () {
          const records = []
          for (const d of configOf(node)) {
            const value = d.owner === "service" ? config.service[d.name] : config.inputs[d.owner.input]?.[d.name]
            records.push(yield* Prisma.EnvironmentVariable(`${configKey(address, d)}-var`, {
              projectId: provisioned.outputs.projectId,
              key: configKey(address, d),
              // encode typed→string: a concrete leaf stringifies; a provisioning
              // ref (already string-typed) passes through and carries the edge.
              value: typeof value === "number" ? String(value) : (value as never),
              class: "production",
            }))
          }
          return { outputs: { environment: records } }   // → deploy's environment prop (the edge)
        }),

      // Print the bootstrap (address baked in) and assemble the deployable
      // artifact: bootstrap.js + compute.manifest.json beside the app bundle,
      // deterministic tar.gz (fixed mtimes/ordering so unchanged inputs hash
      // identically). The whole envelope is the pack's — target vocabulary.
      package: ({ id }, { bundle, address }) =>
        Effect.gen(function* () {
          // bootstrap.js: `import main from "./main.js"; await main.run(${JSON.stringify(address)})`
          // write it + manifest beside bundle.dir, tar deterministically, sha256
          return { path: `…/${id}.tar.gz`, sha256: "…" }
        }),

      // A specific BUILD into the place: version → upload → start → promote.
      // The environment prop references serialize's env-var records, so the
      // version depends on them (the edge that kills PRO-211 + propagates
      // change). deployedUrl is read post-promote — the create-time domain is a
      // placeholder (PRO-200).
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
(`compute()` returns the runnable subclass; `.run(address)` is the whole thing),
so the app bundle carries the runtime with a single copy of core and the
bootstrap needs nothing but `./main.js`. (A missing client factory is impossible
by construction — `postgres({ client })` requires it at authoring, at compile
time.)

## The app, end to end

Three app-owned files; bundling stays hand-rolled in the app:

```ts
// src/service.ts — the authored service; the connection + its driver live here
import { compute, postgres } from "@makerkit/prisma-cloud"
import { SQL } from "bun"                       // the APP's choice of client

const db = postgres({ client: ({ url }) => new SQL({ url }) })
// typeof hydrated db = SQL — inferred from the factory, no phantom declaration

export default compute({ db }, ({ db }, { port }) =>
  Bun.serve({ port, hostname: "0.0.0.0",
    fetch: async () => Response.json(await db`select 1 as ok`) }))

// src/main.ts — runtime bundle entry (app-owned): a pure re-export; nothing runs.
// The Service node carries its own run(); the pack-printed bootstrap imports this
// bundle and calls main.run(address) with the service's deployment identity.
export { default } from "./service"

// makerkit.config.ts — declares the app, its target, and where the bundle is.
// `makerkit deploy` reads this, calls lower() internally, and drives Alchemy;
// the app author writes no stack file. (The CLI is a named extension point.)
import app from "./src/service"
import { prismaCloud } from "@makerkit/prisma-cloud/target"
export default {
  app,
  target: prismaCloud({ workspaceId: requiredEnv("PRISMA_WORKSPACE_ID") }),
  name: "hello",
  bundle: { dir: "dist/bundle" },   // app-built; the pack packages it at deploy
}
```

The app's build script bundles `src/main.ts` — that is the whole build. The
envelope (bootstrap + `compute.manifest.json` + tar) is the pack's `package`
step at deploy; the app never writes target vocabulary and never a stack file.

Note where Bun appears: only in `service.ts` (`Bun.serve` in the handler, `new
SQL` in the connection factory) — the app's choice, since it deploys to a platform
whose runtime is Bun. Switching the client to node-postgres, or the app to a Node
platform, changes these app lines and nothing in MakerKit.

And note what a test needs: `service.invoke(fakes, { port: 0 })` — inject typed
fakes at the inputs and call the handler directly, no environment, no cloud, no
pack. That is the dependency inversion the model promises. The config round-trip
is proven separately at the pack level (serialize → deserialize identity).

### Two services, connected — the hex

The storefront-auth shape, on the primitive (this replaces the hand-written mixed
stack: the ten lines of URL plumbing, the `requireStringOutput` guard, and the
hand-named `EnvironmentVariable` all disappear into core's sequencing):

```ts
// storefront service — declares the dependency; never learns how the address arrives
const auth = http()
export default compute({ auth }, async ({ auth }, { port }) => {
  // auth: HttpClient — e.g. await auth.fetch("/verify")
})

// the app's hex — transparent wiring, runs at Load
import authService from "./hexes/auth/src/service"
import storefrontService from "./hexes/storefront/src/service"

export default hex("storefront-auth", (h) => {
  const authRef = h.provision("auth", authService)
  h.provision("storefront", storefrontService, { auth: authRef })  // wires the edge
})

// makerkit.config.ts — the whole deploy declaration; `makerkit deploy` drives it
export default {
  app: appHex,
  target: prismaCloud({ workspaceId }),
  name: "StorefrontAuth",
  bundles: {
    auth: { dir: "hexes/auth/dist/bundle" },
    storefront: { dir: "hexes/storefront/dist/bundle" },
  },
}
```

At deploy, core sequences: auth provision → auth deploy (URL now real) → storefront
provision → build the storefront's `Config` (auth's deploy URL fills the
`auth.url` leaf) → `serialize` (the pack encodes it under its address-prefixed
keys) → package → storefront deploy — first VM boots with its config present. At
boot, `main.run(address)` deserializes and core's `hydrate` turns the `auth` leaf
into a client exactly as it does `db`; the handler cannot tell the two apart.

## Invariants (enforced, not aspirational)

1. **Core has no target dependency**: `@makerkit/core`'s `package.json` depends on
   neither `@makerkit/prisma-alchemy` nor any `prisma-*` package — checked by a test.
2. **Authoring imports stay lean**: bundling a module that imports `@makerkit/core`
   and `@makerkit/prisma-cloud` (authoring entries only) contains no
   `alchemy`/`effect`/`prisma-alchemy`/`new SQL(` tokens — the existing import-split
   guard test, extended to the pack.
3. **Importing runs nothing**: constructing nodes is pure; only the node's `run`/the
   alchemy CLI execute anything. This now reaches the artifact: the app bundle is a
   pure module (`main.ts` re-exports the Service), and the pack-printed bootstrap is
   the only runnable a deployed artifact contains.
4. **Core and user code contain zero environment reads.** The pack's `run`
   (deserialize) is the single sanctioned reader for its platform — `process.env`
   appears exactly once per pack, inside its config serializer; a local test injects
   fakes via `invoke` and reads nothing. Core's shape, Config-building, and
   `hydrate` never touch an environment.
5. **No runtime coupling**: neither core nor a target pack imports Bun or Node APIs
   — even type-only — in its shipped surface (the [runtime-agnostic
   principle](../01-principles/architectural-principles.md)). Drivers and server APIs
   enter only from app files; the import-guard test extends to `"bun"`/`node:`
   tokens.

## Extension points (designed for, not yet built)

- **MakerKit-owned deploy entrypoint** — the standard deploy path is `makerkit
  deploy` over a declarative `makerkit.config.ts` (`{ app, target, name,
  bundle(s) }`); the CLI reads it and calls `lower()` internally, so the app
  author writes no stack file. `lower()`/`lowering()` stay in `/deploy` as the
  mechanism and the escape hatch for hand-composed / mixed-stack topologies.
  Until the CLI lands, examples invoke `lower()` from an interim `alchemy.run.ts`.
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
- **Registry exhaustiveness** — `Target.lower` is a string-keyed record; a pack can
  tighten it to its own type-id union for compile-time exhaustiveness. Core stays
  stringly-typed by design at deploy (it routes); the runtime side has no registry
  at all — behavior rides the nodes.
- **Config introspection** — `configOf` already enumerates the shape without
  booting; a "which physical key is this param" projection is a pack serializer
  addition (it owns the encoding), and a running host can report its typed
  `Config` with secrets redacted by the `secret` flag.
- **`ParamType` growth** — the tag set is `"string" | "number"`, curated; new tags
  (`"boolean"`, `"url"`, …) are added consciously with their validation, never as
  an open plugin surface.
- **Serialized topology** — the topology view of Graph is already JSON-safe; an emit
  step for external tooling is additive.

## Related

- [`../03-domain-model/core-and-targets.md`](../03-domain-model/core-and-targets.md) — the architectural split this implements.
- [`../03-domain-model/authoring-surface.md`](../03-domain-model/authoring-surface.md) — the developer-facing narrative.
- [`../03-domain-model/layering.md`](../03-domain-model/layering.md) — Alchemy as the provisioning plane (claim 3).
