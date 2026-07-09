# Authoring Layer — Plan

## Summary

Two build slices deliver the corrected design (the build contract is
[`docs/design/10-domains/core-model.md`](../../../docs/design/10-domains/core-model.md)):
first the target-agnostic core + the prisma-cloud pack proven on the minimal
example, then the partial migration of the real example app. The capability
roadmap (typed interfaces, hexes, contracts, …) follows as later projects.

**Spec:** `.drive/projects/authoring-layer/spec.md`

## Current position

**Update — R6 merged (2026-07-09).** R1–R6 are all on `main`. R6 (typed RPC contracts)
landed via [PR #13](https://github.com/prisma/makerkit/pull/13), together with the
repo-wide no-bare-cast enforcement machinery. **Next up:** the `makerkit deploy` CLI over
a declarative `makerkit.config.ts` (see
[`makerkit-deploy-cli-brief.md`](makerkit-deploy-cli-brief.md)), which also folds
`bundle-next.ts` into `@makerkit/nextjs`'s assembler. R6 follow-ups remain deferred
(in-memory/mock bindings, structural `satisfies`, gRPC/WebSocket kinds, PDL authoring,
contract errors, distributed spec compare, hex boundary ports). The paragraphs below are
the historical R1–R5 narrative.

**R1–R3 merged** (R1 → [#6](https://github.com/prisma/makerkit/pull/6),
R2 → [#7](https://github.com/prisma/makerkit/pull/7), R3 →
[#8](https://github.com/prisma/makerkit/pull/8)). **R4 (Connection primitive)
built and proven live** on `claude/plan-state-store` / [PR #10](https://github.com/prisma/makerkit/pull/10):
the design settled through decisions 8–10, the code shipped, Opus-reviewed, the
storefront→auth round trip runs on real Prisma Cloud, rebased onto main, strict-TS
green, e2e switched to `storefront-auth`.

**R5 (authoring-surface redesign) — active, on the same branch / PR #10.** A long
design session (decision 11) resolved R4's two warts at the root: the framework-DI
gap (Next page read `process.env` directly) and the packaging fragility (import
cycle hidden behind a non-literal `serverModule` trick). The service becomes
declarations only (`compute({deps,build})`, no handler); `run(address,boot)` is the
process controller and `load()` is typed pull-DI; the app owns and bundles its own
entry; build is a two-piece adapter (`@makerkit/node`/`@makerkit/nextjs`). Docs
rewritten (core-model.md, design-note, decision 11); implementation dispatched;
re-prove live is the headline proof. See the R5 slice below.

## Legend

`[ ]` not started · `[~]` in progress · `[x]` done (proof met)

---

## Build slices (this project)

### [x] Slice R6 — typed RPC connection contracts — **merged** (PR #13 → `main`)

> **Merged.** The accept/reject matrix lives as a CI-typechecked type-test
> (`@makerkit/rpc/src/__tests__/contract-satisfaction.test-d.ts` — the two `.poc.ts`
> files were folded into it); four dispatched units (types → runtime → example → hex
> enforcement), Opus-reviewed, a PR-review round addressed (data structures carry no
> optional keys, only possibly-undefined values; "RPC first, not REST"; the identity
> check is the RPC contract's own `satisfies()`, not a framework-level rule), green incl.
> real-cloud E2E, and the storefront renders `auth.verify() -> { ok: true }` over real
> RPC. Landed alongside repo-wide **no-bare-cast** enforcement
> (`biome-plugins/no-bare-cast.grit` + the `scripts/lint-casts.mjs` ratchet +
> `blindCast`/`castAs` in `@makerkit/core/casts`; `.cursor/rules/no-bare-casts.mdc`).

**Outcome:** service-to-service Connections become typed. A framework-owned
`Contract<Kind, Cmp>` (opaque `Cmp` + `kind` brand + runtime `satisfies()`); the
core's compat check is plain assignability with `NoInfer` on the brand; the RPC kind
(`@makerkit/rpc`) makes it correct by building `Cmp` as a concrete function map, so TS
enforces contravariant-input / covariant-output at the hex wiring. `serve(service,
handlers)` generates the RPC server + forces handler↔contract satisfaction; `load()`
returns the typed client (RPC over HTTP). `http()` stays as the untyped escape hatch.
Proof: storefront-auth live, storefront renders `auth.verify()` typed.
**Contract:** `docs/design/10-domains/connection-contracts.md` + the compiled POC.
**Builds on:** R5 (`main`). **Out:** in-memory/mock bindings, structural satisfies,
gRPC/WS, PDL, contract errors, distributed spec compare, hex boundary ports.
**Dispatches:** (1) core + `@makerkit/rpc` types + compat + type tests; (2) RPC
runtime (serve + client binding); (3) examples retrofit; (4) deploy/verify + Opus.

### [x] Slice R5 — authoring-surface redesign (`compute({deps,build})`, `run`/`load`, build adapters) — **merged** (PR #10, squashed to `main` `23ed278`)

> Retrofitted R4: service = declarations, `run`/`load`, build adapters; proven live;
> Opus-reviewed; PR-review round addressed + resolved. See decision 11.

**Outcome:** the service is declarations only (`compute({ deps, build })`, no
handler); the node carries `run(address, boot)` (resolve → stash → boot) and
`load()` (read stash → hydrate → memoize, typed); the app writes AND bundles its own
entrypoint; build is a two-piece adapter (`@makerkit/node`, `@makerkit/nextjs`:
descriptor + `/assemble`). R4's import cycle, non-literal `serverModule` trick,
keep-alive, in-service error handlers, and the Next page's `process.env` read are
all deleted; the framework-DI gap closes (`load()` is the one pull mechanism).
Proof: both `storefront-auth` services on the new shape, live, storefront renders
`Auth /verify says: 200 {"ok":true}`.
**Contract:** rewritten `core-model.md` + `slices/r5-authoring-surface/design-note.md`.
**Motivation:** operator design session — R4's framework-DI gap and packaging
fragility resolved at the root (the service stops being a program).
**Builds on:** R4 (same branch).
**Closes:** the roadmap's **Framework-hosted DI** item (`use()` subsumed by
`load()`).
**Dispatches:** (1) core node reshape + `/deploy` `PackageInput`; (2) pack
`run`/`load`/stash + `/target` `package`; (3) the two adapter packages; (4) examples
refactor; (5) tests; (6) Opus review + fix rounds; (7) deploy/verify/destroy.

### [x] Slice R1 — core + pack rebuild, proven on the minimal example

> **Done.** Commits `eaf7251` + `1bcd818`; 42 tests incl. the five invariant guards;
> two Opus review rounds, all findings fixed with negative-probe verification.
> Proof: deployed via `lower(service, prismaCloud(...))` → live `select 1`
> (`200 [{"ok":1}]`, first attempt) → **idempotent redeploy (`Plan: 3 to noop`)** →
> destroy clean (404 after). PR #6 retitled.

**Outcome:** `@makerkit/core` and `@makerkit/prisma-cloud` exist per
`core-model.md`; `examples/makerkit-hello` is authored via the pack, bundles
itself with tsdown, deploys to real Compute, serves a live `select 1`, destroys
clean.
**Scope:** core factories/`Load`/`lowering`+`lower` router/`runHost` (no `/build`,
no target imports); the pack's three entries (`compute`/`postgres`,
`prismaCloud()`, `runtime({ clients })`); the five invariant guard tests; the
example's app-owned build (tsdown bundle → manifest → tar) and app-supplied
client factory. Reworks PR #6 in place; retitle at DoD.
**Builds on:** nothing (supersedes the prior build on the same branch).
**Hands to:** R2 — the published vocabulary + `lowering()` for mixed stacks.
**Dispatches:** (1) core+pack+example rework with gates green; (2) Opus review +
fix round; (3) deploy/verify/destroy + PR retitle.

### [x] Slice R3 — core-owned config pipeline (own PR)

> **Done.** [PR #8](https://github.com/prisma/makerkit/pull/8) → `main`. Two design
> iterations recorded with motivation (config pipeline → ConfigAdapter model);
> `/deploy` entry rename under the four-plane taxonomy; loud-config validation
> ("a default substitutes for absence, never for garbage"). 64 package tests;
> five review rounds across the slice, all findings closed. Proofs: hello full
> ephemeral cycle green through the new pipeline; storefront-auth updated
> **in place** (dry-plan identity check: 3 update / 4 noop, zero creates), round
> trip live, no env-var race (pre-existing variable — contrast PRO-211).

**Outcome:** the runtime path matches the redesigned model (core-model.md §
Runtime, commit `7862835`): `runtime()`/`TargetRuntime`/the hydrator registry are
gone; connections carry declared config fields + an app-parameterized hydrate;
service types carry `HostConvention` addressing data; core enumerates
(`configOf`), resolves, validates-before-hydrate, and supports field-level
overrides. `runHost(service)` takes no second argument. Both examples updated;
proof = both deploy and serve as before, plus a test overriding config through
core with no environment faked.
**Motivation:** operator design review of `runtime()` — opaque config providers
lose visibility/interception; registries compose poorly across packs; the phantom
client type was a trust boundary. See the doc's Motivation block.
**Builds on:** R2 (branch `claude/r3-config-runtime` off the R2 tip).
**Hands to:** the Connection-primitive project (connections are now the declared
config + hydrate unit it will formalize).

### [x] Slice R2 — storefront-auth partial migration (own PR)

> **Done.** [PR #7](https://github.com/prisma/makerkit/pull/7) (stacked on #6;
> retarget to `main` after #6 merges). Commits `0a23f2c`/`908ce89`/`aec91cc`/`46af1f6`
> + doc amendment `5753e1a`. Old deployment destroyed 7/7; migrated system deployed
> fresh and LEFT LIVE; round trip verified (storefront renders `Auth /verify says:
> 200 {"ok":true}`); redeploy `Plan: 7 to noop`. Pack gained `projectId` output +
> per-key-optional client factories (D7/D8). Race observation recorded: Compute
> applies production env vars at VM boot, not to running versions — candidate
> gotcha; the ordering edge is the Connection primitive's job.

**Outcome:** both storefront-auth services authored via the pack — auth as a
plain handler, storefront as a framework-boot handler over the Next standalone
artifact — in a mixed hand-written stack that yields `lowering(…)` per service
and hand-wires only the `AUTH_URL` EnvironmentVariable (+ deploy ordering); the
deployed storefront→auth round trip works live.
**Builds on:** R1 (merged).
**Hands to:** the Connection-primitive project (the hand-wired `AUTH_URL` is its
target picture) and the framework-DI project (`use()` replaces Next-internal env
reads).
**Known landmine:** the latent `EnvironmentVariable` typing bug
(`deployedUrl: string | undefined` vs `Input<string>`) becomes live once this
stack typechecks — fix belongs in the example wiring or `prisma-alchemy`,
decided at slice spec time.

---

## Capability roadmap (later projects, unchanged through-line)

### [x] Service → service dependency (HTTP, no interface) — the Connection primitive → **slice R4, done** (`slices/r4-connection-primitive/spec.md`). Shipped: `http()`/`connectionEnd`, minimal `hex()`, single-Project placement, `DATABASE_URL` poison, and the decision-8/9/10 reshape (bootstrap identity, node-carried `run`, core=structure/pack=encoding config round-trip). **Proven live on real Prisma Cloud** — storefront→auth round trip renders `Auth /verify says: 200 {"ok":true}` (config on the first version, PRO-211 race dead). Five real-cloud bugs found + fixed en route (Connection DSN, storefront artifact packaging, poison `"-"`, env-var upsert); PRO-212/PRO-213 filed. See its **Deferred** block below.

**Deferred from R4 (decisions 8–10 + the deploy proof) — each is future work, not a regression:**

### [ ] MakerKit-owned deploy entrypoint — `makerkit deploy` over a declarative `makerkit.config.ts` (decision 9)
The standard deploy path: the user writes no stack file; the CLI reads `{ app, target, name, bundle(s) }` and calls `lower()` internally. `lower()`/`lowering()` stay as the mechanism + mixed-stack escape hatch. Documented as an extension point; examples use an interim `alchemy.run.ts` until it lands.
### [ ] Environment-edge **propagation** (provenance-based) (decision 10 / Finding 2)
The edge's ordering job is proven (fresh-deploy race dead); propagating a wire whose value *changes* after deploy is not yet wired — the env-var resource exposes only `{id,key}`, so a changed value doesn't diff the consumer. Fix is provenance-based (consumer depends on the **source node's** version/identity — never the value or a hash of it). Narrow in practice (promoted endpoints are stable); docs are scoped to ordering only.
### [ ] Platform-sourced **secrets** wired to DI (decision 10)
MakerKit *wires* a secret from the platform's secret store (user-set, or via a third-party manager like **Doppler**) into the consumer's DI — it never sources or persists it. R4 has no secrets (all wires); this is the mechanism for when an app needs one.
### [ ] Provisioned credentials → transient platform secret (decision 10 hardening)
A MakerKit-provisioned credential (the DB URL) should be written to the platform secret store transiently at provisioning and wired by reference, so its value never lands in (unencrypted, local) Alchemy state — where it does today.
### [ ] Deterministic Next-standalone artifact / idempotent redeploy
The storefront artifact bundles the standalone `node_modules` (self-contained fix); that copy is not yet byte-deterministic, so a Next-hex redeploy may re-version even when unchanged. The single-service (tsdown) artifact is deterministic; the Next case needs a stable copy (fixed mtimes/ordering) for a true no-op redeploy.
### [ ] Typed HTTP interface, enforced at Load
### [ ] Hex wiring (`hex`, `provision`, ownership, forwarding)
### [ ] Replace a dependency by interface (DIP swap)
### [ ] Data Contract for a data dependency (migrations open)
### [ ] Hex composition / app root (multi-hex deploy)
### [x] Framework-hosted DI — **closed by R5**: `service.load()` is the one typed pull mechanism for both a Hono entry and a Next page; the Next-internal `process.env` read is gone. No separate `use()` accessor needed.
### [ ] Local emulation / test (Load + Hydrate with fakes)
### [ ] Streams (async connection style)
### [x] Prisma-hosted Alchemy state store (platform target) → **slice R8, merged** ([PR #17](https://github.com/prisma/makerkit/pull/17) → `main` `b86f093`)

> Shipped the client-side interim: `@makerkit/prisma-alchemy/state` — a
> `StateService` over postgres.js, automatic Management-API bootstrap (find-or-
> create the `makerkit-state` project, ownership-marker verified against PDP's
> duplicate-name behaviour), session advisory lock with a pid+`pg_locks`
> liveness check, `Target.state` (required) with `prismaCloud()` supplying it
> by default. Proven live (fresh-workdir no-op redeploy, lock contention,
> crash-release, destroy leaves the store standing); two review passes + an
> operator review round. The platform-side final form (Management API
> implementing alchemy's `StateApi` v5) is a filed ask
> (`slices/r8-hosted-state-store/platform-ask.md`); PN adoption for the store's
> data access is captured and deferred (`pn-adoption-design-note.md`).

Implements Alchemy's `StateService` on the platform side: workspace-scoped,
backed by Prisma Postgres, encrypted, authorized by workspace RBAC — the
design already recorded in `docs/design/03-domain-model/layering.md` (Step 1
of the provisioning-state spectrum). **Why it moved up the list:** CI
ownership of the standing demo exposed the gap concretely — Alchemy state is
local files, so any deployer without the live state creates duplicates and
orphans the running system; the CI setup's committed-state-branch mechanism
is the stopgap that deletes wholesale when this lands. Also unlocks: multiple
operators/machines deploying the same stack, and the platform answering
"what's provisioned in this project" (the inspectable-topology goal's
platform half). Not a MakerKit-core capability — a target/platform
deliverable (prisma-cloud pack + Management API surface).

### [ ] Prisma Next for the state store's data access — **deferred** (operator call, PR #17 review)

Replace the state store's hand SQL with a PN contract + `db.orm` + the
programmatic control API (`createPostgresControlClient` → `dbUpdate(mode:
'apply')`, which exists and fits the bootstrap shape — verified against
published 0.14.0). Deferred: complex, rabbit-hole risk, little to gain while
the store is 12 trivial CRUD queries. Facts, costs, and pick-up triggers:
[`slices/r8-hosted-state-store/pn-adoption-design-note.md`](slices/r8-hosted-state-store/pn-adoption-design-note.md).

## Parked / cross-cutting

- **Hex-to-hex addressing** — URL baking today → runtime name resolution (cycles,
  independent redeploys).
- **Inspectable / queryable topology** — the graph's topology view is JSON-safe by
  design; the emit step is additive.
- **Configuration & secrets / egress**; **BYO resources** via capability layers.

## Follow-ups (out of current scope, tracked)

- **`prisma-alchemy` `providers()` typing gap** — satisfies Alchemy's `Stack`
  providers at runtime but not structurally; the pack's `prismaCloud()` will carry
  the same single commented cast until fixed upstream.
- **`name`/`region` authoring** — passed via `prismaCloud()`/`LowerOptions` today;
  consider authoring on the node later.
- **Client-factory typing** — tie the app factory's return type to the declared
  `postgres<C>()` phantom so a mismatch fails at compile (extension point in
  `core-model.md`).
- **Filed platform gotchas (upstream, tracked in Linear "Compute Gotchas"):**
  [PRO-212](https://linear.app/prisma-company/issue/PRO-212) (Connection response
  buries the DSN under `endpoints.*`; `url` is a self-link),
  [PRO-213](https://linear.app/prisma-company/issue/PRO-213) (Compute's bun runtime
  auto-install masks incomplete artifacts + cross-platform native binaries as
  ENOSPC), and the still-biting [FT-5219](https://linear.app/prisma-company/issue/FT-5219)
  (Bun.SQL idle-connection close on scale-to-zero — auth 503s on idle, recovers on
  wake). All have MakerKit-side workarounds in place; the asks are platform fixes.
- **e2e-deploy CI reconciliation** — the workflow reads makerkit-hello's stack
  `outputs.url`; confirm the R4 single-service `lower()` still surfaces it (or
  update the example/CI). Validated by deploying makerkit-hello (also the
  idempotence check).

## R5 review follow-ups (Opus review of `e65bbfb` — verdict: ship; these are latent/pre-existing, none block)

- **[closed by R9]** **Config-key separator ambiguity** — `configKey` joins `address ▸ owner ▸ name` with `_` and uppercases, so `db_url` (a service param) and `db`.`url` (an input's param) both yield `AUTH_DB_URL`. Fixed by rejecting `_` in param and input names at construction (the three core factories).
- **[closed by R9]** **`port` param ↔ listen port decoupling** — `Deployment` hardcoded `port: 3000` while the app binds the service's `port` param. Fixed by threading the resolved port from `serialize` into the `Deployment` through its outputs, so the platform routes to whatever the app binds.
- **[closed by R9]** **Graph is not topologically sorted** — `graph.ts`'s hex load preserved provision order and only validated acyclicity; a consumer-before-producer DAG fed `undefined` into `buildConfig`. Fixed with a stable topological sort at Load (Kahn, smallest-original-index tie-break), so the doc's "topo-ordered (deps first)" claim is now true by construction and an already-producer-first graph is byte-identical.
- **`@makerkit/node` name is a misnomer** (noted in R6 review) — the adapter's `kind: 'node'` means "plain long-running server process" (as opposed to `nextjs`), but the example's server runtime is **Bun** (`Bun.serve` in `server.ts`, `Bun.SQL`, `@effect/platform-bun`, `bunx --bun alchemy deploy`). The name reads as "Node.js runtime" and caused reviewer confusion. Consider renaming the descriptor kind (e.g. `server`) or documenting the distinction where it's defined (`packages/makerkit-node/src/index.ts`).

## PR-review follow-ups (operator review of PR #10)

- **Dev-mode e2e for storefront-auth** (operator ask) — the primitives are runnable in dev today (`load()` reads the address-free `DB_URL`/`PORT` straight from the local env; `run()` is only for translating production's address-prefixed keys — verified by booting both examples). Needs a CI test that boots the services in dev against a local Postgres and asserts the round trip. Approach: a script that starts auth's dev server against a test Postgres, reads its URL, sets `STOREFRONT_AUTH_URL`, starts storefront's dev server, curls the page. Needs a Postgres service in the workflow. Operator noted this becomes a core framework concern later.
- **`bundle-next.ts` belongs in `@makerkit/nextjs/assemble`** (operator ask #11) — `next.config.ts` already owns what it can (standalone output, tracing excludes); the residue (copy `.next/static`+`public`, bundle the wrapper, `bunfig`) can't move to `next.config` (Next omits those by design) but should not be an app-owned script. It moves into the adapter's assembler — folded into the `makerkit deploy` CLI brief. **When it moves, carry over the tsdown `noExternal` rule that inlines the app's own hex packages (`@storefront-auth/*`), not just `@makerkit/*`:** a contract imported by package specifier (`@storefront-auth/auth/contract`) left external is an unresolved import in `main.mjs` that boot-crashes the artifact, so Compute serves "Service not found." This regressed the E2E in R6 when the hexes were renamed from relative imports to package specifiers; fixed in PR #13.

## Close-out (required)

- [ ] Verify all acceptance criteria in `spec.md`
- [ ] Migrate long-lived docs into `docs/` (design already lives there; sync
      `core-model.md` to what shipped)
- [ ] Strip repo-wide references to `.drive/projects/authoring-layer/**`
- [ ] Delete `.drive/projects/authoring-layer/`
