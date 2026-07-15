# ADR-0028: Organize packages into numbered domains and layers, enforced by dependency-cruiser

## Decision

`packages/` is organized into three numbered **domains**:

```text
packages/
  0-framework/            # target-agnostic; imports nothing but external deps
    0-foundation/         #   casts, shared types
    1-core/               #   module(), graph/topology, config params
    2-authoring/          #   rpc, node, nextjs authoring surfaces
    3-tooling/            #   assemble, the CLI implementation
  1-prisma-cloud/         # the Prisma Cloud target; may import 0-framework
    0-lowering/           #   the Alchemy provider
    1-extensions/         #   compute(), postgres(), the target descriptor
    2-shared-modules/            #   first-party modules realized on this target (cron)
  9-public/               # the ONLY publishable packages; imports both domains
    compose/              #   → @prisma/compose (bin + curated re-exports + subpaths)
    compose-prisma-cloud/ #   → @prisma/compose-prisma-cloud (+ /cron)
```

**The numbering is the ruleset.** Lower numbers may be imported by higher numbers,
never the reverse — across domains (0-framework imports only external
dependencies; 1-prisma-cloud may import 0-framework; 9-public assembles both) and
within a domain (layers depend downward and laterally, never upward). Gaps are
deliberate: a future target lands as `2-<target>/` without renumbering anything.

**9-public is a sink.** No internal package imports it, which structurally
prevents cycles — and examples and integration tests import *only* `9-public`
packages, so every example is an honest demo of what a user can actually write.

**Planes are adopted now**, as entrypoint-mapped globs in
`architecture.config.json` — not directories. This names the split
[ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) already
established as separate import surfaces: **control** (topology, assemble,
extension descriptors, deploy), **execution** (boot, serve, `load()`), and
**shared**. Control and execution never import each other's code; both may import
shared. A multi-plane package maps its entrypoints per plane (e.g. `src/core/**`
shared, `src/exports/control.ts` control, `src/exports/runtime.ts` execution),
exactly as Prisma Next's multi-plane adapters do.

**Internal packages use the `@internal/*` scope** (`@internal/core`,
`@internal/lowering`, …), all `"private": true`. The scope is publish-proof twice
over: the private flag blocks `npm publish`, and the `@internal` npm scope is not
ours, so even a forced attempt is rejected. The unscoped `internal/x` form was
tested and rejected: npm refuses the name at publish (good) but Node's ESM
resolver parses it as a subpath of a package named `internal` and dies with
`ERR_UNSUPPORTED_DIR_IMPORT` (fatal).

**Publishing bundles.** A public package cannot ship a dependency on a private
one, so `9-public` packages inline their internal workspace dependencies at build
time (the same mechanism as the existing inlined external deps). The published
dist is self-contained; `@internal/*` never appears in a published dependency
tree.

**Enforcement is dependency-cruiser**, data-driven from
`architecture.config.json` mapping directory globs to `{domain, layer, plane}`,
run as `pnpm lint:deps` locally, in lint-staged, and in CI — the same shape as
Prisma Next's, copied with plane support from day one.

## Reasoning

ADR-0027 constrained the published surface to two packages and declared internal
seams free — but "free" without structure decays into a tangle, and a
`"private": true` flag is invisible when browsing. Prisma Next already solved
both problems with a mechanism proven in this codebase's sibling: directory
placement dictates allowed dependencies, package name dictates how consumers
import, and a machine checks the difference. We adopt it rather than invent one.

The one divergence is `9-public`. Prisma Next publishes everything and needs no
such domain; we publish exactly two names, and putting them in a numbered
terminal domain makes ADR-0027's constraint *physical* — "what do users install"
is answered by `ls packages/9-public`, and the publish pipeline can enforce
"nothing else is publishable" mechanically.

Planes cost nothing to adopt now precisely because they are not directories: the
control/execution split already exists as ADR-0017's import surfaces, so naming
it in config turns a documented intention into an enforced rule the day the
cruiser lands.

## Consequences

- **The restructure lands with the ADR-0027 consolidation** — one migration, not
  two. Old package directories become `@internal/*` packages placed by domain and
  layer.
- **Adding a package means placing it**: choose domain, layer, and plane(s), add
  the glob mapping to `architecture.config.json`, and `pnpm lint:deps` holds the
  line from then on.
- **The publish pipeline must inline internal deps** and produce self-contained
  dists (exports maps and d.ts rollups included) for the two public packages.
- **dependency-cruiser joins the dev toolchain** (`pnpm lint:deps` in CI and
  lint-staged).
- **Future targets** land as `2-<target>/` domains publishing a
  `@prisma/compose-<target>` package from `9-public`.

## Alternatives considered

- **Flat `packages/` with `private: true` flags.** The status quo shape; the
  constraint lives in JSON nobody reads and drifts silently. Rejected for
  invisibility.
- **Folding internals into the two public package directories as plain source.**
  Simplest possible layout, but it erases per-package boundaries — no
  per-package builds or caching, no cruiser-enforceable seams, and the layering
  would live in lint config alone. Rejected: ADR-0027 freed internal packages
  precisely so structure could live there.
- **Unscoped `internal/x` names.** Publish-proof by being invalid — and
  import-proof for the same reason: Node ESM treats the slash as a subpath of a
  package named `internal` (`ERR_UNSUPPORTED_DIR_IMPORT`, verified empirically).
- **Deferring planes.** Initially proposed on the assumption planes were a
  directory axis; they are config-mapped entrypoints, and the control/execution
  split already exists (ADR-0017). Deferring would mean enforcing two of three
  axes and leaving the one with an existing documented rule unenforced.

## Related

- [ADR-0027](ADR-0027-two-packages-compose-and-compose-prisma-cloud.md) — the
  two-public-package constraint this organizes.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — the
  control/execution import surfaces the plane rules enforce.
- Prisma Next: `docs/architecture docs/Package-Layering.md` and ADR 140 — the
  pattern adopted here, including `architecture.config.json` and the
  dependency-cruiser setup.
