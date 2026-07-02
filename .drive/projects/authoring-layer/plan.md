# Authoring Layer — Plan

## Summary

Two build slices deliver the corrected design (the build contract is
[`docs/design/10-domains/core-model.md`](../../../docs/design/10-domains/core-model.md)):
first the target-agnostic core + the prisma-cloud pack proven on the minimal
example, then the partial migration of the real example app. The capability
roadmap (typed interfaces, hexes, contracts, …) follows as later projects.

**Spec:** `.drive/projects/authoring-layer/spec.md`

## Current position

**R1 complete** (see below) — the target-agnostic core + pack are real and proven
on real Compute; PR #6 carries them. **R2 in progress** (unattended): storefront-auth
migration per its slice spec; decisions D2–D4 in `wip/unattended-decisions.md`.

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

### [ ] Slice R2 — storefront-auth partial migration (own PR)

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
