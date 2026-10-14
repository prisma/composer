# Deploy CLI MVP — Deferred items

- **Assemble-time native-addon detection.** The catch-all wrapper inlining
  ships a `.node`-bearing dep's JS without its binary → boot failure. Detect
  and fail loudly at assemble, or keep known-native packages external and copy
  their binaries. Origin: S3 review finding #3.

# Authoring layer — deferred at project close (2026-07-09)

## Capability backlog (later projects — from the authoring-layer roadmap)

- **In-memory/mock contract bindings** (next up): bind a consumer's contract
  slot to a co-located handler or test mock instead of a network client —
  tests + local dev without deploy. Design pass first (where the binding
  decision lives in wiring).
- **DIP swap** (replace a dependency by interface); **structural
  `satisfies`**; **gRPC/WS contract kinds**; **PDL authoring**; **contract
  errors**; **distributed spec compare**.
- **Platform-sourced secrets wired to DI**; **provisioned credentials →
  transient platform secret** (avoid credentials in state — ADR-0009 notes
  the standing concern).
- **Deterministic Next-standalone artifact** (BUILD_ID non-determinism →
  Next services re-version on unchanged redeploys).

# RPC service keys — deferred at project close (2026-07-16)

Shipped: ADR-0030 (every RPC binding carries an auto-provisioned per-binding
key; `serve()` 401s a caller without one) and ADR-0031 (the generic mechanism —
an opaque branded `ProvisionNeed` resolved through the target's `provisions`
registry). What we deliberately didn't do:

- **Cross-extension provisioned edges.** An edge whose consumer and provider
  belong to different extensions fails closed (`crossExtensionProvisionError`).
  The real shape is a cross-target contract (who mints, who validates) and there
  is no second target to design it against. ADR-0031's registry +
  resolve-against-the-consumer's-extension rule is chosen so lifting this adds a
  code path, not a redesign.
- **More than one provisioned param on one connection** — also fails closed
  (`multipleProvisionedParamsError`). One edge mints one value keyed by
  `${consumer}.${input}`, so a second need on the same connection would silently
  take the first's value under the first's brand. If a second need ever appears,
  design per-param keying (note: that churns the `servicekey-${edgeId}` resource
  id, so it re-mints keys).
- **Rotation UX.** Rotation is "remove the binding (or destroy the stack) and
  redeploy" — no rotate command, and no way to rotate without a redeploy.
- **Per-method / per-contract authorization.** The key authorizes at the service
  level: any valid key reaches every method the service exposes. Splitting into
  two services is the workaround (operator: out of scope, "easily mimickable by
  creating multiple RPC contracts").
- **Publishing the provisioning SPI.** `provisionNeed` / `ProvisionNeed` /
  `ProvisionerDescriptor` live in `@internal/*`, so only first-party authoring
  kinds and targets can use ADR-0031's mechanism. This is *consistent* with
  secrets — `secretSource` is equally internal — so it's not a regression; if
  third-party extensions ever land, both SPIs publish together.
- **Security: a service with no accepted-keys variable accepts every caller.**
  `serve()` reads `COMPOSER_RPC_ACCEPTED_KEYS` straight from the environment
  (`packages/0-framework/2-authoring/service-rpc/src/serve.ts`,
  `acceptedKeys()`). Absent or empty means "unprovisioned: local or test", and
  every request passes; `"[]"` means "deployed with no wired callers", and
  every request is refused. So a target that forgets to set the variable
  ships a service that accepts anyone, instead of one that refuses everyone.
  Mock/in-memory bindings rely on the same pass-through today, because a mock
  binding has no edge and no minted key. Fix: make enforcement the default
  and have local/test runs opt out explicitly, then design the mock-bindings
  slice against that. Related: the variable's name is spelled separately in
  two packages (`RPC_ACCEPTED_KEYS_ENV` in service-rpc, `RPC_ACCEPTED_KEYS`
  through `configKey` in the target's `service-keys.ts`), so a rename on one
  side would also fail open. Share the constant or add a cross-package test.
  Origin: forcing-function-apps streams-binding audit, 2026-07.
- **Wired egress: mount an rpc port only if something is wired to it.**
  Today `serve()` mounts every rpc port of a service under one flat
  `/rpc/<method>` route, with one accepted key set for the whole service, so
  method names must be unique across ports and a key for one port reaches
  every port. The settled direction (Will, 2026-07-23): a port exists on the
  network only when a consumer is wired to it, it accepts only those edges'
  keys, and public exposure becomes an explicit binding the root supplies.
  The platform gives a Compute version one port and one public URL, so v1
  would be per-port path prefixes on the one listener. Design record:
  the `wired-egress` Drive project on branch `claude/wired-egress-project`.
  Rationale in `docs/design/10-domains/auth-module.md`.

# Prisma ORM data contract — deferred at project close (2026-07-12)

- **Multi-contract / contract-space extension** — full design preserved in
  ADR-0022 §Alternatives ("Deferred, not rejected"). Prerequisite spike before
  pickup: confirm Prisma ORM handles multiple peer app-authored spaces in one database
  end-to-end (Prisma ORM ADR 212's monorepo-aggregator case).

# Config params — deferred (2026-07, PR #41 review)

- **HTTP ingress should be a declared capability, not a reserved `port`
  param.** `compute()` reserves a `port` config param (default 3000) that the
  service reads to bind its server and deploy reads for `portMapping.http`
  (`packages/1-prisma-cloud/1-extensions/target/src/compute.ts`). The listen
  port is a platform runtime binding, not user configuration. Instead: the
  service declares that it serves HTTP, the platform supplies the bind
  address at runtime, and deploy derives `portMapping` from the declaration.
  Not a `deps` entry, since nothing in the graph is on the other end. Likely
  its own ADR.

# Composition — deferred (2026-07, PR #39 review)

- **One `ControlClient` for `(extension, type)` lookups.** Three places look
  up an extension descriptor by `(extension, node type)` on their own:
  `core/src/control/deploy.ts`, `cli/src/validate-coverage.ts` and
  `assemble/src/assemble-services.ts`. Replace them with one in-memory client
  that performs control-plane operations, not a state map. Open design.

# Upstream alchemy — asks (2026-08, provider adoption)

- **Raise or make configurable `destroyApp`'s 409 retry budget, or drain the
  App's deployments before deleting it.** It retries for about 3.75 seconds in
  total; Composer's old provider retried for up to 5 minutes. See
  `docs/design/05-prisma-cloud/alchemy-lowering.md`.
- **Export `PrismaUploadClient` / open `alchemy/Prisma/Internal/*`.** The
  package export is `null`, so an outside stack cannot compose the scoped
  upload client; the only alternative is overriding the ambient
  `HttpClient`.

# Build reporting — deferred (2026-10, ADR-0051 follow-ups)

- **The display-name fallback can adopt another app's Project.**
  `resolveProject` in `packages/1-prisma-cloud/0-lowering/lowering/src/container.ts`
  falls back to matching Projects by display name when none has the app's
  `logicalId`. That fallback also matches a Project that already carries a
  different `logicalId`. It should only consider Projects with no
  `logicalId`.
- **Document recovery from a duplicate-`logicalId` 409.** A deploy that lost
  its state hits a 409 when it recreates an App, Database or Bucket whose
  `logicalId` already exists; Composer never adopts the existing row. No doc
  says what to do.
- **Ask pdp to change the branch-topology spec's example.** Its worked example
  uses `catalog-db` as a node `logicalId`. Composer cannot produce that
  address (below the root, addresses contain only letters, digits and dots),
  and it reads like an Alchemy resource ID. Ask for `catalog` instead.

# Auth module — deferred (2026-07/09)

- **The embedded export never shipped.** `createEmbeddedAuth()` (`./embedded`),
  which runs Better Auth in the consumer's own service with the same
  `buildAuthOptions()`, was the auth project's slice S4 and was not built.
  The package README still says "Arrives with slice S4". Design in
  `docs/design/10-domains/auth-module.md`.
- **`composeServiceFetch` matches the public prefix as a plain string.**
  `/api/auth` also matches `/api/authorize`. Match on a path-segment boundary
  (`packages/0-framework/2-authoring/service-rpc/src/compose-fetch.ts`).

# Forcing-function apps — deferred at shelving (2026-07)

- **Upstream the open-chat `@prisma/streams-server@0.1.11` performance
  patch.** open-chat patches the server for parallel bootstrap of segment
  heads (`STREAMS_BOOTSTRAP_HEAD_CONCURRENCY`) and an AbortController that
  honours `DS_OBJECTSTORE_TIMEOUT_MS` in the R2 client. Composer's streams
  module pins 0.1.11 unpatched: correct, but cold-start bootstrap is
  sequential. Make it a minimal PR to prisma/streams, not a vendored copy.
  Same PR: `withTimeout` in the server's `src/util/retry.ts` never clears its
  losing timer, so the process lingers up to `DS_OBJECTSTORE_TIMEOUT_MS`
  after SIGTERM.
- **Streams wiring checks only the kind.** `streamsContract.satisfies` is
  `required.kind === 'streams'`. Two consumers with conflicting typed stream
  definitions are not caught at wiring, only when one reads the other's
  events.
- **The datahub live deploy and cutover never happened.** The datahub port
  (branch `claude/prisma-app-port` in prisma/datahub) was proven by a graph
  test and a local boot, but never refreshed to the current packages,
  deployed with real credentials, or cut over. Needs operator credentials.
