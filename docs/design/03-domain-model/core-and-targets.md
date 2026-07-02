# Core and targets

MakerKit splits into a **thin core** that knows only an abstract model, and
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
import { compute, postgres } from "@makerkit/prisma-cloud"

export default compute({ db: postgres() }, ({ db }) => Bun.serve(/* uses db */))
```

- **`@makerkit/core`** knows three kinds — **Service**, **Resource**, **Connection**
  — as a graph, plus the machinery to Load, validate, lower, and run that graph. It
  imports no deployment target. It never learns what "Postgres" or "Compute" is.
- **`@makerkit/prisma-cloud`** (a target pack) provides the concrete vocabulary:
  `compute()` — a Service; `postgres()` — a Resource; and connection types like
  `http()`. Each is an ergonomic constructor that returns a **plain data object**
  carrying the metadata that routes it to an Alchemy Stack/Provider.

The developer imports the vocabulary from the target; core is the invisible engine
underneath.

## Constructors return data, not behaviour

`postgres()` does not *do* anything — it returns a description:

```ts
// inside @makerkit/prisma-cloud — illustrative shape
export const postgres = () => ({
  kind: "resource",
  provider: /* the prisma-alchemy Prisma Postgres provider */,
  hydrate: /* runtime: DATABASE_URL → Bun.SQL — behind the pack's /runtime entry */,
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
is provisioned or a `Bun.SQL` client is built lives in the pack, wrapped in the
constructor.

## Lowering is routing

To deploy, core **Loads** the graph — walks the constructors' data and validates it —
then routes: for each node it instantiates the Alchemy object the node's metadata
points at. A Service node → its `host` provider; a Resource node → its `provider`.
That is the whole of lowering. There is no per-target branch and no provisioning
logic in core; the router only ever follows references it was handed. Swap
`@makerkit/prisma-cloud` for another target pack and the router is unchanged.

## Runtime is a dumb loop

Inside the deployed bundle, core boots a loop that, for each declared Input, calls
the hydrator the target attached and passes the result to the handler. Core does not
know that `db` becomes a `Bun.SQL` client from `DATABASE_URL` — only the target's
`postgres` hydrator knows that. Config still arrives as environment variables, but
they terminate at that hydrator; user code is dependency-injected and never reads the
environment.

Because the hydrator is heavy (a driver) and the provider heavier (Alchemy), a target
pack splits along the same control/execution line the core does: `@makerkit/prisma-cloud`
(provisioning — imported only at deploy) and `@makerkit/prisma-cloud/runtime`
(hydration — the only target code that lands in the deployed bundle). The authoring
import stays lean.

## Bundling is the app's

MakerKit does not bundle. Turning the service module into a runnable bundle is the
app's job, with the app's tool (tsdown, esbuild, whatever). MakerKit's responsibility
ends at the code *inside* the bundle: the service data and the entry that boots the
runtime loop over it. The platform's artifact envelope — for Compute, a tar with
`compute.manifest.json` — is likewise assembled by the app's build script. Core ships
no build step.

## Why this is the correct boundary

The test of the split is a one-line swap: change `@makerkit/prisma-cloud` to another
target pack and nothing in `@makerkit/core` changes — not the abstract model, not the
router, not the runtime loop. Everything a platform is idiosyncratic about — its
compute unit, its managed Postgres, how it injects config, its artifact format —
lives in the pack, as data the core routes rather than code the core contains. A
core that imported prisma-alchemy, or owned bundling, would fail that test; both are
target/tooling concerns the core must not absorb.

## Open questions

- **Alchemy in core, or behind the target?** Core could hold Alchemy as the shared
  provisioning engine (the target supplies only providers + the node→resource
  mapping), or the target could own `apply` end-to-end (core stays agnostic of even
  Alchemy). The first reuses Alchemy's engine/state across targets; the second is
  maximally agnostic. The routing shape above holds either way.
- **Where connection types route.** A Connection (e.g. `http`) between two nodes
  lowers to config wiring — a URL carried in an env var. Whether that wiring is target
  vocabulary (like a resource) or core structure is TBD; slice 1 has no connections.
- **A serializable neutral plan.** Routing can walk the in-memory graph directly. A
  serialized, target-neutral plan would also feed the inspectable-topology goal, at
  the cost of an IR to maintain.

## Related

- [`authoring-surface.md`](authoring-surface.md) — what the developer writes on top of this split.
- [`layering.md`](layering.md) — the three planes (authoring → provisioning → hosting).
- [`../01-principles/guiding-principles.md`](../01-principles/guiding-principles.md) — thin core, fat targets; compose, don't special-case.
- [`../01-principles/architectural-principles.md`](../01-principles/architectural-principles.md) — no target knowledge in core; no-globals.
