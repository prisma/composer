# Alchemy → MakerKit takeaways (evolving)

This doc is explicitly **not** "research." It records what we currently believe
MakerKit should emulate/adapt from **Alchemy v2**, and it is expected to change as
MakerKit's design evolves.

Primary reference: [Alchemy v2 docs](https://v2.alchemy.run) (local mirror:
`./docs/`). See also the deeper [`viability-assessment.md`](viability-assessment.md).

## The headline

Alchemy gives us roughly **90% of the platform dependency-graph definition
model** — for free, and already partly adopted (Prisma ships Alchemy wrappers for
Postgres and Compute). The pieces we'd otherwise design from scratch — typed
Resources, the graph between them, DI-as-bindings, swappable Layers — are all
here and well-realized.

The decisive distinction (see the viability assessment) is **definition model**
vs **engine**:

- **Definition model** (Resources, Props/Attributes, Providers, Bindings, Layers,
  Effect): adopt it.
- **Engine** (client-side plan→apply loop + client-side state store): an open
  question. For a managed, multi-tenant platform we likely want reconciliation
  state **server-side**, which means keeping Alchemy's *definition language* and
  replacing its *engine*.

## What we want to emulate directly

- **"The binding is the client."** A dependency resolves to a typed SDK, not a
  name to look up. This is the cleanest realization of our no-globals / DI-only
  principle (see `../../01-principles/architectural-principles.md`).
- **Phases (plantime vs runtime) as colored functions.** Encoding the
  control-plane / execution-plane split in the type system — `RuntimeContext`
  satisfiable only at runtime — is a sharp, type-safe version of our two-plane
  architecture.
- **Layers as the ports/adapters mechanism.** A typed service interface +
  swappable implementation is exactly the hexagonal "Component with ports" we
  want, and the Effect `Layer` substrate gives it to us natively.
- **The Provider model.** "Declare a type, implement a lifecycle Layer" is a good
  template for how MakerKit resource kinds get defined and extended.
- **Resource as the unifying noun**, with **Platform** as the compute-bearing
  subtype — a clean split between passive resources and units that run code.

## What we want: the Convex Component, on Alchemy's substrate

The goal we're chasing (see `../Convex/takeaways-for-makerkit.md`) is the **Convex
Component**: a sandboxed, self-contained unit with its own data/contract and an
explicit API boundary — composed into an app by **explicit wiring**, never
ambient access. Alchemy has the substrate (Resources + Layers + Effect) but **not
the Component concept**. MakerKit builds that concept on top.

Concretely, two Alchemy ideas have to be **fused**, which Alchemy keeps separate:

- A **Stack** is a deployable grouping of resources.
- A **Layer** is a typed-interface-with-swappable-implementation (a port), but
  **in-process only**.

A MakerKit **Component wants to be both at once**: a deployable grouping *and* a
typed-port interface that other Components connect to **across deployment
boundaries**. That fusion is the core design work — not a thin wrapper.

## What we likely need to adapt for MakerKit

- **Engine / reconciliation location.** Client-side (Alchemy today) vs server-side
  (platform-owned). Leaning server-side; this is the live decision.
- **Unify the two "connect" mechanisms.** Alchemy splits **Layer** (local DI) from
  **Reference** (concrete, address-based, cross-deployment pull from state). A
  MakerKit **port** should be one typed interface satisfiable *either way* — local
  adapter or connection to a remotely-deployed Component — with the consumer
  blind to which. This inter-Component wiring is the differentiator Alchemy
  doesn't provide.
- **Durable Streams as the remote adapter.** The natural adapter for a remote
  compute↔compute port is a Durable Stream: "Component A provides events of type
  T, Component B requires them" — the port is the typed contract, the stream is
  the adapter. This is where ports/adapters and our Durable Streams backbone
  become the same mechanism (see `../../03-domain-model/glossary.md` → Connections).
- **Emit a portable topology artifact.** MakerKit wants a serialized desired
  graph an external (server-side) orchestrator can ingest. Alchemy has no
  documented "produce the graph without applying" path — closing that gap is a
  prerequisite for keeping its definition language under a server-side engine.
- **Local emulation.** We want `prisma dev` to emulate the cloud locally; Alchemy
  deliberately refuses emulation (`alchemy dev` = real cloud + local handler).
  Our local story diverges.

## Near-term design questions this raises

- Server-side or client-side reconciliation — and if server-side, can we extract
  Alchemy's desired graph without running its apply loop?
- Are the existing Prisma Postgres / Compute Alchemy wrappers v1 (async) or v2
  (Effect)? Determines how much of the Layer/DI model is already in flight.
- Do we adopt **Effect** as MakerKit's substrate? (The thing that makes Alchemy
  "feel like MakerKit" is Effect, not the apply engine.) → warrants an ADR.
- What is the precise MakerKit **Component** primitive that fuses Stack (grouping)
  and Layer (typed port), and lowers into Alchemy/Effect resources + bindings?
- How does a **port** represent both a local adapter and a Durable-Stream-backed
  remote connection behind one interface?
