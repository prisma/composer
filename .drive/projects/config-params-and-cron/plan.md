# Config Params + Cron — Project Plan

## Summary

Two slices, stacked: the config-model change first, cron on top. The design is
fixed by ADR-0018/0019/0020 and the two domain docs; these slices implement it.

**Spec:** [spec.md](spec.md) · **Design notes:** [design-notes.md](design-notes.md)

## Tracker

Slices are identified by S-number here; this plan is the source of truth. Linear
issues are created per-slice when the slice starts, not during planning. Tracker
project: [Prisma App: Config Params + Cron](https://linear.app/prisma-company/project/prisma-app-config-params-cron-78113f9ba550).

- **S1** — TML-3007 — Done ([PR #41](https://github.com/prisma/app/pull/41), merged).
- **S2** — TML-3010 — In progress ([spec](specs/s2-cron-driver-system.md)).

## S1 — The config-model change (ADR-0018 + ADR-0019)

Realizes ADR-0018/0019/0021 as one coherent change — schema-typed params, the
target owning serialization, and the `config()`/`load()` split — because they
co-touch the same files and must land together for a green tree. Full contract:
[specs/s1-schema-typed-params.md](specs/s1-schema-typed-params.md).

Scope:

- `config.ts`: `ConfigParam` becomes plain `{ schema, secret?, optional?, default? }`
  (no serialize method — the target owns encoding); delete `ParamType` / `TypeOf`;
  `Values` infers via `InferOutput`; `ConfigDeclaration` / `configOf` carry the
  schema projection. `string()` / `number()` / `param()` helpers. Core gains a
  type-only `@standard-schema/spec` dependency.
- `app-cloud` (`control.ts` deploy encode, `serializer.ts` boot decode): drive
  encoding off the schema (JSON for service-own, ref pass-through for
  dependency-inputs), validating on the way back; keep `configKey` namespacing.
- `node.ts` / `compute.ts`: add `config()` (returns params); `load()` returns deps
  only. `compute()` accepts user params, merged with the reserved `port`.
- Migrate the four existing param declarations and the storefront-auth read site.

- **Builds on:** the merged ADR-0016/0017 model (nothing else).
- **Hands to:** S2 — a service can declare a structured, schema-typed param that
  round-trips through platform storage, validated.
- **Note:** if one review can't hold this, split into "schema-typing + config()"
  then "target serializer + compute-params" with a green boundary between (spec §
  Open questions).

## S2 — Cron as a driver System (ADR-0020)

Build cron on the structured param from S1, and prove the whole pipeline in-repo.

Scope:

- A reusable `cron-scheduler` `compute()` service: `params: { jobs }` (structured,
  from S1), `deps: { trigger }`, an always-on timer-loop build that calls
  `trigger(jobId)` on schedule.
- `defineSchedule` (produces the `jobs` param) and `serveSchedule` (the `serve()`
  analog that forces a handler per jobId).
- The `Cron` system pattern (scheduler + user router, target as input).
- An in-repo example app (a service with a scheduled endpoint) that deploys and
  fires on schedule — exercising the structured `jobs` param end to end.

- **Builds on:** S1.
- **Hands to:** the Forcing-Function Apps project — a working cron datahub's
  `/tick` can consume.

## Sequencing

A stack: S1 → S2. No parallelism (S2 needs S1's structured param). Both are green
at their boundary.

## Follow-ups

- **HTTP ingress should not be a `port` config param.** Surfaced in S1 review
  ([PR #41](https://github.com/prisma/app/pull/41)): `compute()` reserves a `port`
  config param (default 3000) that the service reads to bind its HTTP server and
  the deploy reads for `portMapping.http`. But the listen port is a platform
  runtime binding, not user configuration. Model it instead as a **declared HTTP
  ingress capability** — the service declares it serves HTTP, the platform
  supplies the bind address at runtime, and the deploy derives `portMapping` from
  the declaration — removing the user-facing `port` param. Not a `deps` entry
  (nothing is on the other end; it's the platform, not another node). Pre-existing
  behaviour (not introduced by S1) and separable from the config-model mechanism;
  likely its own ADR ("how a compute service declares HTTP ingress"). Deferred by
  the operator to keep S1 focused.

## Close-out (required)

- [ ] Verify all acceptance criteria in [spec.md](spec.md) § Project-DoD
- [ ] Confirm ADR-0018/0019/0020 and the domain docs match what shipped; amend if not
- [ ] Strip repo-wide references to `.drive/projects/config-params-and-cron/**`
- [ ] Delete `.drive/projects/config-params-and-cron/`
