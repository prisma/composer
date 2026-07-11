# ADR-0019: The deploy target owns config serialization

## Status

Proposed

## Decision

Turning a param's value into stored platform configuration — and back into a
typed value at boot — belongs to the **deploy target**. A param carries its
`serialize`/`deserialize` pair, and that pair is the target's, because the param
type itself comes from the target: a `compute()` service takes *Compute* params,
and a Compute param is built by `@prisma/app-cloud`, serializer included.

The one thing fixed across targets is the medium. A param serializes to
**key/value string pairs**:

```ts
serialize(value)   → Record<string, string>   // pairs under the param's key namespace
deserialize(pairs) → value                    // reverses them, validates via the schema
```

What the strings *contain* — JSON, a custom encoding, one pair or several — is
the target's private business. Core never sees it: core builds the typed
`Config` from the graph and hands it over; it never stringifies a value and
never reads an environment.

## Reasoning

A scheduler service declares a structured `jobs` param — a list of
`{ jobId, every }` entries ([ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md)).
That value has to travel from the deploy onto a running instance. On Prisma
Cloud the storage is concrete: configuration is project-scoped, encrypted
environment variables — rows of `{ key, value: string }` — which Compute injects
into the service, and which the service's bootstrap reads back at boot.

So somewhere, `Job[]` becomes strings at deploy and `Job[]` again at boot. The
question is whose code does that, and the answer follows from who stores it.
The writer and the reader must be the same party — the deploy-side encoding and
the boot-side decoding have to agree exactly, and the only package positioned to
guarantee that is the one that owns both ends of the storage: the target. This
is already the model's shape elsewhere: the target owns the mapping from
semantic config to physical platform keys precisely so writer and reader cannot
drift.

The subtlety is that a param can be *declared* far from the target. The `jobs`
param is declared by a scheduling extension; Prisma Cloud has never heard of it.
Who serializes a value the storer didn't declare? The resolution is that there
is no such thing as a target-less param. A param exists to configure a service
node, and the service node is the target's — a scheduler is a `compute()`
service, `compute()` is `@prisma/app-cloud`'s, and `compute()` accepts Compute
params. So the `jobs` param is a Compute param *by construction*, carrying
app-cloud's serializer, and the requirement floats up the type tree: the utility
a user calls to build a schedule returns the Compute param type, the user passes
it to a system that passes it to the service, and the compiler rejects a param
typed for some other target. Nobody chooses a serializer; the types choose it.

That leaves the medium. The serializer could hand the target one opaque string
per param, but that conflates "the storage holds strings" with "a value is one
string": a structured value may want to fan out across several keys, and the
storage is itself a set of key/value rows, one per pair. So the contract is
pairs — `Record<string, string>` under the param's key namespace — and the
target's `deserialize` reverses whatever its `serialize` wrote. The framework
fixes the medium and nothing else; the final string form inside a value never
matters to it.

Different platforms then differ only in their param type. A platform whose
services accept structured JSON configuration supplies a param type whose
serializer emits its native shape; the services and systems consuming those
params do not change, because they only ever handled the param as a typed value.

## Consequences

- **A new platform is a new param type with its own serializer — not a change to
  core or to consuming code.** The param's schema (the caller's) is unchanged;
  only the storage side swaps.
- **`compute()` accepts user params, typed as Compute params.** Its reserved
  params (`port`) merge with them; a user param whose name collides with a
  reserved one fails at authoring, the same way a colliding dependency name
  does.
- **Core stays out of encoding entirely.** It assembles the typed `Config` and
  delegates; even the key/value medium is an agreement between param and
  target, not something core interprets.
- **A param and its target must agree on the medium.** A serializer that cannot
  express its value as string pairs cannot feed an environment-backed target.
  That is the deliberate contract, not a gap.
- **Extensions that declare params for another target's services** (the
  scheduling extension pattern) must build them with that target's param
  constructor — which is exactly what makes their utilities portable: the
  utility takes the constructor's output types, not a hand-rolled shape.

## Alternatives considered

- **Core serializes everything to a universal intermediate (JSON), targets do
  physical placement only.** Rejected: it makes core see and constrain a
  representation it has no business knowing, forces every target through JSON
  even when its storage is richer, and splits writer/reader ownership across two
  parties — the drift this design exists to prevent.
- **The param owns a default serializer; the target may override it.** Rejected:
  two owners for one encoding is ambiguity where the type system can give
  certainty. Making the param type *be* the target's yields a single owner with
  the compiler enforcing it.
- **A serializer registry on the target, keyed by param kind.** Rejected: the
  target would have to enumerate or generically handle every param kind anyone
  might declare. Carrying the serializer on the target's own param type gets the
  same ownership without a registry.
- **One string per param.** Rejected as needlessly narrow: it forbids a value
  fanning out across keys, and the storage medium is already key/value pairs.

## Related

- [`ADR-0018`](ADR-0018-config-params-carry-a-caller-owned-schema.md) — the
  schema-typed param whose values this serializes.
- [`ADR-0017`](ADR-0017-control-plane-loads-through-the-app-config.md) — the
  extension control plane; serialization is part of a target extension's
  control.
- [`../10-domains/config-params.md`](../10-domains/config-params.md) — the full
  pipeline from declaration to platform storage and back.
