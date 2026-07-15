# Plan — RPC service keys

Two slices, each one PR. Slice 1 lands the mechanism and the decision record and
is safe to merge alone; slice 2 wires provisioning and turns it on in a real
deploy.

## Slice 1 — RPC-layer enforcement (`@internal/rpc` only) — THIS PR

Self-contained, no deploy, fully unit-testable via the in-memory transport
(`serve()`'s handler bound straight into `makeClient`).

- **`rpc()` / connection** — add a `serviceKey` connection parameter alongside
  `url`, carrying the generic "auto-provisioned per binding" facet (a plain
  param facet, per ADR-0018; the value is a capability token, not user config).
  `hydrate({ url, serviceKey })` passes the key to `makeClient`.
- **`makeClient`** — attach `Authorization: Bearer <serviceKey>` to every request
  when a key is present.
- **`serve()`** — read the provider's accepted key set from a reserved config
  channel (define the reserved key name + JSON-array format now; slice 2 writes
  it, mirroring how `secretKey`/`secretPointerRows` share a key between reader and
  writer). Enforce: missing/unknown bearer → `401` before parse/dispatch;
  constant-time membership check. When no accepted set is configured, pass through
  unchanged — the migration state until slice 2 provisions keys (ADR-0030's
  end-state semantics; the staged rollout is a plan detail, not in the ADR).
- **Tests** — in-memory transport: right key → dispatches; wrong/missing key →
  `401`; unconfigured provider → passes through. Type test: the `serviceKey`
  param is invisible to the authoring surface.
- **DoD** — `@internal/rpc` unit + type tests green; ADR-0030 + spec included;
  no core/target change; behavior of existing deploys unchanged (inert until
  slice 2).

## Slice 2 — deploy provisioning (core + Prisma Cloud target + example)

Turns the mechanism on end to end and proves it live.

- **Core** — a generic edge-scoped provisioned value: a connection parameter
  marked "auto-provisioned per binding" is not filled from the producer node's
  outputs in `buildConfig`; the target mints one value per RPC edge instead.
  Expose the RPC edges + the empty slot for the target to fill. Keep core free of
  any `rpc`/`serviceKey` knowledge (react to the facet only).
- **Target (`@internal/composer-prisma-cloud` lowering)** — a per-edge `ServiceKey`
  Alchemy resource (random value, stable in deploy state). Wire its value ref
  into (a) the consumer's `serviceKey` `COMPOSER_*` variable and (b) the provider's
  accepted-set `COMPOSER_*` variable, aggregating all inbound edges (Alchemy string
  interpolation over the JSON array).
- **Example + live proof** — deploy `storefront-auth`, assert the wired round trip
  returns `ok` and an anonymous `curl` returns `401`; second redeploy is a no-op.
- **DoD** — the spec's Definition of Done, in full.

## Sequencing / safety

Slice 1 is fail-open when unconfigured, so merging it changes no running deploy.
Slice 2 makes every provider carry keys, at which point enforcement is always
active. If we ever want a provider with no consumers to reject all external
calls (empty accepted set → deny), decide that in slice 2 with the live behavior
in front of us.
