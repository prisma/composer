# Config params

> Amended by [ADR-0061](../90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): a module declares one `input` schema, as a compute service does; the module `params`/`paramNeed()` and `secrets`/`secret()` slots described here are removed.
>
> Amended by the module-input project (2026-10-29): every source constructor returns a value; see [Sources are values](#sources-are-values).
>
> Amended by the module-input project (2026-10-30): the module slots are removed from the code; § Secrets and the table below describe `input`.

How a service's configuration is declared, typed, carried to the platform, and
read back at boot. Rests on
[ADR-0018](../90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md)
(a param's type is a caller-owned schema),
[ADR-0019](../90-decisions/ADR-0019-the-target-owns-config-serialization.md) (the
deploy target owns serialization),
[ADR-0021](../90-decisions/ADR-0021-params-are-read-through-config-not-load.md)
(params are read through `config()`),
[ADR-0029](../90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md) (a secret
is carried by name only, never by value), and
[ADR-0032](../90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)
(a param binds at provision — a literal or an env source).

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
facet — it is a `secretString()` input field, see § Secrets.) `string()`/`number()` are one-word helpers
for the common scalars; `param(schema)` wraps any other schema. There is no
framework enum of permitted types.

This mirrors how RPC handles message types: the caller's schema lives on the
declaration, and the value may be any object Standard Schema accepts. Getting that
value into storage is a separate job, and not the param's.

## Binding a param at provision

A declaration carries no value beyond its `default`. The value is bound where
the composition decision is made — the `provision()` call — as either a
**literal** (schema-validated when config is built at deploy; beats the
`default`) or a target-owned **source** naming where the value lives
(ADR-0032):

```ts
// A literal — per-application configuration without touching the service:
provision(web, { params: { appOrigin: 'https://example.com' } });

// An env source — the value lives in a platform env var, per environment
// (envParam is the TARGET's, from @prisma/composer-prisma-cloud):
provision(web, { params: { appOrigin: envParam('APP_ORIGIN') } });
```

Both bindings suit an origin the operator genuinely knows — a custom domain
they provisioned. A service's own *platform-assigned* origin is not a param at
all: the target resolves it and app code reads the service's `origin()`
(ADR-0039).

Resolution order per param: binding, else `default`, else absent (only legal
for an `optional` param) — a required param nothing binds fails the deploy
loudly, naming the param and the service.

An **env-sourced** param mirrors the secrets rail (§ Secrets): the stored row is
a pointer to the platform variable's NAME (discriminated from a JSON-encoded
literal by the `@composer-param-pointer:` value prefix, which no JSON output
can start with), deploy preflight verifies the name exists per environment (filling
it from the config pool when absent, failing early otherwise), and boot does
the double-lookup — pointer, then platform variable. The differences from a
secret are deliberate: the value reads back through `config()`, **unredacted**;
the platform variable's **raw string** is handed to the param's own schema (no
decode — a `number()` param bound to `envParam` fails at boot); and an empty
string is a value, valid iff the schema accepts it. A module passes a binding
down to a child as a field of its own `input`. Value changes need a redeploy,
same as secret rotation.

**One concept, a param, bound to a source** (the glossary's *params and their
sources* is the canonical statement). Four sources, by where the value comes
from: a **literal** (in the binding); an **`envParam`**
([ADR-0032](../90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md),
operator-supplied per environment, read at boot, **never in deploy state**); an
**`envSecret`**
([ADR-0029](../90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md), the
platform secret store, redacted, **never in deploy state** — the only secret);
and a **generated param**
([ADR-0042](../90-decisions/ADR-0042-service-input-is-one-standard-schema.md) §
Generated sources — the target generates it at deploy and **keeps it in deploy
state**: an rpc service key, an instance signing key; the generic mechanism
formerly framed as a per-edge provisioning need,
[ADR-0031](../90-decisions/ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md)).
A generated value is config the system produces and owns, **not a secret** —
"minted" was a misnomer; the value is *generated*. Persistence follows the
source (environment sources never enter state; generated and literal values
do), and redaction is an orthogonal display facet, not what makes a value a
secret. A param claiming both a generated value and a provision-time binding is
a loud lowering error.

> The rest of this document predates
> [ADR-0042](../90-decisions/ADR-0042-service-input-is-one-standard-schema.md)
> (one input schema, `service.input()`); its `params`/`config()` spelling and
> the "secret is its own slot" framing are superseded there. Syncing this
> domain doc to the input model is tracked with ADR-0042's own follow-ups; the
> source model above is current.

## Sources are values

`envParam()`, `envSecret()`, `generatedParam()` and `serviceOrigin()` each
return one object that is both the target's source and a
[value](../03-domain-model/glossary.md#value). Where a source is accepted:

| Where | `envParam()` | `envSecret()` | `generatedParam()` | `serviceOrigin()` |
| --- | --- | --- | --- | --- |
| A service's `input` binding | kept; read at serialize from the config pool | kept | kept | kept |
| A service's `params` | kept; pointer row, as today | kept (fails at deploy, as today) | kept (fails at deploy, as today) | kept (fails at deploy, as today) |
| A module's `input` binding | its string; unset or empty leaves the key out | its pointer, which a `secretString()` field accepts | its pointer: a `secretString()` field accepts it when redacted, a wrapped field otherwise | its pointer, which a wrapped field accepts |
| A `resolve()` dependency | its string; unset or empty fails | its pointer | its pointer | its pointer |
| A resource's `props` | its string; unset or empty leaves the key out | refused by the type | refused by the type | refused at Load |

In a service's and a module's input, the schema checks each of the three
runtime sources as its pointer. A plain field refuses a pointer, so a field
bound to `generatedParam()` or `serviceOrigin()` is wrapped with `field()`,
or is a `secretString()` field for a redacted `generatedParam()`
([glossary](../03-domain-model/glossary.md#field)).

A service's input binding and a service's params receive the source itself,
the same object they received before
sources were values. So the target reads the same leaves, writes the same
pointer rows and checks the same names, and the rest of this document holds
unchanged.

Where core needs a source's real value, in a module's input, a `resolve()`
dependency or a resource's props, the source decides what that is.
`envParam('NAME')` is deploy-time: its real value is the value of the variable
`NAME` at deploy, read from the config pool Load is given, which the `config` adapters fill, by default from the process environment; an unset or empty variable
gives no real value. `envSecret('NAME')` is runtime: the deploy never holds the
secret, so its real value at deploy is a pointer, the source itself, which the
service dereferences at boot. `generatedParam()` and `serviceOrigin()` are
runtime too, because the deploy creates their values after Load; their real
value at deploy is also the pointer. A pointer cannot be read: turning it into
text or a number throws an error that names the source. A `resolve()` function
may return a pointer it received, at any depth of its result, and the target
then receives it as if the source had been bound directly.

Deploy preflight checks every `envSecret()` the graph names, including one that
only a `resolve()` dependency lists and one in a module's input that no service
receives.

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
`@prisma/composer-prisma-cloud`'s, so app-cloud is the target that serializes that scheduler's
params. A scheduling extension's `defineSchedule` returns a plain param; whichever
target runs the scheduler encodes it.

A value must therefore be something the target can serialize. A schema validating
a value guarantees its shape, not that the target can store it (a `Symbol` would
fail); serializability is the target's contract, surfaced as a deploy error.

## The round trip, end to end

Follow `jobs` from the declaration to a firing timer, deployed through
`@prisma/composer-prisma-cloud`, whose storage is project-scoped encrypted environment
variables. (The scalar params `port` and the dependency `url` travel the same
path; the structured one just exercises more of it.)

**Deploy — build the Config.** The deploy loads the root module into the graph
and, per service node, assembles its typed `Config`: the service's own params from
their declared values, each dependency's params from its producer's lowered
outputs (the runner's URL, a database's connection string). `Config` values are
structurally untouched — the `Job[]` rides through as an array:

```
Config = { service: { jobs: [ {jobId:'tick',…}, {jobId:'mrr',…} ], port: 3000 },
           inputs:  { trigger: { url: 'https://…runner…' } } }
```

**Deploy — serialize (the target).** `@prisma/composer-prisma-cloud` encodes each value into
its medium — key/value strings, keyed `COMPOSER_ADDRESS_OWNER_NAME` to stay unique in
the shared project. The address is the full one, starting with the app name, with
`-` turned into `_` (a `scheduler` service in the app `billing` is
`COMPOSER_BILLING_SCHEDULER_…`) — validating structured values and passing dependency-input values
(provisioning refs) through untouched. Every generated key carries the `COMPOSER_`
prefix — the framework's reserved namespace, kept clear of the user-provisioned
variables secrets point at (§ Secrets):

```
COMPOSER_BILLING_SCHEDULER_JOBS        = '[{"jobId":"tick","every":"60s"},…]'
COMPOSER_BILLING_SCHEDULER_PORT        = '3000'
COMPOSER_BILLING_SCHEDULER_TRIGGER_URL = 'https://…runner…'
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

A secret is **not** a param (ADR-0029). The value is provisioned out-of-band on
the platform; the framework carries only the NAME. A service types the field
`secretString()` in its input schema; a module declares the same field in its
own `input` and passes it on; the root binds it to a platform variable with
`envSecret('NAME')`. The service reads it back through `service.input()` as a
redacting `SecretString`:

```ts
// A service declares the field's type — no platform name here:
compute({ name: 'auth', input: type({ signingKey: secretString() }), build: … });

// A module declares the same field in its input and passes it on:
module('auth', { input: type({ signingKey: secretString() }), expose: … }, ({ input, provision }) =>
  provision(inner, { input: { signingKey: input.signingKey } }),
);

// Only the ROOT names the platform variable (envSecret is the TARGET's, from
// @prisma/composer-prisma-cloud; secretString() is core's, from @prisma/composer/arktype):
provision(auth, { input: { signingKey: envSecret('AUTH_SIGNING_KEY') } });

// Read at the point of use — expose() is the sole reader:
const { signingKey } = service.input(); // SecretString
signingKey.expose();                     // the one door to the value
```

`service.input()` returns the whole validated input. A `SecretString` redacts
under `toString`/`toJSON`/`valueOf`/`inspect`, so a stray log or serialization
prints `[REDACTED]`; only `expose()` returns the value. `secretString()` and the
opaque `SecretSource` are core (`@prisma/composer`); `envSecret('NAME')`, the
source constructor that names and validates a platform variable, is the
target's, from `@prisma/composer-prisma-cloud` (ADR-0018/0019 applied to
secrets).

The round trip carries only the name, never the value:

1. **Bind.** The root binds each secret field to a platform name, and each
   module on the way passes it on as a field of its input. Load records
   each service's input binding, and preflight collects every `envSecret()` it
   names.
2. **Preflight.** Before Alchemy runs, the deploy verifies every bound name
   exists on the platform for the target environment's class/branch, filling a name
   from the secrets pool when the platform lacks it (a direct write-only POST,
   never an Alchemy resource, never overwriting an existing value). A name
   missing from both fails the deploy, listing exactly what's absent.
3. **Pointer row.** The target writes a pointer per secret field — the generated key
   (`COMPOSER_`-prefixed, like every generated key) maps to the bound name, not a
   value:
   ```
   COMPOSER_SHOP_AUTH_SIGNINGKEY = "AUTH_SIGNING_KEY"   # service `auth` in the app `shop`
   ```
4. **Boot double-lookup.** Boot reads the pointer for the name, then reads
   `process.env[name]` for the platform value, and wraps it in a `SecretBox`.

The `COMPOSER_` prefix reserves the framework's generated keys into their own
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
its real shape rather than "a string". Secrets are not params — a secret is a
`secretString()` input field (§ Secrets) whose value never enters this surface at all. This is
what keeps topology tooling and agents able to answer "what is this service
configured with?" truthfully.

## Boundaries

Three lines the model holds everywhere:

- **Core never encodes.** It builds the typed `Config` and hands it to the target;
  it never stringifies a value, never chooses a medium, and never reads storage.
  Serialization — logic, encoding, and medium — is wholly the target's.
- **Params are static data.** A value that must come from another node — an
  address, a URL, credentials a resource mints — is a dependency, never a
  field inside a param value.
- **Secrets are not params.** A secret is a `secretString()` field of an input
  schema (§ Secrets, ADR-0029, ADR-0042), read through `service.input()` as a
  `SecretString`: sensitivity is carried by the type, never a param facet.

## Related

- [ADR-0018](../90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md),
  [ADR-0019](../90-decisions/ADR-0019-the-target-owns-config-serialization.md),
  [ADR-0021](../90-decisions/ADR-0021-params-are-read-through-config-not-load.md) —
  the decisions this documents.
- [ADR-0029](../90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md) — the
  secrets model this document's § Secrets summarizes.
- [ADR-0032](../90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)
  — provision-time binding and env-sourcing, summarized in § Binding a param at
  provision.
- [`core-model.md`](core-model.md) — where params sit in the node → graph → Config
  model.
- [`ADR-0020`](../90-decisions/ADR-0020-scheduled-work-is-a-driver-not-a-resource.md)
  — cron, whose `jobs` schedule is this document's worked structured param.
- [`connection-contracts.md`](connection-contracts.md) — the RPC contract whose
  caller-schema / target-owned-wire split params mirror.
