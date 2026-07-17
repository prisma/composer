# ADR-0019: The deploy target owns config serialization

## Decision

Turning a config param's value into stored platform configuration — and reading
it back into a typed value at boot — belongs entirely to the **deploy target**.
The target owns the serialization logic, the storage medium, and the
destination. Core builds the typed `Config` from the graph and hands it over; it
never encodes a value, never picks a medium, and never reads a platform's
storage. A param carries no serialization of its own — only its schema, which
the target uses to validate the value on the way back in.

A param and what the target does with it sit on opposite sides of that line:

```ts
// The param carries only a schema — the caller's own type for the value.
compute({
  name: 'scheduler',
  params: { jobs: param(type({ jobId: 'string', every: 'string' }).array()) },
  // …
});
```

Here `type(...)` is an [arktype](https://arktype.io) schema — the canonical
choice, though any [Standard Schema](https://standardschema.dev) validator works;
`param` wraps it and nothing else.

```
// The target owns everything between that schema and storage.
//
// Encode (deploy): the typed Job[] becomes one stored string, in the target's
// chosen medium — for @prisma/composer-prisma-cloud, a project-scoped env var:
COMPOSER_SCHEDULER_JOBS = '[{"jobId":"tick","every":"60s"},{"jobId":"mrr","every":"24h"}]'

// Decode (boot): the target reads the string back and validates it against the
// param's schema, producing the typed value config() returns:
const { jobs } = service.config();   // Job[] — validated, typed exactly as declared
```

The whole round trip is one line, with the target owning both ends:

```
schema on the param → Config (core, structured) → target encode (its medium) → stored
                    → target decode + schema-validate → config()
```

## Reasoning

Take a scheduler service that declares a structured `jobs` param — a list of
`{ jobId, every }` entries
([ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md)). That value
has to reach a running instance and come back typed at boot. Between the value
and the platform sits serialization, and the only real question is whose job it
is.

It is the target's, and the reason is that a value's writer and its reader must
agree exactly. The bytes written at deploy and the bytes read at boot have to
round-trip perfectly — the same encoding, the same medium — and the one party
that can guarantee that is the party that owns both ends. The target owns the
storage, so the target is the only one positioned to encode into it and decode
back out consistently. Core therefore hands the target a typed `Config` and
steps out of the way: whether the target writes environment variables, a JSON
config document, or a secret store, and in whatever encoding, is its business
alone. Core does not even define the medium.

This is the same split the framework already uses for remote procedure calls
(RPC). An RPC contract puts the caller's schema on the message and lets the
transport move the bytes; the schema lives on the declaration, the serialization
lives with the party that owns the wire. Config params copy that split exactly:
the schema lives on the param, the serialization lives with the target that owns
the storage. A param states *what* its value is; the target decides *how* it is
stored.

That is why a param is just a schema plus a few facets, with no serialize method
of its own. Making the param encode itself would fragment the wire logic across
every param author and force each one to know something about storage. The
param's whole job is to state a type; the target's whole job is to move that
type in and out of a platform.

One consequence is worth stating plainly: a value must be something the target
can serialize. A schema validating a value guarantees its *shape*, not that the
target can store it — a `Symbol` or a function passes no useful schema anyway,
but the general point holds. Serializability is the target's contract, surfaced
as a deploy-time failure, not a core guarantee.

Because serialization binds to the target and not the param, a param is
target-agnostic: the same `jobs` declaration can deploy through any target, and
each target serializes it its own way. What ties a particular service's params
to a particular target is not the params — it is the **service factory**, the
constructor that creates the service node. A scheduler is a `compute()` service,
`compute()` is `@prisma/composer-prisma-cloud`'s, so `@prisma/composer-prisma-cloud`
is the target that serializes that scheduler's `jobs`. A scheduling extension
that ships `defineSchedule` returns a plain param; the target hosting the
scheduler is what encodes it. Nobody has to answer "which serializer" — the
target that runs the service is the answer.

### On Prisma Cloud specifically

`@prisma/composer-prisma-cloud` stores configuration as project-scoped, encrypted
environment variables — rows of `{ key, value: string }` — which Compute injects
into the service. Each key is generated in the framework's reserved `COMPOSER_`
namespace and carries the service's address so it stays unique within the shared
project (`COMPOSER_SCHEDULER_JOBS` above). At deploy the target JSON-encodes each
of a service's own param values into those strings; at boot it JSON-parses them
back and validates each against its schema. A dependency input's value (a
provisioning reference such as a producer's URL) passes through untouched rather
than being re-encoded, because that reference is the ordering edge the deploy
engine resolves through. The target writes these rows as environment-variable
resources that **Alchemy** — the infrastructure-provisioning engine the
framework's deploy lowers onto — creates on the platform.

That the medium here is key/value strings is *this target's* choice. A different
target is free to store the same `Config` however it likes; nothing about the
medium is fixed by the framework.

## Consequences

- **A new platform is a new target with its own serialization — not a change to
  core or to consuming code.** The param's schema is unchanged; only the storage
  side differs.
- **`compute()` accepts user params, and `@prisma/composer-prisma-cloud`
  serializes them.** Its reserved params (`port`) merge with the user's; a
  colliding name fails at authoring, the same way a colliding dependency name
  does.
- **Core stays out of encoding entirely** — logic, medium, and destination are
  all the target's. Core's boundary is the typed `Config`.
- **Params are target-agnostic**; the service factory (`compute()`) is what binds
  a service's config to a target's serialization.
- **Serializability is the target's contract**, surfaced at deploy time. A value
  a target cannot store is a deploy error, not something core prevents.

## Alternatives considered

- **A framework-fixed intermediate medium** — core serializes everything to, say,
  key/value strings or JSON, and the target only places it. Rejected: it makes
  core define a medium it has no business knowing, forces every target through it
  even when its storage is richer, and splits the writer and reader across two
  owners. The target owns the whole path, medium included.
- **The param owns its serialization** (a param subtype with encode/rehydrate
  logic). Rejected: it fragments the wire logic across param authors and burdens
  a declaration that only needs to state a type. The RPC split — schema on the
  declaration, serialization on the party that moves the bytes — is simpler and
  already proven.
- **A serializer keyed to the param's declaring package.** Rejected: a param
  declared far from the target (a scheduling extension's `jobs`) would carry an
  encoding chosen without knowing the target. The target that *stores* the value
  is the right owner, and the service factory already names it.

## Related

- [`ADR-0018`](ADR-0018-config-params-carry-a-caller-owned-schema.md) — the
  schema-typed param whose values this serializes.
- [`ADR-0017`](ADR-0017-control-plane-loads-through-the-app-config.md) — the
  extension control plane; a target's serialization is part of its control plane.
- [`../10-domains/config-params.md`](../10-domains/config-params.md) — the full
  pipeline from declaration to platform storage and back.
