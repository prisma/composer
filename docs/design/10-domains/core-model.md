# Core model — classes and data structures

The complete type-level design of `@makerkit/core` and the target-pack contract,
with `@makerkit/prisma-cloud` as the worked instance. This is the implementation
design under [`core-and-targets.md`](../03-domain-model/core-and-targets.md): that
doc says *what* the split is; this one says exactly *which types exist, what fields
they carry, and who imports what*. Scope: the current model — one Service with
Resource inputs; Hex and Connections are named as extension points.

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
| **execution** | run it — `runHost`, the config pipeline | `/runtime` |

**`/control` is reserved as the settled design direction**: today the control
surface is two pure, lean functions, too little to justify its own entry — but
the moment it grows (the queryable-topology emit, config-manifest tooling, graph
transforms when Hexes arrive), it carves out of `.` into `@makerkit/core/control`.
The boundary is decided; only the carve is deferred.

| Entry | Exports | Imports (weight) |
| --- | --- | --- |
| `@makerkit/core` | node factories (`service`, `resource`), `Load`, `configOf`, model types | nothing |
| `@makerkit/core/deploy` | `lower()`, `Target` types | `alchemy`, `effect` |
| `@makerkit/core/runtime` | `runHost()` | nothing |
| `@makerkit/prisma-cloud` | `compute()`, `postgres({ client })` | `@makerkit/core` only |
| `@makerkit/prisma-cloud/target` | `prismaCloud()` | `@makerkit/prisma-alchemy`, `alchemy`, `effect` |

Per the [runtime-agnostic
principle](../01-principles/architectural-principles.md), no entry imports Bun or
Node APIs — not even type-only. Runtime-specific code (the DB driver, the server
API) appears only in **app files**. The pack has no runtime entry at all: everything
a node needs at boot rides on the node itself (see § Runtime), so the pack splits
into just authoring (lean) and target (heavy, deploy-only).

Who imports what, end to end:

- the **user's service module** imports `@makerkit/prisma-cloud` plus the app's own
  connection definitions (which hold the driver import);
- the **deploy script** (`alchemy.run.ts`) imports the service module +
  `@makerkit/core/deploy` + `@makerkit/prisma-cloud/target` (heavy — deploy-time only);
- the **runtime bundle entry** (`main.ts`, app-owned) imports the service module +
  `@makerkit/core/runtime` — nothing else.

The runtime bundle never contains Alchemy. One accepted consequence: because
connections close over the app's client factory, the deploy script *loads* (never
uses) the driver when it imports the service module — fine under Bun, and mitigable
with a lazy import inside the factory if it ever matters.

## Decision taken: Alchemy is core's provisioning substrate

`@makerkit/core/deploy` imports `alchemy`/`effect`. The architectural principle
forbids core knowledge of **deployment targets** (Prisma Cloud); Alchemy is not a
target — it is the provisioning plane [`layering.md`](../03-domain-model/layering.md)
already commits to (claim 3: MakerKit uses Alchemy's definition language *and*
engine). Putting the engine in core means every target pack supplies only data
(providers + lowerings) instead of re-implementing apply/state. The swap test still
holds: replacing `@makerkit/prisma-cloud` with another pack changes nothing in core.

## Core model types (`@makerkit/core`)

All nodes are **plain, frozen, serializable data** — with exactly **three
sanctioned behavior slots** hanging off the graph: the Service node's handler
(`run`), a Connection's `hydrate` (validated values → client), and the Service's
`ConfigAdapter` (the platform's config I/O). Config *declarations* are pure data;
only the adapter touches a real environment. The topology view simply drops the
function slots. A node's `type` is its routing key at deploy; core never
interprets it beyond lookup.

```ts
// Brand — set by the factories below; how Load tells a node from junk.
// Symbol.for so the check survives duplicated module instances in a workspace.
const NODE: unique symbol = Symbol.for("makerkit:node") as never

interface NodeBase {
  readonly [NODE]: true
  readonly kind: "service" | "resource"        // "hex" later — see § Extension points
  readonly type: string                        // routing key, e.g. "prisma-cloud/postgres"
}

// ——— Configuration model (core-owned pipeline; see § Runtime) ———
//
// Three components, each owned by exactly one party:
//   1. DECLARE — nodes carry semantic param declarations (names + runtime type
//      tags). Target-independent: no platform key names anywhere in the graph.
//   2. GET — core collects declarations and asks the service's ConfigAdapter
//      (pack-provided) for raw values, then validates them against the tags.
//   3. SET — the same adapter concept writes config: in-memory for tests, the
//      deploy plane for real environments (the two-readers idea applied to
//      config — get and set share one mapping, so they cannot drift).

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

// The platform's config I/O, pack-provided and attached to the service node by
// its constructor. The mapping between semantic params and physical locations
// (e.g. url ↔ DATABASE_URL) is the adapter's PRIVATE business — core never sees
// platform keys. The adapter owns its source: the platform adapter is the one
// sanctioned environment reader; an in-memory test adapter reads nothing.
interface ConfigAdapter {
  get(requests: readonly ConfigRequest[]): Promise<Readonly<Record<string, string>>>
                                               // raw values keyed by request id; core validates/coerces
  set?(values: Readonly<Record<string, string>>): Promise<void>   // tests · deploy plane
  describe?(request: ConfigRequest): Promise<{ location: string }> // ops: "which env var is this?"
}
interface ConfigRequest {
  readonly id: string                          // core-assigned; keys the returned value map
  readonly owner: "service" | { readonly input: string }
  readonly name: string
  readonly param: ConfigParam
}

// ——— Nodes ———

// A Resource a service depends on, carrying its connection face. C flows from
// the connection's hydrate return type into the handler's parameter.
interface ResourceNode<C = unknown> extends NodeBase {
  readonly kind: "resource"
  readonly connection: Connection<Params, C>
}

// A Service: inputs + its own declared params + the platform's ConfigAdapter +
// the opaque handler. This IS the user's default export — inspectable
// (inputs/type/params) and runnable (run), inert until invoked. There is no
// separate handle type: the node is the handle.
interface ServiceNode<D extends Deps = Deps, P extends Params = Params> extends NodeBase {
  readonly kind: "service"
  readonly inputs: D
  readonly params: P                           // service-level config (e.g. port) — no special "context" concept
  readonly config: ConfigAdapter               // how this service GETS its config on this platform
  run(deps: HydratedDeps<D>, ctx: Values<P>): unknown
}

// Dependency map: name → ResourceNode. Widens to full connection ends when
// Connections become first-class (service-to-service).
type Deps = Record<string, ResourceNode<any>>   // `any`, not `unknown` — keeps inference

type Hydrated<N> = N extends ResourceNode<infer C> ? C : never
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
  config: ConfigAdapter
  handler: ServiceHandler<D, P>
}): ServiceNode<D, P>
```

`service()` stores `handler` as the node's `run` and freezes `inputs`/`params`;
`resource()` freezes the connection's declared params. Both throw on an empty
`type`. Nothing executes: constructing nodes is pure.

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

Load walks `root.inputs`, assigns ids, builds edges, and **validates**: the root is a
branded `kind: "service"` node; every input value is a branded `kind: "resource"`
node with a non-empty `type`. (When Connections arrive, Load additionally checks:
connection ends directionally valid, interfaces compatible, nothing dangling.) Load
executes nothing — the graph
is data in memory to inspect or hand to `lower`/`runHost`. A **topology view** —
nodes as `{ id, kind, type, config }` plus edges, handler dropped — is
`JSON.stringify`-able by construction; the serialized-artifact emit step builds on
this later.

## Lowering (`@makerkit/core/deploy`)

The router. Core's only job at deploy: Load, then look up each node's `type` in the
target's lowering table and run what it finds, deps before dependents.

```ts
import type { Layer } from "effect"
import type { Effect } from "effect"

// What a target pack's /target entry produces — data + per-type functions.
interface Target {
  readonly name: string
  providers(): Layer.Layer<never>                       // the pack's Alchemy providers
  readonly lower: Record<string, Lowering>              // type id → lowering
}

// One node's realization. Runs inside the Alchemy stack effect; yields the
// pack's Alchemy resources. Core never looks inside.
type Lowering = (ctx: LowerContext) => Effect.Effect<LoweredNode, unknown, unknown>

interface LowerContext {
  readonly id: NodeId
  readonly node: ServiceNode | ResourceNode
  readonly graph: Graph
  readonly opts: LowerOptions
  readonly lowered: ReadonlyMap<NodeId, LoweredNode>    // already-lowered deps (topo order)
}

// What a lowering hands downstream — e.g. a deployed URL a later node's env
// wiring consumes. The inter-node config-wiring hook for Connections.
interface LoweredNode { readonly outputs: Readonly<Record<string, unknown>> }

interface LowerOptions {
  readonly name: string                                  // stack + root node id
  readonly artifact: { readonly path: string; readonly sha256: string }  // app-built bundle
  readonly stage?: string
  readonly state?: AlchemyStateLayer                     // default: localState(); the
                                                         // hosted-state store slots in here
}

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

Notes:

- **Target-specific identity** (workspace id, region) never appears in
  `LowerOptions` — it is captured by the pack's target constructor
  (`prismaCloud({ workspaceId })`). Core's options are target-neutral.
- **The artifact is an input, not a product.** The app bundles (tsdown, Bun.build,
  whatever) and passes path + sha256. Core has no build step; the hash in the
  options is what makes a rebuild register as a change.

## Runtime: the config pipeline (`@makerkit/core/runtime` + `configOf` in core)

At boot, three things have to happen: obtain this platform's config values, turn
them into clients, and call the handler. The responsibilities are split so that
**core owns config management end to end** while caring nothing about the mapping:

- **declarations** (connections' `params`, the service's own `params`) say *what*
  is needed — semantic names + runtime type tags. Target-independent data.
- the **`ConfigAdapter`** (pack-provided, on the service node) answers *get* and
  *set* for its platform; the semantic↔physical mapping is its private business.
- **core** does everything in between: enumerate, request, validate, coerce,
  intercept, distribute, call.

```ts
// The enumerable config surface of a service — derivable from the graph alone,
// nothing booted, no platform keys. The introspection artifact (secrets marked,
// values absent). Physical locations are the adapter's business (describe()).
interface ConfigManifestEntry {
  readonly owner: "service" | { readonly input: string }
  readonly name: string              // "url" · "port"
  readonly type: ParamType
  readonly secret: boolean
  readonly optional: boolean
  readonly default?: string | number
}
function configOf(root: ServiceNode): readonly ConfigManifestEntry[]   // in @makerkit/core (pure)

// Boot: Load → configOf → adapter.get(requests) → per-param: override ?? raw ??
// default → validate + coerce against the declared type. Validation rules:
//   · "" is UNRESOLVED, not a value — it falls to the default or, if required,
//     joins the missing set;
//   · a NON-EMPTY value that fails its declared type is an ERROR regardless of
//     any default — a default substitutes for absence, never for garbage;
//   · unknown override keys are errors (a typoed override must not silently
//     fall through to the platform value).
// ALL problems reported in one ConfigError, before any hydrate
// (Load-before-Hydrate applied to config) → per input:
// await connection.hydrate(typedValues) → root.run(deps, serviceParamValues).
function runHost(root: ServiceNode, opts?: {
  config?: ConfigAdapter                       // swap the platform adapter: in-memory tests, inspection harnesses
  overrides?: Record<string, string | number>  // per-param overrides, applied before the adapter is
                                               // consulted; keyed "input.param" (dotted) for input params,
                                               // bare "param" for service-level params
}): Promise<unknown>
class ConfigError extends Error {}             // names every missing/invalid/unknown param at once
```

Core and user code contain **zero** environment reads: the platform's adapter is
the single sanctioned reader for its platform (an in-memory test adapter reads
nothing). Because core is the single resolver, there is one choke point for
interception: tests override per-param or swap the adapter entirely; a production
host can report its resolved config with secrets redacted by construction
(`secret` is declared on the param).

**Motivation (why this shape, recorded).** Two discarded iterations:

*First*, a pack-exported `runtime()` carrying a type-id–keyed hydrator table plus
app-supplied client factories. Discarded because: (1) an opaque `env → config`
provider loses the config surface — no enumeration, no interception point, no
introspection of a running service; (2) it made the pack a second environment
reader; (3) composition across packs required merging registries, where the
node-carried design composes structurally; (4) the app-declared phantom client
type (`postgres<SQL>()`) created a declared-vs-actual trust boundary that factory
inference eliminates; (5) it contradicted the settled decision that *MakerKit
manages the config-to-input mapping*.

*Second*, a `HostConvention` on the service node — addressing as data (channel
enum + a `key(input, field)` naming rule + context fields). Discarded because:
(1) it baked **platform key names into the graph**, coupling every service's
config surface to its target — declarations should be target-independent; (2)
the `channel` discriminator was an enum-switch waiting to grow inside core,
against "compose, don't special-case"; (3) it had no *write* side — tests,
deploy-plane config creation, and inspection all need `set`, which an addressing
rule can't express. The adapter model keeps declarations semantic, makes the
mapping the adapter's private business, and gives get/set/describe one home per
platform.

## The Prisma Cloud pack (`@makerkit/prisma-cloud`) — worked instance

Authoring entry — nodes carrying their connection/host knowledge; the driver is a
**parameter**, so the pack ships none and the client type is inferred:

```ts
import { resource, service, type Connection, type Deps, type ServiceHandler, type ServiceNode } from "@makerkit/core"

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

const computeParams = { port: { type: "number", default: 3000 } } as const

export const compute = <D extends Deps>(
  deps: D,
  handler: ServiceHandler<D, typeof computeParams>,   // ctx: { port: number }
): ServiceNode<D, typeof computeParams> =>
  service({
    type: "prisma-cloud/compute",
    inputs: deps,
    params: computeParams,
    config: computeAdapter,
    handler,
  })

// The platform adapter — the pack's single environment reader. The semantic↔
// physical mapping (url ↔ DATABASE_URL, port ↔ PORT; per-input naming when
// multiple databases arrive) lives HERE, private to the pack.
const computeAdapter: ConfigAdapter = {
  async get(requests) {
    const values: Record<string, string> = {}
    for (const r of requests) {
      const key = r.name === "url" ? "DATABASE_URL" : r.name.toUpperCase()
      const raw = process.env[key]
      if (raw !== undefined) values[r.id] = raw
    }
    return values
  },
  async describe(r) {
    return { location: `env:${r.name === "url" ? "DATABASE_URL" : r.name.toUpperCase()}` }
  },
}
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
  lower: {
    // For now the postgres input is served by the project's default database
    // (Compute auto-injects DATABASE_URL), so it provisions nothing itself.
    // It becomes a real Database resource when contracts/multiple DBs arrive.
    "prisma-cloud/postgres": () => Effect.succeed({ outputs: {} }),

    // The service is the deployment unit: Project + ComputeService + Deployment.
    "prisma-cloud/compute": ({ id, opts }) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project(`${id}-project`, {
          workspaceId: o.workspaceId, name: id,
        })
        const svc = yield* Prisma.ComputeService(`${id}-svc`, {
          projectId: project.id, name: id, region: o.region ?? "us-east-1",
        })
        const deploy = yield* Prisma.Deployment(`${id}-deploy`, {
          computeServiceId: svc.id,
          artifactPath: opts.artifact.path,
          artifactHash: opts.artifact.sha256,
          port: 3000,
        })
        // outputs are the inter-node config-wiring hook: expose what hand-wired
        // neighbors in a mixed stack need (the URL for consumers; the project id
        // for e.g. an EnvironmentVariable scoped to this service's project).
        return { outputs: { url: deploy.deployedUrl, projectId: project.id } }
      }),
  },
})
```

There is **no runtime entry**: the connection and host knowledge above already
rides on the nodes, so `runHost(service)` needs nothing else. (A missing client
factory is now impossible by construction — `postgres({ client })` requires it at
authoring, at compile time.)

## The app, end to end

Three app-owned files; bundling stays hand-rolled in the app:

```ts
// src/connections.ts — app-owned connection definitions; the driver import lives HERE
import { postgres } from "@makerkit/prisma-cloud"
import { SQL } from "bun"                       // the APP's choice of client

export const db = postgres({ client: ({ url }) => new SQL({ url }) })
// typeof hydrated db = SQL — inferred from the factory, no phantom declaration

// src/service.ts — the authored service
import { compute } from "@makerkit/prisma-cloud"
import { db } from "./connections"

export default compute({ db }, ({ db }, { port }) =>
  Bun.serve({ port, hostname: "0.0.0.0",
    fetch: async () => Response.json(await db`select 1 as ok`) }))

// src/main.ts — runtime bundle entry (app-owned); the whole thing
import service from "./service"
import { runHost } from "@makerkit/core/runtime"

runHost(service)

// alchemy.run.ts — deploy (heavy imports; never bundled)
import service from "./src/service"
import { lower } from "@makerkit/core/deploy"
import { prismaCloud } from "@makerkit/prisma-cloud/target"
export default lower(service, prismaCloud({ workspaceId: requiredEnv("PRISMA_WORKSPACE_ID") }), {
  name: "hello",
  artifact: { path: "dist/hello.tar.gz", sha256: sha256File("dist/hello.tar.gz") },
})
```

The app's build script bundles `src/main.ts`, writes `compute.manifest.json`
pointing at the bundle, and tars — ~10 lines the app owns, not MakerKit.

Note where Bun appears: only in these app files (`Bun.serve` in the handler, `new
SQL` in `connections.ts`) — the app's choice, since it deploys to a platform whose
runtime is Bun. Switching the client to node-postgres, or the app to a Node
platform, changes these app lines and nothing in MakerKit.

And note what a test needs: `runHost(service, { overrides: { "db.url": testUrl } })`
— a per-param override through core's resolver, no environment faked, no cloud.
Or skip `runHost` entirely and call `service.run(fakes, { port: 0 })` with fakes at
the inputs — the same dependency inversion the model promises.

## Invariants (enforced, not aspirational)

1. **Core has no target dependency**: `@makerkit/core`'s `package.json` depends on
   neither `@makerkit/prisma-alchemy` nor any `prisma-*` package — checked by a test.
2. **Authoring imports stay lean**: bundling a module that imports `@makerkit/core`
   and `@makerkit/prisma-cloud` (authoring entries only) contains no
   `alchemy`/`effect`/`prisma-alchemy`/`new SQL(` tokens — the existing import-split
   guard test, extended to the pack.
3. **Importing runs nothing**: constructing nodes is pure; only `runHost`/the alchemy
   CLI execute anything.
4. **Core and user code contain zero environment reads.** The platform adapter is
   the single sanctioned reader for its platform — `process.env` appears exactly
   once per pack, inside its `ConfigAdapter`; an in-memory test adapter reads
   nothing. Declarations, resolution, validation, and distribution never touch an
   environment.
5. **No runtime coupling**: neither core nor a target pack imports Bun or Node APIs
   — even type-only — in its shipped surface (the [runtime-agnostic
   principle](../01-principles/architectural-principles.md)). Drivers and server APIs
   enter only from app files; the import-guard test extends to `"bun"`/`node:`
   tokens.

## Extension points (designed for, not yet built)

- **Hex** — a third `kind: "hex"` node whose body is *transparent*: Load executes it
  (it is wiring, not user code) with a `provision` collector, producing sub-nodes and
  edges in the same Graph. Services stay opaque leaves.
- **Connections/interfaces** — `Deps` values widen from `ResourceNode` to connection
  ends; Load gains interface-compatibility validation; `LoweredNode.outputs` is how a
  provider's deployed address reaches a consumer's config wiring.
- **Registry exhaustiveness** — `Target.lower` is a string-keyed record; a pack can
  tighten it to its own type-id union for compile-time exhaustiveness. Core stays
  stringly-typed by design at deploy (it routes); the runtime side has no registry
  at all — behavior rides the nodes.
- **Deploy-side `set`** — when the Connection primitive wires a producer's URL
  into a consumer (today's hand-wired `AUTH_URL`), the deploy plane writes it
  through the same adapter mapping the runtime reads through — the two readers,
  applied to config, so get and set cannot drift. Per-input key naming (multiple
  databases) also lands privately in the pack adapter when it arrives.
- **`ParamType` growth** — the tag set is `"string" | "number"`, curated; new tags
  (`"boolean"`, `"url"`, …) are added consciously with their validation, never as
  an open plugin surface.
- **Serialized topology** — the topology view of Graph is already JSON-safe; an emit
  step for external tooling is additive.

## Related

- [`../03-domain-model/core-and-targets.md`](../03-domain-model/core-and-targets.md) — the architectural split this implements.
- [`../03-domain-model/authoring-surface.md`](../03-domain-model/authoring-surface.md) — the developer-facing narrative.
- [`../03-domain-model/layering.md`](../03-domain-model/layering.md) — Alchemy as the provisioning plane (claim 3).
