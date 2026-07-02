# Authoring Layer — Project Spec

## Purpose

Prove MakerKit's authoring model on real infrastructure: a developer describes a
service and its dependencies in TypeScript — vocabulary imported from a target pack —
and gets **typed, injected dependencies on a real deployment**, with the framework
provably agnostic of both the deployment target and the JavaScript runtime. This is
the foundation every later capability (connections, interfaces, hexes, contracts)
builds on; if this layer is wrong, everything above it inherits the error.

## At a glance

The developer writes (and this deploys, for real):

```ts
// src/service.ts
import { compute, postgres } from "@makerkit/prisma-cloud"
import type { SQL } from "bun"                     // the APP's client choice

export default compute({ db: postgres<SQL>() }, ({ db }, { port }) =>
  Bun.serve({ port, fetch: async () => Response.json(await db`select 1 as ok`) }))

// src/main.ts — the app's bundle entry; the driver import lives here
runHost(service, runtime({ clients: { postgres: ({ url }) => new SQL({ url }) } }))

// alchemy.run.ts — deploy
export default lower(service, prismaCloud({ workspaceId }), { name, artifact })
```

`@makerkit/core` Loads the graph and routes each node to the Alchemy object its
metadata references; `@makerkit/prisma-cloud` supplies the vocabulary as data. The
complete class/data-structure design is
[`docs/design/10-domains/core-model.md`](../../../docs/design/10-domains/core-model.md)
— this project builds exactly that.

## Non-goals

- **Bundling or packaging** — the app owns its bundler and the platform artifact
  envelope; MakerKit ships no build step.
- **A bespoke provisioning orchestrator** — Alchemy's engine + the existing
  `packages/prisma-alchemy` providers.
- **Hexes, Connections/interfaces, data contracts, streams** — named extension points
  in the design; later projects.
- **Framework-hosted services (Next.js/`use()`), local emulation, runtime name
  resolution** — later projects.
- **Shipping a DB driver or fixing a JS runtime** — the client factory is app-supplied.
- **Migrating `examples/storefront-auth`** — it stays on its hand-wired path.
- Production DX polish (versioning, publishing, docs sites).

## Place in the larger world

First build phase of the authoring-layer initiative (the capability roadmap lives in
`plan.md`). Sits on `packages/prisma-alchemy` (unchanged) and Alchemy's engine.
Realizes the design recorded in `docs/design/` — `core-model.md` (types),
`core-and-targets.md` (the split), `authoring-surface.md` (developer view), and the
principles (no-globals, runtime-agnostic, no-target-knowledge, wiring-precedes-
execution). Supersedes the earlier coupled implementation on this branch
([PR #6](https://github.com/prisma/makerkit/pull/6)): that code lowered from core
directly to prisma-alchemy and owned bundling; parts of it (graph/Load mechanics,
test approach) survive restructuring, its architecture does not.

## Cross-cutting requirements

- **`core-model.md` is the contract.** The built surface matches the deep dive —
  types, entry points, dependency weights. A deviation discovered during the build is
  a design-doc amendment agreed with the operator *first*, then code.
- **The five invariants are enforced by tests, not convention** (from
  `core-model.md` § Invariants): core has no target dependency; authoring imports
  bundle lean (no alchemy/effect/prisma/SQL tokens); importing runs nothing;
  `process.env` appears exactly once (the `runHost` default); no Bun/Node coupling in
  any shipped entry — even type-only.
- **Proven on real Prisma Cloud.** The example deploys, serves a live DB query, and
  tears down clean — not only unit tests.
- **The example owns its build**: tsdown (or similar) bundles `main.ts`; the app's
  script writes `compute.manifest.json` and tars.

## Transitional-shape constraints

- `examples/storefront-auth` stays deployable on its hand-wired path throughout.
- The rework happens on the existing branch; intermediate commits keep typecheck and
  tests green (the old `makerkit-hello` may be broken mid-rework, but not at any
  PR-ready point).

## Project-DoD

- [ ] The example above deploys via `lower(service, prismaCloud(...))`, returns a
      live `select 1` over HTTP, and destroys clean — verified against real Prisma Cloud.
- [ ] App code contains no `process.env` (service module and `main.ts`); the deploy
      script reads only `PRISMA_WORKSPACE_ID` + artifact inputs.
- [ ] All five invariant tests pass; `@makerkit/core`'s `package.json` names no
      `prisma-*` package and no runtime API.
- [ ] The six package entries exist with the specced exports and dependency weights.
- [ ] `docs/design/10-domains/core-model.md` matches what shipped (amended through
      the agreed process if the build forced changes).
- [ ] PR open with CI green and the review loop complete.

## Open questions

- **PR mechanics** — rework in place on PR #6 (retitle when done) vs close and open
  fresh. Default: rework in place; one PR delivers the corrected layer.
- **Pack package naming** — `packages/prisma-cloud` vs `packages/makerkit-prisma-cloud`
  (npm name is `@makerkit/prisma-cloud` either way). Default: mirror the core
  package's directory convention.
- **Example bundler** — default tsdown per operator preference; the app may use
  anything (runtime-agnostic principle makes this app-local).

## References

- [`docs/design/10-domains/core-model.md`](../../../docs/design/10-domains/core-model.md) — the complete type-level design (the build contract)
- [`docs/design/03-domain-model/core-and-targets.md`](../../../docs/design/03-domain-model/core-and-targets.md) — the architectural split
- [`docs/design/03-domain-model/authoring-surface.md`](../../../docs/design/03-domain-model/authoring-surface.md) — the developer-facing narrative
- [`docs/design/01-principles/architectural-principles.md`](../../../docs/design/01-principles/architectural-principles.md) — no-globals, runtime-agnostic, no-target-knowledge, wiring-precedes-execution
- `packages/prisma-alchemy` — the providers the pack routes to (unchanged)
- [PR #6](https://github.com/prisma/makerkit/pull/6) — the superseded first build (history + review findings)
