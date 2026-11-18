# ADR-0032: Params bind at provision, to a literal or a deploy-time value

```ts
// 1. The service declares its params. A compute service declares one, the reserved
//    port, as { port: number({ default: 3000 }) }; every other value is a field of its input.
const api = compute({ name: 'api', deps: {}, build });
const web = compute({ name: 'web', deps: {}, build });

// 2. The app root binds each param at provision.
export default appRoot('shop', { input: type({ WEB_PORT: 'string.integer.parse' }) }, ({ input, provision }) => {
  provision(api, { params: { port: 8080 } });             // a literal
  provision(web, { params: { port: input.WEB_PORT } });   // a deploy-time value: a root input field
});

// 3. Inside the service, the value reads back through its accessor.
const port = web.port();   // number
```

## Decision

A service's per-key param can be bound at `provision()` instead of only carrying an authoring-time `default`. Core's per-key params mechanism is general: core's `service()` takes any `params` map, each param a schema plus facets ([ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md)). But a Prisma Cloud `compute()` service declares one per-key param only, the reserved `port`, read through `service.port()`. Every other value a compute service needs is a field of its `input` ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)).

A param takes one of two bindings:

- **A literal**, schema-validated when config is built at deploy.
- **A deploy-time value** of the param's type, such as a root input field or a `resolve()` result ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). The deploy writes its real value as it writes a literal.

A param takes no source: not a platform variable node's value, not `generatedParam()`, not `serviceOrigin()`. Core's `ParamBindings` admits no `ParamSource`, so binding one fails to compile. A source that a cast gets into a param fails Load with `COMPOSE.GRAPH_INVALID`: `Service "<address>" binds its param "<name>" to <label of the source>, a value known only at boot. A param takes a literal or a value the deploy has. Bind the value to a field of the service's input instead.` A value known only at boot, such as a platform variable's, goes into a field of the service's `input` ([ADR-0064](ADR-0064-an-app-declares-its-platform-variables-in-its-root-and-the-deploy-copies-no-local-values.md)).

## Reasoning

**Why provision-time binding at all.** Without a binding, a param's only value is its authoring-time `default`, which makes per-environment configuration impossible without editing the service's own source. Binding at `provision()` puts the value where the composition decision is made: the service declares what it needs, the application decides what it is worth. A binding beats the `default`; the `default` is the fallback when nothing is bound; a param that is neither optional, defaulted nor bound fails the deploy, naming the param, the service and the fix. A service's own platform-assigned origin is not operator input: the target resolves it ([ADR-0039](ADR-0039-a-compute-services-own-origin-is-a-target-resolved-property.md)).

**Why a param takes no source.** The deploy needs a compute service's port before the service exists: the compute descriptor reads the bound number to set the deployment's port mapping, and boot sets `PORT` from the same number. A value known only at boot cannot set it. The deploy would route to the default 3000 while the service read the variable. A per-key param therefore holds data the deploy has.

## Consequences

- A provision-time literal or deploy-time value is schema-validated when config is built, and beats the `default`.
- A required param that nothing binds fails the deploy loudly.
- The deploy writes each param as one JSON-encoded row, `COMPOSER_<address>_<name>`, and boot reads it back with the param's schema ([ADR-0019](ADR-0019-the-target-owns-config-serialization.md)). No param row names a variable on the platform.
- A value change needs a redeploy: a deployment snapshots its environment at creation.
- Where a compute service's port is set is not decided: through this per-key param, or somewhere else such as the build options.

## Alternatives considered

- **A pointer row: a per-key param bound to a variable on the platform**, through `envParam('NAME')`. The deploy wrote `@composer-param-pointer:<NAME>` in the param's row, and boot read the named variable and handed its raw text to the param's schema. Removed: a compute service's only per-key param is `port`, which the deploy needs before the service exists, so the deploy routed to 3000 while the service read the variable. The variable's text also fails `port`'s number schema, so the service failed at boot whenever the variable was set. The row's encoder, its reading at boot, its preflight checks and triggers, its handling under `prisma dev`, and `paramName()` were removed with it.
- **App-declared per-key params on a compute service**, such as `params: { appOrigin: string() }` read through `config()`. Replaced by one `input` schema read through `service.input()` ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)); compute keeps only the reserved `port`.
- **A fourth accessor (`env()` or `platformConfig()`).** Rejected: it keys the read on provenance, forcing consumers to know how the application bound the value.
- **`paramNeed()` slots on modules**, which this decision first described as the way a module forwards a param binding. Replaced by fields of the module's `input` ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).
- **`envParam('NAME')`, a source that read `NAME` from the app configuration**, in per-key params and in service input. In per-key params it could bind only `port` and failed at boot whenever its variable was set; in an input binding it gave a value the deploy reads a second spelling beside a root input field. Removed: a root input field is the one way for a value the deploy reads.
- **A `sentinel` option on `paramSource()`**, a stand-in value schemas checked in place of a pointer. Replaced by pointers, which schemas see as they are ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).

## Related

- [ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md) and [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) — schema on the declaration, wire owned by the target.
- [ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md) — framework-minted param values, which live in deploy state.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) — service input, where every other value goes.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) — values, deploy-time and runtime.
- [ADR-0064](ADR-0064-an-app-declares-its-platform-variables-in-its-root-and-the-deploy-copies-no-local-values.md) — platform variables, which go into input fields.
- [config-params.md](../10-domains/config-params.md).
