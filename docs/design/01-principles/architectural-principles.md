# Architectural Principles

Structural rules that shape Prisma Compose's architecture and package boundaries.

## No globals — all dependencies are injected

Application code never reads global configuration or looks up a service by name —
no `process.env`, no discovery, no magic. Every resource a Module uses is handed to
it as a typed dependency. Configuration still reaches a compute unit as environment
variables, but that channel **terminates at the framework's host shim**, which
hydrates it and injects typed clients; user code — including framework-hosted
code, which reaches its dependencies through a `use(…)` accessor — never touches
the environment. The framework propagates data to user code only through
dependency injection. See
[the authoring surface](../03-domain-model/authoring-surface.md).

## Wiring precedes execution — Load, then Hydrate

A Service or Module is *wired* and then *run*; it never runs itself. Executing its
`define` Loads an in-memory graph that the framework validates for integrity
before anything executes; only then is the graph Hydrated — adapters attached,
data pushed through. This holds symmetrically for Services and Modules, so an
integrity error
surfaces at Load, a test can trust nothing ran until the graph was whole, and the
topology can be inspected without a deploy. See
[the authoring surface](../03-domain-model/authoring-surface.md).

## Runtime-agnostic — no Node or Bun coupling

The framework's shipped surface — core and target packs — never depends on a specific
JavaScript runtime: no Bun APIs, no Node-only modules, not even type-only imports of
a runtime's types in public signatures. Anything runtime-specific — a database
driver, a server API — enters from application code, which owns its runtime choice,
or through an adapter the app supplies. A deployment platform may fix a runtime
(Prisma Compute runs Bun); that is a hosting fact about the target, not a dependency
of the framework.

## We don't bundle — users build, the framework wraps

The framework **never** bundles, transforms, discovers, or repairs application
code. Your build hands deploy a finished, flat, self-contained bundle; deploy
wraps it in the framework's own bootstrap and ships it exactly as handed over.
No filename guessing, no monorepo-layout inference, no tree fix-ups — a symlink
in a bundle is an error to report, not a job to do. See
[ADR-0005](../90-decisions/ADR-0005-users-build-the-framework-assembles.md);
every violation of this principle has produced a real deploy failure. Do not
relitigate.

## Code over configuration

Your topology is *inferred* from your application code — type-checked, and living in
your TypeScript, not a separate manifest you maintain by hand. The structure you
write is the structure that deploys; the two can't silently drift. The node
constructor's declaration (`compute(…)`, `module(…)`) *is* the manifest: one live value
read by the control plane at deploy and by the runtime host at boot, so there is
nothing to keep in sync.

## Tree-shakeable by default

Control-plane code (inferring, emitting, provisioning) and execution-plane code
(running your app) live behind separate imports, so build-time machinery never
lands in your application bundle. You ship only what runs.

## The framework has no knowledge of specific deployment targets

The core deals only in the abstract model — Modules, inputs, outputs, resources — and
never branches on where you're deploying. Everything a given target needs (Prisma
Cloud's resource types, or another's) arrives as an extension pack.

## Data contracts are the interface for data resources

A data contract names exactly what a Module may read and write; a resource plugs in
only if it satisfies that contract. It's the data-world version of an Alchemy
Layer: the consumer depends on a typed interface (`Context.Service`), and any
implementation that satisfies it can be swapped in.

## Realtime/streaming-first

Streaming and subscription are first-class in the runtime from day one, not bolted
onto a request/response model after the fact. We build for the hard case — async,
durable, ordered delivery — so the synchronous case falls out for free, not the
reverse.
