# Config params

How a service's configuration is declared, typed, carried to the platform, and
read back at boot. Rests on
[ADR-0018](../90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md)
(a param's type is a caller-owned schema) and
[ADR-0019](../90-decisions/ADR-0019-the-target-owns-config-serialization.md)
(the deploy target owns serialization).

## The problem in one example

A scheduler service needs its schedule as configuration — a list of jobs, fixed
at deploy:

```ts
const jobs = [
  { jobId: 'tick', every: '60s' },
  { jobId: 'mrr',  every: '24h' },
];
```

That value has to be declared on the service in a typed way, survive the trip
onto the deployed instance (which stores configuration as encrypted key/value
environment variables), and come back out of `service.load()` at boot as a
validated `Job[]` — not a string somebody remembered to parse. Everything in
this document is the machinery that makes that round trip work, for this
structured value and for the humbler scalars (`port`, a connection `url`) that
travel the same road.

## Declaring a param

A param is a **schema plus a few framework facets**. The schema — any Standard
Schema validator, arktype canonically — is the caller's own; it both types the
param (TypeScript infers the value type from it) and validates the value at
boot:

```ts
compute({
  name: 'scheduler',
  params: {
    jobs: param(type({ jobId: 'string', every: 'string' }).array()),
    region: string({ optional: true }),
  },
  deps:  { trigger: rpc(triggerContract) },
  build: node({ module: import.meta.url, entry: '../dist/scheduler.js' }),
});
```

The facets are `default` (the value used when none is stored), `secret`
(redacted in introspection, placed securely by the target), and `optional`.
They are deliberately not schema concerns: they describe how a value is
*handled*, not what it *is*.

There is no framework enum of permitted types. `string()` and `number()` are
one-word helpers for the common scalars; anything else is just another schema.

## Where the serializer comes from

Between the typed value and the platform sits serialization, and it is not the
param author's job. The `param()` constructor in the example above comes from
the **target extension** (`@prisma/app-cloud`), and the params it builds carry
the target's `serialize`/`deserialize`. That is the whole resolution of "who
encodes this": a param configures a service node, the service node is the
target's (`compute()` is app-cloud's), so the param is the target's type by
construction — and the compiler rejects a param built for some other target.
A package that declares params without being a target (a scheduling extension
declaring `jobs` for its Compute-based scheduler) uses the target's constructor
and stays portable precisely because it never invents its own encoding.

The serializer's contract is fixed only in its **medium**: key/value string
pairs.

```ts
serialize(value)   → Record<string, string>   // under the param's key namespace
deserialize(pairs) → value                    // reverses it; validates via the schema
```

Whether a value becomes one pair holding an encoded blob or fans out across
several pairs — and what the string format inside a value is — is the target's
private business. Core never sees it.

## The round trip, end to end

Follow `jobs` from the declaration above to a firing timer.

**Deploy — build the Config.** The deploy loads the root system into the graph
and, per service node, assembles its typed `Config`: the service's own params
from their declared values, each dependency input's params from its producer's
lowered outputs (the router's URL, a database's connection string). `Config`
values are structurally untouched — the `Job[]` rides through as an array:

```
Config = { service: { jobs: [ {jobId:'tick',…}, {jobId:'mrr',…} ], port: 3000 },
           inputs:  { trigger: { url: 'https://…router…' } } }
```

**Deploy — serialize.** The target's control walks the `Config` and calls each
param's `serialize`, collecting key/value string pairs under the
`ADDRESS_OWNER_NAME` key namespace that keeps them unique within the shared
project:

```
SCHEDULER_JOBS        = '[{"jobId":"tick","every":"60s"},…]'
SCHEDULER_PORT        = '3000'
SCHEDULER_TRIGGER_URL = 'https://…router…'
```

**Deploy — store.** Each pair becomes one project-scoped, encrypted environment
variable, written through the platform API. The service's deployed version
declares those variables as inputs, which orders it after the writes and forces
a new version whenever a value changes.

**Boot — deserialize.** The instance's bootstrap reads the stored pairs back by
key and calls each param's `deserialize`: `jobs` is parsed and validated
against its schema into a `Job[]`; `port` back into a number; the dependency
params into their connection values. The result is the identical typed
`Config`, reconstructed. The values are then re-emitted under address-free keys
so application code never needs to know its own deployment address.

**Runtime — load.** The service entry calls `service.load()` and receives
`{ trigger, jobs, port }`: dependencies hydrated into clients (`trigger` is a
typed RPC client aimed at the router), params as their validated, typed values.
The schedule is back exactly as authored, and the scheduler starts its timers.

One line:

```
Job[] → Config (structured) → target serialize → k/v string pairs
      → encrypted env vars → target deserialize → schema-validated Job[] → load()
```

## Introspection

A service's config surface is enumerable from the graph alone, nothing booted:
`configOf` lists every param — its owner, facets, and **schema** — so a
structured param reports its real shape rather than "a string". Secret params
appear with values redacted. This is what keeps topology tooling and agents
able to answer "what is this service configured with?" truthfully.

## Boundaries

Three lines the model holds everywhere:

- **Core never encodes.** It builds the typed `Config` and hands it to the
  target; it never stringifies a value and never reads an environment. Even the
  key/value medium is an agreement between param and target.
- **Params are static data.** A value that must come from another node — an
  address, a URL, credentials a resource mints — is a dependency input, never a
  field inside a param value. A schema param cannot embed a provisioning ref.
- **`secret` is handling, not type.** The schema says what a value is; `secret`
  says it must be redacted and placed securely. The two never mix.

## Related

- [ADR-0018](../90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md),
  [ADR-0019](../90-decisions/ADR-0019-the-target-owns-config-serialization.md) —
  the decisions this documents.
- [`core-model.md`](core-model.md) — where params sit in the node → graph →
  Config model.
- [`scheduled-work.md`](scheduled-work.md) — the scheduler whose `jobs` param is
  this document's worked example.
- [`connection-contracts.md`](connection-contracts.md) — the caller-owned-type
  idiom (Contract/rpc) that params mirror.
