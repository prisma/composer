# ADR-0018: Config params carry a caller-owned schema, not a framework type enum

## Decision

A config param declares its type as a **schema the caller supplies** — any
[Standard Schema](https://standardschema.dev) validator, with arktype as the
canonical author. The framework maintains no enum of permitted param types;
whatever shape a schema can validate, a param can carry. A param is a plain
object — a schema plus a few framework facets — and nothing more; how its value
becomes stored configuration is not its concern
([ADR-0019](ADR-0019-the-target-owns-config-serialization.md)).

```ts
// A scalar param and a structured one, declared the same way.
compute({
  name: 'scheduler',
  params: {
    region: string(),
    jobs:   param(type({ jobId: 'string', every: 'string' }).array()),
  },
  // ...
});

// At boot, config() returns the values, typed by their schemas:
const { region, jobs } = service.config();
// region: string;  jobs: { jobId: string; every: string }[]
```

The schema does double duty: TypeScript infers the param's value type from it
(`StandardSchemaV1.InferOutput`), and it validates the value when the service
boots. `secret` and `optional` remain separate framework facets — they govern
redaction and absence, which are about *handling* a value, not what it is.

## Reasoning

Consider a scheduler service that needs its schedule as configuration: a list of
`{ jobId, every }` entries, fixed at deploy so it survives every restart. That
value is a structured array, and it is genuinely configuration — it belongs with
the service's other params and should be visible wherever the service's config
surface is inspected.

A param model built on a fixed set of scalar types cannot hold it. The escape
hatch — declare a string param and stuff a `JSON.stringify` of the schedule into
it — works mechanically but destroys the information: introspection reports "a
string" where there is a schedule, tooling and agents can't see inside it, and
any deploy-time machinery that wants to *translate* the schedule (into a
platform's own scheduling primitives, say) has to re-parse an opaque blob by
private convention. The structure exists in the author's head and nowhere else.

The tempting fix is to grow the type set: add `'boolean'`, then `'url'`, then
some object type, each with its own validation. But the framework cannot
enumerate every shape configuration will take, and each addition is core surface
to maintain forever. The real question is *who owns a param's type* — and the
framework has already answered it, one layer up, for RPC. An RPC contract puts
the caller's Standard Schema on the message and lets the transport handle the
wire; the schema is the caller's, the serialization is the framework's:

```ts
rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) })
```

Params take the same shape. The schema is the caller's — it types the value and
validates it — and the value may be any object Standard Schema accepts. Turning
that value into stored config is the target pack's job, exactly as turning an
RPC message into bytes is the transport's:

```ts
interface ConfigParam<S extends StandardSchemaV1 = StandardSchemaV1> {
  readonly schema: S;
  readonly default?: StandardSchemaV1.InferOutput<S>;
  readonly secret?: boolean;
  readonly optional?: boolean;
}
```

A string param is `{ schema: type('string') }`; the schedule is the array schema
above; a shape nobody has thought of yet is just another schema. `string()` and
`number()` are one-word helpers for the common scalars; `param(schema)` wraps any
other schema. Validation at boot runs the schema itself, which checks structured
values far more precisely than a hand-written scalar coercion could.

Because the schema travels with the declaration, the structure survives into the
graph: the enumeration of a service's config surface reports the real shape of
every param, so tooling, agents, and deploy-time translation all see a schedule —
not a string.

## Consequences

- **There is no param-type extension point to maintain.** A new shape is a new
  schema in user space, never a core change. The framework commits only to the
  Standard Schema interface.
- **Core gains a type-only dependency** on `@standard-schema/spec` — the same
  interface package `@prisma/compose/rpc` already uses. Users bring the validator;
  core names none.
- **A param value must be serializable by its target.** Since serialization is
  the target's ([ADR-0019](ADR-0019-the-target-owns-config-serialization.md)), a
  value the target can't encode (a `Symbol`, a function) fails at deploy — the
  same way an unserializable RPC payload would. Standard Schema validating a
  value does not guarantee the target can store it; that is the target's contract.
- **Every param is declared this way** — a service's own params and the
  connection params on dependency declarations alike — with helpers keeping
  scalars terse.
- **Params are static data.** A value that must come from another node (an
  address, a connection string) arrives through a dependency input, never inside a
  param value.

## Alternatives considered

- **Grow the type enum case by case** (`'boolean'`, `'url'`, an object type…).
  Rejected: the framework cannot anticipate every shape, each addition is
  permanent core surface, and its validation logic re-implements what schema
  validators already do well.
- **Keep scalars and encode structured values as JSON strings.** Rejected: the
  structure vanishes from the graph — introspection, tooling, and deploy-time
  translation see an opaque blob — and every author re-invents the
  stringify/parse convention.
- **Give the param its own serialization** (a param subtype that knows how to
  encode and rehydrate itself). Rejected: it puts a second responsibility on a
  thing that only needs to state a type, and it fragments serialization across
  every param author. Following the RPC split — schema on the declaration,
  serialization owned by the target — keeps params plain and the wire logic in one
  place.

## Related

- [`ADR-0019`](ADR-0019-the-target-owns-config-serialization.md) — the target,
  not the param, serializes a value into platform storage and back.
- [`ADR-0021`](ADR-0021-params-are-read-through-config-not-load.md) — params are
  read through `config()`, separate from `load()`'s dependencies.
- [`../10-domains/config-params.md`](../10-domains/config-params.md) — the params
  model end to end.
- [`../10-domains/connection-contracts.md`](../10-domains/connection-contracts.md)
  — the RPC contract this mirrors: caller's schema, framework-owned wire.
