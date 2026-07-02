# Core model — classes and data structures

The complete type-level design of `@makerkit/core` and the target-pack contract,
with `@makerkit/prisma-cloud` as the worked instance. This is the implementation
design under [`core-and-targets.md`](../03-domain-model/core-and-targets.md): that
doc says *what* the split is; this one says exactly *which types exist, what fields
they carry, and who imports what*. Scope: the current model — one Service with
Resource inputs; Hex and Connections are named as extension points.

## Package and entry map

Six entry points, split by dependency weight. The split is enforced, not aspirational
(see § Invariants).

| Entry | Exports | Imports (weight) |
| --- | --- | --- |
| `@makerkit/core` | node factories (`service`, `resource`), `Load`, model types | nothing |
| `@makerkit/core/lower` | `lower()`, `Target` types | `alchemy`, `effect` |
| `@makerkit/core/runtime` | `runHost()`, `TargetRuntime` types | nothing |
| `@makerkit/prisma-cloud` | `compute()`, `postgres()` | `@makerkit/core` only |
| `@makerkit/prisma-cloud/target` | `prismaCloud()` | `@makerkit/prisma-alchemy`, `alchemy`, `effect` |
| `@makerkit/prisma-cloud/runtime` | `runtime()` | nothing — the DB client factory is app-supplied |

Per the [runtime-agnostic
principle](../01-principles/architectural-principles.md), no entry imports Bun or
Node APIs — not even type-only. Runtime-specific code (the DB driver, the server
API) appears only in **app files**.

Who imports what, end to end:

- the **user's service module** imports only `@makerkit/prisma-cloud` (lean);
- the **deploy script** (`alchemy.run.ts`) imports the service module +
  `@makerkit/core/lower` + `@makerkit/prisma-cloud/target` (heavy — deploy-time only);
- the **runtime bundle entry** (`main.ts`, app-owned) imports the service module +
  `@makerkit/core/runtime` + `@makerkit/prisma-cloud/runtime`, plus the app's own
  driver import (the client factory it hands to `runtime()`).

The deploy path never loads the DB driver; the runtime bundle never contains Alchemy.

## Decision taken: Alchemy is core's provisioning substrate

`@makerkit/core/lower` imports `alchemy`/`effect`. The architectural principle
forbids core knowledge of **deployment targets** (Prisma Cloud); Alchemy is not a
target — it is the provisioning plane [`layering.md`](../03-domain-model/layering.md)
already commits to (claim 3: MakerKit uses Alchemy's definition language *and*
engine). Putting the engine in core means every target pack supplies only data
(providers + lowerings) instead of re-implementing apply/state. The swap test still
holds: replacing `@makerkit/prisma-cloud` with another pack changes nothing in core.

## Core model types (`@makerkit/core`)

All nodes are **plain, frozen, serializable data** — with one exception: a Service
node carries the user's handler, the single function reference in the model. A
node's `type` is its routing key; core never interprets it beyond lookup.

```ts
// JSON-safe config values
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }
type JsonObject = { [k: string]: JsonValue }

// Brand — set by the factories below; how Load tells a node from junk.
// Symbol.for so the check survives duplicated module instances in a workspace.
const NODE: unique symbol = Symbol.for("makerkit:node") as never

interface NodeBase {
  readonly [NODE]: true
  readonly kind: "service" | "resource"        // "hex" later — see § Extension points
  readonly type: string                        // routing key, e.g. "prisma-cloud/postgres"
  readonly config?: JsonObject                 // constructor opts, opaque to core
}

// A Resource a service depends on. H is the phantom hydrated-client type:
// declared type-only, never set at runtime, erased at compile — it is what
// makes `({ db }) => db`select 1`` typecheck without runtime code in the node.
interface ResourceNode<H = unknown> extends NodeBase {
  readonly kind: "resource"
  readonly __hydrated?: H                      // phantom only
}

// A Service: inputs + the opaque handler. This IS the user's default export —
// inspectable (inputs/type/config) and runnable (run), inert until invoked.
// There is no separate handle type: the node is the handle.
interface ServiceNode<D extends Deps = Deps> extends NodeBase {
  readonly kind: "service"
  readonly inputs: D
  run(deps: HydratedDeps<D>, ctx: RuntimeContext): unknown   // the one non-data member
}

// Dependency map: name → ResourceNode. Widens to connection ends when Connections arrive.
type Deps = Record<string, ResourceNode<any>>   // `any`, not `unknown` — keeps phantom inference

type Hydrated<N> = N extends ResourceNode<infer H> ? H : never
type HydratedDeps<D extends Deps> = { readonly [K in keyof D]: Hydrated<D[K]> }

// What the host provides a running service besides its deps. Core defines the
// shape; the target's runtime supplies the values (see TargetRuntime.context).
interface RuntimeContext { readonly port: number }

type ServiceHandler<D extends Deps> = (deps: HydratedDeps<D>, ctx: RuntimeContext) => unknown
```

### Node factories

Target packs do not hand-roll node objects — they call core's factories, which brand,
validate, and freeze. This is the whole "framework provides / pack wraps" contract:

```ts
// @makerkit/core
function resource<H>(def: { type: string; config?: JsonObject }): ResourceNode<H>

function service<D extends Deps>(def: {
  type: string
  inputs: D
  handler: ServiceHandler<D>
  config?: JsonObject
}): ServiceNode<D>
```

`service()` stores `handler` as the node's `run` and freezes `inputs`. Both throw on
an empty `type`. Nothing executes: constructing nodes is pure.

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

## Lowering (`@makerkit/core/lower`)

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

## Runtime (`@makerkit/core/runtime`)

The dumb loop. Symmetric to lowering: look up each input's `type` in the target's
hydrator table.

```ts
type Env = Record<string, string | undefined>

interface TargetRuntime {
  readonly hydrate: Record<string, Hydrator>            // type id → hydrator
  context(env: Env): RuntimeContext                     // e.g. PORT → { port } — platform convention lives in the pack
}

type Hydrator = (ctx: HydrateContext) => unknown

interface HydrateContext {
  readonly id: NodeId
  readonly input: string                                 // the input name, e.g. "db"
  readonly node: ResourceNode
  readonly env: Env
}

// Load(root) → hydrate each input via runtime.hydrate[node.type] →
// root.run(hydratedDeps, runtime.context(env)). Unknown type → HydrateError.
function runHost(root: ServiceNode, runtime: TargetRuntime, env?: Env): unknown  // env defaults to process.env
class HydrateError extends Error {}
```

`runHost` is the **only** place `process.env` enters the system (as the default
`env`), and it hands it straight to the target's hydrators/context. Load runs before
any hydration — the wiring-precedes-execution principle, mechanically.

## The Prisma Cloud pack (`@makerkit/prisma-cloud`) — worked instance

Authoring entry — data only:

```ts
import { resource, service, type Deps, type ServiceHandler, type ServiceNode } from "@makerkit/core"

// C is the app-declared client type — whatever the app's client factory (see
// runtime()) produces. The pack fixes neither the driver nor the JS runtime.
export const postgres = <C = unknown>(): ResourceNode<C> =>
  resource<C>({ type: "prisma-cloud/postgres" })

export const compute = <D extends Deps>(deps: D, handler: ServiceHandler<D>): ServiceNode<D> =>
  service({ type: "prisma-cloud/compute", inputs: deps, handler })
```

Target entry — the lowering table (the only place `prisma-alchemy` is imported):

```ts
import * as Effect from "effect/Effect"
import * as Prisma from "@makerkit/prisma-alchemy"
import type { Target } from "@makerkit/core/lower"

export interface PrismaCloudOptions {
  workspaceId: string
  region?: Prisma.ComputeRegion   // the pack imports prisma-alchemy freely — use its union
}

export const prismaCloud = (o: PrismaCloudOptions): Target => ({
  name: "prisma-cloud",
  providers: () => Prisma.providers(),
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
        return { outputs: { url: deploy.deployedUrl } }
      }),
  },
})
```

Runtime entry — the hydrator table. The pack owns the **platform convention**
(Compute injects `DATABASE_URL`); the **client** that wraps the connection is
app-supplied — MakerKit ships no driver:

```ts
import type { TargetRuntime } from "@makerkit/core/runtime"

export interface PostgresConfig { readonly url: string }

export interface RuntimeOptions {
  readonly clients: {
    readonly postgres: (config: PostgresConfig) => unknown   // the app's driver choice
  }
}

export const runtime = (o: RuntimeOptions): TargetRuntime => ({
  context: (env) => ({ port: intOr(env.PORT, 3000) }),
  hydrate: {
    "prisma-cloud/postgres": ({ env, input }) => {
      const url = env.DATABASE_URL
      if (!url) throw new HydrateError(`input "${input}": DATABASE_URL is not set`)
      return o.clients.postgres({ url })
    },
  },
})
```

## The app, end to end

Three app-owned files; bundling stays hand-rolled in the app:

```ts
// src/service.ts — the authored service (lean imports; the app declares its client type)
import { compute, postgres } from "@makerkit/prisma-cloud"
import type { SQL } from "bun"        // the APP's choice of client — type-only here

export default compute({ db: postgres<SQL>() }, ({ db }, { port }) =>
  Bun.serve({ port, hostname: "0.0.0.0",
    fetch: async () => Response.json(await db`select 1 as ok`) }))

// src/main.ts — runtime bundle entry (app-owned); the driver import lives HERE
import service from "./service"
import { runHost } from "@makerkit/core/runtime"
import { runtime } from "@makerkit/prisma-cloud/runtime"
import { SQL } from "bun"

runHost(service, runtime({ clients: { postgres: ({ url }) => new SQL({ url }) } }))

// alchemy.run.ts — deploy (heavy imports; never bundled)
import service from "./src/service"
import { lower } from "@makerkit/core/lower"
import { prismaCloud } from "@makerkit/prisma-cloud/target"
export default lower(service, prismaCloud({ workspaceId: requiredEnv("PRISMA_WORKSPACE_ID") }), {
  name: "hello",
  artifact: { path: "dist/hello.tar.gz", sha256: sha256File("dist/hello.tar.gz") },
})
```

The app's build script bundles `src/main.ts`, writes `compute.manifest.json`
pointing at the bundle, and tars — ~10 lines the app owns, not MakerKit.

Note where Bun appears: only in these app files (`Bun.serve` in the handler, `new
SQL` in `main.ts`) — the app's choice, since it deploys to a platform whose runtime
is Bun. Switching the client to node-postgres, or the app to a Node platform, changes
these app lines and nothing in MakerKit.

## Invariants (enforced, not aspirational)

1. **Core has no target dependency**: `@makerkit/core`'s `package.json` depends on
   neither `@makerkit/prisma-alchemy` nor any `prisma-*` package — checked by a test.
2. **Authoring imports stay lean**: bundling a module that imports `@makerkit/core`
   and `@makerkit/prisma-cloud` (authoring entries only) contains no
   `alchemy`/`effect`/`prisma-alchemy`/`new SQL(` tokens — the existing import-split
   guard test, extended to the pack.
3. **Importing runs nothing**: constructing nodes is pure; only `runHost`/the alchemy
   CLI execute anything.
4. **`process.env` appears exactly once** in the system — `runHost`'s default `env`
   parameter. User code and core contain no other reads; hydrators receive `env`
   explicitly.
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
- **Registry exhaustiveness** — `Target.lower` / `TargetRuntime.hydrate` are
  string-keyed records; a pack can tighten them to its own type-id union for
  compile-time exhaustiveness. Core stays stringly-typed by design (it routes).
- **Client-factory typing** — `postgres<C>()` declares the hydrated type; the factory
  the app passes to `runtime()` is what actually produces it. Today that agreement is
  a documented trust boundary; tying the factory's return type to the declared
  phantom (so a mismatch fails at compile) is additive.
- **Serialized topology** — the topology view of Graph is already JSON-safe; an emit
  step for external tooling is additive.

## Related

- [`../03-domain-model/core-and-targets.md`](../03-domain-model/core-and-targets.md) — the architectural split this implements.
- [`../03-domain-model/authoring-surface.md`](../03-domain-model/authoring-surface.md) — the developer-facing narrative.
- [`../03-domain-model/layering.md`](../03-domain-model/layering.md) — Alchemy as the provisioning plane (claim 3).
