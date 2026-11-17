# Config params

How a per-key param is declared, typed, bound at provision, carried to the platform, and read back at boot. Rests on [ADR-0018](../90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md) (a param's type is a caller-owned schema), [ADR-0019](../90-decisions/ADR-0019-the-target-owns-config-serialization.md) (the deploy target owns serialization) and [ADR-0032](../90-decisions/ADR-0032-params-bind-at-provision-to-a-literal-or-a-deploy-time-value.md) (a param binds at provision to a literal or a deploy-time value).

## Params and input

A service receives its configuration in two places:

- **Its `input`**, one Standard Schema for all of its plain values and credentials, bound at `provision()` and read through `service.input()` ([ADR-0042](../90-decisions/ADR-0042-service-input-is-one-standard-schema.md)). This is where an app's own configuration goes: a schedule, a region, a flag, a sender address, an API key.
- **Its per-key params**, each a separate key with its own schema. Core's mechanism is general: core's `service()` takes a `params` map, and a dependency's connection declares the params its producer supplies. But a Prisma Cloud `compute()` service declares one per-key param only, the reserved `port`, read through `service.port()`. Every other value is a field of its `input`.

The target also writes reserved provider params of its own, such as a service's origin and its RPC service keys ([ADR-0031](../90-decisions/ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md), [ADR-0039](../90-decisions/ADR-0039-a-compute-services-own-origin-is-a-target-resolved-property.md)). No author binds those.

A module has no params: it declares everything as fields of its `input` ([ADR-0061](../90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).

## Declaring a param

A param is a **schema plus a few framework facets**, a plain object. The schema, any Standard Schema validator, is the declarer's own: it types the param and validates the value at boot. Compute's reserved port is declared like this:

```ts
const reservedParams = { port: number({ default: 3000 }) };
```

A dependency's connection declares its params the same way, for example `connection: { params: { url: string() }, hydrate }` for a raw Postgres dependency, whose producer supplies the URL.

The facets are `default` (used when no value is bound or stored) and `optional`. They describe how a value is *handled*, not what it *is*. A secret is never a param: it is a `secretString()` field of an input schema (§ Secrets). `string()` and `number()` are one-word helpers for the common scalars; `param(schema)` wraps any other schema. There is no framework enum of permitted types.

## Binding a param at provision

A declaration carries no value beyond its `default`. The value is bound where the composition decision is made, the `provision()` call ([ADR-0032](../90-decisions/ADR-0032-params-bind-at-provision-to-a-literal-or-a-deploy-time-value.md)):

```ts
export default appRoot('shop', { input: type({ WEB_PORT: 'string.integer.parse' }) }, ({ input, provision }) => {
  // A literal, schema-validated when config is built at deploy:
  provision(api, { params: { port: 8080 } });

  // A deploy-time value of the param's type, here a root input field read from
  // the config adapters; the deploy writes its real value as it writes a literal:
  provision(web, { params: { port: input.WEB_PORT } });
});
```

A param takes no source: not a platform variable node's value, not `generatedParam()`, not `serviceOrigin()`. The deploy needs a compute service's port before the service exists, to set the deployment's port mapping, so a value known only at boot cannot set it. The binding's type admits no `ParamSource`, and Load refuses a source a cast gets there with `COMPOSE.GRAPH_INVALID`, saying to bind the value to a field of the service's input instead.

Resolution order per param: binding, else `default`, else absent (only legal for an `optional` param). A required param nothing binds fails the deploy, naming the param and the service.

## Sources are values

A platform variable node's value, `generatedParam()` and `serviceOrigin()` are each one object that is both the target's source and a [value](../03-domain-model/glossary.md#value). The app root gets a platform variable's value from `provision(variable({ name }))` or `provision(variable.secret({ name }))`; only an `appRoot()` body can provision the node. A value the deploy reads is a root input field, not a source. Where each is accepted:

| Where | Plain platform variable | Platform secret | `generatedParam()` | `serviceOrigin()` |
| --- | --- | --- | --- | --- |
| A service's `input` binding | its pointer, which a wrapped field accepts | its pointer, which a `secretString()` field accepts | its pointer: a `secretString()` field accepts it when redacted, a wrapped field otherwise | its pointer, which a wrapped field accepts |
| A service's per-key params | refused by the type, and at Load through a cast | refused by the type, and at Load through a cast | refused by the type, and at Load through a cast | refused by the type, and at Load through a cast |
| A module's `input` binding | its pointer, which a wrapped field accepts | its pointer, which a `secretString()` field accepts | its pointer: a `secretString()` field accepts it when redacted, a wrapped field otherwise | its pointer, which a wrapped field accepts |
| A `resolve()` dependency | refused | refused | refused | refused |
| A resource's `props` | refused at Load | refused by the type | refused by the type | refused at Load |

In a service's and a module's input, the schema checks each runtime source as its pointer. A plain field refuses a pointer, so a field bound to one is wrapped with `field()`, or is a `secretString()` field for a secret ([glossary](../03-domain-model/glossary.md#field)). Both bindings are typed from the schema, so a source bound to a field that refuses it fails to compile. The deploy check catches what the compiler cannot see: a refinement the type does not carry, such as a URL format, a schema without type information, or a cast. A schema failure on a field that reads a platform variable ends with the variable's name.

A service's input binding receives the source itself. So the target reads the leaves, writes the markers and checks the names from the source's payload.

Every source is runtime: the deploy never holds its data, so its real value at deploy is a pointer, which the service dereferences at boot. A platform variable's data is on the platform; `generatedParam()` and `serviceOrigin()` are runtime because the deploy creates their values after Load. A pointer cannot be read: turning it into text or a number throws an error that names the source. A `resolve()` cannot list a source: listing one fails to compile, and Load refuses a dependency whose real value is a pointer or holds one.

The provisioned value records the node's address, so Load lists in `graph.valueReads` each service that reads each platform variable node, and where. Deploy preflight checks every platform variable a service reads, and every node no service reads, including a secret that a module receives and passes to no service.

## Serialization belongs to the target

A param does not know how to store itself. Turning its value into platform configuration, and reading it back, is entirely the **deploy target's** job: logic, encoding, and medium. Core builds the typed `Config` and hands it over; it never encodes a value and never touches storage. A param carries only its schema, which the target uses to validate on the way back in. So a param is target-agnostic: what ties a service's params to a target is the service factory, such as `@prisma/composer-prisma-cloud`'s `compute()`.

A value must be something the target can serialize. A schema validating a value guarantees its shape, not that the target can store it (a `Symbol` would fail); serializability is the target's contract, surfaced as a deploy error.

## The round trip

Follow a compute service `web` in the app `shop`, with a `rawPostgres()` dependency `db`.

**Deploy: build the Config.** For each service node, the deploy assembles its typed `Config`: the service's own params from their bindings or defaults, and each dependency's params from its producer's lowered outputs:

```
Config = { service: { port: 3000 }, inputs: { db: { url: 'postgres://…' } } }
```

**Deploy: serialize and store (the target).** `@prisma/composer-prisma-cloud` encodes each value as one environment variable on the platform, keyed `COMPOSER_` plus the full address, upper-cased, with `.` and `-` turned into `_`, then the owner and name. Every generated key carries the `COMPOSER_` prefix, the framework's reserved namespace, kept clear of the platform variables the operator sets:

```
COMPOSER_SHOP_WEB_PORT   = '3000'
COMPOSER_SHOP_WEB_DB_URL = '"postgres://…"'
```

The service's deployment depends on these variables, so it is created after the writes and replaced when a value changes.

**Boot: deserialize (the target).** The service's bootstrap reads the rows back and reverses the encoding: `port` is validated into a number, and the dependency's params into its connection values.

**Runtime.** The service reads the port through `service.port()` and its dependencies through `service.load()`, which hydrates them. Its input comes separately, from its input document, through `service.input()` ([ADR-0042](../90-decisions/ADR-0042-service-input-is-one-standard-schema.md)).

## Secrets

A secret is **not** a param ([ADR-0029](../90-decisions/ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md)). The value is set out-of-band on the platform; the framework carries only the name. A service types the field `secretString()` in its input schema; a module declares the same field in its own `input` and passes it on; the app root provisions a platform secret node, `variable.secret({ name: 'NAME' })`, and binds its value. The service reads it back through `service.input()` as a redacting `SecretString`:

```ts
// A service declares the field's type — no platform name here:
compute({ name: 'auth', input: type({ signingKey: secretString() }), deps: {}, build: … });

// A module declares the same field in its input and passes it on:
module('auth', { input: type({ signingKey: secretString() }), expose: … }, ({ input, provision }) =>
  provision(inner, { input: { signingKey: input.signingKey } }),
);

// Only the app ROOT names the platform variable (variable is the TARGET's, from
// @prisma/composer-prisma-cloud; secretString() is core's, from @prisma/composer/arktype):
export default appRoot('shop', ({ provision }) => {
  const signingKey = provision(variable.secret({ name: 'AUTH_SIGNING_KEY' }));
  provision(auth, { input: { signingKey } });
});

// Read at the point of use — expose() is the sole reader:
const { signingKey } = service.input(); // SecretString
signingKey.expose();                     // the one door to the value
```

`service.input()` returns the whole validated input. A `SecretString` redacts under `toString`/`toJSON`/`valueOf`/`inspect`, so a stray log or serialization prints `[REDACTED]`; only `expose()` returns the value. `secretString()` and the opaque `SecretSource` are core (`@prisma/composer`); `variable.secret()`, the node constructor that names and validates a platform variable, is the target's, from `@prisma/composer-prisma-cloud`.

The round trip carries only the name, never the value:

1. **Bind.** The app root provisions a platform secret node and binds its value, and each module on the way passes it on as a field of its input. Load records each service's input binding and each read in `valueReads`, and preflight collects every platform secret, also one no service reads.
2. **Set.** The operator sets the variable on the platform with `prisma project env add`, for production, for every preview environment, or for one. The deploy does not copy a value from the app secrets to the platform.
3. **Preflight.** Before Alchemy runs, the deploy checks whether each name has a row the environment sees, and writes none. A missing name that a service's schema requires fails the deploy, with its readers and the command that sets it; a missing name nothing requires is listed and the deploy goes on.
4. **Marker.** The target writes the service's input document with a marker in place of each secret field, naming the variable, not its value:
   ```json
   { "signingKey": { "$platform": { "name": "AUTH_SIGNING_KEY", "secret": true } } }
   ```
5. **Boot.** Boot reads `process.env[name]` for each marker and wraps the text in a `SecretBox`. An unset or empty variable leaves the field out, and the service's schema decides.

**Rotation is change + redeploy.** A deployment snapshots its environment at creation and never re-reads it, so changing a secret's value means changing it on the platform, then deploying again.

## Introspection

A service's params are enumerable from the graph alone, nothing booted: every param lists its owner, facets and schema. A secret is not a param, so its value never enters this surface at all.

## Boundaries

Three lines the model holds everywhere:

- **Core never encodes.** It builds the typed `Config` and hands it to the target; it never stringifies a value, never chooses a medium, and never reads storage.
- **Params are static data.** A value that must come from another node, such as an address, a URL or credentials a resource mints, is a dependency, never a field inside a param value.
- **Secrets are not params.** A secret is a `secretString()` field of an input schema (§ Secrets, [ADR-0029](../90-decisions/ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md), [ADR-0042](../90-decisions/ADR-0042-service-input-is-one-standard-schema.md)), read through `service.input()` as a `SecretString`.

## Related

- [ADR-0018](../90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md) and [ADR-0019](../90-decisions/ADR-0019-the-target-owns-config-serialization.md): a param's schema, and the wire the target owns.
- [ADR-0032](../90-decisions/ADR-0032-params-bind-at-provision-to-a-literal-or-a-deploy-time-value.md): binding a param at provision.
- [ADR-0042](../90-decisions/ADR-0042-service-input-is-one-standard-schema.md): service input, where every other value goes.
- [ADR-0029](../90-decisions/ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md): the secrets model § Secrets summarizes.
- [ADR-0064](../90-decisions/ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md): platform variables.
- [`core-model.md`](core-model.md): where params sit in the node → graph → Config model.
- [`connection-contracts.md`](connection-contracts.md): the RPC contract whose caller-schema / target-owned-wire split params mirror.
