# SPI inversion & deployment results — Project Plan

## Summary

Three slices: the DI refactor first (operator-directed ordering), then
wiring enforcement and deployment results in parallel on the clean seams.

**Spec:** [spec.md](spec.md) · **Design notes:** [design-notes.md](design-notes.md)

## Tracker

Slices are identified by S-number here; this plan is the source of truth.
Linear issues are created per-slice when the slice starts, under
[Prisma Composer: SPI inversion & deployment results](https://linear.app/prisma-company/project/prisma-composer-spi-inversion-and-deployment-results-f87bb6d9de12)
(Terminal/TML).

## External dependencies

- **alchemy `2.0.0-beta.59`** — execution-model facts in design-notes are
  verified against this version; a version bump mid-project re-opens them.
- **Composer PR #101** — the superseded `NodeReport` PR; disposed of in S3.
- No dependency on other in-flight projects.

## Slices

### S1 — Invert the lowering SPI (+ ADR)

**Spec:** [slices/s1-invert-spi/spec.md](slices/s1-invert-spi/spec.md)
· **Plan:** [slices/s1-invert-spi/plan.md](slices/s1-invert-spi/plan.md)

Retire `LoweredNode`'s triple duty. Phase handoffs become descriptor-owned
types carried generically by the SPI (opaque to core); the inter-node
wiring record becomes its own named type, still name-keyed because
`buildConfig` reads it by the consumer's declared params. Every descriptor
(compute, postgres, prisma-next, s3-store, s3-credentials) migrates to its
own typed handoffs; the casts that recover a descriptor's own values go
away. Decide and apply the treatment for `ApplicationDescriptor` and
provisioner surfaces from their actual consumers. Author the ADR in
`docs/design/90-decisions/` covering the seam design: consumer-declared
interfaces, the loop as sole router, results assembled at full context, no
transport before a cross-process consumer exists.

**Builds on:** nothing.
**Hands to:** S2, S3 — a `deploy.ts` SPI whose three contracts are distinct
types with distinct consumers, all descriptors compiling cleanly against it,
behavior unchanged (deploys identical to today).

### S2 — Enforce the wiring contract *(operator-confirmed 2026-07-17)*

**Spec:** [slices/s2-enforce-wiring-contract/spec.md](slices/s2-enforce-wiring-contract/spec.md)
· **Plan:** [slices/s2-enforce-wiring-contract/plan.md](slices/s2-enforce-wiring-contract/plan.md)

After a producer lowers, verify its wiring outputs satisfy every param the
consumer's connection declares (skipping provisioned params, which the mint
supplies). A gap fails the deploy with a `LowerError` naming the edge, the
param, and both nodes. Tests cover the loud path and the provisioned-param
exemption. Behavior change: descriptor pairs silently under-delivering
today start failing — that is the point.

**Builds on:** S1 (the named wiring type and its single consumer path).
**Hands to:** nothing downstream; independently mergeable.

### S3 — DeploymentResult and rendered deploys (supersedes #101)

**Spec:** [slices/s3-deployment-results/spec.md](slices/s3-deployment-results/spec.md)
· **Plan:** [slices/s3-deployment-results/plan.md](slices/s3-deployment-results/plan.md)

The deploy phase returns wiring and primitives as distinct values
(`LoweredResult`); the lowering loop routes wiring to `lowered` and hands
the address-keyed primitives to an alchemy **Action** declared at the end
of the stack effect. The action runs during apply with the primitives
resolved, joins them to the graph by closure into per-node
`DeploymentResult`s, and calls the CLI's renderer (wired through the
generated stack file): the app's own topology, authored names, platform
ids, public URLs. The stack returns `undefined`, so the raw alchemy
stack-output dump stays gone. First dispatch is a probe of the Action
mechanism on a fresh stack. Close PR #101 with a supersession comment.

**Builds on:** S1.
**Hands to:** nothing downstream; the project-DoD demo rides on it.

## Sequencing

- **Stack:** S1 → (S2 ∥ S3). S2 and S3 touch different parts of the loop
  and can run in parallel once S1 merges.

## Open items

- **`core-model.md`'s model section is stale beyond this project's reach**
  (surfaced by S1-D3, deliberately not fixed there). It still describes a
  `Target` with separate `resources`/`services` maps; the code has
  `ExtensionDescriptor` with a single `nodes` registry (ADR-0017/0031).
  S1-D3 transcribed only the SPI signatures it owned — correctly, since
  fixing the surrounding model is its own change with its own review.
  **Not a finding; needs a follow-up ticket.** (`Record<string, ServiceLowering>`
  at ~line 447 is *not* part of this: it stays correct under the new
  generics, storing at the `unknown` defaults — the erasure ADR-0033
  describes.)

## Close-out (required)

- [ ] Verify all acceptance criteria in [spec.md](spec.md)
- [ ] Migrate long-lived docs into `docs/` (the ADR lands in S1; check
      design-notes for anything else durable)
- [ ] Strip repo-wide references to `.drive/projects/spi-inversion-and-deploy-results/**`
- [ ] Delete `.drive/projects/spi-inversion-and-deploy-results/`
