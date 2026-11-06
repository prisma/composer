# ADR-0061: A module declares its input the way a compute service does

```ts
import { module } from '@prisma/composer';
import { field, secretString } from '@prisma/composer/arktype';
import { envSecret, serviceOrigin } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

// a reusable module declares what it needs, as a service does
const auth = module('auth',
  { input: type({ baseUrl: field(type('string')), signingKey: secretString() }), expose: { rpc: authContract } },
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
export default module('shop', ({ provision }) => {
  provision(auth, {
    input: { baseUrl: serviceOrigin('shop.web'), signingKey: envSecret('AUTH_SIGNING_SECRET') },
  });
});
```

The body passes `input.baseUrl` and `input.signingKey` on by name. Writing `input` in their place fails to compile, because `input` is a dictionary of values, not a value.

## Decision

A module declares all of its input as **one Standard Schema**, `input`, exactly as `compute()` does. Whoever provisions the module binds that input with `provision(module, { input: { … } })`. Modules have no per-key `params` or `secrets` slots.

- **The schema** comes from any Standard Schema library. A secret field is typed `secretString()`. A leaf field that may receive a value known only at boot is wrapped in `field()`: a **wrapped field**. A field written without it is a **plain field**, which accepts deploy-time data only. `@prisma/composer/arktype` and `@prisma/composer/zod` export both helpers.
- **The binding** is typed from the schema's input type. Each key takes a literal, a value of the field's type, or a source such as `envSecret()`, which is a value too ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). A module with an input schema must be bound, and a module without one must not be.
- **The body** receives `input`, a **dictionary** with one value per field, typed from the schema's output: `input.from`, or `input.smtp.user` for a nested field. It can pass a field on, by name, into a child module's or a service's `input`, a service param or a resource's props, and it can list a plain field as a `resolve()` dependency. It cannot read a field's data.
- **The dictionary itself is not a value.** Passing the whole `input` where a value is accepted fails to compile, for every module. A cast gets past the compiler, so Load refuses it too, with an error that says the whole input of the module was passed on, and to pass its fields on by name.
- **The root** may declare `input` too. Nothing provisions the root, so the deploy binds its input to the app configuration ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)): the merged values of the `config` adapters, which by default are every variable of the process environment, secrets included. So the root's input can hold a secret's text. Composer keeps it out of the file it hands the second process in two ways. Load refuses a root input field that the root's body passes on when an `envSecret()` in the graph reads the same name. The CLI refuses to write that file when any value in it contains a known secret: a value under a name an `envSecret()` in the graph reads. Each refusal names the field, never the value. The root may not declare `deps`, because a dependency needs a producer in the graph.

## Reasoning

**A module has the same boundary as a service.** That is the module-boundary decision ([ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md)): `deps` in, `expose` out, so a consumer cannot tell a provisioned module from a provisioned service. The service input decision ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)) gave a service one schema for all of its input. A module that took its input in a different shape, under different names, with a different secret mechanism, would break the boundary the first decision drew. This decision puts modules on the service's shape.

**Everything the service input decision gave services, modules get.** Legality can be relational ("no `stripeSecretKey` unless `stripeEnabled`"), because a schema library expresses that and per-key slots cannot. The caller brings the schema library, and Composer keeps no type vocabulary of its own ([ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md)). Secretness is enforced by validation: binding a plain value where the schema expects a secret fails the deploy, and so does binding a secret source to a plain field.

**A module receives the input it needs and no more.** The body names each field it passes on, and only those fields reach the graph. Nothing stands for the whole input. A field such as `input.smtp` may be passed on whole because it is a unit the schema declares; the whole input is not a field but everything the schema outputs. This matters most for the root: its input by default holds every variable of the process environment, secrets included, and passing it on whole would put all of them into an input document that the platform stores and the deploy report prints. A module that is not the root follows the same constraint, so that a child receives only what its parent chose to give it, and so that a module's body does not change when it becomes the root or stops being it.

**The body holds values, not data, so the graph cannot branch on its input.** `input.baseUrl` is a value, an opaque stand-in for data known later ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). Turning a field into text or a number, serializing it, listing its keys, spreading or iterating it, testing it with `in`, or assigning to it fails at Load with an error naming the field. `===` or `switch` against a literal fails to compile. A truthiness check or `typeof` cannot be caught, because JavaScript calls no hook for them, but a value is always an object, so such a branch always goes the same way and cannot vary the graph. So a module provisions the same children in every environment, as the structure requirement asks ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)).

**The schema checks the binding at Load.** During Load's second pass, from the root down, Load resolves each module's binding, replacing each deploy-time value with its real value, and checks the result with the module's schema. The check runs synchronously, because a child's real value is read from its parent's checked output; an async schema fails the Load. A field's real value is read from the schema's output, so a field typed `number` by a parsing schema receives `4`, not `'4'`, and defaults apply. The child's schema then checks the value again. A value known only at boot reaches the schema as its pointer: `secretString()` accepts a secret pointer, a wrapped field a plain pointer, and a plain field neither. A schema may check such a field but never replace it or move its pointer to another field; Load refuses a schema that does. A schema may return a copy of a pointer, as ArkType does when a transform runs, so Load recognises a pointer by its brand and the variable it names, and passes on the source the binding named. A secret box written in a binding is refused, because a secret's value never appears in the code.

**How the body gets one value per field.** The framework cannot read the keys out of a Standard Schema; Standard Schema exposes only `validate`, which is why the service input decision rejected introspection. So the values come from the keys the author writes in the body. `input` is an object whose property reads each return a value recording its key path, typed from the schema's output, and the same path always returns the same value. Load records which field flows into which binding or `resolve()`. An input field the body never uses is not an error, because Load cannot list a schema's keys.

**A union schema becomes a flat one.** For a union schema the body's types offer only the keys every member has, and the body can neither narrow with an `if` nor pass the whole input on. So a module cannot declare a union input and still pass every field to its service. It declares a flat schema instead, for example with an optional field, and passes each field on by name. An array field has no element access; a `resolve()` that lists a plain array field computes with its elements.

## Consequences

- **`module()` takes `input`**, and `provision(module, …)` takes one `input` binding, typed from the schema. `ModuleNode<D, E, I>` and `ModuleContext<D, I>` carry the schema's type. `module()` refuses a `params` or `secrets` key, and `provision()` of a module refuses a `params` or `secrets` map, each with an error naming `input`. `paramNeed()` and the module form of `secret()` are gone.
- **The body's `input` has the type `ModuleInput<S>`, which is not a `Value`.** Every binding type refuses it. Where the compiler sees no type, such as a binding slot typed `unknown`, only Load refuses it.
- **`paramSource()` and `secretSource()`**, which targets use to build their sources, each return one object that is both the source and a value. `secretSource()` takes `label` and `secretsKey`, the app secrets key that holds the secret. `paramSource()` takes `label`, `configurationKey` and `redacted`: `configurationKey` is the app configuration key whose text is the source's real value at deploy, and `redacted` says whether a source known only at boot is a secret pointer or a plain one.
- **Load accepts `input` on a root** and binds it to the app configuration, which the root's schema checks before any other module's binding. Load still refuses `deps` on a root.
- **A value passed on is checked twice**, by the module's schema and by the child's. Both run at deploy, before anything is created.

## Alternatives considered

- **Per-key slots on modules under new names.** Rejected: modules and services would still take their input in two shapes.
- **Separate `config` and `secrets` declarations on modules, through builder callbacks with a Composer type vocabulary** (`(c) => ({ foo: c.string() })`). Rejected: it splits what the service input decision deliberately merged, and gives Composer a type vocabulary to maintain beside the schema libraries.
- **Input on the root only.** Rejected: the root would take its input in a shape no other module uses.
- **Hand the body the actual values.** Rejected: the body could branch on them, and the graph would differ per environment.
- **Passing the whole `input` on**, which an earlier version of this decision allowed for a module that is not the root, as the way to narrow a union schema. Rejected: a module should receive the input it needs and no more, and a child should receive only what its parent names. One constraint for every module is also simpler than one for the root and another for the rest.
- **Refusing the whole `input` at Load only.** Rejected: code that type-checks should deploy, so the compiler refuses it wherever the binding has a type, and Load refuses it where the compiler cannot see.

## Related

- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md): a module has the same boundary as a service. Its current text includes this decision: a module's input is one Standard Schema, bound at `provision()`.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): service input is one standard schema. Its current text includes this decision: a module's binding has the same type as a service's.
- [ADR-0029](ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md) and [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md): the forwardable secret and param slots this replaces on modules; their sources (`envSecret`, `envParam`) remain.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): values, `resolve()`, and how the root's input is bound.
- [module-composition.md](../10-domains/module-composition.md) and [config-params.md](../10-domains/config-params.md).
