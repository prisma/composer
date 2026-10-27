# ADR-0061: A module declares its input the way a compute service does

## Decision

A module declares all of its incoming configuration as **one Standard Schema**, `input`, exactly as `compute()` does. Secret fields are typed `secretString()`. The module's body receives `input` as a set of opaque references, one per key, which it can only pass on: into a child's input, into a node's parameter that takes a value (such as a public URL's `url`), or as a `resolve()` dependency. The per-key `params: { … paramNeed() }` and `secrets: { … secret() }` slots on modules are removed.

```ts
// a reusable module
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

// the module that provisions it binds its input like a service's
provision(authModule, {
  input: { baseUrl: envParam('AUTH_BASE_URL'), signingKey: envSecret('AUTH_SIGNING_SECRET') },
});
```

The root module may declare `input` too. Nothing provisions the root, so the deploy binds the root's input from the config adapters ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). The root still may not declare `deps`, because a dependency needs a producer in the graph.

## Reasoning

**A module was meant to have the same boundary as a service.** That is the module-boundary decision ([ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md)): `deps` in, `expose` out, so a consumer cannot tell a provisioned module from a provisioned service. The service input decision ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)) then replaced a service's per-key `params` and `secrets` with one schema, but modules kept the per-key slots. Today a service and a module take configuration in two different shapes, under two different names, with two different secret mechanisms (`secretString()` fields on a service, `secret()` slots on a module). This decision brings modules onto the service's shape.

**Everything the service input decision gave services, modules now get.** Legality can be relational ("no `stripeSecretKey` unless `stripeEnabled`"), because a schema library expresses that and per-key slots cannot. The caller brings the schema library, and Composer keeps no type vocabulary of its own ([ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md)). Secretness is enforced by validation: binding a plain value where the schema expects a `SecretString` fails the deploy, and so does binding a secret source where it expects a string.

**The module's references are opaque, so the graph cannot branch on configuration.** `input.baseUrl` in the body is a reference, not the string. The body can pass it where a value is accepted (a child's input, a node parameter, a `resolve()` dependency) and nothing else: it cannot read it or branch on it, so a module cannot provision different children in different environments. The topology is the same in every environment, which the structure rule requires ([ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)).

**Validation happens at deploy, as for a service.** The deploy resolves the module's binding (literals as-is, sources resolved, secrets as opaque boxes) and passes it to the module's schema. The value then flows into a child's input and is validated again by the child's schema. A module that only forwards a value can use a permissive schema for it; a module that constrains it says so once.

**How the body gets one reference per key is not yet proven.** The framework cannot read the keys out of a Standard Schema; Standard Schema exposes only `validate`, which is why the service input decision rejected introspection. So the references must come from the keys the author writes in the body. The candidate is a typed object whose property accesses each return a reference that records its key path, typed from the schema's inferred output. A spike must show that it:

- types each reference from the schema's output, including nested keys;
- lets Load record which input key flows into which child input;
- produces a clear error when the body passes a reference somewhere other than an input;
- lets the deploy validate the resolved binding against the module's schema, and report keys a parent binds that the schema rejects.

The decision stands on the shape above; the mechanism is settled by the spike.

## Consequences

- **Breaking authoring change for modules.** `module()` takes `input` instead of `params` and `secrets`; `provision(module, …)` takes one `input` binding. The shipped modules (`auth()`, `email()`) and the examples migrate.
- **`paramNeed()` and the module form of `secret()` are removed.** `paramSource()` and `secretSource()`, which targets use to build their sources, are unchanged.
- **Load accepts `input` on a root.** Today Load refuses param and secret slots on a root, because nothing above the root binds them. With config adapters, the deploy binds them. Load still refuses `deps` on a root.
- **A forwarded value is validated twice**, by the module's schema and by the child's. Both run at deploy, before anything is created.

## Alternatives considered

- **Keep per-key slots on modules and rename `paramNeed()`.** Rejected: modules and services would still take configuration in two shapes.
- **Separate `config` and `secrets` declarations on modules, through builder callbacks with a Composer type vocabulary** (`(c) => ({ foo: c.string() })`). Rejected: it splits what the service input decision deliberately merged, and gives Composer a type vocabulary to maintain beside the schema libraries.
- **Input on the root only.** Rejected: the root would take configuration in a shape no other module uses.
- **Hand the body the actual values.** Rejected: the body could branch on them, and the graph would differ per environment.

## Related

- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md): a module has the same boundary as a service. Amended by this ADR.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): service input is one standard schema. Extended to modules by this ADR.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) and [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md): the forwardable secret and param slots this replaces on modules; their sources (`envSecret`, `envParam`) are unchanged.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): how the root's input is bound.
- [module-composition.md](../10-domains/module-composition.md) and [config-params.md](../10-domains/config-params.md).
