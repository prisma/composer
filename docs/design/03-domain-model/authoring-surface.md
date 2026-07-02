# The authoring surface

How a developer writes MakerKit's [Core nouns](glossary.md#core-nouns) — the API
that sits directly above the [domain model](domain-map.md) and lowers onto the
[Alchemy/Effect compile
target](glossary.md#provisioning-plane--the-compile-target-alchemy--effect). Where
the domain map says *what* the nouns are, this describes *how you write them*, and
what running them does. It is a description of the current design, not a settled
decision record.

Take the worked example: two hexes, `auth` (a Bun/Hono service with its own
Postgres) and `storefront` (a Next.js app with its own Postgres) where the
storefront calls auth while serving a request. Today the deploy script wires that by
hand — it sets an `AUTH_URL` environment variable from auth's deployed URL, orders
the two deploys, and the app code reads `process.env` to find its database and the
auth endpoint. That works, but every wire is untyped, manual, and invisible to any
tool. This is the authoring layer that replaces it — the surface a developer writes,
which lowers to exactly that provisioning.

## One port mechanic, uniform at every level

Every node — Service, Hex, or Resource — has typed Inputs and Outputs, and a
connection wires one node's Output to another's Input of the same named interface.
This rule already governs the model (see the [domain map](domain-map.md)); the point
here is that it is also the *authoring surface*. A Service declares its ports and
consumes or produces them:

```ts
// auth service — Input: db · Output: its API
export default defineService(
  { db: Postgres(authData) },                 // dependency position ⇒ Input ⇒ hydrated client
  ({ db }) => ({ api: Auth.serve(buildAuthApp(db)) })   // returned ⇒ Output
)
```

## Direction is inferred from position; connection types are neutral

A connection type is a value — `Auth = http(AuthInterface)` — not a raw TypeScript
interface, and it is direction-neutral. Where you place it decides polarity: name it
as a dependency and it is an Input, hydrated to a typed client; return it and it is
an Output you must implement. This is not merely stylistic — it mirrors data flow.
Inputs must be declared up front because they are hydrated before your code runs;
Outputs are naturally the return, because they are what your code produces.

Because the connection type is a neutral value that either side may author, it
supports dependency inversion directly: declare the interface on the *consumer* side
and the provider conforms to it, rather than every consumer bending to whatever a
provider happened to publish.

```ts
export const Auth = http(AuthInterface)   // neutral connection type

// storefront service — Auth in dependency position ⇒ Input ⇒ typed client
export default defineService(
  { db: Postgres(storeData), auth: Auth },
  (deps) => ({ web: next(deps) })         // 'web' Output served by a Next.js adapter
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
// storefront hex — same port mechanic for its boundary; body only wires
import store, { Auth } from "./storefront-service"
export default hex("storefront",
  { auth: Auth, web: http(StoreInterface) },   // hex-level ports
  ({ auth, provision }) => {
    const db  = provision(Postgres(storeData))  // the Hex owns resources
    const svc = provision(store, { db, auth })  // forward hex Input → service Input
    return { web: svc.web }                      // forward service Output → hex Output
  }
)
```

Wiring resolves at `define` time for both, symmetrically — enforced for a Hex
(MakerKit can see it), expected of a Service (a black box it cannot reach into).
Keeping resolution time the same is deliberate: it makes a Hex behave like a
Service, so the model stays predictable, and it guarantees nothing executes before
the wiring is complete.

## The `define` call is the manifest

There is no separate MakerKit manifest file (the platform's `compute.manifest.json`
stays — it only names the boot entrypoint). The dependency declaration is a live
value read by two readers: the control plane at deploy time provisions the resources
and wires the config; the runtime host hydrates the Inputs and injects them. Because
each Service is isolated in its own compute unit, the environment-variable names
those two readers agree on are derived by convention, not communicated through a
file. Environment variables remain the physical channel that carries config into the
VM, but they **terminate at the host's hydration step** — user code never reads them.

## The entrypoint is a host shim; a framework is just an Output adapter

The boot entrypoint is MakerKit-generated: it hydrates the declared Inputs into
typed clients and hands them to the user handler. When the "handler" is a framework
that owns its own server — Next.js — MakerKit does not wrap the handler signature;
it wires the framework in as the implementation of an HTTP Output, and framework
code reaches its dependencies through a DI accessor (`use(…)`), never through the
environment. This is the concrete form of the [no-globals
principle](../01-principles/architectural-principles.md): MakerKit propagates data to
user code only through dependency injection.

## Load, then Hydrate

Running a `define` constructs a typed dataflow graph — a graph of streams, where
request/response is simply the bounded case (one message in, one out). At the end of
`define` the graph is closed, so MakerKit validates its integrity: every Input
satisfied, interfaces compatible, nothing dangling. That is **Load** — the graph is
in memory to inspect, validate, or manipulate, and nothing has executed. **Hydrate**
is the second phase: attach adapters and push data through the Inputs and out of the
Outputs.

One graph serves both a test harness and a real deployment. Because Loading executes
nothing, the topology can be interrogated and emitted for tooling independently of a
deploy. Because integrity is validated at Load before any Hydrate, an error surfaces
before execution and a test can trust that nothing ran until the graph was whole.
And because a fake Output can be substituted at any Input — the same dependency
inversion — a Service or Hex is testable with no real infrastructure, which is the
local-emulation story.

## Alternatives set aside

- **A separate MakerKit manifest file** describing each service's inputs. The
  `defineService` declaration already carries it; a second artifact would only
  restate the code and risk drifting from it, and per-service isolation makes
  convention-based env names sufficient.
- **Explicit `In()` / `Out()` wrappers** on every port. Position already determines
  direction unambiguously (dependencies are hydrated before the body runs; outputs
  are the return), and a neutral connection type is what enables dependency
  inversion.
- **Provider-owned interfaces only.** Forcing the interface onto the provider
  prevents a consumer — or the platform — from declaring the contract it needs and
  having providers conform.
- **A framework as its own entrypoint kind**, distinct from a MakerKit service. It
  fractures the model into "native" and "framework-hosted" cases; a framework server
  is better understood as one implementation of an HTTP Output.
- **Topology-path environment-variable names** (`hex/resource/id`). Only needed under
  a shared namespace; each Service is isolated, so a per-input name is unique already.

## Open questions

- **Deploy-time URL baking vs. runtime name resolution.** Baking `AUTH_URL` from a
  deployed URL forces the topology into a DAG with a deploy order and forbids two
  hexes calling each other. A name-based internal registry (stable internal
  addressing resolved at runtime) would allow cycles and independent redeploys. This
  constrains the whole topology model, so it wants deciding early.
- **`use(…)` scoping** in framework-hosted code — process-scoped (a module singleton,
  e.g. the database pool) vs request-scoped (via `AsyncLocalStorage`). The example
  only needs process-scoped.
- **Cross-repo contract provenance.** A monorepo type-only import of a connection
  type is trivial; hexes in separate repos need the connection type published as a
  package or generated from a schema.
- **Framework build-time evaluation.** Code that runs during static generation sees
  no hydrated container, the same dynamic/static boundary the example already meets;
  where `use(…)` is legal needs to be pinned.

## Related

- [`domain-map.md`](domain-map.md) — the Input/Output model this surface expresses.
- [`glossary.md`](glossary.md) — the authoring vocabulary and the compile target.
- [`layering.md`](layering.md) — how the authoring plane lowers to Alchemy and Prisma
  Cloud.
- [`../01-principles/architectural-principles.md`](../01-principles/architectural-principles.md)
  — no-globals/DI, code over configuration, wiring precedes execution.
