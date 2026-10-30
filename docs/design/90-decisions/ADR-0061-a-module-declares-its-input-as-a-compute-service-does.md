# ADR-0061: A module declares its input the way a compute service does

Amended 2026-10-29 (module-input project, second slice): each input field the body receives is a **value**, `Value<T>` typed from the schema's output, the same kind of value as `environment.name` and a `resolve()` result ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). Three statements below are corrected. First, the body cannot be stopped from reading or branching on a value in every case: turning one into text or a number, serializing it, listing its keys or iterating it fails with an error naming the field, and `===` or `switch` against a literal fails to compile, but a truthiness check such as `if (input.enabled)` is not caught: it sees an object, so it always takes the branch. The structure rule holds, because such a branch always goes the same way and so cannot vary the graph. Second, a module's binding is validated during Load's second pass, synchronously, not after it, because a child's real value is read from its parent's validated output; an async schema fails the Load. A real value is the schema's output, so a field typed `number` by a parsing schema receives `4`, not `'4'`. Third, a body reaches only the keys every member of a union schema has, and an array field has no element access: to narrow, forward the whole `input` or narrow inside a `resolve()` function. An input field the body never uses is not an error, because Load cannot list a schema's keys.

## Decision

A module declares all of its incoming configuration as **one Standard Schema**, `input`, exactly as `compute()` does. Secret fields are typed `secretString()`. The module's body receives `input` as a set of opaque references, one per key, which it can only pass on: into a child's input, into a node parameter that takes a value, or as a `resolve()` dependency. Modules have no per-key `params` or `secrets` slots.

```ts
// a reusable module declares what it needs, as a service does
export default module('auth',
  { input: type({ baseUrl: 'string', signingKey: secretString() }), expose: { rpc: authContract } },
  ({ input, provision }) => {
    const db = provision(rawPostgres({ name: 'database' }));
    const service = provision(authService, {
      id: 'service',
      deps: { db },
      input: { baseUrl: input.baseUrl, signingKey: input.signingKey },
    });
    return { rpc: service.rpc };
  });

// the module that provisions it binds that input, as it would a service's
provision(authModule, {
  input: { baseUrl: envParam('AUTH_BASE_URL'), signingKey: envSecret('AUTH_SIGNING_SECRET') },
});
```

The root module may declare `input` too. Nothing provisions the root, so the deploy binds the root's input from the config adapters ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). The root may not declare `deps`, because a dependency needs a producer in the graph.

## Reasoning

**A module has the same boundary as a service.** That is the module-boundary decision ([ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md)): `deps` in, `expose` out, so a consumer cannot tell a provisioned module from a provisioned service. The service input decision ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)) gave a service one schema for all of its configuration. A module that took configuration in a different shape, under different names, with a different secret mechanism, would break the boundary the first decision drew. This decision puts modules on the service's shape.

**Everything the service input decision gave services, modules get.** Legality can be relational ("no `stripeSecretKey` unless `stripeEnabled`"), because a schema library expresses that and per-key slots cannot. The caller brings the schema library, and Composer keeps no type vocabulary of its own ([ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md)). Secretness is enforced by validation: binding a plain value where the schema expects a `SecretString` fails the deploy, and so does binding a secret source where it expects a string.

**The module's references are opaque, so the graph cannot branch on configuration.** `input.baseUrl` in the body is a reference, not the string. The body can pass it where a value is accepted and nothing else: it cannot read it or branch on it, so a module cannot provision different children in different environments. The topology is the same in every environment, which the structure rule requires ([ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)).

**Validation happens at deploy, as for a service.** The deploy resolves the module's binding (literals as-is, sources resolved, secrets as opaque boxes) and passes it to the module's schema. The value then flows into a child's input and is validated again by the child's schema. A module that only forwards a value can use a permissive schema for it; a module that constrains it says so once.

**How the body gets one reference per key.** The framework cannot read the keys out of a Standard Schema; Standard Schema exposes only `validate`, which is why the service input decision rejected introspection. So the references come from the keys the author writes in the body: `input` is a typed object whose property accesses each return a reference recording its key path, typed from the schema's inferred output. The mechanism has to type each reference from the schema's output including nested keys, let Load record which input key flows into which child input, and produce a clear error when the body reads a reference or branches on it instead of passing it where a value is accepted. The shape of the decision does not depend on how that object is built.

## Consequences

- **`module()` takes `input`**, and `provision(module, …)` takes one `input` binding. There are no `paramNeed()` or module-level `secret()` slots. `paramSource()` and `secretSource()`, which targets use to build their sources, are unchanged.
- **Load accepts `input` on a root** and binds it from the config adapters. Load still refuses `deps` on a root.
- **A forwarded value is validated twice**, by the module's schema and by the child's. Both run at deploy, before anything is created.

## Alternatives considered

- **Per-key slots on modules under new names.** Rejected: modules and services would still take configuration in two shapes.
- **Separate `config` and `secrets` declarations on modules, through builder callbacks with a Composer type vocabulary** (`(c) => ({ foo: c.string() })`). Rejected: it splits what the service input decision deliberately merged, and gives Composer a type vocabulary to maintain beside the schema libraries.
- **Input on the root only.** Rejected: the root would take configuration in a shape no other module uses.
- **Hand the body the actual values.** Rejected: the body could branch on them, and the graph would differ per environment.

## Related

- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md): a module has the same boundary as a service. Amended by this ADR.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): service input is one standard schema. Extended to modules by this ADR.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) and [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md): the forwardable secret and param slots this replaces on modules; their sources (`envSecret`, `envParam`) are unchanged.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): how the root's input is bound.
- [module-composition.md](../10-domains/module-composition.md) and [config-params.md](../10-domains/config-params.md).
