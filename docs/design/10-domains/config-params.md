# Config params

How a service's configuration is declared, typed, carried to the platform, and
read back at boot. Rests on
[ADR-0018](../90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md)
(a param's type is a caller-owned schema),
[ADR-0019](../90-decisions/ADR-0019-the-target-owns-config-serialization.md) (the
deploy target owns serialization),
[ADR-0021](../90-decisions/ADR-0021-params-are-read-through-config-not-load.md)
(params are read through `config()`), and
[ADR-0029](../90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md) (a secret
is a distinct forwardable slot, read through `secrets()`).

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
onto the deployed instance, and come back out at boot as a validated `Job[]` —
not a string somebody remembered to parse. Everything in this document is the
machinery that makes that round trip work, for this structured value and for the
humbler scalars (`port`, a connection `url`) that travel the same road.

## Declaring a param

A param is a **schema plus a few framework facets** — a plain object, nothing
more. The schema — any Standard Schema validator, arktype canonically — is the
caller's own; it types the param (TypeScript infers the value type from it) and
validates the value at boot:

```ts
compute({
  name: 'scheduler',
  params: {
    jobs:   param(type({ jobId: 'string', every: 'string' }).array()),
    region: string({ optional: true }),
  },
  deps:  { trigger: rpc(triggerContract) },
  build: node({ module: import.meta.url, entry: '../dist/scheduler.js' }),
});
```

The facets are `default` (used when no value is stored) and `optional`. They
describe how a value is *handled*, not what it *is*. (A secret is not a param
facet — it is its own slot, see § Secrets.) `string()`/`number()` are one-word helpers
for the common scalars; `param(schema)` wraps any other schema. There is no
framework enum of permitted types.

This mirrors how RPC handles message types: the caller's schema lives on the
declaration, and the value may be any object Standard Schema accepts. Getting that
value into storage is a separate job, and not the param's.

## Serialization belongs to the target

A param does not know how to store itself. Turning its value into platform
configuration, and reading it back, is entirely the **deploy target's** job —
logic, encoding, and medium. Core builds the typed `Config` and hands it over; it
never encodes a value and never touches storage. A param carries only its schema,
which the target uses to validate on the way back in.

Because serialization lives with the target and not the param, a param is
target-agnostic — the same `jobs` declaration deploys through any target, each
serializing it its own way. What binds a service's config to a particular target
is the **service factory**: a scheduler is a `compute()` service, `compute()` is
`@prisma/compose-prisma-cloud`'s, so app-cloud is the target that serializes that scheduler's
params. A scheduling extension's `defineSchedule` returns a plain param; whichever
target runs the scheduler encodes it.

A value must therefore be something the target can serialize. A schema validating
a value guarantees its shape, not that the target can store it (a `Symbol` would
fail); serializability is the target's contract, surfaced as a deploy error.

## The round trip, end to end

Follow `jobs` from the declaration to a firing timer, deployed through
`@prisma/compose-prisma-cloud`, whose storage is project-scoped encrypted environment
variables. (The scalar params `port` and the dependency `url` travel the same
path; the structured one just exercises more of it.)

**Deploy — build the Config.** The deploy loads the root module into the graph
and, per service node, assembles its typed `Config`: the service's own params from
their declared values, each dependency input's params from its producer's lowered
outputs (the runner's URL, a database's connection string). `Config` values are
structurally untouched — the `Job[]` rides through as an array:

```
Config = { service: { jobs: [ {jobId:'tick',…}, {jobId:'mrr',…} ], port: 3000 },
           inputs:  { trigger: { url: 'https://…runner…' } } }
```

**Deploy — serialize (the target).** `@prisma/compose-prisma-cloud` encodes each value into
its medium — key/value strings, keyed `COMPOSE_ADDRESS_OWNER_NAME` to stay unique in
the shared project — validating structured values and passing dependency-input values
(provisioning refs) through untouched. Every generated key carries the `COMPOSE_`
prefix — the framework's reserved namespace, kept clear of the user-provisioned
variables secrets point at (§ Secrets):

```
COMPOSE_SCHEDULER_JOBS        = '[{"jobId":"tick","every":"60s"},…]'
COMPOSE_SCHEDULER_PORT        = '3000'
COMPOSE_SCHEDULER_TRIGGER_URL = 'https://…runner…'
```

The encoding (JSON here) is app-cloud's own; a different target would store the
same `Config` however it likes.

**Deploy — store.** Each entry becomes one project-scoped, encrypted environment
variable. The service's deployed version declares those variables as inputs, which
orders it after the writes and forces a new version when a value changes.

**Boot — deserialize (the target).** The instance's bootstrap reads the stored
values back and reverses app-cloud's encoding: `jobs` is parsed and validated
against its schema into a `Job[]`, `port` into a number, the dependency params
into their connection values. The typed `Config` is reconstructed.

**Runtime — load() and config().** The service entry reads its two kinds of value
through two methods:

```ts
const { trigger } = service.load();    // dependencies — a typed rpc client
const { jobs, port } = service.config(); // params — validated, typed values
```

`load()` returns hydrated dependencies; `config()` returns the params. The
schedule is back exactly as authored, and the scheduler starts its timers.

One line:

```
Job[] → Config (structured) → target serialize (its medium) → stored config
      → target deserialize → schema-validated Job[] → config()
```

## Secrets

A secret is **not** a param — it is its own forwardable slot (ADR-0029). The
value is provisioned out-of-band on the platform; the framework carries only the
NAME. A service declares a nameless *need* with `secret()`; the root binds it to
a platform env-var with `envSecret('NAME')` and forwards it in; it reads back
through a third accessor, `secrets()`, as a redacting `SecretBox`:

```ts
// A service/module declares the need — no platform name here:
compute({ name: 'auth', secrets: { signingKey: secret() }, build: … });

// A module forwards its need down to an inner service (ctx.secrets):
module('auth', { secrets: { signingKey: secret() }, expose: … }, ({ secrets, provision }) =>
  provision(inner, { secrets: { signingKey: secrets.signingKey } }),
);

// Only the ROOT names the platform variable (envSecret is the TARGET's, from
// @prisma/compose-prisma-cloud — secret() is core's, from @prisma/compose):
provision(auth, { secrets: { signingKey: envSecret('AUTH_SIGNING_KEY') } });

// Read at the point of use — expose() is the sole reader:
const { signingKey } = service.secrets(); // SecretBox<string>
signingKey.expose();                       // the one door to the value
```

`secrets()` sits beside `load()`/`config()` (ADR-0021). The `SecretBox` redacts
under `toString`/`toJSON`/`valueOf`/`inspect`, so a stray log or serialization
prints `[REDACTED]`; only `expose()` returns the value. `secret()` and the opaque
`SecretSource` are core (`@prisma/compose`); `envSecret('NAME')` — the source
constructor that names and validates a platform variable — is the target's, from
`@prisma/compose-prisma-cloud` (ADR-0018/0019 applied to secrets).

The round trip carries only the name, never the value:

1. **Bind + forward.** The root binds each need to a platform name and wires it
   down the module topology (the same rail dependency inputs use). Load records
   one binding per resolved service secret slot: `{ serviceAddress, slot, name }`.
2. **Preflight.** Before Alchemy runs, the deploy verifies every bound name
   exists on the platform for the target stage's class/branch, filling a name
   from the deploy shell when the platform lacks it (a direct write-only POST,
   never an Alchemy resource, never overwriting an existing value). A name
   missing from both fails the deploy, listing exactly what's absent.
3. **Pointer row.** The target writes a pointer per slot — the generated key
   (`COMPOSE_`-prefixed, like every generated key) maps to the bound name, not a
   value:
   ```
   COMPOSE_AUTH_SIGNINGKEY = "AUTH_SIGNING_KEY"
   ```
4. **Boot double-lookup.** Boot reads the pointer for the name, then reads
   `process.env[name]` for the platform value, and wraps it in a `SecretBox`.

The `COMPOSE_` prefix reserves the framework's generated keys into their own
namespace, so a generated key never collides with — and silently overwrites — a
user-provisioned platform variable.

**Rotation is PATCH + redeploy.** A compute version snapshots its whole env map
at creation and never re-resolves it, so changing a secret's value is the
platform's own semantics: `PATCH` the value, then create a new version.

See [ADR-0029](../90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md) for the full design and its
alternatives.

## Introspection

A service's config surface is enumerable from the graph alone, nothing booted:
every param lists its owner, facets, and **schema**, so a structured param reports
its real shape rather than "a string". Secrets are not params — they are a
separate slot (§ Secrets) whose value never enters this surface at all. This is
what keeps topology tooling and agents able to answer "what is this service
configured with?" truthfully.

## Boundaries

Three lines the model holds everywhere:

- **Core never encodes.** It builds the typed `Config` and hands it to the target;
  it never stringifies a value, never chooses a medium, and never reads storage.
  Serialization — logic, encoding, and medium — is wholly the target's.
- **Params are static data.** A value that must come from another node — an
  address, a URL, credentials a resource mints — is a dependency input, never a
  field inside a param value.
- **Secrets are not params.** A secret is a distinct forwardable slot (§ Secrets,
  ADR-0029), read through `secrets()` as a `SecretBox` — sensitivity is carried by
  the type, never a param facet.

## Related

- [ADR-0018](../90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md),
  [ADR-0019](../90-decisions/ADR-0019-the-target-owns-config-serialization.md),
  [ADR-0021](../90-decisions/ADR-0021-params-are-read-through-config-not-load.md) —
  the decisions this documents.
- [ADR-0029](../90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md) — the
  secrets model this document's § Secrets summarizes.
- [`core-model.md`](core-model.md) — where params sit in the node → graph → Config
  model.
- [`ADR-0020`](../90-decisions/ADR-0020-scheduled-work-is-a-driver-not-a-resource.md)
  — cron, whose `jobs` schedule is this document's worked structured param.
- [`connection-contracts.md`](connection-contracts.md) — the RPC contract whose
  caller-schema / target-owned-wire split params mirror.
