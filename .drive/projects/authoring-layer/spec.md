# Summary

Build and prove MakerKit's **authoring layer** as a **thin, target-agnostic core**
plus a **Prisma Cloud target pack**. A developer imports a concrete vocabulary from
the pack (`compute`, `postgres`) and wires it into a graph; `@makerkit/core` Loads
that graph and **routes** each node to the Alchemy object its metadata references —
without ever importing a deployment target. Validated end-to-end on Prisma Compute /
Postgres.

# Description

## Purpose

A MakerKit developer should describe a service and its dependencies in TypeScript and
deploy to a platform with those dependencies **injected as typed handles** — the
topology inferred from the code, validated before it runs, and never coupled to a
specific cloud. This project turns the recorded design
([`authoring-surface.md`](../../../docs/design/03-domain-model/authoring-surface.md),
[`core-and-targets.md`](../../../docs/design/03-domain-model/core-and-targets.md))
into a working primitive, proven against a real deployment.

## At a glance

The developer writes:

```ts
import { compute, postgres } from "@makerkit/prisma-cloud"

export default compute({ db: postgres() }, ({ db }) => Bun.serve(/* uses db */))
```

`postgres()` and `compute()` are **data** from the target pack, each carrying the
metadata that routes it to an Alchemy provider. `@makerkit/core` sees only "a Service,
a Resource," Loads the graph, and instantiates the referenced Alchemy objects. Core
imports no target and owns no bundler; the app bundles (hand-rolled, as today) and the
target pack's runtime hydrators turn injected config into typed clients.

# Requirements

## Cross-cutting requirements (true at the system level)

- **Core is target-agnostic.** `@makerkit/core` imports no deployment target and no
  `prisma-alchemy`. The swap test: replace the target pack and nothing in core (model,
  router, runtime loop) changes.
- **Lowering is routing.** Core Loads the graph and instantiates the Alchemy object
  each node's metadata references — no per-target branch, no provisioning logic in core.
- **MakerKit does not bundle.** The app owns bundling (hand-rolled in the example);
  core manages only the code *inside* the bundle. The platform artifact envelope is the
  app's build script.
- **No globals.** User code never reads `process.env`. Config reaches the VM as env
  vars but terminates at the target's runtime hydrator, which injects typed clients.
- **Load before Hydrate.** The graph is built and validated before anything executes.
- **Proven on real Prisma Cloud.** Every slice deploys, is hit, and is observed on real
  Compute/Postgres — not only unit tests.
- **The example is the proof.** A minimal example authored via the target pack is
  re-expressed on the primitive and remains deployable throughout.

## Non-goals

- A bespoke provisioning orchestrator — the target pack uses Alchemy's engine + `prisma-alchemy`.
- **MakerKit-owned bundling / packaging** — that is the app's.
- Replacing or changing Prisma Compute / Postgres.
- General framework completeness or production DX polish.
- Runtime name-resolution / hex-to-hex addressing — start on URL baking.
- Non-Postgres BYO resources early; data-migration semantics up front.

## Transitional-shape constraints

During the build, `examples/storefront-auth` stays deployable on its hand-wired
Alchemy path; the new primitive is proven on a separate minimal example first.

# Acceptance Criteria (project DoD)

- [ ] A service authored via the target pack (`compute` + `postgres`) deploys to Prisma
      Cloud and returns a live DB query; the handler has zero `process.env`.
- [ ] `@makerkit/core` imports **no** deployment target — verifiable (no
      `prisma-alchemy`/`alchemy` import in core; a check enforces it).
- [ ] Bundling lives in the example's build script; `@makerkit/core` ships no build step.
- [ ] Each shipped slice's capability is demonstrated on Compute.
- [ ] End state: swapping the target pack would require no change to `@makerkit/core`.

# References

- [`docs/design/03-domain-model/core-and-targets.md`](../../../docs/design/03-domain-model/core-and-targets.md) — the thin-core/target-pack split
- [`docs/design/03-domain-model/authoring-surface.md`](../../../docs/design/03-domain-model/authoring-surface.md) — what the developer writes
- [`docs/design/01-principles/guiding-principles.md`](../../../docs/design/01-principles/guiding-principles.md) — thin core, fat targets; compose, don't special-case
- [`docs/design/01-principles/architectural-principles.md`](../../../docs/design/01-principles/architectural-principles.md) — no target knowledge in core; no-globals
- `packages/prisma-alchemy` — the providers the target pack routes to
- `examples/` — the proving ground (a fresh minimal example)

# Open Questions

- **Alchemy in core, or behind the target?** Shared engine in core (target supplies
  providers + mapping) vs the target owning `apply` end-to-end (core agnostic of even
  Alchemy). See `core-and-targets.md`.
- **Where connection types route** — target vocabulary or core structure (no
  connections in slice 1).
- **Serializable neutral plan** vs walking the in-memory graph (feeds the
  inspectable-topology goal).
- **Hex-to-hex addressing** — URL baking (today) vs runtime name resolution.
- **Migrations** — when/how under a data contract; **`use()` scoping** for framework-hosted.
- **Sizing** — the full capability sequence exceeds one 1–4-slice Drive project; tracked
  as one initiative, re-boundaried as we go (see `plan.md`).

## Note on the prior build

Slice 1 was first built ([PR #6](https://github.com/prisma/makerkit/pull/6)) with
`lower()` importing `prisma-alchemy` and a `@makerkit/core/build` bundler — both
violating the requirements above. That implementation is **superseded** by this spec;
the rebuild targets the target-agnostic shape. The prior design docs and the authoring
model (ports, direction, Load/Hydrate, DIP) carry forward unchanged.
