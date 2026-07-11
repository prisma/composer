# ADR-0018: Config params carry a caller-owned schema, not a framework type enum

## Status

Proposed

## Decision

A config param declares its type as a **schema the caller supplies** — any
[Standard Schema](https://standardschema.dev) validator, with arktype as the
canonical author. The framework maintains no enum of permitted param types;
whatever shape a schema can express, a param can carry.

```ts
// A scalar param and a structured one, declared the same way.
compute({
  name: 'scheduler',
  params: {
    region: { schema: type('string') },
    jobs:   { schema: type({ jobId: 'string', every: 'string' }).array() },
  },
  // ...
});

// At boot, load() returns values typed by the schemas:
const { region, jobs } = service.load();
// region: string;  jobs: { jobId: string; every: string }[]
```

The schema does double duty: TypeScript infers the param's value type from it
(`StandardSchemaV1.InferOutput`), and it validates the value when the service
boots. `secret` and `optional` remain separate framework facets on the param —
they govern redaction and absence, which are about *handling* a value, not about
what it is.

## Reasoning

Consider a scheduler service that needs its schedule as configuration: a list of
`{ jobId, every }` entries, fixed at deploy so it survives every restart. That
value is a structured array, and it is genuinely configuration — it belongs with
the service's other params, travels the same deploy-to-boot path, and should be
visible wherever the service's config surface is inspected.

A param model built on a fixed set of scalar types cannot hold it. The escape
hatch — declare a string param and stuff a `JSON.stringify` of the schedule into
it — works mechanically but destroys the information: introspection reports "a
string" where there is a schedule, topology tooling and agents can't see inside
it, and any deploy-time machinery that wants to *translate* the schedule (for
instance, into a platform's own scheduling primitives) has to re-parse an opaque
blob by private convention. The structure exists in the author's head and
nowhere else.

The tempting fix is to grow the type set: add `'boolean'`, then `'url'`, then
some object type, each with its own validation. But the framework cannot
enumerate every shape configuration will take, and each addition is core surface
to maintain forever. The question is really *who owns a param's type* — and the
framework has already answered that question once, one layer up. An RPC
`Contract` imposes no structure on its message types; the caller supplies
Standard Schema validators and the framework carries them:

```ts
rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) })
```

Params adopt the same principle. The type is the caller's schema; the framework
carries it, infers from it, and validates with it, imposing nothing:

```ts
interface ConfigParam<S extends StandardSchemaV1 = StandardSchemaV1> {
  readonly schema: S;
  readonly default?: StandardSchemaV1.InferOutput<S>;
  readonly secret?: boolean;
  readonly optional?: boolean;
  // serialization is the target's — see ADR-0019
}
```

A string param is `{ schema: type('string') }`; the schedule is the array schema
above; a shape nobody has thought of yet is just another schema. Validation at
boot runs the schema itself, which checks structured values far more precisely
than a hand-written scalar coercion ever did. Small helpers (`string()`,
`number()`) keep the common scalar declarations to a single word.

Because the schema travels with the declaration, the structure survives into the
graph: the enumeration of a service's config surface (`configOf`) reports the
real shape of every param, so tooling, agents, and deploy-time translation all
see a schedule — not a string.

## Consequences

- **There is no param-type extension point to maintain.** A new shape is a new
  schema in user space, never a core change. The framework's only commitment is
  to the Standard Schema interface.
- **Core gains a type-only dependency** on `@standard-schema/spec` — the same
  interface package `@prisma/app-rpc` already uses. Users bring the validator;
  core names no specific one.
- **Every param is declared this way** — a service's own params and the
  connection params on dependency declarations alike. There is one declaration
  shape, with helpers keeping scalars terse.
- **Params are static data.** A param's value comes from its declaration; a
  reference to another node (an address, a connection string) arrives through a
  dependency input, never inside a param value. A schema param cannot smuggle in
  a provisioning ref.
- **How a schema-typed value is stored and read back is a separate concern** —
  serialization — owned by the deploy target and decided in
  [ADR-0019](ADR-0019-the-target-owns-config-serialization.md).

## Alternatives considered

- **Grow the type enum case by case** (`'boolean'`, `'url'`, an object type…).
  Rejected: the framework cannot anticipate every shape, each addition is
  permanent core surface, and the enum's validation logic re-implements what
  schema validators already do well.
- **Keep scalars and encode structured values as JSON strings.** Rejected: the
  structure vanishes from the graph — introspection, tooling, and deploy-time
  translation see an opaque blob — and every author re-invents the
  stringify/parse convention.
- **A schema variant alongside the scalar enum** (`type: 'schema'` next to
  `type: 'string'`). Rejected: it preserves the enum this decision exists to
  remove and leaves two ways to declare a string. Scalars are just small
  schemas; one mechanism covers everything.

## Related

- [`ADR-0019`](ADR-0019-the-target-owns-config-serialization.md) — how a
  schema-typed value is serialized into platform storage and back.
- [`../10-domains/config-params.md`](../10-domains/config-params.md) — the
  params model end to end.
- [`../10-domains/connection-contracts.md`](../10-domains/connection-contracts.md)
  — the Contract/rpc idiom this mirrors: caller-owned types, framework-carried.
