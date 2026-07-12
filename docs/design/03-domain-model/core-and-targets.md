# Core and targets

Prisma Compose splits into a **thin core** that knows only an abstract model, and
**target packs** that carry everything a specific deployment platform needs — as
*data*, not behaviour the core calls. This is the concrete realization of two
principles the rest of the design leans on:
[*the framework has no knowledge of specific deployment
targets*](../01-principles/architectural-principles.md) and [*thin core, fat
targets*](../01-principles/guiding-principles.md). It is a description of the current
design, not a settled decision record.

## The split

Grounding example — a service with a Postgres dependency, deployed to Prisma Cloud:

```ts
import { compute, postgres } from "@prisma/compose-cloud"

export default compute({ db: postgres() }, ({ db }) => Bun.serve(/* uses db */))
```

- **`@prisma/compose`** knows three kinds — **Service**, **Resource**, **Connection**
  — as a graph, plus the machinery to Load, validate, lower, and run that graph. It
  imports no deployment target. It never learns what "Postgres" or "Compute" is.
- **`@prisma/compose-cloud`** (a target pack) provides the concrete vocabulary:
  `compute()` — a Service; `postgres()` — a Resource; and connection types like
  `http()`. Each is an ergonomic constructor that returns a **plain data object**
  carrying the metadata that routes it to an Alchemy Stack/Provider.

The developer imports the vocabulary from the target; core is the invisible engine
underneath.

## Constructors return data, not behaviour

`postgres()` does not *do* anything — it returns a description:

```ts
// inside @prisma/compose-cloud — illustrative shape
export const postgres = ({ client }) => ({
  kind: "resource",
  provider: /* the prisma-alchemy Prisma Postgres provider (deploy entry) */,
  connection: /* what it needs ({ url }, secret) + hydrate: resolved config →
                 client(...) — the app passed the driver factory in */,
})

export const compute = (deps, handler) => ({
  kind: "service",
  deps, handler,
  host: /* the prisma-alchemy Compute provider */,
})
```

The core never inspects `provider`, `host`, or `hydrate` — they are opaque to it. It
knows only "this is a Service node, that is a Resource node," and that each carries a
reference it can hand to Alchemy. All the intelligence about *how* a Prisma Postgres
is provisioned, or how its connection config reaches the running service, lives in
the pack, wrapped in the constructor. The client that wraps the connection is
supplied by the app — the framework ships no driver (the [runtime-agnostic
principle](../01-principles/architectural-principles.md)).

## Lowering is routing

To deploy, core **Loads** the graph — walks the constructors' data and validates it —
then routes: for each node it instantiates the Alchemy object the node's metadata
points at. A Service node → its `host` provider; a Resource node → its `provider`.
That is the whole of lowering. There is no per-target branch and no provisioning
logic in core; the router only ever follows references it was handed. Swap
`@prisma/compose-cloud` for another target pack and the router is unchanged.

## Runtime: core owns structure, the pack owns encoding

Inside the deployed bundle, boot divides by knowledge. **Core owns structure:**
the config *shape* (each connection's params, the service's own — semantic names
and types, no platform keys in the graph, enumerable without booting), building
the typed `Config` from the graph at deploy, and `hydrate` (typed Config →
clients → handler). **The pack owns encoding:** it *serializes* that typed Config
into the platform environment at deploy and *deserializes* the identical Config
back at boot, through one serializer, so writer and reader cannot drift. The boot loop
is the node's own `run` — deserialize, then core's hydrate, then the handler.

Splitting this way keeps config **visible and interceptable** without core
knowing any platform key: the shape is enumerable via `configOf`, the typed
`Config` is the interception point (a harness inspects it; secrets redact by the
`secret` flag), and a local test injects fakes through `invoke` with no
environment at all. Environment variables still carry the values in, but exactly
one line of the *pack* reads them; core and user code never do.

Because the boot loop rides on the node itself, a target pack has no runtime
entry — just authoring (lean, carries `run`) and provisioning (heavy, deploy
only). No pack entry imports a runtime API or driver.

## Bundling is the app's; the envelope is the pack's

Prisma Compose does not bundle app code. Turning the service module into a runnable
bundle is the app's job, with the app's tool (tsdown, esbuild, whatever) — and
the entry is a pure re-export of the Service node, nothing runs on import. The
platform artifact *envelope* is the pack's: at deploy the pack prints a two-line
bootstrap (`main.run(address)`) and assembles the target's package — for Compute,
a tar with `compute.manifest.json`. Core ships no build step; printing a
bootstrap and assembling a tar is deploy-time assembly, not bundling.

## Why this is the correct boundary

The test of the split is a one-line swap: change `@prisma/compose-cloud` to another
target pack and nothing in `@prisma/compose` changes — not the abstract model, not the
router, not the boot pipeline. Everything a platform is idiosyncratic about — its
compute unit, its managed Postgres, how it injects config, its artifact format —
lives in the pack, as data the core routes rather than code the core contains. A
core that imported prisma-alchemy, or owned bundling, would fail that test; both are
target/tooling concerns the core must not absorb.

## Open questions

- **Alchemy in core, or behind the target?** — *Resolved*: Alchemy is core's
  provisioning substrate (`@prisma/compose/deploy` imports it); the principle forbids
  knowledge of deployment *targets*, and Alchemy is the target-neutral engine
  `layering.md` already commits to. Target packs supply only data (providers +
  lowerings). See the decision note in
  [`core-model.md`](../10-domains/core-model.md).
- **Where connection types route.** A Connection (e.g. `http`) between two nodes
  lowers to config wiring — a URL carried in an env var. Whether that wiring is target
  vocabulary (like a resource) or core structure is TBD.
- **A serializable neutral plan.** Routing can walk the in-memory graph directly. A
  serialized, target-neutral plan would also feed the inspectable-topology goal, at
  the cost of an IR to maintain. (The graph's topology view is JSON-safe by
  construction — see `core-model.md` — so the emit step is additive.)

## Related

- [`../10-domains/core-model.md`](../10-domains/core-model.md) — the complete
  class/data-structure design implementing this split.
- [`authoring-surface.md`](authoring-surface.md) — what the developer writes on top of this split.
- [`layering.md`](layering.md) — the three planes (authoring → provisioning → hosting).
- [`../01-principles/guiding-principles.md`](../01-principles/guiding-principles.md) — thin core, fat targets; compose, don't special-case.
- [`../01-principles/architectural-principles.md`](../01-principles/architectural-principles.md) — no target knowledge in core; no-globals.
