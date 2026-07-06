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
supplied by the app — MakerKit ships no driver (the [runtime-agnostic
principle](../01-principles/architectural-principles.md)).

## Lowering is routing

To deploy, core **Loads** the graph — walks the constructors' data and validates it —
then routes: for each node it instantiates the Alchemy object the node's metadata
points at. A Service node → its `host` provider; a Resource node → its `provider`.
That is the whole of lowering. There is no per-target branch and no provisioning
logic in core; the router only ever follows references it was handed. Swap
`@makerkit/prisma-cloud` for another target pack and the router is unchanged.

## Runtime: core owns the config pipeline

Inside the deployed bundle, boot is a config pipeline that **core owns end to end**.
The pieces divide by knowledge, not by plumbing: the *service type* declares where
this platform delivers config (env vars, and which key holds what) — as **data**,
never as a function that reads the environment; each *connection* declares what it
needs and hydrates a client from resolved values (the app passed the driver factory
into the connection when authoring it); *core* enumerates the declared config
surface from the graph, resolves it against the environment, validates it before
anything hydrates, applies any test/production overrides, hands each connection its
slice, and calls the handler.

Owning the pipeline is what makes config **visible and interceptable**: the full
config surface of a service is enumerable without booting it (keys, secret-ness,
defaults — the introspection artifact), tests override individual fields through
core instead of faking environments, and a running host can report its resolved
config with secrets redacted by construction. Environment variables still carry the
values in, but exactly one line of core reads them; user code and packs never do.

Because everything a node needs at boot rides on the node itself, a target pack has
no runtime entry at all — just authoring (lean) and provisioning (heavy, deploy
only). No pack entry imports a runtime API or driver.

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

- **Alchemy in core, or behind the target?** — *Resolved*: Alchemy is core's
  provisioning substrate (`@makerkit/core/lower` imports it); the principle forbids
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
