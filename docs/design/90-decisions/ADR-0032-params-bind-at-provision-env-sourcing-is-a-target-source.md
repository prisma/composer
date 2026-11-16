# ADR-0032: Params bind at provision; env-sourcing is a target-owned source

```ts
// 1. The service declares the param: a schema, no value, no platform name.
const web = compute({ name: 'web', params: { appOrigin: string() }, build: /* … */ });

// 2. The app root binds it at provision: a literal, or a plain platform variable node's value.
export default appRoot('app', ({ provision }) => {
  const appOrigin = provision(variable({ name: 'APP_ORIGIN' }));
  provision(web, { params: { appOrigin } });
  // …or a literal: { params: { appOrigin: 'https://example.com' } }
});

// 3. Inside the service, the value reads back like every other param.
const { appOrigin } = web.config();   // string
```

## Decision

A service's per-key param can be bound at `provision()` to a literal, or to a target-owned source known only at boot, instead of only carrying an authoring-time `default`. On Prisma Cloud that source is a plain platform variable node's value, `provision(variable({ name: 'NAME' }))`, provisioned in the app root ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)). A param bound to it is the plain sibling of [ADR-0029](ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md)'s secret: the same per-environment platform variable that the operator sets, the same preflight check, but read back unredacted and validated by the param's own schema.

- **The deploy writes a pointer row** naming the platform variable, which the operator sets on the platform. The service reads the variable at boot. A variable with no value gives the param its default, or leaves it out when the param is optional; boot fails only for a required param.
- **A platform secret does not fit a per-key param.** `ParamBindings` admits no secret source, so binding a `variable.secret()` value there fails to compile. A secret goes in a `secretString()` field of the service's `input`.
- **A value the deploy reads** is a root input field ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), not a source. A per-key param also accepts a deploy-time value of its type, such as a root input field, and the deploy writes its real value as it writes a literal.

Core knows a source only as an opaque payload; `paramSource(payload, { label, redacted })` is the constructor a target calls. A param source is always known only at boot: its real value at deploy is a pointer. `redacted` makes it a secret pointer rather than a plain one. Prisma Cloud's `variable({ name })` builds a plain one, labelled `the platform variable "NAME"`.

## Reasoning

**Why provision-time binding at all.** A param's only source of a value used to be its authoring-time `default`. That made per-environment configuration impossible without editing the service's own source. Binding at `provision()` puts the value where the composition decision is made: the service declares what it needs, the application decides what it is worth or where it comes from. A binding beats the `default`; the `default` is the fallback when nothing is bound; a param that is neither optional, defaulted nor bound fails the deploy, naming the param, the service and the fix. A service's own platform-assigned origin is not operator input: the target resolves it ([ADR-0039](ADR-0039-a-compute-services-own-origin-is-a-target-resolved-property.md)).

**Why the source constructor is the target's.** Core forwards a `ParamSource` and never reads its payload. `variable()` ships with `@prisma/composer-prisma-cloud`, as `variable.secret()` does. This is [ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md) and [ADR-0019](ADR-0019-the-target-owns-config-serialization.md)'s split between declaration and encoding, applied to where a value comes from.

**The wire: a pointer, told apart by shape.** A pointed param's stored row carries the platform variable's name, not a value. It shares its key, `COMPOSER_<address>_<name>`, with a literal-bound param, so writer and reader tell them apart by the stored value. Literal values are JSON-encoded; a pointer row is `@composer-param-pointer:<NAME>`. No `JSON.stringify` output begins with `@`, so the two never collide.

**Boot reads the pointer, then the variable, then runs the schema on the raw string.** Boot reads the pointer for the name, reads that platform variable, and hands the raw string to the param's own schema. A `number()` param bound to a platform variable fails at boot with the existing invalid-value error, because the variable is a string. A variable that is unset or empty has no value, as the platform cannot store an empty one: the param takes its default, or is left out when it is optional. A required param fails boot with `The param "<name>" of this service reads the platform variable "<NAME>", which has no value. Set it with prisma project env add.`

**Preflight covers pointed params as it covers secrets, and only checks them.** Before Alchemy runs, deploy preflight checks whether each per-key param's platform variable has a row the environment sees. A missing variable fails the deploy when the param has no default and is not optional, naming the variable, the service, the param and the commands that set it. Otherwise it is listed and the deploy goes on ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)). Under `prisma dev` the target's dev preflight reads the variable's text from the app configuration, and the local target gives the service that text, under the same rule ([ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md)).

## Consequences

- A provision-time literal is schema-validated when config is built, and beats the `default`.
- A required param that nothing binds fails the deploy loudly.
- Pointed params are strings at the boundary. Decoding before the schema, per ADR-0019, is an additive change if a real consumer needs it.
- A value change needs a redeploy: a compute version snapshots its environment at creation. The deployment's triggers carry the variable's `updatedAt`, so a deploy after a change replaces exactly the services that read it.
- The `@composer-param-pointer:` prefix is reserved only in raw stored-row space, which literals never occupy.
- A platform variable's name is declared by one node, and a name may not be both a platform variable and a root input field; the Prisma Cloud extension's graph check and core's Load refuse them ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)).

## Alternatives considered

- **A fourth accessor (`env()` or `platformConfig()`).** Rejected: it keys the read on provenance, forcing consumers to know how the application bound the value.
- **Restricting pointed params to string-output schemas at authoring.** Rejected: it needs schema inspection, which Standard Schema does not offer portably, to prevent a failure boot already reports.
- **A separate pointer key per param.** Rejected: it doubles the rows and leaves the primary key's meaning ambiguous.
- **Reusing the secrets channel for pointed params.** Rejected: it would wrap plain config in redaction and impose the non-empty constraint.
- **`paramNeed()` slots on modules**, which this decision first described as the way a module forwards a param binding. Replaced by fields of the module's `input` ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).
- **`envParam('NAME')`, a source that read `NAME` from the app configuration**, which this decision first used for both per-key params and service input. In per-key params it named a platform variable with no node; in an input binding it gave a value the deploy reads a second spelling beside a root input field. Replaced by a plain platform variable node in per-key params and a root input field everywhere else, so each kind of value has one way in.
- **Reading `NAME` from the deploying shell.** Replaced by the app configuration, whose default, `[environmentVariables()]`, is the shell; it now fills only the root's input.
- **A `sentinel` option on `paramSource()`**, a stand-in value schemas checked in place of a pointer. Replaced by pointers, which schemas see as they are ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).

## Related

- [ADR-0029](ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md) — the secret this mirrors.
- [ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md) — framework-minted param values, which live in deploy state.
- [ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md) and [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) — schema on the declaration, wire owned by the target.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) — values and the app configuration.
- [ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md) — platform variables: names, boot and preflight.
- [config-params.md](../10-domains/config-params.md).
