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
| **control** | the deploy-time face of an extension — its `ExtensionDescriptor` (node registry, provisioners, application hook, providers, preflight, teardown); plus core's `Load`, `configOf`, the topology view | each extension's `/control`; core's own stay on `.` |
| **deploy** | convert the model to Alchemy for deployment — `lower()`, `lowering()`, the SPI types; assemble the artifact | `/deploy`; assemblers ride in each extension's `/control` registry |
| **execution** | run it — the node's `run`/`load`, core's `hydrate` | rides on the node (pack authoring entry) |

**`/control` is a shipped entry, not a reservation** (ADR-0017): every extension
exposes one, and it is where its heavy deploy-time code lives —
`@prisma/composer-prisma-cloud/control` exports `prismaCloud()`,
`@prisma/composer/node/control` exports `nodeBuild()`. Only
`prisma-composer.config.ts` imports those entries, and only the CLI loads that
file, so nothing an app's own import graph reaches can pull control-plane code
into the runtime artifact. Core's own control-plane surface (`Load`, `configOf`)
is small and pure and still sits on `.`; the config *types* (`defineConfig`,
`ExtensionDescriptor`) live on `@prisma/composer/config`.

| Entry | Exports | Imports (weight) |
| --- | --- | --- |
| `@prisma/composer` | node factories (`service`, `resource`, `dependency`, `module`), `Load`, `configOf`, `hydrate`, `BuildAdapter` type, model types (incl. `Config`) | nothing |
| `@prisma/composer/config` | `defineConfig`, `PrismaAppConfig`, `ExtensionDescriptor`, `NodeDescriptor`, `PreflightInput`, `TeardownInput` — the types `prisma-composer.config.ts` is checked against (ADR-0017) | nothing (types + one identity function) |
| `@prisma/composer/deploy` | `lower()`, `lowering()`, the SPI types (`ServiceLowering`, `Lowering`, `ApplicationDescriptor`, `ProvisionerDescriptor`, `LowerContext`, `Outputs`, `LoweredResult`, `DeployedEntity`), `Bundle`/`AssembleInput` (the assembler's contract, defined once here) | `alchemy`, `effect` |
| `@prisma/composer-prisma-cloud` | `compute()` (declares a service; carries `run`/`load`), `postgres()` (`{ name }` identity or `{ client }` dependency, by argument shape) + `postgresContract`, `http()` | `@prisma/composer` only |
| `@prisma/composer/service-rpc` | the RPC Contract kind — `contract()`, `rpc()`, `serve()`, the typed client binding (see [`connection-contracts.md`](connection-contracts.md)) | `@prisma/composer` + a Standard Schema validator |
| `@prisma/composer-prisma-cloud/cron` | cron as a driver (see [ADR-0020](../90-decisions/ADR-0020-scheduled-work-is-a-driver-not-a-resource.md)) — `defineSchedule`, `serveSchedule`, `cronScheduler`, `cron()`, `triggerContract` | `@prisma/composer` + `app-node` + `app-rpc` |
| `@prisma/composer-prisma-cloud/storage` | S3-compatible object storage as a module (S3 wire protocol on Compute + Postgres `bytea`; see [`README`](../../../packages/1-prisma-cloud/2-shared-modules/storage/README.md)) — `storage()`, `s3()` + `s3Contract`/`S3Config`, `storageService`; `/storage/testing` adds the `createPgStore` + `startStorageServer` local stand-in | `@prisma/composer` + `app-node` + `@prisma/composer-prisma-cloud` |
| `@prisma/composer-prisma-cloud/control` | `prismaCloud()` — the extension descriptor the config lists | `@internal/lowering`, `alchemy`, `effect` |
| `@prisma/composer/node` · `@prisma/composer/nextjs` (build adapters) | `node()` · `nextjs()` — the authoring **descriptor** (lean, rides in `service.ts`), stamped with the adapter's own `extension` | `@prisma/composer` only |
| `@prisma/composer/node/control` · `@prisma/composer/nextjs/control` | `nodeBuild()` · `nextjsBuild()` — an `ExtensionDescriptor` whose `nodes` registry holds the deploy-side assembler under `{ kind: "build" }` | `node:fs`/framework tooling — deploy machine only |
| `@internal/assemble` | `assembleServices()` — looks each service's `build` descriptor up in the configured extensions' registries, the wrapper-inlining policy, `AssembleError` | `node:fs`/`node:module` — deploy machine only; consumed by `@internal/cli` and the future programmatic deploy API |

A build adapter splits exactly like any other extension: a **lean authoring
descriptor** that the service module carries (pure data — `{ extension, type,
module, entry }`, `extension` being the adapter's own package name, baked in by
its factory), and a **heavy deploy-side assembler** invoked once at deploy on the
build machine. The two are joined by the same mechanism every other node uses:
the assembler is a `{ kind: "build" }` entry in the adapter's own `/control`
registry, found by the descriptor's `(extension, type)` pair. There is no
`${build.extension}/assemble` specifier and no path resolution — the config's
static imports are the only way control-plane code is reached (ADR-0017). The descriptor
rides into every bundle that imports `service.ts`; the assembler never does.

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
- the **deploy entry is the app module itself**: everything about the
  *application* is still derived from the root node (ADR-0003).
  `prisma-composer deploy <entry>` imports it and calls
  `@prisma/composer/deploy`'s `lower()` internally;
- the **`prisma-composer.config.ts`** at the app root carries the two things the
  graph cannot yield — the **extension list** and the **state store** (ADR-0017).
  The CLI finds it by walking up from the deploy entry and loads it with c12. It
  is the only importer of the `/control` entries where heavy code lives, and app
  code never imports it, which is what keeps that code out of the artifact. The
  app author still writes no *stack* file — `prisma-composer deploy` generates one
  at `.prisma-composer/alchemy.run.ts` per run and drives it; see
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
| **provision** | deploy machine, via Alchemy | provision the application once (Project + poison vars), then walk the DAG realizing each service's host | `ExtensionDescriptor.application.provision`, then `ServiceLowering.provision` → identity (App) |
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

// Shared base for extension-authored nodes (service + resource): the authoring
// extension's package name, e.g. "@prisma/composer-prisma-cloud". Deploy tooling
// reads it off the graph and matches it against each configured
// ExtensionDescriptor's `id` (ADR-0017) — it is a registry KEY, never a module
// specifier to import. DependencyEnd stays extension-less. Routing is on the
// (extension, type) pair: `extension` selects the descriptor, `type` selects the
// entry in its `nodes` registry — `type` never carries a package prefix itself.
// (A doc device: the real ResourceNode/ServiceNode declare these fields inline
// rather than sharing a base interface.)
interface ExtensionAuthoredNode extends NodeBase {
  readonly extension: string
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
// ASSEMBLER (fs, framework tooling) is a `{ kind: "build" }` entry in this
// adapter's own /control registry (ADR-0017), found by the (extension, type)
// pair below — never a computed `${extension}/assemble` import — and never ships
// in a bundle (§ Lowering, § Extension).
interface BuildAdapter {
  readonly extension: string                   // the adapter's package name, e.g. "@prisma/composer/node" — baked in by node()/nextjs(); the registry key at deploy
  readonly type: string                        // "node" · "nextjs" — the build descriptor's id within that extension's `nodes`
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
interface ResourceNode<C extends Contract<any, any> = Contract<any, any>> extends ExtensionAuthoredNode {
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
interface ServiceNode<D extends Deps = Deps, P extends Params = Params> extends ExtensionAuthoredNode {
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
  extension: string
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

The router. Core's only job at deploy: Load, then look up each node's
`(extension, type)` pair in the app config's extension registries and run what it
finds, deps before dependents.

```ts
import type { Layer } from "effect"
import type { Effect } from "effect"

// The config file's default export (ADR-0017). `prisma-composer.config.ts` sits at
// the app root and STATICALLY imports each extension's /control entry, so the
// framework never builds a module specifier, never resolves a path, and never
// imports by a computed name. Only the CLI loads it — app code never does, which
// is what keeps control-plane code out of the runtime artifact.
interface PrismaAppConfig {
  readonly extensions: ExtensionDescriptor[]
  readonly state: () => AlchemyStateLayer               // the ONE state store per deploy — explicit,
                                                        // platform-agnostic, never defaulted by an extension
}
function defineConfig(config: PrismaAppConfig): PrismaAppConfig   // in @prisma/composer/config

// One extension's control-plane registry: everything the deploy pipeline may look
// up for a node whose `extension` field names this package. The extension is never
// the actor — these are tools core invokes at moments core chooses; none sees the
// graph, sequences anything, or calls another.
interface ExtensionDescriptor {
  readonly id: string                                   // the package name a node's `extension` is matched against
  readonly nodes: Record<string, NodeDescriptor>        // ONE registry, keyed by the within-extension node id
  readonly provisions?: ReadonlyMap<symbol, ProvisionerDescriptor>   // param provisioners by need brand (ADR-0031)
  readonly application?: ApplicationDescriptor          // once per lowering, before any of this extension's nodes
  readonly providers?: () => Layer.Layer<never>         // merged across configured extensions, in config order
  readonly preflight?: (input: PreflightInput) => Promise<void>      // platform prerequisites; throws to abort (ADR-0029)
  readonly teardown?: (input: TeardownInput) => Promise<void>        // destroy-time cleanup of infrastructure the
                                                                     // extension owns OUTSIDE the stack (e.g. the deploy
                                                                     // state store `alchemy destroy` was still reading).
                                                                     // Runs after destroy succeeds, before the stage's
                                                                     // Project/Branch go; throwing aborts (ADR-0034)
}

// What ONE registry entry can do. The `kind` discriminant is checked at every
// lookup against what the site needs — a resource node found under a `service`
// descriptor is an error naming (extension, type, expected kind). One registry,
// not a resources/services split: a build adapter is an extension like any other
// and registers its assembler here too.
type NodeDescriptor =
  | ({ readonly kind: "resource" } & Lowering)          // one-shot lowering
  | ({ readonly kind: "service" } & ServiceLowering)    // the phased SPI
  | { readonly kind: "build"; assemble(input: AssembleInput): Promise<Bundle> }

// The application's shared infrastructure: on Prisma Cloud, the one Project
// (the config namespace and lifecycle boundary) plus the poison DATABASE_URL
// variables. Its product (e.g. { projectId }) reaches every later SPI call of
// the SAME extension via LowerContext.application. Core declares it `unknown`
// and never reads it — the extension narrows with its own guard (ADR-0033).
interface ApplicationDescriptor {
  provision(ctx: LowerContext): Effect.Effect<unknown, unknown, unknown>
}

// Mints one framework-provisioned param value for one dependency edge (ADR-0031).
// Core looks the need's brand up in the CONSUMER extension's `provisions` map,
// forwards the opaque need, and never reads its payload; a need no configured
// extension satisfies fails the deploy naming the brand and the edge.
interface ProvisionerDescriptor {
  provision(edge: ProvisionEdge): Effect.Effect<unknown, unknown, unknown>
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
// extension's Alchemy resources. Core never looks inside.
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
  readonly provisioned: ReadonlyMap<string, unknown>    // every framework-minted param value this lowering,
                                                        // keyed by edge id (ADR-0031); opaque to core
}

// The values a node provides to its dependents — e.g. a deployed URL a later
// node's env consumes; what a consumer's declared connection params
// resolve against. Name-keyed and unknown-valued of necessity: core cannot
// know extension types, and which producer feeds which consumer is decided by
// the user's graph at runtime. The connection declaration is the contract
// (ADR-0033).
type Outputs = Readonly<Record<string, unknown>>

// One thing a node became on the deployment target, RESOLVED — what a report
// consumer sees. The descriptor NAMES it; core never infers meaning from it.
// `url` is present only when the descriptor declares the address publicly
// reachable — a connection string is never a `url` (no core-level rule is safe:
// `url` on compute is an endpoint, on postgres it would be a DSN). A descriptor
// constructing one holds `deployment.deployedUrl` — an Output<T>, not a T,
// because the stack effect runs before Alchemy applies — so construction sites
// traffic in `Input<DeployedEntity>` (LoweredResult.entities above); apply
// resolves them before any reader sees them.
interface DeployedEntity {
  readonly kind: string
  readonly id: string
  readonly url?: string
  readonly details?: Readonly<Record<string, string>>
}

// What one graph node became — assembled by the loop at full context, RESOLVED.
// In-process only: it holds the node itself, so it never crosses the stack boundary.
interface DeployedNode {
  readonly address: string
  readonly node: ServiceNode | ResourceNode
  readonly entities: readonly DeployedEntity[]
}

// The result of the whole Deploy operation: the app and every node it deployed,
// topo-ordered — what LowerOptions.report receives.
interface DeploymentResult {
  readonly app: string
  readonly nodes: readonly DeployedNode[]
}

interface LowerOptions {
  readonly name: string                                  // stack name (+ Load's root id override)
  // `prisma-composer deploy` runs each service's build-adapter assembler and writes
  // the resulting bundle dirs here, into the generated stack file it hands to
  // `lower()` — one bundle per provision id (the deploy root is always a
  // module). A hand-composed / mixed-stack caller (the escape hatch — see
  // § Lowering) supplies these itself.
  readonly bundles: Record<string, Bundle>
  readonly stage?: string
  readonly state?: AlchemyStateLayer                     // explicit override — wins over the config's
                                                         // own state store (PrismaAppConfig.state)
  // Invoked once per deploy, during apply, with the Deploy operation's RESOLVED
  // result (app + every node, topo order). Presentation belongs to the caller
  // (the CLI wires its renderer here); core never formats. Absent means no report
  // is assembled and no Action is declared at all.
  readonly report?: (result: DeploymentResult) => void
}
interface Bundle { readonly dir: string; readonly entry: string }          // the ONE assembled-bundle shape (assembler product; defined once, here)
interface Artifact { readonly path: string; readonly sha256: string }       // package()'s product

// Load → route each node through its extension's nodes[node.type] → an Alchemy
// Stack (the default export the alchemy CLI consumes). An unknown (extension,
// type) pair → LowerError naming both and the known ids. root must be a module —
// a bare service is not independently deployable.
function lower(root: ModuleNode, config: PrismaAppConfig, opts: LowerOptions): AlchemyStack
class LowerError extends Error {}

// Composable form — for MIXED topologies: framework-authored nodes beside
// hand-wired Alchemy resources in one stack. Runs the same Load → route walk
// inside the caller's stack effect. Resolves to `undefined`: the root module
// has no outputs of its own (boundary ports are future work), and returning
// nothing keeps Alchemy from printing and persisting a stack-output dump —
// Apply.apply short-circuits on a falsy plan output (ADR-0033).
// Error channel: LowerError from routing, PLUS whatever an extension's lowering
// fails with (their error type is open) — a mixed-stack caller treats failures as
// deploy-fatal or inspects; it must not assume LowerError is the only inhabitant.
function lowering(root: ModuleNode, config: PrismaAppConfig, opts: LowerOptions):
  Effect.Effect<undefined, LowerError, unknown>
```

`lower()` is nothing but the whole-stack wrapper:
`Alchemy.Stack(opts.name, { providers: mergedProviders(config), state: opts.state ?? config.state() }, lowering(root, config, opts))`
— Alchemy requires a state layer; the config supplies the deploy's one state store
and an explicit `opts.state` always wins. Providers are **every configured
extension's** `providers()` merged in config-array order, with no
used-extensions-only filtering (ADR-0017's pinned-providers rule); an extension
that declares none is skipped. Two type-level notes the wrapper carries (both
commented at the single site): a `LowerError` is fatal at deploy (`Effect.orDie`),
and the effect's requirements channel is narrowed to what `Alchemy.Stack` accepts
— `lowering()` itself stays `unknown`-requirements for composability.
In the mixed case the hand-written stack supplies providers itself, yields a
`lowering(…)` per framework-authored service, and wires its own resources around
the nodes it composes.

**Core's deploy-path sequencing** — the control flow no extension can misorder.
First, each extension's `application.provision` runs once (the Project reference,
with the poison `DATABASE_URL` variables). Then walk the graph in topological
order (the module body's provision order; the dependency DAG Load validated). Each
module-provisioned **resource** lowers exactly once via its extension's
`nodes[type]` `{ kind: "resource" }` entry (e.g. one Database + Connection — its
`outputs` carry the url), no matter how many services consume it; dependency-slot
nodes are edges only and never lower. Then for each service:

1. `provision` — the service now has identity (its App).
2. core **builds the typed `Config`** — each input's declared params matched by
   name to its producer's `outputs` through the one `dependency` edge:
   whatever the module wired in — a resource's outputs (shared by every consumer
   wired to it) or a producer service's deploy outputs (the producer, earlier in
   topo order, is already fully deployed — its URL is real, not the create-time
   placeholder) — plus service-param defaults. Leaf values are provisioning refs,
   not strings.
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
  if (opts?.name !== undefined) return resource({ name: opts.name, extension: "@prisma/composer-prisma-cloud", provides: postgresContract })
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
  name: string
  deps: D
  build: BuildAdapter
}): RunnableServiceNode<D, typeof computeParams> => {
  const node = service({
    name: def.name, extension: "@prisma/composer-prisma-cloud", type: "compute", inputs: def.deps, params: computeParams, build: def.build,
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

Control entry (`@prisma/composer-prisma-cloud/control`) — the extension
descriptor `prisma-composer.config.ts` lists, and the only place `@internal/lowering`
is imported. Each node kind's hooks live in their own descriptor file; the
descriptor stitches them into one `nodes` registry:

```ts
import * as Effect from "effect/Effect"
import * as Prisma from "@internal/lowering"
import type { ExtensionDescriptor } from "@prisma/composer/config"

export interface PrismaCloudOptions {
  workspaceId?: string             // defaults to PRISMA_WORKSPACE_ID
  region?: Prisma.ComputeRegion    // the pack imports prisma-alchemy freely — use its union
}

// The application's own product, typed by THIS extension because it is the only
// reader (ADR-0033). Core hands ctx.application over as `unknown`; the guard
// below narrows it back — nothing in core ever reads `projectId`.
interface CloudApplication { readonly projectId: string }
const projectIdOf = (application: unknown): string => {
  if (typeof application !== "object" || application === null || !("projectId" in application))
    throw new Error("prisma-cloud: the application hook must run before any node lowers")
  return (application as CloudApplication).projectId
}

export const prismaCloud = (opts: PrismaCloudOptions = {}): ExtensionDescriptor => {
  const o = resolveOptions(opts)   // reads PRISMA_WORKSPACE_ID/REGION/PROJECT_ID; fails fast, naming the var
  return {
    id: "@prisma/composer-prisma-cloud",   // what a node's `extension` field is matched against

    // Merged across every configured extension in config order (a commented cast
    // bridges prisma-alchemy's provider collection to Stack's Layer — an upstream
    // typings gap, kept in the pack, never in core).
    providers: () => Prisma.providers() as unknown as Layer.Layer<never>,

    // Deploy-time prerequisite check (ADR-0029): the CLI runs it once, after the
    // Project/Branch are resolved and before any stack file or Alchemy — it
    // verifies every secret the provision manifest needs exists, throwing to abort.
    preflight: (input) => runPreflight(input),

    // Runs ONCE per lowering, before any node — REFERENCES the CLI-ensured Project
    // (it no longer creates one) and writes the poison DATABASE_URL variables so
    // nothing can rely on the platform default. Its product reaches this
    // extension's own nodes via ctx.application.
    application: {
      provision: () =>
        Effect.gen(function* () {
          const projectId = o.projectId    // set by the CLI in the deploy env; required
          for (const key of ["DATABASE_URL", "DATABASE_URL_POOLED"]) {
            yield* Prisma.EnvironmentVariable(`${key}-poison`, {
              projectId, key, value: "-", class: "production",  // "-": the API rejects "" (verified at the deploy proof)
            })
          }
          return { projectId } satisfies CloudApplication
        }),
    },

    // ADR-0031: this extension's param provisioners, keyed by need brand. Core
    // resolves a provisioned param's need against the CONSUMER's extension — this
    // one — and mints one value per dependency edge.
    provisions: new Map([[RPC_PEER_KEY, serviceKeyProvisioner]]),

    // ONE registry, keyed by within-extension node id. `kind` is checked at every
    // lookup; a build adapter is an extension's node too (its /control adds one).
    nodes: {
      // A resource's descriptor IS the lowering function, tagged kind:"resource"
      // (Object.assign — a resource lowers once). Returns a LoweredResult: OUTPUTS
      // for dependents (resolved by param name), plus the ENTITIES it became on the
      // deployment target. No `url` entity — a connection string is not a public
      // endpoint, and only this descriptor could know that (ADR-0033). `id` is the
      // module provision id (e.g. "db"), so a resource shared by several consumers
      // is created exactly once.
      postgres: Object.assign(
        ({ id, application }) =>
          Effect.gen(function* () {
            const db = yield* Prisma.Database(`${id}-db`, { projectId: projectIdOf(application), name: id })
            const conn = yield* Prisma.Connection(`${id}-conn`, { databaseId: db.id, name: id })
            const warm = yield* Prisma.PgWarm(`${id}-warm`, { url: conn.connectionString })  // FT-5226 cold-start
            return { outputs: { url: warm.url }, entities: [{ kind: "postgres-database", id: db.id }] }
          }),
        { kind: "resource" as const },
      ),

      // The phased service SPI (kind: "service"). P = ComputeProvisioned, S =
      // ComputeSerialized — each is the descriptor's OWN handoff type, read only
      // here; core threads them through as `unknown` (ADR-0033).
      compute: {
        kind: "service",

        // The service as a PLACE inside the Project: the App, identity only.
        // serviceId is an Output<string> (an unresolved ref) — the honest type,
        // since the whole stack effect runs before Alchemy applies. projectId is a
        // real string (from the CLI env, not a resource attribute).
        provision: ({ id, application }) =>
          Effect.gen(function* () {
            const svc = yield* Prisma.ComputeService(`${id}-svc`, {
              projectId: projectIdOf(application), name: id, region: o.region ?? "us-east-1",
            })
            return { serviceId: svc.id, projectId: projectIdOf(application) }  // : ComputeProvisioned
          }),

        // Encode the typed Config into the runtime environment — one env var per
        // leaf, keyed by the SAME serializer run() reads with at boot. Values are
        // the provisioning refs core built the Config from, so each env var depends
        // on its resource/producer (the ordering edges). Returns the records deploy
        // must depend on, plus the resolved listen port.
        serialize: ({ address, node }, provisioned, config) =>
          Effect.gen(function* () {
            const records = []
            for (const d of configOf(node)) {
              const value = d.owner === "service" ? config.service[d.name] : config.inputs[d.owner.input]?.[d.name]
              if (value === undefined) continue
              records.push(yield* Prisma.EnvironmentVariable(`${configKey(address, d)}-var`, {
                projectId: provisioned.projectId, key: configKey(address, d),
                value: encode(d.owner, value), class: "production",
              }))
            }
            const port = typeof config.service.port === "number" ? config.service.port : 3000
            return { environment: records, port }   // : ComputeSerialized → deploy's edges
          }),

        // Print the bootstrap (address + boot import baked in) and assemble the
        // deployable artifact from the build adapter's normalized bundle dir:
        // bootstrap.js + compute.manifest.json beside the app's entry + wrapper,
        // deterministic tar.gz. The whole envelope is the pack's — target vocabulary.
        package: ({ id }, { assembled, address }) =>
          Effect.try(() => Prisma.packageComputeArtifact({ id, bundleDir: assembled.dir, appEntry: assembled.entry, address })),

        // version → upload → start → promote. The environment prop references
        // serialize's records, so the version depends on them (the edge that kills
        // PRO-211). Returns a LoweredResult: `url` IS published here — a Compute
        // service's deployed URL is a public endpoint, and this descriptor is the
        // only party that knows it. Both fields are still Output refs until apply.
        deploy: ({ id }, provisioned, artifact, serialized) =>
          Effect.gen(function* () {
            const deployment = yield* Prisma.Deployment(`${id}-deploy`, {
              computeServiceId: provisioned.serviceId,   // Input<string> accepts the Output ref — no cast
              artifactPath: artifact.path, artifactHash: artifact.sha256,
              environment: serialized.environment, port: serialized.port,
            })
            return {
              outputs: { url: deployment.deployedUrl, projectId: provisioned.projectId },
              entities: [{ kind: "compute-service", id: provisioned.serviceId, url: deployment.deployedUrl }],
            }
          }),
      },
    },
  }
}
```

There is **no public runtime entry**: the boot loop rides on the node itself
(`compute()` returns the runnable subclass; `.run(address, boot)` + `.load()` are
the whole thing), so the wrapper bundle carries the runtime with a single copy of
core and the bootstrap needs nothing but `./main.js` and a dynamic import of the
app's entry.

## The build adapter — worked instances

A build adapter is a two-piece package: a **lean authoring descriptor** carried on
the service node, and a **heavy deploy-side assembler** invoked at `package` time.
The assembler normalizes the app's own build output into a bundle dir with the
framework wrapper, and reports the runtime entry path.

```ts
// @prisma/composer/node — the authoring descriptor (lean; rides in service.ts). `entry`
// resolves relative to dirname(module) — exactly like an import specifier.
// `extension` + `type` are baked in by this factory, not passed by the caller —
// together they are the control-plane registry key (ADR-0017).
export default (opts: { module: string; entry: string }): BuildAdapter =>
  ({ extension: "@prisma/composer/node", type: "node", module: opts.module, entry: opts.entry })

// @prisma/composer/nextjs — carries an extra `appDir` (the Next app's root, the
// standalone layout root), also resolved relative to dirname(module). `entry`
// is a bare filename inside the standalone output dir.
export default (opts: { module: string; appDir: string; entry: string }): NextjsBuildAdapter =>
  ({ extension: "@prisma/composer/nextjs", type: "nextjs", module: opts.module, appDir: opts.appDir, entry: opts.entry })

// @internal/assemble — looks each service's `build` descriptor up in the
// configured extensions' registries by its (extension, type) pair and runs the
// `{ kind: "build" }` entry it finds — never a hardcoded kind→package map, never a
// computed import. The assembler itself is registered in the adapter's /control
// entry (@prisma/composer/node/control), heavy, deploy-machine only:
type Assembler =
  { assemble(input: AssembleInput): Promise<Bundle> }  // { build } → { dir, entry } — the shared contract, defined once in /deploy
// No serviceDir/serviceModule input: the descriptor's own `module` is the anchor.
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

// The app builds itself first (its own bundler produces dist/server.js), then:
//
//   prisma-composer deploy src/module.ts
//
// The application is derived from the module root (ADR-0003); the extension list
// and state store come from prisma-composer.config.ts at the app root (ADR-0017),
// whose /control entries the CLI loads. It runs each service's assembly and drives
// Alchemy — no bundle map, no hand-written stack file.
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
   descriptor entries. Every extension's `/control` entry is loaded only by the
   config and is deploy-only, so it is exempt (ADR-0017).
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
   Drivers and server APIs enter only from app files; the adapters' `/control`
   entries may use `node:fs` (deploy machine only); the import-guard test extends
   to `"bun"`/`node:` tokens for every execution-plane entry.

## Extension points (designed for, not yet built)

- **Build-adapter ecosystem** — `node` and `nextjs` are the first two; the
  descriptor/assembler split is the seam for community adapters (Nuxt, TanStack
  Start, a cron access-pattern, a static site). Each is a package the app lists in
  its `prisma-composer.config.ts`; nothing in core, the prisma-cloud extension,
  `@internal/assemble`, or the CLI changes to add one — the assembler is a
  `{ kind: "build" }` entry in the adapter's own `/control` registry, found by the
  build descriptor's `(extension, type)` pair (ADR-0017), exactly like every other
  node kind.
- **Framework-hosted DI is `load()`** — the Next page pulls its typed deps via
  `service.load()`, the same mechanism the Hono entry uses. No separate `use()`
  accessor is needed; the earlier framework-DI gap is closed by `load()`.
- **Typed connection interfaces — shipped as Contracts.** A service-to-service
  dependency is declared against a Contract (`@prisma/composer/service-rpc`'s `contract()` +
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
