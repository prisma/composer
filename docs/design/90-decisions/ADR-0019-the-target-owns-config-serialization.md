# ADR-0019: The deploy target owns config serialization

## Status

Proposed

## Decision

Turning a param's value into stored platform configuration — and back into a
typed value at boot — belongs entirely to the **deploy target**. The target owns
the serialization logic, the storage medium, and the destination. Core builds the
typed `Config` from the graph and hands it over; it never encodes a value, never
chooses a medium, and never reads a platform's storage. A param carries no
serialization of its own — only its schema, which the target uses to validate on
the way back in.

## Reasoning

A scheduler service declares a structured `jobs` param — a list of
`{ jobId, every }` entries ([ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md)).
That value has to reach a running instance and come back typed at boot. Between
the value and the platform sits serialization, and the question is only whose job
it is.

It is the target's, for the same reason it is the RPC transport's and not the
contract author's: the party that *stores and retrieves* a value is the only one
positioned to encode and decode it consistently. The deploy-side write and the
boot-side read must agree exactly, and they can only be guaranteed to agree if
one party owns both — the target that owns the storage. So core hands the target
a typed `Config` and steps out of the way; whether the target writes environment
variables, a JSON config document, or a secret store, and in whatever encoding,
is its business alone. Core does not even define the medium.

This is why a param is just a schema and facets, with no serialize method. Making
the param encode itself would fragment the wire logic across every param author
and force each to know something about storage. The RPC split is the model to
copy: the schema lives on the declaration, the serialization lives with the party
that moves the bytes. A param states *what* its value is; the target decides
*how* it is stored.

One consequence is worth stating plainly: a value must be something the target
can serialize. Standard Schema validating a value guarantees its *shape*, not
that the target can store it — a `Symbol` or a function passes no useful schema
anyway, but the general point stands that serializability is the target's
contract, surfaced as a deploy-time failure, not a core guarantee.

Because serialization is bound to the target and not the param, a param is
target-agnostic: the same `jobs` declaration can be deployed through any target,
and each target serializes it its own way. What ties a particular service's
params to a particular target is not the params — it is the service factory. A
scheduler is a `compute()` service, `compute()` is `@prisma/app-cloud`'s, so
`@prisma/app-cloud` is the target that serializes that scheduler's `jobs`. A
scheduling extension that ships `defineSchedule` returns a plain param; the target
hosting the scheduler is what encodes it. Nobody has to answer "which serializer"
— the target that runs the service does.

### On Prisma Cloud specifically

`@prisma/app-cloud` stores configuration as project-scoped, encrypted environment
variables — rows of `{ key, value: string }` — which Compute injects into the
service, keyed so each param is unique within the shared project. It encodes a
service's own param values into those strings at deploy and reverses them at
boot, validating each against its schema. That the medium here is key/value
strings is *this target's* choice; a different target is free to store the same
`Config` however it likes. Nothing about it is fixed by the framework.

## Consequences

- **A new platform is a new target with its own serialization — not a change to
  core or to consuming code.** The param's schema is unchanged; only the storage
  side differs.
- **`compute()` accepts user params**, and `@prisma/app-cloud` is what serializes
  them. Its reserved params (`port`) merge with the user's; a colliding name fails
  at authoring, as a colliding dependency name does.
- **Core stays out of encoding entirely** — logic, medium, and destination are all
  the target's. Core's boundary is the typed `Config`.
- **Params are target-agnostic**; the service factory (`compute()`) is what binds
  a service's config to a target's serialization.
- **Serializability is the target's contract**, surfaced at deploy time. A value a
  target cannot store is a deploy error, not something core prevents.

## Alternatives considered

- **A framework-fixed intermediate medium** — core serializes everything to, say,
  key/value strings or JSON, and the target only places it. Rejected: it makes
  core define a medium it has no business knowing, forces every target through it
  even when its storage is richer, and splits writer/reader ownership. The target
  owns the whole path, medium included.
- **The param owns its serialization** (a param subtype with encode/rehydrate
  logic). Rejected: it fragments the wire logic across param authors and burdens a
  declaration that only needs to state a type. The RPC split — schema on the
  declaration, serialization on the mover — is simpler and already proven here.
- **A serializer keyed to the param's declaring package.** Rejected: a param
  declared far from the target (a scheduling extension's `jobs`) would carry an
  encoding chosen without knowing the target. The target that *stores* the value
  is the right owner, and the service factory already names it.

## Related

- [`ADR-0018`](ADR-0018-config-params-carry-a-caller-owned-schema.md) — the
  schema-typed param whose values this serializes.
- [`ADR-0017`](ADR-0017-control-plane-loads-through-the-app-config.md) — the
  extension control plane; a target's serialization is part of its control.
- [`../10-domains/config-params.md`](../10-domains/config-params.md) — the full
  pipeline from declaration to platform storage and back.
