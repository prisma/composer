# Deploy CLI MVP — Deferred items

- **Destroy without a build.** Investigate whether `alchemy destroy` can run
  the generated stack with placeholder bundles (does destroy-time evaluation
  invoke the pack's `package()`?). Needs live credentials. Origin: S3 review
  finding #1; MVP documents the build-first requirement instead.
- **Assemble-time native-addon detection.** The catch-all wrapper inlining
  ships a `.node`-bearing dep's JS without its binary → boot failure. Detect
  and fail loudly at assemble, or keep known-native packages external and copy
  their binaries. Origin: S3 review finding #3.
- **"Built output missing" error not covered by CLI-package tests — closed by
  S5.** `test/integration/test/cli.entry-anchored-resolution.test.ts` now
  drives the real CLI binary against a real, unbuilt fixture app and asserts
  on the real "no built entry at" message from `@makerkit/node`'s assembler.
  Origin: S3 review.
- **CLI publishability — closed by S5.** The CLI no longer depends on any
  target/adapter pack; resolution is anchored at the app's entry package via
  `createRequire` (see `packages/makerkit-cli/src/resolve-from-entry.ts`).
  Origin: S3 review finding #8.

# Authoring layer — deferred at project close (2026-07-09)

## Platform asks — DRAFTED, NOT YET FILED on Linear (operator action)

1. **Workspace-scoped Alchemy state API** — implement alchemy's HTTP `StateApi`
   v5 (bearer → workspace RBAC, `/version` probe) as a Management API surface.
   When it lands, deployers switch to the stock `httpStateStore` and the
   client-side store (ADR-0009) shrinks to a client or dies. Requirements
   sketch: storage keyed `(stack, stage, fqn)` + `(stack, stage)` outputs;
   per-(stack, stage) lease semantics (409-on-concurrent-apply acceptable v1);
   encryption at rest.
2. **Reserved/unique project names** — PDP allows duplicate project names
   (verified 2026-07-09), so name-based discovery of control-plane projects
   (`makerkit-state`) is ambiguous and squattable; the client-side ownership
   marker (bootstrap.ts `verifyOwnership`) is a workaround. Ask: unique names
   per workspace, or atomic create-if-absent, or a system-project concept.
   Related: workspace ids circulate in two shapes (`wksp_`-prefixed in API
   responses, bare in tokens/config) — normalize or document.

## Capability backlog (later projects — from the authoring-layer roadmap)

- **In-memory/mock contract bindings** (next up): bind a consumer's contract
  slot to a co-located handler or test mock instead of a network client —
  tests + local dev without deploy. Design pass first (where the binding
  decision lives in wiring).
- **Dev-mode e2e** (operator ask, PR #10 review): CI boots both storefront-auth
  services locally against a Postgres, asserts the round trip.
- **Hex composition / boundary ports / nesting**; **DIP swap** (replace a
  dependency by interface); **Data Contract** for data dependencies
  (migrations open); **streams**; **structural `satisfies`**; **gRPC/WS
  contract kinds**; **PDL authoring**; **contract errors**;
  **distributed spec compare**.
- **Environment-edge propagation** (provenance-based): a changed producer
  value doesn't redeploy the consumer today (env-var resource exposes only
  `{id, key}`); fix = consumer depends on the source node's version, never
  the value. Narrow in practice (promoted endpoints are stable).
- **Platform-sourced secrets wired to DI**; **provisioned credentials →
  transient platform secret** (avoid credentials in state — ADR-0009 notes
  the standing concern).
- **Deterministic Next-standalone artifact** (BUILD_ID non-determinism →
  Next services re-version on unchanged redeploys).
- **`@makerkit/node` rename** (descriptor kind means "plain server process",
  not Node.js runtime — needs operator naming call).
- **Interval-lease follow-ups from R8/R9 reviews**: `--wait` affordance on
  lock contention; connection-cap telemetry for the state store.
- **CI workspace sweep** (operator/token): ~17 duplicate `makerkit-state`
  projects accumulated in the CI workspace during the id-shape bug; deploys
  are stable (deterministic oldest-first adoption) but they're quota noise.
