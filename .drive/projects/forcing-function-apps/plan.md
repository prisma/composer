# Forcing-Function Apps — Project Plan

## Summary

Two milestones. **M1 (datahub)** is fully sliced: secrets and the emulated
cron resource System land in the framework while the datahub port proceeds in
parallel, converging on a production cutover. **M2 (open-chat + dev loop)** is
sketched — its slices are firmed at the M1-close health check, where we also
decide whether M2 becomes a successor project instead.

**Spec:** [spec.md](spec.md) · **Design notes:** [design-notes.md](design-notes.md)

## Tracker

Slices are identified by their S-number here; this plan is the source of truth.
Linear issues are created per-slice when the slice starts, not during planning.
Tracker project: [Prisma App: Forcing-Function Apps](https://linear.app/prisma-company/project/prisma-app-forcing-function-apps-495e5a5c6a0d).

## External dependencies

- **System composition (`hex-composition` project)** — branch
  `claude/system-composition`. This delivers the resource-as-System seam our
  resource slices consume; see § "What we consume from hex-composition" below.
  Blocks S3 (and M2's S5).
- **Publishing pipeline** — [PR #29](https://github.com/prisma/app/pull/29);
  blocks S2's "consume published packages" condition.
- Both are in flight in other sessions; neither blocks S1.

## What we consume from hex-composition (do not re-derive)

The resource-as-System seam is **owned by the hex-composition project**, not
this one. We build our resource slices on its resolved model rather than
spiking it ourselves:

- **ADR-0016** — a system has the same boundary as a service
  (`SystemNode<Deps, Expose>`); systems nest and `provision()` accepts a system
  wherever it accepts a service.
- **The resource-decoupling / unified model** — `resource()` takes
  `provides: Contract`; `provision(id, resource)` flattens that contract onto
  the ref; a resource-backed input forwards across a system boundary. This is
  how an emulated resource presents a binding without leaking its
  implementation.
- **H3 (their last slice)** — a reusable auth system plus a same-contract fake,
  proven live in CI: swap the backing, consumer unchanged. Our object-storage
  swap (S5) is a second instance of exactly this pattern; we reuse it, we don't
  reinvent it.

**One open question is ours to coordinate, not consume:** the **cron
reverse-edge**. hex-composition's model is consumer-calls-resource; cron
*invokes* the consumer on a schedule. Nothing in ADR-0016's Deps/Expose/
forwarding expresses a scheduled reverse edge. Before S3 is specced, settle
with the hex-composition session whether this is a new composition capability
(lives there) or something our cron System expresses on top of the existing
primitives. This replaces the cancelled S0 spike — it is a design conversation
with that session, not a parallel spike against their moving target.

## Milestone 1: datahub on the framework

### S1 — Secrets as bindings

Secret declared as a dependency, resolved to a binding; backing grounded
against the platform surface (Compute env vars vs management-API store) before
the design settles. ADR for the secrets model.

- **Builds on:** nothing.
- **Hands to:** S2 — apps can declare secret inputs and receive typed bindings.

### S2 — datahub port skeleton

datahub deployed via `prisma-app deploy` from its own repo: ingest + web
services, postgres resource, secrets bindings, published/preview packages.
Scheduling unchanged (in-process tick) for this slice.

- **Builds on:** S1; publishing pipeline.
- **Hands to:** S4 — a framework-deployed datahub verified equivalent to the
  current deployment.

### S3 — datahub consumes cron

The cron design and mechanism moved to its own project — **[Config Params +
Cron](../config-params-and-cron/spec.md)** (ADR-0018/0019/0020): cron is a driver
System (a scheduler that depends on what it calls), built on a new schema-typed,
target-serialized config param. Designing cron for datahub is what surfaced the
config-model change, so that foundation was carved out.

This slice is now just the datahub side: wire datahub's `/tick` to the cron
`cron-scheduler` + a `router`, with the schedule as a `defineSchedule` param.

- **Builds on:** the Config Params + Cron project delivering a working cron; S2
  (datahub port skeleton).
- **Hands to:** S4 — datahub's scheduled ingest running on the framework's cron.

### S4 — datahub on cron + cutover

`/tick` driven by the cron resource; equivalence verified; the team's real
instance cut over. Closes M1.

- **Builds on:** S2, S3.
- **Hands to:** M2 — port mechanics proven, first emulated resource in
  production.

### Parallelisation

Two independent threads join at S4:

- Thread A: S1 → S2 (no dependency on hex-composition; can start now)
- Thread B: S3 — starts once hex-composition lands its resource-as-System model
  **and** the cron reverse-edge is resolved with that session
- Join: S4 (needs S2 and S3)

## Milestone 2: open-chat + dev loop (sketch)

Slices below are placeholders, firmed at the M1-close health check (also the
decision point for splitting M2 into a successor project):

- **S5 — Object storage as an emulated resource System**: blob contract, postgres + R2 backings, the swap demonstration — a direct application of hex-composition's H3 pattern (reusable system + same-contract fake).
- **S6 — Streams as a resource**: design pass first (wrapper System vs managed primitive).
- **S7 — open-chat port**: builds on S5, S6 (+ S1, S3 from M1).
- **S8 — The local dev loop**: builds on S7 — deliberately last, after two ports' worth of evidence.

S5 and S6 are parallel; S7 joins them; S8 closes.

## Close-out (required)

- [ ] Verify all acceptance criteria in [spec.md](spec.md) § Project-DoD
- [ ] Migrate long-lived docs into `docs/` (ADRs: secrets, cron reverse-edge if new, dev loop; cron/object-storage contract specs). The resource-as-System ADR is hex-composition's (ADR-0016), not ours.
- [ ] Strip repo-wide references to `.drive/projects/forcing-function-apps/**`
- [ ] Delete `.drive/projects/forcing-function-apps/`
