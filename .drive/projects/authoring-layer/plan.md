# Authoring Layer — Plan

## Summary

Two build slices deliver the corrected design (the build contract is
[`docs/design/10-domains/core-model.md`](../../../docs/design/10-domains/core-model.md)):
first the target-agnostic core + the prisma-cloud pack proven on the minimal
example, then the partial migration of the real example app. The capability
roadmap (typed interfaces, hexes, contracts, …) follows as later projects.

**Spec:** `.drive/projects/authoring-layer/spec.md`

## Current position

**All three build slices complete.** R1 →
[PR #6](https://github.com/prisma/makerkit/pull/6) (merged); R2 →
[PR #7](https://github.com/prisma/makerkit/pull/7) (open → main, mergeable); R3 →
[PR #8](https://github.com/prisma/makerkit/pull/8) (open → main). The
storefront-auth demo is live on the authoring layer through the ConfigAdapter
pipeline. Remaining: merge #7 then #8 (operator), project close-out (verify spec
DoD, sync docs, delete this project dir), then the Connection-primitive project
(first capability-roadmap entry — its target picture is the hand-wired AUTH_URL).

## Legend

`[ ]` not started · `[~]` in progress · `[x]` done (proof met)

---

## Build slices (this project)

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

### [ ] Service → service dependency (HTTP, no interface) — the Connection primitive; replaces R2's hand-wired `AUTH_URL`
### [ ] Typed HTTP interface, enforced at Load
### [ ] Hex wiring (`hex`, `provision`, ownership, forwarding)
### [ ] Replace a dependency by interface (DIP swap)
### [ ] Data Contract for a data dependency (migrations open)
### [ ] Hex composition / app root (multi-hex deploy)
### [ ] Framework-hosted DI (`use()` accessor; removes Next-internal env reads)
### [ ] Local emulation / test (Load + Hydrate with fakes)
### [ ] Streams (async connection style)
### [ ] Prisma-hosted Alchemy state store (platform target)

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

## Close-out (required)

- [ ] Verify all acceptance criteria in `spec.md`
- [ ] Migrate long-lived docs into `docs/` (design already lives there; sync
      `core-model.md` to what shipped)
- [ ] Strip repo-wide references to `.drive/projects/authoring-layer/**`
- [ ] Delete `.drive/projects/authoring-layer/`
