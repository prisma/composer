# Authoring Layer — Plan

## Summary

Two build slices deliver the corrected design (the build contract is
[`docs/design/10-domains/core-model.md`](../../../docs/design/10-domains/core-model.md)):
first the target-agnostic core + the prisma-cloud pack proven on the minimal
example, then the partial migration of the real example app. The capability
roadmap (typed interfaces, hexes, contracts, …) follows as later projects.

**Spec:** `.drive/projects/authoring-layer/spec.md`

## Current position

**Both build slices complete** (unattended run; decisions D1–D12 in
`wip/unattended-decisions.md`). R1 → [PR #6](https://github.com/prisma/makerkit/pull/6);
R2 → [PR #7](https://github.com/prisma/makerkit/pull/7) (stacked). The storefront-auth
demo is live on the authoring layer. Next: merge #6, retarget + merge #7, then the
Connection-primitive project (first capability-roadmap entry).

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
