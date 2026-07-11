# Config Params + Cron — Project Plan

## Summary

Two slices, stacked: the config-model change first, cron on top. The design is
fixed by ADR-0018/0019/0020 and the two domain docs; these slices implement it.

**Spec:** [spec.md](spec.md) · **Design notes:** [design-notes.md](design-notes.md)

## Tracker

Slices are identified by S-number here; this plan is the source of truth. Linear
issues are created per-slice when the slice starts, not during planning. Tracker
project: [Prisma App: Config Params + Cron](https://linear.app/prisma-company/project/prisma-app-config-params-cron-78113f9ba550).

## S1 — The config-model change (ADR-0018 + ADR-0019)

Replace the scalar `ParamType` enum with caller-owned schemas, move serialization to
the target over key/value string pairs, and open `compute()` to user params — one
coherent change, because changing the param type breaks the existing serializer, so
they land together for a green tree.

Scope:

- `config.ts`: `ConfigParam` carries `schema` (Standard Schema) + `serialize` /
  `deserialize` (`Record<string,string>`); delete `ParamType` / `TypeOf`; `Values`
  infers via `InferOutput`; `ConfigDeclaration` / `configOf` carry the schema.
  `string()` / `number()` helpers. Core gains a type-only `@standard-schema/spec`
  dependency.
- `app-cloud/serializer.ts`: replace the `coerce` / `String()` scalar path with the
  param's own `serialize` / `deserialize`; keep `configKey`'s `ADDRESS_OWNER_NAME`
  namespacing.
- `compute.ts`: accept a `params` field, merged with the reserved `port`; collision
  check as with deps. `@prisma/app-cloud` exports a Compute-param constructor.
- Migrate every existing param declaration to the schema form via the helpers.

- **Builds on:** the merged ADR-0016/0017 model (nothing else).
- **Hands to:** S2 — a service can declare a structured, schema-typed param that
  round-trips through platform storage, validated.
- **Note:** if one review can't hold this, split into "schema-typing + migration"
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

## Close-out (required)

- [ ] Verify all acceptance criteria in [spec.md](spec.md) § Project-DoD
- [ ] Confirm ADR-0018/0019/0020 and the domain docs match what shipped; amend if not
- [ ] Strip repo-wide references to `.drive/projects/config-params-and-cron/**`
- [ ] Delete `.drive/projects/config-params-and-cron/`
