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
  on the real "no built entry at" message from `@prisma/composer-node`'s assembler.
  Origin: S3 review.
- **CLI publishability — closed by S5.** The CLI no longer depends on any
  target/adapter pack; resolution is anchored at the app's entry package via
  `createRequire` (see `packages/app-cli/src/resolve-from-entry.ts`).
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
   (`prisma-composer-state`) is ambiguous and squattable; the client-side ownership
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
- **System composition / boundary ports / nesting**; **DIP swap** (replace a
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
- **`@prisma/composer-node` rename** (descriptor kind means "plain server process",
  not Node.js runtime — needs operator naming call).
- **Interval-lease follow-ups from R8/R9 reviews**: `--wait` affordance on
  lock contention; connection-cap telemetry for the state store.
- **CI workspace sweep** (operator/token): ~17 duplicate `prisma-composer-state`
  projects accumulated in the CI workspace during the id-shape bug; deploys
  are stable (deterministic oldest-first adoption) but they're quota noise.
- **core-model.md R6 absorption**: the doc's type sketches (Nodes, factories,
  Graph, SystemBuilder) predate R6 — `expose`, `ConnectionEnd.required`,
  ref-ports, the two-overload `provision()`, and required `name`/`pack` are
  shipped but absent from the sketches. The false "not yet built" claims and
  the missing `@prisma/composer-rpc` entry-map row were fixed at close-out; absorbing
  the full mechanism into the sketches is a docs slice of its own
  (connection-contracts.md is the accurate record meanwhile).

# Stage-as-branch — deferred (2026-07-12)

- **Route container resolution through the extension, not the CLI.** Today
  `@prisma/composer-cli` hard-codes the Prisma Cloud specifics of stage resolution:
  it imports `@prisma/composer-alchemy`'s `resolveContainer`/`deleteBranch` directly and
  sets the target-specific `PRISMA_PROJECT_ID`/`PRISMA_BRANCH_ID` env vars on
  the alchemy child (`run-alchemy.ts`). That is Prisma Cloud config leaking
  into the otherwise target-agnostic CLI — accepted for the first
  stage-as-branch slice (ADR-0024 pins that the CLI ensures containers), but
  the durable shape is a deploy-plane hook on the extension descriptor
  (ADR-0017's config already loads extensions): the extension resolves its own
  containers and supplies the env for the child; the CLI stays generic. Origin:
  operator review of PR #42 (`run-alchemy.ts` comment).

# Auth — deferred (2026-07-12)

- **Adopt the `@prisma/cli` credential mechanism; stop rolling our own auth.**
  `@prisma/composer` authenticates the Management API with a static
  `PRISMA_SERVICE_TOKEN` read from the env and sent as a raw `Bearer` header
  (`@prisma/composer-alchemy` `credentials.ts` `fromEnv()` → `client.ts`
  `createManagementApiClient({ token })`) — no login, no refresh, no stored
  credential; a long-lived plaintext token in `.env`. `@prisma/cli` already
  solves this: interactive `prisma auth login` (PKCE OAuth against
  `auth.prisma.io`), a persisted + auto-refreshed credential, with
  `PRISMA_SERVICE_TOKEN` as the CI/non-interactive fallback. The same SDK ships
  the machinery we're not using (`@prisma/management-api-sdk`:
  `createManagementApiSdk` + `createTokenRefreshingFetch`). Ask: reuse the
  prisma CLI's credential resolution in `@prisma/composer` — ideally its own loader,
  so we don't reimplement the store/refresh — so `prisma-composer deploy`
  authenticates exactly like the rest of the CLI and we maintain no auth of our
  own. Touches `credentials.ts`, `client.ts`, `app-cli/ensure-containers.ts`,
  and the token-based state-store bootstrap (`state/bootstrap.ts`). Origin: auth
  review 2026-07-12 (during stage-as-branch); operator directive not to roll our
  own auth.

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
- **Mock/in-memory contract bindings must assume enforcement is on.** A mock
  binding has no edge and therefore no minted key; it works because an
  *unprovisioned* service passes through, which is now a deliberate distinction
  (absent var = local/test → pass; `"[]"` = deployed with zero peers → deny).
  Design the mock-bindings slice against that distinction rather than relying on
  it accidentally.

# Prisma Next data contract — deferred at project close (2026-07-12)

- **Multi-contract / contract-space extension** — full design preserved in
  ADR-0022 §Alternatives ("Deferred, not rejected"). Prerequisite spike before
  pickup: confirm PN handles multiple peer app-authored spaces in one database
  end-to-end (PN ADR 212's monorepo-aggregator case).
- **Dev-time story** — resolved by ADR-0041: the "lowering unchanged" half of
  the parked sketch survives, but substitution happens at the Alchemy provider
  boundary (local providers for the same resource types), not by serving a
  local copy of the Management API — see
  `docs/design/90-decisions/ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md`
  and `docs/design/10-domains/local-dev.md`.
- **Factory name** — `pnPostgres` is a placeholder; Prisma Next → Prisma Data
  rename incoming at GA. Rename the factory when the product name lands.
