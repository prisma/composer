# Purpose

Make the framework's config model carry **structured, typed configuration**, and
build **cron** on top of it — the concrete framework adaptation that datahub's
scheduled `/tick` forced. Today a service's config params are limited to
`string | number` scalars; a schedule (a list of `{ jobId, every }`) has nowhere to
live except an opaque JSON string that the graph can't see. This project replaces
the scalar enum with caller-owned schemas, moves serialization to the deploy target,
and delivers cron as a driver System that rides on the new structured param.

The design is settled and recorded as ADRs and domain docs (see § References); this
spec and its plan carry only what's true at the project level.

# At a glance

Three decisions, realized in two slices:

- **Config params carry a caller-owned schema** (ADR-0018) — `ConfigParam` holds a
  Standard Schema instead of a `type: 'string' | 'number'`; any shape becomes
  expressible with no core change.
- **The target owns serialization, over key/value string pairs** (ADR-0019) — a
  param's `serialize`/`deserialize` belong to the target that stores it, carried by
  the target's param type; the medium is k/v strings, the format inside a value is
  the target's business. `compute()` opens to user params.
- **Cron is a driver System** (ADR-0020) — a reusable `cron-scheduler` that depends
  on a `trigger(jobId)` endpoint, a user `router`, and `defineSchedule` /
  `serveSchedule` utilities; the schedule is a build-time structured param.

# Non-goals

- **Native platform cron.** We build the emulated (always-on scheduler) realization
  and design the param so a native lowering is possible later; we do not build the
  native lowering or a platform scheduler here.
- **Durable / exactly-once / dynamic scheduling.** v1 cron is stateless with a
  build-time schedule and idempotent targets. Runtime-registered or
  exactly-once scheduling is out of scope until a consumer needs it.
- **Field-level secrecy inside a structured param.** `secret` is whole-param.
- **Provisioning refs inside a structured param.** Structured params are static
  data; a needed address is a dependency edge, not a param field.
- **The datahub port.** Wiring datahub onto this cron is the Forcing-Function Apps
  project's job; this project ships the mechanism and an in-repo proof.

# Place in the larger world

- Builds directly on the merged system-composition + control-plane work
  (ADR-0016/0017): `compute()`, `service()`, the `ServiceLowering` serialize/
  deserialize seam, `buildConfig`, and app-cloud's `serializer.ts` /
  `EnvironmentVariable` path are what this changes.
- Is the framework foundation the **Forcing-Function Apps** project depends on: its
  cron slice (datahub `/tick`) consumes this project's output, and its object-storage
  slice will reuse the structured-param mechanism.
- Tracker: [Prisma App: Config Params + Cron](https://linear.app/prisma-company/project/prisma-app-config-params-cron-78113f9ba550)
  (Terminal). Linear issues are created per-slice when a slice starts, not now.

# Cross-cutting requirements

- **Caller owns the type; the target owns the serialization.** These meet on the
  param object and must not bleed: core imposes neither a type enum nor an encoding,
  and never stringifies or reads an environment.
- **The serializer medium is key/value string pairs.** A param serializes to
  `Record<string, string>` under its key namespace; the string form inside a value
  is private to the target's serializer/deserializer.
- **Structured values stay visible to the graph.** `configOf` reports a param's
  schema, not "a string" — introspection and a future native lowering can read the
  real shape.
- **The build stays green at each slice boundary.** Because changing the param type
  breaks the existing serializer, the type change and the serializer change land
  together; no intermediate state leaves the tree uncompilable or unbootable.
- **Cron adds no new composition capability.** A driver is a normal consumer of a
  sibling's exposed endpoint; if the implementation reaches for a new primitive,
  stop — the design says it isn't needed.

# Transitional-shape constraints

- Every existing param declaration (`postgres`/`rpc`/`http`'s `url`, `compute`'s
  `port`, service params) migrates to the schema form in the same slice that
  changes `ConfigParam`; the `string()` / `number()` helpers keep each a one-word
  change.

# Project-DoD

- [ ] A service can declare a **structured, schema-typed param**, and its value
      round-trips deploy → platform storage → boot → `load()`, validated, with the
      graph able to report its shape (`configOf`).
- [ ] `compute()` accepts user params (typed as Compute params); the reserved `port`
      still works; a colliding name fails at authoring.
- [ ] Serialization is the **target's**, over key/value string pairs; core contains
      no `ParamType` enum and no stringifying.
- [ ] **Cron works end to end in an in-repo example**: a `cron-scheduler` +
      `router` + `Cron` system, jobs declared with `defineSchedule` /
      `serveSchedule`, deployed, firing its target on schedule — the structured
      `jobs` param exercised through the full pipeline.
- [ ] ADR-0018/0019/0020 and the two domain docs are accurate to what shipped.

# Open questions

- **Helper surface for authoring a Compute param.** ADR-0019 implies `@prisma/app-cloud`
  exports a param constructor (its branded `ConfigParam`) so `defineSchedule` and
  Compute service authors build params carrying app-cloud's serializer. Exact
  surface (`param(schema)` vs a typed re-export) is a slice-time call.
- **Whether the config-model slice (S1) splits.** It is one coherent change but may
  be large; if a single review can't hold it, split into "schema-typing + migration"
  then "serializer + compute-params" with a green boundary between.

# References

- ADRs: [0018](../../../docs/design/90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md),
  [0019](../../../docs/design/90-decisions/ADR-0019-the-target-owns-config-serialization.md),
  [0020](../../../docs/design/90-decisions/ADR-0020-scheduled-work-is-a-driver-not-a-resource.md).
- Domain docs: [config-params.md](../../../docs/design/10-domains/config-params.md),
  [scheduled-work.md](../../../docs/design/10-domains/scheduled-work.md).
- Code this changes: `packages/app/src/config.ts` (`ConfigParam`, `Params`,
  `Values`, `configOf`), `packages/app/src/deploy.ts` (`buildConfig`,
  `ServiceLowering`), `packages/app-cloud/src/compute.ts` (`computeParams`),
  `packages/app-cloud/src/serializer.ts` (`configKey`, `coerce`, `stash`,
  `deserialize`), `packages/alchemy/src/compute/EnvironmentVariable.ts`.
- [Forcing-Function Apps](../forcing-function-apps/spec.md) — the consumer project.
