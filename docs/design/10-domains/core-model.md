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
| `@makerkit/core` | node factories (`service`, `resource`), `Load`, `configOf`, model types | nothing |
| `@makerkit/core/lower` | `lower()`, `Target` types | `alchemy`, `effect` |
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
  `@makerkit/core/lower` + `@makerkit/prisma-cloud/target` (heavy — deploy-time only);
- the **runtime bundle entry** (`main.ts`, app-owned) imports the service module +
  `@makerkit/core/runtime` — nothing else.

The runtime bundle never contains Alchemy. One accepted consequence: because
connections close over the app's client factory, the deploy script *loads* (never
uses) the driver when it imports the service module — fine under Bun, and mitigable
with a lazy import inside the factory if it ever matters.

## Decision taken: Alchemy is core's provisioning substrate

`@makerkit/core/lower` imports `alchemy`/`effect`. The architectural principle
forbids core knowledge of **deployment targets** (Prisma Cloud); Alchemy is not a
target — it is the provisioning plane [`layering.md`](../03-domain-model/layering.md)
already commits to (claim 3: MakerKit uses Alchemy's definition language *and*
engine). Putting the engine in core means every target pack supplies only data
(providers + lowerings) instead of re-implementing apply/state. The swap test still
holds: replacing `@makerkit/prisma-cloud` with another pack changes nothing in core.

## Core model types (`@makerkit/core`)

All nodes are **plain, frozen, serializable data** — with exactly **three
sanctioned behavior slots** hanging off the graph: the Service node's handler
(`run`), a Connection's `hydrate` (config → client), and nothing else that
executes; the Service type's config knowledge is *data* (an addressing rule), not
a provider function. The topology view simply drops the function slots. A node's
`type` is its routing key at deploy; core never interprets it beyond lookup.

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

// ——— Configuration model (core-owned; see § Runtime for the pipeline) ———

// A config field a connection needs at boot — declared shape, pure data.
interface ConfigField {
  readonly name: string                        // e.g. "url"
  readonly secret?: boolean                    // redacted in any introspection output
  readonly optional?: boolean
}

// The connection face of a dependency: what it needs (data) and how the needed
// values become a client (the hydrate behavior slot). C is INFERRED from the
// app's factory — no phantom types, no declared-vs-actual trust boundary.
interface Connection<C = unknown> {
  readonly config: readonly ConfigField[]
  hydrate(config: Record<string, string>): C
}

// How a Service KIND's platform delivers config — pack-declared DATA plus a pure
// addressing rule core drives. Core does all reading/resolving; the pack never
// touches an environment.
interface HostConvention {
  readonly channel: "env"                            // the only channel today
  key(input: string, field: string): string          // e.g. (_, "url") => "DATABASE_URL"
  readonly context: readonly ContextField[]          // e.g. [{ name: "port", key: "PORT", default: 3000 }]
}
interface ContextField {
  readonly name: keyof RuntimeContext
  readonly key: string
  readonly default?: string | number
}

// ——— Nodes ———

// A Resource a service depends on, carrying its connection face. C flows from
// the connection's hydrate return type into the handler's parameter.
interface ResourceNode<C = unknown> extends NodeBase {
  readonly kind: "resource"
  readonly connection: Connection<C>
}

// A Service: inputs + host convention + the opaque handler. This IS the user's
// default export — inspectable (inputs/type/host/config) and runnable (run),
// inert until invoked. There is no separate handle type: the node is the handle.
interface ServiceNode<D extends Deps = Deps> extends NodeBase {
  readonly kind: "service"
  readonly inputs: D
  readonly host: HostConvention
  run(deps: HydratedDeps<D>, ctx: RuntimeContext): unknown
}

// Dependency map: name → ResourceNode. Widens to full connection ends when
// Connections become first-class (service-to-service).
type Deps = Record<string, ResourceNode<any>>   // `any`, not `unknown` — keeps inference

type Hydrated<N> = N extends ResourceNode<infer C> ? C : never
type HydratedDeps<D extends Deps> = { readonly [K in keyof D]: Hydrated<D[K]> }

// What the host provides a running service besides its deps. Core defines the
// shape; values resolve through the service's HostConvention.
interface RuntimeContext { readonly port: number }

type ServiceHandler<D extends Deps> = (deps: HydratedDeps<D>, ctx: RuntimeContext) => unknown
```

### Node factories

Target packs do not hand-roll node objects — they call core's factories, which brand,
validate, and freeze. This is the whole "framework provides / pack wraps" contract:

```ts
// @makerkit/core
function resource<C>(def: {
  type: string
  connection: Connection<C>
  config?: JsonObject
}): ResourceNode<C>

function service<D extends Deps>(def: {
  type: string
  inputs: D
  host: HostConvention
  handler: ServiceHandler<D>
  config?: JsonObject
}): ServiceNode<D>
```

`service()` stores `handler` as the node's `run` and freezes `inputs`; `resource()`
freezes the connection's declared fields. Both throw on an empty `type`. Nothing
executes: constructing nodes is pure.

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

At boot, three things have to happen: know where this platform puts config (env
vars, for Compute), turn config values into clients, and call the handler. The
responsibilities are split so that **core owns config management end to end**:

- the **Service type** (pack) declares *where config arrives* — the
  `HostConvention`: channel + addressing rule + context fields. Data, not a
  provider function.
- each **Connection** declares *what it needs* (`ConfigField[]`) and hydrates a
  client from resolved values.
- **core** does everything in between: enumerate, resolve, validate, intercept,
  distribute, call.

```ts
type Env = Record<string, string | undefined>

// The enumerable config surface of a service — derivable from the graph alone,
// nothing booted. This is the introspection artifact (secrets marked, values absent).
interface ConfigManifestEntry {
  readonly input?: string            // absent for context fields
  readonly field: string             // "url" · "port"
  readonly channel: "env"
  readonly key: string               // "DATABASE_URL" · "PORT"
  readonly secret: boolean
  readonly default?: string | number
  readonly optional: boolean
}
function configOf(root: ServiceNode): readonly ConfigManifestEntry[]   // in @makerkit/core (pure)

// Boot: Load → configOf → resolve each entry (override ?? env[key] ?? default) →
// validate (ALL missing required fields reported in one ConfigError, before any
// hydrate — Load-before-Hydrate applied to config) → per input:
// connection.hydrate(resolvedSlice) → root.run(deps, contextFromResolvedFields).
function runHost(root: ServiceNode, opts?: {
  env?: Env                                    // source override (tests) — default process.env
  config?: Record<string, string>              // field-level overrides, keyed "input.field" / "context.field"
}): unknown
class ConfigError extends Error {}             // names every missing key at once
```

`runHost`'s default `env` is the **only** place `process.env` enters the system —
the pack declares addressing but never reads an environment. Because core is the
single resolver, there is one choke point for interception: tests override at the
field level without faking an environment; a production host can report its
resolved config with secrets redacted by construction (`secret` is declared on the
shape).

**Motivation (why this shape, recorded).** An earlier iteration had the pack export
a `runtime()` value carrying a type-id–keyed hydrator table plus app-supplied
client factories. It was discarded because: (1) an opaque `env → config` provider
loses the config surface — no enumeration, no interception point, no introspection
of a running service; (2) it made the pack a second environment reader, weakening
the env-exactly-once invariant; (3) composition across packs required merging
registries, where the node-carried design composes structurally — a service mixing
two packs' inputs just works; (4) the app-declared phantom client type
(`postgres<SQL>()`) created a declared-vs-actual trust boundary that factory
inference eliminates; and (5) it contradicted the settled decision that *MakerKit
manages the config-to-input mapping*. The replacement assigns: config *source
conventions* to the Service type (as data), *client construction* to the
Connection, and the *pipeline* to core.

## The Prisma Cloud pack (`@makerkit/prisma-cloud`) — worked instance

Authoring entry — nodes carrying their connection/host knowledge; the driver is a
**parameter**, so the pack ships none and the client type is inferred:

```ts
import { resource, service, type Connection, type Deps, type ServiceHandler, type ServiceNode } from "@makerkit/core"

export interface PostgresConfig { readonly url: string }

// The app supplies the client factory; C is inferred from its return type.
export const postgres = <C>(opts: { client: (config: PostgresConfig) => C }): ResourceNode<C> =>
  resource<C>({
    type: "prisma-cloud/postgres",
    connection: {
      config: [{ name: "url", secret: true }],
      hydrate: (cfg) => opts.client({ url: cfg.url }),
    },
  })

export const compute = <D extends Deps>(deps: D, handler: ServiceHandler<D>): ServiceNode<D> =>
  service({
    type: "prisma-cloud/compute",
    inputs: deps,
    handler,
    host: {
      channel: "env",
      // Compute's convention: the project default DB arrives as DATABASE_URL
      // (per-input naming arrives with multiple databases).
      key: (_input, field) => (field === "url" ? "DATABASE_URL" : field.toUpperCase()),
      context: [{ name: "port", key: "PORT", default: 3000 }],
    },
  })
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
SQL` in `connections.ts`) — the app's choice, since it deploys to a platform whose
runtime is Bun. Switching the client to node-postgres, or the app to a Node
platform, changes these app lines and nothing in MakerKit.

And note what a test needs: `runHost(service, { config: { "db.url": testUrl } })`
— a field-level override through core's resolver, no environment faked, no cloud.
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
4. **`process.env` appears exactly once** in the system — `runHost`'s default `env`
   parameter. User code, packs, and the rest of core contain no reads at all: packs
   declare addressing (`HostConvention`), core resolves, connections receive
   already-resolved values.
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
- **Per-input config naming** — Compute's default DB fixes `DATABASE_URL` today;
  when multiple databases (or service-to-service Connections) arrive, the
  `HostConvention.key` rule becomes a real per-input naming scheme, and the deploy
  side sets values against the same rule (the two readers, applied to config).
- **Config channels beyond env** — `HostConvention.channel` is `"env"` only; a
  platform delivering config another way (files, metadata endpoints) adds a channel
  without touching connections or core's pipeline shape.
- **Serialized topology** — the topology view of Graph is already JSON-safe; an emit
  step for external tooling is additive.

## Related

- [`../03-domain-model/core-and-targets.md`](../03-domain-model/core-and-targets.md) — the architectural split this implements.
- [`../03-domain-model/authoring-surface.md`](../03-domain-model/authoring-surface.md) — the developer-facing narrative.
- [`../03-domain-model/layering.md`](../03-domain-model/layering.md) — Alchemy as the provisioning plane (claim 3).
