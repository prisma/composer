# System Composition — Design Notes

The implementation-level record for this project. The design itself lives in
the ADRs (0016 system boundary, 0017 control-plane config) and
`docs/design/10-domains/system-composition.md`; this file tracks where the work
stands, the calls made building it, and what is still open. Kept current — when
a slice closes or a decision lands, it is written here in the same change.

## Status (2026-07-10)

- **H1 — system boundary, forwarding, nesting: done.** On the branch, twice
  Opus-reviewed. `system(name, { deps?, expose? }, body)`; recursive Load
  flatten with hierarchical addresses; four boundary-validation rules.
- **Deploy-module loading: mid-redesign.** The node-owned-loads approach (nodes
  carry `targetModule`/`assembler` specifiers and load them) failed empirically
  and is being replaced by the extension-config design (below). This is the
  active slice.
- **H3 — reusable auth system + same-contract fake, proven live in CI:
  pending.** The last slice; builds on the extension-config work.
- Branch `claude/system-composition`. **PR #28 is closed** pending the
  extension-config redesign; it reopens when the deploy resolves for real
  (the no-env probe fails at missing `PRISMA_WORKSPACE_ID`, not at "Cannot
  resolve") and CI's live e2e is green.

## The model this builds on (durable, post-merge)

Everything the project once waited on has merged to main; the results that
matter:

- **Unified dependency model** (#21): one `dependency()` slot factory (no
  separate connection/resource ends); `resource()` takes `provides: Contract`;
  `provision(id, resource)` returns that contract flattened onto the ref;
  `Edge.kind` is `'input' | 'dependency'`. A resource-backed input forwards
  across a system boundary like any other — no special case.
- **Always-system root** (#22): the deploy root must be a system; a bare
  service is not independently deployable (Load says "wrap it in a system").
  Bundles are keyed by the full dot-joined address.
- **Naming** (#24): the composition unit is a **System** (`system()`); an
  **extension** is a control-plane package (was "pack"); the framework is
  Prisma App (`@prisma/app*`), the CLI `prisma-app`; the node brand is
  `Symbol.for('prisma:node')`.
- **Bindings** (#26): a dependency resolves to a binding — a typed config for
  a resource, a client for a protocol-owned kind — constructed app-side; the
  declaration carries no driver choice.

## Current slice: control plane loads through `prisma-app.config.ts`

Full spec at `slices/extension-config/spec.md` (with the pinned, no-discretion
implementation decisions); recorded as ADR-0017.

**Why.** Node-owned loads did `import(this.targetModule)` from core's own
module; core depends on no extension, so a real workspace deploy failed to
resolve `@prisma/app-cloud/target` (the same specifier resolves fine from the
app root). Two earlier shapes on this seam also failed: framework-constructed
paths via `createRequire` (hand-rolled resolution, dead on Yarn PnP / Deno),
and a loader thunk with a literal import (breaks the bundler firewall).

**The design.** A `prisma-app.config.ts` at the app root — loaded by the CLI
with c12, discovered by walking up from the deploy entry, never imported by app
code — statically imports each extension's control descriptor and declares the
deploy's one state store. Deploy tooling looks up control-plane behavior by the
data every node already carries: `extensions[node.extension].nodes[node.type]`.
The firewall becomes a file boundary (app code never reaches the config), not a
bundler trick; resolution is ambient (ordinary static imports from the app
root). The **target concept is deleted** — no `fromEnv()` contract, no
one-target rule; nodes on different platforms coexist, providers compose, and
the one `state:` store is platform-agnostic. Nodes revert to pure frozen data.

## Implementation calls (settled; flag on divergence)

- **`InputRef`** — a body's `ctx.inputs` entries are branded wiring values
  carrying (system identity, input key). At Load, when the enclosing scope
  wires the input, the ref resolves to the real producer; forwarding edges are
  recorded so cycle detection sees through boundaries. The brand satisfies the
  same `Wiring<D>` assignability a producer's ref-port does (a contract-typed
  input carries that contract's `Req`). Per-key object identity (a symbol-keyed
  shallow copy) keeps forwarding attribution precise when one producer wires
  two inputs.
- **Body executes during Load only**, once per provision, pure by convention;
  nothing composition adds runs at runtime.
- **Addresses**: parent address + `.` + provision id. The config-key
  derivation joins with `_` and forbids `_`/`.` inside a provision id, so keys
  cannot collide at depth; tests cover depth ≥ 2.
- **Nodes are plain frozen data** — identity is the `Symbol.for('prisma:node')`
  brand via `isNode()`, never `instanceof`, so a node built by another
  installed copy of core still validates. (The extension-config slice removes
  the load-method class hierarchy that briefly lived here.)
- **Bundle keys**: the full dot-joined address (provision ids are unique only
  within a scope).
- **Workspace-package system** (H3): built via its own `build` script at repo
  build time (turbo), standing in for publish-time building; `@prisma/app*`
  declared as peer deps as they would be for npm.

## Open decisions

- **Auth-system v1 `db` posture (H3).** Boundary input vs internally owned.
  The old blocker dissolved — the unified model forwards resource-backed inputs
  across boundaries — so either works with no groundwork. Recommendation:
  boundary input, since exercising composition is H3's whole point. Decide at
  H3 dispatch.

## Risks (live)

- **Type-level cost** of `SystemContext`/`Wiring` inference at depth — the
  contract types are heavy; keep a three-level nesting case in the type-level
  tests.
- **Address depth vs config-key length** — env-var names are finite; deep
  nesting yields long keys. Tests document the practical bound rather than
  discovering it in production.
- **Harness stalls on large reads** — the extension-config implementer stalled
  three times on big reference reads; mitigation is bounded reads + inlined
  references + phase-by-phase commits. If it recurs despite that, the cause is
  harness flakiness, not the work.
