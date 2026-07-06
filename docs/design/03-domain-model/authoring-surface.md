# The authoring surface

How a developer writes MakerKit's [Core nouns](glossary.md#core-nouns) and what
running them does. The developer imports a concrete **vocabulary from a target pack**
— for Prisma Cloud, `compute` (a Service) and `postgres` (a Resource) from
`@makerkit/prisma-cloud` — and wires them into a graph. `@makerkit/core` is the
target-agnostic engine underneath; see [core and targets](core-and-targets.md) for
that split. This describes the current design, not a settled decision record.

Grounding example — a service with a Postgres dependency:

```ts
import { compute, postgres } from "@makerkit/prisma-cloud"

export default compute({ db: postgres() }, ({ db }) =>
  Bun.serve({ port, fetch: async () => Response.json(await db`select 1 as ok`) })
)
```

`postgres()` is a **Resource** the service depends on; `compute(deps, handler)` is a
**Service**. MakerKit provisions the Postgres and the compute unit, injects a typed
`db` client into the handler, and serves — with no `process.env` in the service code.
The vocabulary (`compute`, `postgres`, `http`, …) belongs to the target; the wiring
rules below belong to the core.

## One port mechanic, uniform at every level

Every node — Service, Hex, or Resource — has typed Inputs and Outputs, and a
connection wires one node's Output to another's Input of the same named interface.
This rule already governs the model (see the [domain map](domain-map.md)); the point
here is that it is also the *authoring surface*. A Service declares its ports as it
consumes and produces them:

```ts
// a service with an Input (db) and an Output (its API)
export default compute(
  { db: postgres() },
  ({ db }) => ({ api: Auth.serve(buildApp(db)) })   // returned ⇒ Output
)
```

## Direction is inferred from position; connection types are neutral

A connection type is a value — `Auth = http(AuthInterface)`, also from the target
pack — not a raw TypeScript interface, and it is direction-neutral. Where you place
it decides polarity: name it as a dependency and it is an Input, hydrated to a typed
client; return it and it is an Output you must implement. This is not merely
stylistic — it mirrors data flow. Inputs must be declared up front because they are
hydrated before your code runs; Outputs are naturally the return, because they are
what your code produces.

Because the connection type is a neutral value that either side may author, it
supports dependency inversion directly: declare the interface on the *consumer* side
and the provider conforms to it, rather than every consumer bending to whatever a
provider happened to publish.

```ts
export const Auth = http(AuthInterface)   // neutral connection type

export default compute(
  { db: postgres(), auth: Auth },          // Auth as dependency ⇒ Input ⇒ typed client
  (deps) => ({ web: next(deps) })          // 'web' Output served by a Next.js adapter
)
```

## Services and Hexes are both wiring; they differ only in opacity

Neither a Service nor a Hex runs itself; each is wired and then run by MakerKit. The
convention is identical for both: **Inputs arrive as arguments, Outputs are the
return.** A Service's body is opaque — it wires its ports to a server adapter
(Next.js, Hono, a bare handler) and MakerKit sees only the boundary; it is a **black
box**. A Hex's body is transparent — MakerKit sees the topology it owns — and it
additionally gets `provision()`. Forwarding needs no new primitive: a Hex passes its
Inputs *down* into the nodes it owns and returns their Outputs *up* as its own.
Provisioning and ownership are a Hex concern; a Service only ever *requires*.

```ts
// a hex — same port mechanic for its boundary; body only wires
import store, { Auth } from "./storefront-service"
export default hex("storefront",
  { auth: Auth, web: http(StoreInterface) },   // hex-level ports
  ({ auth, provision }) => {
    const db  = provision(postgres())           // the Hex owns resources
    const svc = provision(store, { db, auth })  // forward hex Input → service Input
    return { web: svc.web }                      // forward service Output → hex Output
  }
)
```

Wiring resolves at define time for both, symmetrically — enforced for a Hex (MakerKit
can see it), expected of a Service (a black box it cannot reach into). Keeping
resolution time the same is deliberate: it makes a Hex behave like a Service, so the
model stays predictable, and it guarantees nothing executes before the wiring is
complete.

## The returned data is the manifest

A constructor like `compute(...)` or `postgres()` runs no logic — it returns a plain
data object (see [core and targets](core-and-targets.md)). That object *is* the
manifest: there is no separate MakerKit manifest file (the platform's
`compute.manifest.json` stays — it only names the boot entrypoint). The same value is
read twice: the control plane at deploy time routes each node's metadata to its
provider and wires the config; the runtime host hydrates the Inputs and injects them.
Because each Service is isolated in its own compute unit, the environment-variable
names those two readers agree on are derived by convention, not communicated through
a file. Environment variables remain the physical channel that carries config into
the VM, but they **terminate at hydration** — user code never reads them.

## The runtime is a dumb loop; a framework is an Output adapter

At boot, core runs the **config pipeline**: it enumerates every config field the
service's Inputs declare, resolves each against the platform's addressing rule (the
service type's data — e.g. Compute delivers the database URL at `DATABASE_URL`),
validates the lot before anything hydrates, then hands each connection its resolved
values so it can build its client — with the driver factory the app supplied at
authoring time, since MakerKit ships none (the [runtime-agnostic
principle](../01-principles/architectural-principles.md)). Config is thereby
enumerable without booting, overridable field-by-field in tests, and reportable
(secrets redacted) in production. When the "handler" is a framework that owns
its own server — Next.js — MakerKit does not wrap the handler signature; it wires the
framework in as the implementation of an HTTP Output, and framework code reaches its
dependencies through a DI accessor (`use(…)`), never through the environment. This is
the concrete form of the [no-globals
principle](../01-principles/architectural-principles.md): MakerKit propagates data to
user code only through dependency injection.

## Load, then Hydrate

Loading the graph — walking the constructors' data and validating it — constructs a
typed dataflow graph (a graph of streams, where request/response is the bounded case:
one message in, one out). At the end the graph is closed, so MakerKit validates its
integrity: every Input satisfied, interfaces compatible, nothing dangling. That is
**Load** — the graph is in memory to inspect, validate, or manipulate, and nothing
has executed. **Hydrate** is the second phase: attach adapters and push data through
the Inputs and out of the Outputs.

One graph serves both a test harness and a real deployment. Because Loading executes
nothing, the topology can be interrogated and emitted for tooling independently of a
deploy. Because integrity is validated at Load before any Hydrate, an error surfaces
before execution and a test can trust that nothing ran until the graph was whole. And
because a fake Output can be substituted at any Input — the same dependency inversion
— a Service or Hex is testable with no real infrastructure, which is the
local-emulation story.

## Alternatives set aside

- **A separate MakerKit manifest file** describing each service's inputs. The
  constructor's returned data already carries it; a second artifact would only restate
  the code and risk drifting from it, and per-service isolation makes convention-based
  env names sufficient.
- **Explicit `In()` / `Out()` wrappers** on every port. Position already determines
  direction unambiguously (dependencies are hydrated before the body runs; outputs are
  the return), and a neutral connection type is what enables dependency inversion.
- **A generic core `service()` the user calls.** The concrete constructor is
  target-provided (`compute`), because the node it produces must carry the target's
  routing. Core defines the *kind* Service; the target stamps out nodes of it.
- **A framework as its own entrypoint kind**, distinct from a MakerKit service. It
  fractures the model into "native" and "framework-hosted" cases; a framework server
  is better understood as one implementation of an HTTP Output.

## Open questions

- **Deploy-time URL baking vs. runtime name resolution.** Baking a consumer's
  `AUTH_URL` from a deployed URL forces the topology into a DAG with a deploy order and
  forbids two hexes calling each other. A name-based internal registry (stable internal
  addressing resolved at runtime) would allow cycles and independent redeploys.
- **`use(…)` scoping** in framework-hosted code — process-scoped (a module singleton,
  e.g. the database pool) vs request-scoped (via `AsyncLocalStorage`).
- **Cross-repo contract provenance.** A monorepo type-only import of a connection type
  is trivial; hexes in separate repos need it published as a package or generated.
- The core↔target architecture's own open questions (Alchemy in core vs behind the
  target; where connection types route; a serializable plan) live in
  [core and targets](core-and-targets.md#open-questions).

## Related

- [`core-and-targets.md`](core-and-targets.md) — the thin-core/target-pack split this sits on.
- [`domain-map.md`](domain-map.md) — the Input/Output model this surface expresses.
- [`glossary.md`](glossary.md) — the authoring vocabulary and the compile target.
- [`layering.md`](layering.md) — how the authoring plane lowers to Alchemy and Prisma Cloud.
- [`../01-principles/architectural-principles.md`](../01-principles/architectural-principles.md)
  — no-globals/DI, no target knowledge in core, wiring precedes execution.
