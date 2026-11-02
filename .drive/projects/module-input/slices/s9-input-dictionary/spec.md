# S9 — `input` is a dictionary

Parent: [module-input spec](../../spec.md) and [plan](../../plan.md). Design: [design.md](../../design.md), which is authoritative; this slice builds section 3 "What the body receives" and the section 10 item "Forwarding a non-root module's whole `input`", and makes the section 12 reversal of the module input decision. Decisions: the module input decision ([ADR-0061](../../../../../docs/design/90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)) and the `resolve()` and config adapters decision ([ADR-0062](../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). It builds on main, which holds S2 to S8 (prisma/composer#401 and #403). The branch is `claude/module-input-s9`.

This spec leaves nothing to the implementer's judgement. Every type, signature, name, error message, file, test, document edit and commit is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose. § 14 lists the decisions this spec takes, and § 15 what it found that the design does not say.

Every code change and test in § 3, § 4 and § 9 was applied in a scratch copy of this branch, with TypeScript 6.0.3, ArkType 2.2.7 and Zod 4.4.3; § 13 lists what ran and what passed.

Read for this spec: `CLAUDE.md`; `docs/design/01-principles/`; ADR-0061 with its six amendment notes and ADR-0062; the glossary entries Module, Input, Value, RuntimeValue and `field()`; `module-composition.md` § Input; `design.md` sections 2, 3, 10 and 12; `plan.md`; the S2 and S8 slice specs and S8's `qa.md`; the PR description of #403, which holds the release note of S3 to S8; `.agents/rules/user-facing-surface-changes.mdc`; `skills/README.md`; and the code each section names.

## 1. At a glance

```ts
const relay = module('relay',
  { input: type({ from: field(type('string')), deliveryCredential: secretString() }) },
  ({ input, provision }) => {
    provision(email(), { input: { from: input.from, deliveryCredential: input.deliveryCredential } }); // compiles
    provision(email(), { id: 'two', input });                     // fails to compile
    provision(emailService, { input: { all: input } });           // fails to compile
    resolve([input], () => 'x');                                  // fails to compile
  });
```

What the author sees for the second line:

```text
error TS2769: No overload matches this call.
  …
          Types of property '[INPUT_DICTIONARY]' are incompatible.
            Type 'true' is not assignable to type '"the whole input of a module is not a value; pass its fields on by name"'.
```

A cast gets past the compiler, so Load refuses the whole `input` too, for every module, wherever it is passed:

```text
the input binding of module "shop.relay.email" depends on the whole input of module "shop.relay". A module body's input is a dictionary of values, not a value, so it cannot be passed on whole. Pass its fields on by name, such as input.from.
```

Today the root's whole input is refused at Load only, and a module that is not the root may pass its whole input on. Both change.

## 2. The model

- **`input` is a dictionary, not a value.** Its type, `ModuleInput<S>`, becomes a brand plus one `ModuleInputField` per field of the schema's output. It is no longer a `Value`. Each field read from it, `input.from` or `input.smtp.user`, is still a `ModuleInputField<T>`, which is a `Value<T>`, and binds as before.
- **Every binding type refuses the brand.** The brand is a type-only property, `[INPUT_DICTIONARY]: true`. Every object branch of a binding type is intersected with `NotInputDictionary`, which declares the same property optional and typed as the message. So the dictionary is not assignable to any object a binding accepts, and the type error ends with the message. `resolve()` refuses it because it is not a `Value`. A service param refuses it because it is neither the param's data type, a `ParamSource` nor a `Value`.
- **Where the compiler sees no type, only Load refuses it.** A binding slot typed `unknown` or `any`, such as a child module whose schema has no type information, accepts anything, the dictionary included. This is the same limit S8 recorded for `resolve()`.
- **Load refuses it for every module.** At run time the dictionary is still the proxy S2 built, which answers the value brand with the origin path `[]`. So Load finds it wherever a binding holds it, at any depth, in a service's or a module's `input`, a service param, a resource's props, or a `resolve()` dependency, and refuses it in one place: the `'input'` case of `resolveOne`. Today that check applies to the root only. It now applies to every module, and the root keeps one more sentence explaining why its input matters most.
- **Misuse of the whole `input` gets its own advice.** Today `Object.keys(input)` or `{ ...input }` reports that "input of module … is a value, not its real value" and advises `resolve([input], …)`, which this slice refuses. The misuse error for the path `[]` now says the input is a dictionary of values and to pass its fields on by name. The same advice changes in `readPath` for an input whose schema outputs no object.
- **Deploy output does not change.** No example, shared module, guide or skill passes a whole `input` on. Checked: every `provision(` and `resolve(` in `examples/`, `packages/*/2-shared-modules/`, `docs/`, `skills/` and `test/`.

## 3. Core: the compile-time check

### 3.1 `packages/0-framework/1-core/core/src/value.ts`

1. After `declare const VALUE_TYPE: unique symbol;`, two new lines:

   ```ts
   // Type-only, never assigned: marks a module body's `input`, a dictionary of values that no binding accepts.
   declare const INPUT_DICTIONARY: unique symbol;
   ```

2. `export type { VALUE_TYPE };` becomes `export type { INPUT_DICTIONARY, VALUE_TYPE };`.
3. In `ValueOrigin`'s `'input'` member, the doc comment of `path` becomes `      /** The key path inside that module's input; \`[]\` is the whole input, which Load refuses wherever it is passed on. */`.
4. Directly after the closing brace of `export interface Value<T>` and its blank line, before the `RuntimeValue` doc comment:

   ```ts
   /** Required of every object a binding accepts, so a module body's whole `input` fits none. The property's type is the message an author sees. */
   export type NotInputDictionary = {
     readonly [INPUT_DICTIONARY]?: 'the whole input of a module is not a value; pass its fields on by name';
   };
   ```

`NotInputDictionary` and `INPUT_DICTIONARY` are not added to `exports/index.ts`. The declaration build inlines them where the exported binding types use them; § 13 records that `pnpm build` passes.

### 3.2 `packages/0-framework/1-core/core/src/module-input.ts`

1. The value import becomes:

   ```ts
   import {
     type INPUT_DICTIONARY,
     type InputOrigin,
     VALUE,
     VALUE_ORIGIN,
     type Value,
   } from './value.ts';
   ```

2. `ModuleInput` and its doc comment become:

   ```ts
   /**
    * The `input` a module body receives for its input schema `S`: a dictionary
    * with one value per field, typed from the schema's output (ADR-0061). It is
    * not itself a value, and no binding accepts it: pass its fields on by name.
    */
   export type ModuleInput<S extends StandardSchemaV1> = {
     readonly [INPUT_DICTIONARY]: true;
   } & FieldsOf<StandardSchemaV1.InferOutput<S>>;
   ```

   `ModuleInputField`, `FieldsOf`, `Fields` and `FieldType` do not change.
3. In `buildModuleInput`, the reason of the final `blindCast` becomes `'the proxy returns a further proxy, a value with its origin, for every string key, which is the shape ModuleInput describes; the dictionary brand is type-only'`.

(§ 4.2 changes `misuse` in the same file.)

### 3.3 `packages/0-framework/1-core/core/src/node.ts`

1. The `./value.ts` import gains `  type NotInputDictionary,` after `  isValue,`.
2. `InputBinding`'s last member, `  | { readonly [key: string]: InputBinding };`, becomes `  | ({ readonly [key: string]: InputBinding } & NotInputDictionary);`.
3. In `ModuleInputBinding<T>`, the object branch's closing `            }` before `          : T);` becomes `            } & NotInputDictionary`. The whole type then reads:

   ```ts
   export type ModuleInputBinding<T> =
     | Value<T>
     | (T extends SecretString
         ? SecretSource
         : T extends readonly (infer E)[]
           ? T | readonly ModuleInputBinding<E>[]
           : T extends { readonly [key: string]: unknown }
             ? {
                 readonly [K in keyof T]:
                   | ModuleInputBinding<T[K]>
                   | (Record<never, never> extends Pick<T, K> ? Value<T[K] | undefined> : never);
               } & NotInputDictionary
             : T);
   ```

4. `export type ResourceProps = { readonly [key: string]: ResourcePropsMember };` becomes `export type ResourceProps = { readonly [key: string]: ResourcePropsMember } & NotInputDictionary;`.
5. `ResourcePropsMember`'s last member, `  | { readonly [key: string]: ResourcePropsMember };`, becomes `  | ({ readonly [key: string]: ResourcePropsMember } & NotInputDictionary);`.
6. `ModuleContext`'s `input` doc comment becomes:

   ```ts
     /** The module's input: a dictionary with one value per field, typed from its input schema's output (ADR-0061); `undefined` when it declares none. It is not itself a value: pass its fields on by name, into a provision() binding or, for a plain field, as a resolve() dependency. A root's input is the config pool, validated by its schema. */
   ```

`ParamBindings` does not change: the dictionary is neither a param's data type, a `ParamSource` nor a `Value`, so a typed param already refuses it (test 9). `resolve()` does not change: its dependencies must be `Value`s.

How the types behave, each checked with `tsc` (§ 13):

- `ResourceProps` needs the intersection as well as `ResourcePropsMember`. Without it, `resource({ props: input })` compiles for a schema whose fields are all plain data, because `P` is inferred as the dictionary type and every field is a `Value<PlainData>`.
- A props object or binding that never mentions the brand still fits: the property is optional, and nothing can write it, because `INPUT_DICTIONARY` exists only as a type.
- For a module child the error ends with the message (§ 1). For a service, TypeScript reports the last overload of `provision()`, the module overload, so the error reads `Argument of type 'ServiceNode<…>' is not assignable to parameter of type 'ModuleNode<…>'` and does not show the message. For `resolve()` it reads `Type 'ModuleInput<…>' is missing the following properties from type 'Value<unknown>': [VALUE], [VALUE_ORIGIN]`. For a resource prop it names the index signature or `NotInputDictionary`. Each still fails to compile; § 15, finding 2.
- A child whose binding keys differ from the dictionary's fields fails on the missing keys before the brand, so its error does not show the message either.

## 4. Core: Load refuses the whole input for every module

### 4.1 `packages/0-framework/1-core/core/src/resolve-values.ts`, `resolveOne`

In `case 'input':`, the block

```ts
        if (entry.fromConfigPool && origin.path.length === 0) {
          throw new LoadError(
            `${describeSite(site)} depends on the whole input of root module "${origin.module}". The root's input is every value the \`config\` adapters return, which by default is every variable of the process environment, secrets included. Pass on the fields the root declares one by one, such as input.EMAIL_FROM.`,
          );
        }
```

becomes

```ts
        if (origin.path.length === 0) {
          const everyVariable = entry.fromConfigPool
            ? " The root's input is every value the `config` adapters return, which by default is every variable of the process environment, secrets included."
            : '';
          throw new LoadError(
            `${describeSite(site)} depends on the whole input of module "${origin.module}". A module body's input is a dictionary of values, not a value, so it cannot be passed on whole.${everyVariable} Pass its fields on by name, such as input.from.`,
          );
        }
```

`LoadError` carries the code `COMPOSE.GRAPH_INVALID`, as every Load error about a module's input does (`graph-types.ts`); no new code. The check runs before `readPath`, so a whole input never reaches a binding, and before `fn` for a `resolve()` that lists it, because `resolveOne` resolves a dependency before calling `fn`.

### 4.2 `packages/0-framework/1-core/core/src/resolve-values.ts`, `readPath`

The `!isPlainObject(current)` branch becomes:

```ts
    if (!isPlainObject(current)) {
      const advice =
        index === 0
          ? `The module's input schema must output a plain object for its body to read fields.`
          : `To compute with it, it must be a plain field, not a wrapped or secret one; list it: resolve([${parent}], ([v]) => …).`;
      throw new LoadError(
        `${missing}: ${parent} is ${describeData(current)}, not a plain object, so it has no fields. ${advice}`,
      );
    }
```

For `index > 0` the message is unchanged, character for character.

### 4.3 `packages/0-framework/1-core/core/src/module-input.ts`, `misuse`

The first lines of `misuse` become:

```ts
function misuse(origin: InputOrigin, what: string): LoadError {
  if (origin.path.length === 0) {
    return new LoadError(
      `input of module "${origin.module}" is a dictionary of values, not data, and ${what}. ` +
        'A module body can only pass the fields of its input on, by name: into a provision() binding or, for a plain field, as a resolve() dependency.',
    );
  }
  const field = inputFieldLabel(origin);
```

The rest of `misuse` does not change.

## 5. What breaks, and what does not

Breaks:

1. A module that is not the root and passes its whole `input` on, into a child module's or a service's `input` at any depth, a service param, a resource's props, or a `resolve()` dependency: a compile error where the target is typed, and a Load error always. Before, Load accepted it.
2. The root's whole `input` passed on: now a compile error too, where the target is typed. The Load error's text changes (§ 6).
3. Code that treats `input` as a `Value`: `ModuleInput<S>` is no longer assignable to `Value<…>`, so a helper typed to take a `Value` refuses it. `isValue(input)` is still `true` at run time (§ 14, decision 4).
4. The misuse error for the whole `input`, and `readPath`'s error for an input whose schema outputs no object (§ 6).

Unchanged:

1. Every binding of a field read from `input`, nested or optional, for ArkType and Zod (test 11).
2. The graph Load returns for any app that loaded before and passes no whole `input` on, and so every input document, stack file and deploy report.
3. The misuse errors for fields, their text included.

The only existing tests this slice changes are listed in § 9.1. If any other existing test fails, the implementer stops and reports.

## 6. Error messages, verbatim

`<site>` is what `describeSite(site)` gives today, such as `the input binding of service "shop.email.echo"`, `input key "settings.0" of service "shop.email.echo"`, `param "label" of service "shop.email.echo"` or `prop "all" of resource "shop.email.site"`. For a `resolve()` that lists the whole input, `<site>` is the binding site of the `resolve()`.

| Where | Condition | Before | After |
| --- | --- | --- | --- |
| `resolveOne`, `'input'` | a module that is not the root | none: Load accepted it | `<site> depends on the whole input of module "<m>". A module body's input is a dictionary of values, not a value, so it cannot be passed on whole. Pass its fields on by name, such as input.from.` |
| `resolveOne`, `'input'` | the root | `<site> depends on the whole input of root module "<m>". The root's input is every value the \`config\` adapters return, which by default is every variable of the process environment, secrets included. Pass on the fields the root declares one by one, such as input.EMAIL_FROM.` | `<site> depends on the whole input of module "<m>". A module body's input is a dictionary of values, not a value, so it cannot be passed on whole. The root's input is every value the \`config\` adapters return, which by default is every variable of the process environment, secrets included. Pass its fields on by name, such as input.from.` |
| `misuse`, path `[]` | the whole input turned into text, spread, iterated, and so on | `input of module "<m>" is a value, not its real value, and <what>. A module body can only pass an input field on: into a provision() binding or as a resolve() dependency. To compute with it, it must be a plain field, not a wrapped or secret one; list it: resolve([input], ([v]) => …).` | `input of module "<m>" is a dictionary of values, not data, and <what>. A module body can only pass the fields of its input on, by name: into a provision() binding or, for a plain field, as a resolve() dependency.` |
| `readPath` | a field of an input whose schema outputs no plain object | `<path> of module "<m>" does not exist: input is <kind>, not a plain object, so it has no fields. To compute with it, it must be a plain field, not a wrapped or secret one; list it: resolve([input], ([v]) => …).` | `<path> of module "<m>" does not exist: input is <kind>, not a plain object, so it has no fields. The module's input schema must output a plain object for its body to read fields.` |

The compile error's message is the type of `NotInputDictionary`'s property: `the whole input of a module is not a value; pass its fields on by name`. Test 10 pins it.

## 7. Documentation

All in the same pull request (`.agents/rules/user-facing-surface-changes.mdc`). Each edit replaces the quoted text exactly; `\n` marks a line break in the quoted original. Every replacement is written without hard wraps: one paragraph or one list item per line.

### 7.1 The module input decision, rewritten as one current record

Will wants each decision record to state the current decision, with no stacked amendment notes, as ADR-0062 already does. So `docs/design/90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md` is replaced in full by the text below, between the two `~~~` lines. Its six amendment notes go: their content is folded in. The S2 note's "to narrow, forward the whole `input` or narrow inside a `resolve()` function" is reversed, and the record says so in its alternatives.

~~~markdown
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

A module declares all of its incoming configuration as **one Standard Schema**, `input`, exactly as `compute()` does. Whoever provisions the module binds that input with `provision(module, { input: { … } })`. Modules have no per-key `params` or `secrets` slots.

- **The schema** comes from any Standard Schema library. A secret field is typed `secretString()`. A leaf field that may receive a value known only at boot is wrapped in `field()`: a **wrapped field**. A field written without it is a **plain field**, which accepts deploy-time data only. `@prisma/composer/arktype` and `@prisma/composer/zod` export both helpers.
- **The binding** is typed from the schema's input type. Each key takes a literal, a value of the field's type, or a source such as `envSecret()`, which is a value too ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). A module with an input schema must be bound, and a module without one must not be.
- **The body** receives `input`, a **dictionary** with one value per field, typed from the schema's output: `input.from`, or `input.smtp.user` for a nested field. It can pass a field on, by name, into a child module's or a service's `input`, a service param or a resource's props, and it can list a plain field as a `resolve()` dependency. It cannot read a field's data.
- **The dictionary itself is not a value.** Passing the whole `input` where a value is accepted fails to compile, for every module. A cast gets past the compiler, so Load refuses it too, with an error that says the whole input of the module was passed on, and to pass its fields on by name.
- **The root** may declare `input` too. Nothing provisions the root, so the deploy binds its input to the app configuration, the merged values of the config adapters ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). The root's input holds no secret, because the app configuration is plain and a `secretString()` field refuses a plain value. The root may not declare `deps`, because a dependency needs a producer in the graph.

## Reasoning

**A module has the same boundary as a service.** That is the module-boundary decision ([ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md)): `deps` in, `expose` out, so a consumer cannot tell a provisioned module from a provisioned service. The service input decision ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)) gave a service one schema for all of its configuration. A module that took configuration in a different shape, under different names, with a different secret mechanism, would break the boundary the first decision drew. This decision puts modules on the service's shape.

**Everything the service input decision gave services, modules get.** Legality can be relational ("no `stripeSecretKey` unless `stripeEnabled`"), because a schema library expresses that and per-key slots cannot. The caller brings the schema library, and Composer keeps no type vocabulary of its own ([ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md)). Secretness is enforced by validation: binding a plain value where the schema expects a secret fails the deploy, and so does binding a secret source to a plain field.

**A module receives the input it needs and no more.** The body names each field it passes on, and only those fields reach the graph. Nothing stands for the whole input. This matters most for the root: its input by default holds every variable of the process environment, secrets included, and passing it on whole would put all of them into an input document that the platform stores and the deploy report prints. A module that is not the root follows the same constraint, so that a child receives only what its parent chose to give it, and so that a module's body does not change when it becomes the root or stops being it.

**The body holds values, not data, so the graph cannot branch on configuration.** `input.baseUrl` is a value, an opaque stand-in for data known later ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). Turning a field into text or a number, serializing it, listing its keys, spreading or iterating it, testing it with `in`, or assigning to it fails at Load with an error naming the field. `===` or `switch` against a literal fails to compile. A truthiness check or `typeof` cannot be caught, because JavaScript calls no hook for them, but a value is always an object, so such a branch always goes the same way and cannot vary the graph. So a module provisions the same children in every environment, as the structure requirement asks ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)).

**The schema checks the binding at Load.** During Load's second pass, from the root down, Load resolves each module's binding, replacing each deploy-time value with its real value, and checks the result with the module's schema. The check runs synchronously, because a child's real value is read from its parent's checked output; an async schema fails the Load. A field's real value is read from the schema's output, so a field typed `number` by a parsing schema receives `4`, not `'4'`, and defaults apply. The child's schema then checks the value again. A value known only at boot reaches the schema as its pointer: `secretString()` accepts a secret pointer, a wrapped field a plain pointer, and a plain field neither. A schema may check such a field but never replace it or move its pointer to another field; Load refuses a schema that does. A schema may return a copy of a pointer, as ArkType does when a transform runs, so Load recognises a pointer by its brand and the variable it names, and passes on the source the binding named. A secret box written in a binding is refused, because a secret's value never appears in the code.

**How the body gets one value per field.** The framework cannot read the keys out of a Standard Schema; Standard Schema exposes only `validate`, which is why the service input decision rejected introspection. So the values come from the keys the author writes in the body. `input` is an object whose property reads each return a value recording its key path, typed from the schema's output, and the same path always returns the same value. Load records which field flows into which binding or `resolve()`. An input field the body never uses is not an error, because Load cannot list a schema's keys.

**A union schema becomes a flat one.** For a union schema the body's types offer only the keys every member has, and the body can neither narrow with an `if` nor pass the whole input on. So a module cannot declare a union input and still pass every field to its service. It declares a flat schema instead, for example with an optional field, and passes each field on by name. An array field has no element access; a `resolve()` that lists a plain array field computes with its elements.

## Consequences

- **`module()` takes `input`**, and `provision(module, …)` takes one `input` binding, typed from the schema. `ModuleNode<D, E, I>` and `ModuleContext<D, I>` carry the schema's type. `module()` refuses a `params` or `secrets` key, and `provision()` of a module refuses a `params` or `secrets` map, each with an error naming `input`. `paramNeed()` and the module form of `secret()` are gone.
- **The body's `input` has the type `ModuleInput<S>`, which is not a `Value`.** Every binding type refuses it. Where the compiler sees no type, such as a binding slot typed `unknown`, only Load refuses it.
- **`paramSource()` and `secretSource()`**, which targets use to build their sources, each return one object that is both the source and a value. `secretSource()` takes a `label`. `paramSource()` takes `label`, `poolKey` and `redacted`; `redacted` says whether the source is a secret pointer or a plain one.
- **Load accepts `input` on a root** and binds it to the app configuration, which the root's schema checks before any other module's binding. Load still refuses `deps` on a root.
- **A value passed on is checked twice**, by the module's schema and by the child's. Both run at deploy, before anything is created.

## Alternatives considered

- **Per-key slots on modules under new names.** Rejected: modules and services would still take configuration in two shapes.
- **Separate `config` and `secrets` declarations on modules, through builder callbacks with a Composer type vocabulary** (`(c) => ({ foo: c.string() })`). Rejected: it splits what the service input decision deliberately merged, and gives Composer a type vocabulary to maintain beside the schema libraries.
- **Input on the root only.** Rejected: the root would take configuration in a shape no other module uses.
- **Hand the body the actual values.** Rejected: the body could branch on them, and the graph would differ per environment.
- **Passing the whole `input` on**, which an earlier version of this decision allowed for a module that is not the root, as the way to narrow a union schema. Rejected: a module should receive the input it needs and no more, and a child should receive only what its parent names. One constraint for every module is also simpler than one for the root and another for the rest.
- **Refusing the whole `input` at Load only.** Rejected: code that type-checks should deploy, so the compiler refuses it wherever the binding has a type, and Load refuses it where the compiler cannot see.

## Related

- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md): a module has the same boundary as a service. Amended by this ADR.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): service input is one standard schema. Extended to modules by this ADR.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) and [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md): the forwardable secret and param slots this replaces on modules; their sources (`envSecret`, `envParam`) remain.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): values, `resolve()`, and how the root's input is bound.
- [module-composition.md](../10-domains/module-composition.md) and [config-params.md](../10-domains/config-params.md).
~~~

### 7.2 The decision index, `docs/design/90-decisions/README.md`

The whole ADR-0061 line, from `- [ADR-0061](` to the end of the line, becomes:

```markdown
- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md) — A module declares its configuration as one Standard Schema, `input`, exactly as a compute service does, and whoever provisions it binds that input with a binding typed from the schema. The body receives `input` as a dictionary with one value per field; it passes fields on by name, or lists a plain field in `resolve()`, and never reads their data, so the graph cannot branch on configuration. The dictionary itself is not a value: passing it on whole fails to compile and fails at Load, for every module. A field that may receive a value known only at boot is wrapped in `field()`; a secret is a `secretString()` field. The module `params`/`paramNeed()` and `secrets`/`secret()` slots are removed. The root may declare `input`, bound to the app configuration.
```

### 7.3 Glossary, `docs/design/03-domain-model/glossary.md`

1. **Module**, the **Input.** bullet: `- **Input.** A Module declares its [Input](#input) as one \`input\` Standard\n  Schema, as a Service does, and whoever provisions it binds it. Its body\n  receives one [value](#value) per input field and can only pass it on: into a \`provision()\`\n  binding or, for a [plain field](#field), as a \`resolve()\` dependency.` becomes:

   ```markdown
   - **Input.** A Module declares its [Input](#input) as one `input` Standard Schema, as a Service does, and whoever provisions it binds it. Its body receives `input`, a dictionary with one [value](#value) per input field, and can only pass a field on, by name: into a `provision()` binding or, for a [plain field](#field), as a `resolve()` dependency. The dictionary itself is not a value: passing it on whole fails to compile, and Load refuses it.
   ```

2. **Value**, the **Provided or computed.** bullet, from `- **Provided or computed.**` to `disabled. \`resolve()\` declares a computed value; Load resolves every value.`, becomes:

   ```markdown
   - **Provided or computed.** A provided value is handed to the module body: `environment.name` is one, a deploy-time fact of the environment, and each field of a module's `input` is another, whose real value is read from the module's input after its schema has validated it. The `input` itself is a dictionary of these values, not a value, so no binding accepts it. A root's input is the config pool. A computed value is what `resolve(dependencies, fn)` returns; Load runs `fn` with its dependencies' real values after every module body has run, with `provision` disabled. `resolve()` declares a computed value; Load resolves every value.
   ```

The **Config pool** entry is left as it is: its last sentence, that Load refuses the root's whole input, stays true, and S12 replaces the entry.

### 7.4 `docs/design/10-domains/module-composition.md`, § Input

1. The paragraph from `The body holds one value for each key of the schema: \`input.from\`,` to `includes \`Pointer<SecretString>\`.` becomes one line:

   ```markdown
   The body holds `input`, a dictionary with one value for each key of the schema, such as `input.from` or `input.smtp.host`. Each is a [value](../03-domain-model/glossary.md#value), the same kind as `environment.name` and a `resolve()` result, and a provided one: the body is handed it. Its real value is the data at that key path in the module's validated input, which is the module's binding with its values replaced by their real values and passed through the module's schema. A real value is the schema's output, so a field typed `number` by a `string.integer.parse` schema receives `4`, not `'4'`. An input field bound to a deploy-time value is deploy-time: its real value is known by the end of Load. A field bound to `envSecret()`, `generatedParam()` or `serviceOrigin()` is a runtime value: the data is known only at boot, so its real value is a pointer, and its type says so: a wrapped field's type includes `Pointer<In>`, and a `secretString()` field's includes `Pointer<SecretString>`.
   ```

2. Directly after that paragraph and its blank line, a new paragraph:

   ```markdown
   `input` itself is not a value. Its type, `ModuleInput<S>`, carries a brand that every binding type refuses, so passing the whole `input` into a child module's or a service's `input`, a service param, a resource's props or a `resolve()` dependency fails to compile, for every module, the root included. A cast gets past the compiler, so Load refuses it too, naming where it was passed and saying to pass its fields on by name. A binding slot typed `unknown` accepts anything, so there only Load refuses it. A module receives the input it needs and no more: its body names each field it passes on.
   ```

3. The list item `- **a service's \`input\` binding**, at any depth, including the whole binding;` becomes `- **a service's \`input\` binding**, at any depth; a field may be the whole binding, as in \`input: input.smtp\`;`, and `- **a module's \`input\` binding**, at any depth, including the whole binding;` becomes `- **a module's \`input\` binding**, at any depth; a field may be the whole binding;`.

### 7.5 The guide, `docs/guides/building-an-app.md`

1. **§ A module's input**, the first bullet after the example, `- The body receives each field as a [value](#values-that-differ-per-environment).\n  It can pass a field into a \`provision()\` binding, or, if the field is\n  plain, list it as a \`resolve()\` dependency to compute with it.`, becomes two bullets:

   ```markdown
   - The body receives `input`, a dictionary with one [value](#values-that-differ-per-environment) per field. It can pass a field into a `provision()` binding, or, if the field is plain, list it as a `resolve()` dependency to compute with it.
   - `input` itself is not a value. Pass each field on by name, as `input: { from: sender, replyTo: input.replyTo, deliveryCredential: input.deliveryCredential }` does above. Passing the whole `input` on, as in `provision(child, { input })`, fails to compile, and the deploy refuses it if a cast gets it past the compiler.
   ```

2. **§ Values from outside the code**, the paragraph `Pass the root's input fields on one by one, as \`from: input.EMAIL_FROM\` is\nabove. The root's whole \`input\` is every value the \`config\` adapters\nreturn, which by default is every variable of the shell, secrets included, so\nLoad refuses it in a binding or a \`resolve()\` dependency.` becomes:

   ```markdown
   Pass the root's input fields on by name, as `from: input.EMAIL_FROM` is above. No module can pass its whole `input` on, and for the root it matters most: its whole `input` is every value the `config` adapters return, which by default is every variable of the shell, secrets included.
   ```

The union-schema bullet, `To narrow, declare a flat schema and pass its fields on by name, or narrow inside a \`resolve()\` function.`, stays: neither advice passes the whole `input`.

### 7.6 The agent skill, `skills/prisma-composer-core-concepts/SKILL.md`

Written to `skills/README.md`. Both in § Values that differ per environment:

1. In the bullet that begins `- A module declares \`input\``, `and the body receives each field as a value it can pass into a binding or, for a plain field, list in \`resolve()\`.` becomes `and the body receives \`input\`, a dictionary of values: it passes each field on by name into a binding or, for a plain field, lists it in \`resolve()\`. Passing the whole \`input\` on fails to compile, and the deploy refuses it.`
2. In the bullet that begins `` - `composer({ config: [...], secrets: [...] })` ``, `pass the root's input fields on one by one, because Load refuses its whole \`input\` (the whole pool, by default every shell variable).` becomes `pass the root's input fields on by name, as every module does; its whole \`input\` would be the whole pool, by default every shell variable.`

No other document teaches passing the whole `input` on. A search of `docs/`, `skills/`, `website/`, `examples/`, the package READMEs and the root markdown files for `whole input`, `whole \`input\``, `forward the whole`, `{ input }` and `input: input` finds only the places above, ADR-0062 (which already states this slice's behaviour: "Passing the whole `input` where a value is accepted fails to compile, and Load refuses it"), and `building-an-app.md`'s text about ArkType copying "the whole input", which is about schemas.

## 8. The release note

The repo has no changesets; GitHub Release notes are generated from pull request titles, and the breaking changes are written in the pull request description, as #403 did under `## Breaking changes`. So the pull request carries the release note:

- **Title**: `feat(core)!: a module's whole input cannot be passed on`.
- **Description**: a section `## Breaking change` holding, in this order:

  1. The before and after:

     ```ts
     // before: a module passed its whole input to its service
     const relay = module('relay',
       { input: type({ from: field(type('string')), deliveryCredential: secretString() }) },
       ({ input, provision }) => {
         provision(relayService, { input });
       });

     // after: it passes each field on by name
     const relay = module('relay',
       { input: type({ from: field(type('string')), deliveryCredential: secretString() }) },
       ({ input, provision }) => {
         provision(relayService, { input: { from: input.from, deliveryCredential: input.deliveryCredential } });
       });
     ```

  2. The sentence: `A module body's input is a dictionary of values, not a value. Passing the whole input into a child module's or a service's input, a service param, a resource's props or a resolve() dependency now fails to compile, for every module. Where the compiler cannot see it, such as a cast or a binding typed unknown, the deploy fails before anything is created, with an error that names where the input was passed and says to pass its fields on by name. Before, only the root's whole input was refused, and only by the deploy.`
  3. The sentence: `The type ModuleInput<S> is no longer a Value. Code that passed a module's input to a function taking a Value no longer compiles.`

## 9. Tests

Runtime tests use `bun test`; type tests use vitest `expectTypeOf` and `@ts-expect-error`. Test files are exempt from the no-bare-casts instruction. A runtime test that passes the whole input casts it with `as never`: that is the cast the design says gets past the compiler, and Load must still refuse it. Every code block below is as `pnpm lint:fix` formats it.

### 9.1 Existing tests this slice changes

**Core** (`packages/0-framework/1-core/core/src/__tests__/`), all in commit 1 unless stated.

- `module-input.test.ts`:
  - The `../node.ts` import becomes `import { dependency, type ModuleNode, module, resource, secretSource, service } from '../node.ts';`.
  - In `a module body receives one value per input field, and the same path gives the same value`, `seen.push(isValue(input.from), isValue(input), first === second);` becomes `seen.push(isValue(input.from), first === second);`, and `expect(seen).toEqual([true, true, true]);` becomes `expect(seen).toEqual([true, true]);` (§ 14, decision 4).
  - `the whole input forwarded into a service reaches it as the module's validated input` is retitled `a field passed into a service reaches it as the module's validated output`, and its `provision(echoService(), { input });` becomes `provision(echoService(), { input: { from: input.from, count: input.count } });`. Its assertion does not change.
  - `the whole input forwarded into a child module reaches its service` is removed. Test 2 replaces it.
- `root-input.test.ts`:
  - In `the root's schema runs before any other module's`, the `email` module becomes `const email = module('email', { input: labelled('email') }, () => {});`.
  - In describe `the root's whole input never reaches a binding`, `refusal` becomes:

    ```ts
      const refusal = (site: string) =>
        `${site} depends on the whole input of module "shop". A module body's input is a ` +
        "dictionary of values, not a value, so it cannot be passed on whole. The root's input is " +
        'every value the `config` adapters return, which by default is every variable of the ' +
        'process environment, secrets included. Pass its fields on by name, such as input.from.';
    ```

  - In `the root's whole input as a resolve() dependency is refused`, `resolve([input], ([i]) => i)` becomes `resolve([input as never], ([i]) => i)` (in commit 2, where it stops compiling).
  - In `the root's whole input bound to a child module is refused`, the `email` module becomes `const email = module('email', { input: anyInputSchema }, () => {});`.
  - `a module that is not the root may forward its whole input` becomes:

    ```ts
      test('a module that is not the root cannot pass its whole input on either', () => {
        const email = module('email', { input: anyInputSchema }, ({ input, provision }) => {
          provision(echoService(), { input: input as never });
        });
        const root = module('shop', { input: schema }, ({ input, provision }) => {
          provision(email as never, { input: { greeting: input.GREETING } } as never);
        });

        expect(loadError(() => Load(root, { configPool: pool })).message).toBe(
          'the input binding of service "shop.email.echo" depends on the whole input of module ' +
            '"shop.email". A module body\'s input is a dictionary of values, not a value, so it ' +
            'cannot be passed on whole. Pass its fields on by name, such as input.from.',
        );
      });
    ```

  - In `a pool-key source whose pool value is not text fails naming its kind`, the `email` module becomes `const email = module('email', { input: anyInputSchema }, () => {});`.
- `source-load.test.ts`: the `forwarding` fixture and its doc comment become:

  ```ts
  /** A module `email` whose `input` schema is `schema` and whose body passes each of `keys` on to `echo` by name. */
  const forwarding = (schema: StandardSchemaV1, keys: readonly string[]): ModuleNode =>
    module('email', { input: schema }, ({ input, provision }) => {
      const fields = input as never as Record<string, unknown>;
      provision(echoService(), {
        input: Object.fromEntries(keys.map((key) => [key, fields[key]])) as never,
      });
    });
  ```

  and its six calls pass the keys: `forwarding(type({ greeting: 'string' }), ['greeting'])` (twice), `forwarding(type({ 'greeting?': 'string' }), ['greeting'])`, `forwarding(recording(seen), ['base'])`, `forwarding(anyInputSchema, ['from'])` and `forwarding(type({ key: secretString() }), ['key'])`. No assertion changes. In `an unset or empty variable in a module's input leaves the key out`, the binding still has no `greeting` key: the field's real value is `undefined`, and `substitute` leaves out a key whose value has no real value.
- `module-input.test-d.ts`, in commit 2:
  - The imports gain `import { string } from '../config.ts';` after the vitest import; the value import becomes `import { module, resolve, resource, SecretBox, secretSource, service } from '../exports/index.ts';`; and after it, `import type { INPUT_DICTIONARY, NotInputDictionary } from '../value.ts';`.
  - `declare const misfitsSchema: StandardSchemaV1<{ missing: string }>;` becomes `declare const plainSchema: StandardSchemaV1<unknown, { host: string; port: number }>;`.
  - In `each input field is a value typed from the schema's output`, `expectTypeOf<RealValue<typeof input>>().toEqualTypeOf<ShopOut>();` becomes `expectTypeOf(input).not.toExtend<Value<unknown>>();`.
  - `the whole input forwards into a child whose input type it satisfies` is replaced by tests 9 and 10.

**Prisma Cloud target** (`packages/1-prisma-cloud/1-extensions/target/src/__tests__/input-serializer.test.ts`), commit 1: in describe `a source forwarded through a module input`, the `login` module's body becomes:

```ts
    const login = module('login', { input: schema }, ({ input, provision }) => {
      const fields = input as never as Record<string, unknown>;
      provision(svc(schema), {
        input: Object.fromEntries(Object.keys(binding).map((key) => [key, fields[key]])) as never,
      });
    });
```

No other existing test passes a whole `input` on. Checked: every `provision(` and `resolve(` in `packages/`, `examples/`, `test/` and `website/` whose binding is `input`, `{ input }`, `[input]` or holds `input` as a value. `resolve-values.test.ts`'s `provision(echoService(), { input: input as never })` names a local `resolve()` result called `input`, not a module's input, and does not change. The `{ id: 'email', input }` in the `shopWith` fixtures of `module-input.test.ts`, `source-load.test.ts` and `pointer.test.ts` is the fixture's own parameter, not a module's input.

### 9.2 New core runtime tests, a new describe at the end of `module-input.test.ts` (commit 1)

```ts
describe("a module's whole input is never passed on", () => {
  const refusal = (site: string, moduleAddress: string) =>
    `${site} depends on the whole input of module "${moduleAddress}". A module body's input is ` +
    'a dictionary of values, not a value, so it cannot be passed on whole. Pass its fields on ' +
    'by name, such as input.from.';
  const schema = type({ from: 'string' });
  …
});
```

The file's existing `echoService`, `shopWith`, `loadError` and `providerContract` are used. Each test, inside that describe:

1. `the whole input bound to a service fails at Load` — `email` is `module('email', { input: schema }, ({ input, provision }) => { provision(echoService(), { input: input as never }); })`; `Load(shopWith(email, { from: 'a' }))` fails with `refusal('the input binding of service "shop.email.echo"', 'shop.email')`.
2. `the whole input bound to a child module fails at Load`:

   ```ts
     test('the whole input bound to a child module fails at Load', () => {
       const email = module('email', { input: schema }, ({ input, provision }) => {
         provision(echoService(), { input: { from: input.from } });
       });
       const relay = module('relay', { input: schema }, ({ input, provision }) => {
         provision(email, { input: input as never });
       });
       const root = module('shop', ({ provision }) => {
         provision(relay, { input: { from: 'shop@example.com' } });
       });

       expect(loadError(() => Load(root)).message).toBe(
         refusal('the input binding of module "shop.relay.email"', 'shop.relay'),
       );
     });
   ```

3. `the whole input nested inside a binding fails at Load, naming the key` — the body binds `provision(echoService(), { input: { settings: [input] } as never })`; fails with `refusal('input key "settings.0" of service "shop.email.echo"', 'shop.email')`.
4. `the whole input bound to a service param fails at Load` — `provision(echoService(), { input: {}, params: { label: input as never } })`; fails with `refusal('param "label" of service "shop.email.echo"', 'shop.email')`.
5. `the whole input in a resource's props fails at Load`:

   ```ts
       const email = module('email', { input: schema }, ({ input, provision }) => {
         provision(
           resource({
             name: 'site',
             extension: 'test/pack',
             provides: providerContract('fake/url', { url: '' }),
             props: { all: input as never },
           }),
         );
       });
   ```

   fails with `refusal('prop "all" of resource "shop.email.site"', 'shop.email')`.
6. `the whole input listed in resolve() fails at Load, and the function never runs`:

   ```ts
       const ran: boolean[] = [];
       const email = module('email', { input: schema }, ({ input, provision }) => {
         const label = resolve([input as never], () => {
           ran.push(true);
           return 'x';
         });
         provision(echoService(), { input: { label } });
       });
   ```

   fails with `refusal('input key "label" of service "shop.email.echo"', 'shop.email')`, and `ran` equals `[]`.
7. `spreading the whole input fails, saying to pass its fields on by name` — the body binds `provision(echoService(), { input: { ...input } as never })`; fails with exactly `'input of module "shop.email" is a dictionary of values, not data, and its keys were ' + 'listed (Object.keys, object spread, for…in or Object.entries). A module body can only ' + 'pass the fields of its input on, by name: into a provision() binding or, for a plain ' + 'field, as a resolve() dependency.'`.
8. `a field of an input whose schema outputs no object fails naming the path`:

   ```ts
     test('a field of an input whose schema outputs no object fails naming the path', () => {
       const text: StandardSchemaV1<unknown, string> = {
         '~standard': { version: 1, vendor: 'test', validate: () => ({ value: 'a' }) },
       };
       const email = module('email', { input: text }, ({ input, provision }) => {
         provision(echoService(), { input: { from: (input as never as { from: never }).from } });
       });

       expect(loadError(() => Load(shopWith(email, {}))).message).toBe(
         'input.from of module "shop.email" does not exist: input is a string, not a plain object, ' +
           "so it has no fields. The module's input schema must output a plain object for its body " +
           'to read fields.',
       );
     });
   ```

Tests 1, 3, 4 and 7 use `Load(shopWith(email, { from: 'a' }))`, and each asserts with `expect(loadError(() => …).message).toBe(…)`.

### 9.3 New core type tests (commit 2)

In `module-input.test-d.ts`, in place of the removed test:

9. `no binding accepts the whole input, even where its fields would fit`:

    ```ts
    test('no binding accepts the whole input, even where its fields would fit', () => {
      const fits = module('fits', { input: fitsSchema }, () => {});
      const echo = service({
        name: 'echo',
        extension: 'test/pack',
        type: 'fake/compute',
        inputs: {},
        params: { label: string() },
        input: plainSchema,
        build: {
          extension: '@prisma/composer/node',
          type: 'node',
          module: 'file:///s.ts',
          entry: 's.js',
        },
      });
      module('shop', { input: shopSchema }, ({ input, provision }) => {
        provision(fits, { input: { EMAIL_FROM: input.EMAIL_FROM } });
        // @ts-expect-error the whole input is not a value
        provision(fits, { id: 'two', input });
      });
      module('shop', { input: plainSchema }, ({ input, provision }) => {
        provision(echo, { input: { host: input.host }, params: { label: input.host } });
        resolve([input.host], ([host]) => host);
        resource({ name: 'site', extension: 'test/pack', props: { host: input.host } });
        // @ts-expect-error the whole input is not a value
        provision(echo, { id: 'two', input });
        // @ts-expect-error the whole input is not a value, at any depth
        provision(echo, { id: 'three', input: { all: [input] } });
        // @ts-expect-error the whole input is not a value
        provision(echo, { id: 'four', input: {}, params: { label: input } });
        // @ts-expect-error the whole input is not a value
        resolve([input], () => 'x');
        // @ts-expect-error the whole input is not a value
        resource({ name: 'two', extension: 'test/pack', props: input });
        // @ts-expect-error the whole input is not a value, at any depth
        resource({ name: 'three', extension: 'test/pack', props: { all: { nested: input } } });
      });
    });
    ```

    `plainSchema`'s fields are all plain data, so each refusal of the second module is the brand's doing, not a field's type.
10. `the type error says to pass the fields on by name`:

    ```ts
    test('the type error says to pass the fields on by name', () => {
      expectTypeOf<
        NonNullable<NotInputDictionary[typeof INPUT_DICTIONARY]>
      >().toEqualTypeOf<'the whole input of a module is not a value; pass its fields on by name'>();
    });
    ```

    This pins the message: a change to its text fails the type test.

At the end of `field.test-d.ts`, using its existing `arkNested` and `zodNested`:

11. `a field read from the input binds, nested or optional, and the whole input does not, in both libraries`:

    ```ts
    test('a field read from the input binds, nested or optional, and the whole input does not, in both libraries', () => {
      const arkNestedChild = module('ark-nested', { input: arkNested }, () => {});
      const zodNestedChild = module('zod-nested', { input: zodNested }, () => {});
      module('m', { input: arkNested }, ({ input, provision }) => {
        expectTypeOf(input.smtp.user).toEqualTypeOf<ModuleInputField<string | Pointer<string>>>();
        expectTypeOf(input.replyTo).toEqualTypeOf<
          ModuleInputField<string | Pointer<string> | undefined>
        >();
        provision(arkNestedChild, {
          input: { smtp: input.smtp, replyTo: input.replyTo, tags: input.tags },
        });
        provision(arkNestedChild, {
          id: 'two',
          input: { smtp: { user: input.smtp.user, password: input.smtp.password }, tags: input.tags },
        });
        // @ts-expect-error the whole input is not a value
        provision(arkNestedChild, { id: 'three', input });
      });
      module('m', { input: zodNested }, ({ input, provision }) => {
        expectTypeOf(input.smtp.user).toEqualTypeOf<ModuleInputField<string | Pointer<string>>>();
        expectTypeOf(input.replyTo).toEqualTypeOf<
          ModuleInputField<string | Pointer<string> | undefined>
        >();
        provision(zodNestedChild, {
          input: { smtp: input.smtp, replyTo: input.replyTo, tags: input.tags },
        });
        provision(zodNestedChild, {
          id: 'two',
          input: { smtp: { user: input.smtp.user, password: input.smtp.password }, tags: input.tags },
        });
        // @ts-expect-error the whole input is not a value
        provision(zodNestedChild, { id: 'three', input });
      });
    });
    ```

## 10. Scope

In: `packages/0-framework/1-core/core` (§ 3, § 4, tests); the Prisma Cloud target's `input-serializer.test.ts`; `docs/`; `skills/`.

Out, as the plan assigns: typing a service's binding from its schema (S10), and with it the service error that does not show the message (§ 15, finding 2); `dotenv-flow` (S11); the configuration file and the "pool" names (S12), including the glossary's Config pool entry and `fromConfigPool`; redaction (S13). Also out: folding the amendment notes of the other decision records this project touched; only ADR-0061 is rewritten here, because this slice reverses one of its statements.

## 11. Commits, in order

Each commit is made with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"` and has no `Co-Authored-By` line. Before each commit, run `pnpm lint:fix` and keep the formatting it writes.

1. `feat(core)!: Load refuses a module's whole input wherever it is passed on` — § 4; § 3.2's `blindCast` reason; § 3.1 item 3; the commit-1 changes of § 9.1; tests 1 to 8.
2. `feat(core)!: a module's whole input fails to compile where a value is accepted` — § 3.1 items 1, 2 and 4; § 3.2 items 1 and 2; § 3.3; the commit-2 changes of § 9.1; tests 9 to 11.
3. `docs(design): a module's whole input is refused, and the module input decision is one current record` — § 7.1 to § 7.4.
4. `docs: a module passes its input fields on by name, in the guide and the agent skill` — § 7.5, § 7.6.
5. `docs(drive): module-input S9 manual QA` — `qa.md` in this slice's folder (§ 12).

## 12. Done when

- Tests 1 to 11 pass, and every test changed in § 9.1 passes. At the root: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm lint:deps`, `pnpm test`, `pnpm turbo run test:types`, `pnpm check:floor-imports`, `pnpm check:publish-deps` and `pnpm check:skill-packaging` are green. `pnpm lint:casts` reports `delta=0`: this slice adds no cast to production code. `pnpm lint` reports 40 warnings and 20 infos, as main does.
- Run `pnpm test` from this worktree, not from a scratch copy. Some target and local-target tests start emulator daemons. Stop no emulator you did not start. If tests fail because of an emulator this run did not start, record it and report; do not stop it. Never run `pnpm test:integration`, `pnpm test:e2e` or `pnpm test:all`.
- The four tests under `a hostname public URL under the Alchemy apply engine` in the Prisma Cloud target fail when `bun test` runs alone in that package, on main too (S7 spec § 16), and pass under `pnpm test`. If any other test fails, stop and report.
- Every document in § 7 is updated. The pull request carries § 8.
- **Manual QA**, recorded in `qa.md` in this slice's folder, after `pnpm build`. No Prisma Cloud deploy: deploy output does not change (§ 2).
  1. **The compile error an author sees, and the Load error behind a missing type check.** Write `examples/email/src/s9-qa.ts` with exactly:

     ```ts
     import { Load, module } from '@prisma/composer';
     import { field, secretString } from '@prisma/composer/arktype';
     import { envSecret } from '@prisma/composer-prisma-cloud';
     import { email } from '@prisma/composer-prisma-cloud/email';
     import { type } from 'arktype';

     const relay = module(
       'relay',
       {
         input: type({
           deliveryMode: field(type('string')),
           from: field(type('string')),
           deliveryCredential: secretString(),
         }),
       },
       ({ input, provision }) => {
         provision(email(), { input });
       },
     );

     const root = module('shop', ({ provision }) => {
       provision(relay, {
         input: {
           deliveryMode: 'none',
           from: 'shop@example.com',
           deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
         },
       });
     });

     try {
       Load(root, { environment: { name: 'production' } });
       console.log('loaded');
     } catch (error) {
       console.log(error instanceof Error ? error.message : error);
     }
     ```

     Run `pnpm --filter @prisma/example-email typecheck` and record its output. It holds `src/s9-qa.ts(17,26): error TS2769: No overload matches this call.` and ends with `Type 'true' is not assignable to type '"the whole input of a module is not a value; pass its fields on by name"'.` Then run `bun src/s9-qa.ts` in `examples/email`, which does not check types. It prints exactly `the input binding of module "shop.relay.email" depends on the whole input of module "shop.relay". A module body's input is a dictionary of values, not a value, so it cannot be passed on whole. Pass its fields on by name, such as input.from.` Record it, then delete `src/s9-qa.ts`.
  2. **The root's Load error.** Write `examples/email/src/s9-qa-root.ts` with exactly:

     ```ts
     import { Load, module } from '@prisma/composer';
     import { email } from '@prisma/composer-prisma-cloud/email';
     import { type } from 'arktype';

     const root = module('shop', { input: type({ EMAIL_FROM: 'string' }) }, ({ input, provision }) => {
       provision(email(), { input: input as never });
     });

     try {
       Load(root, { environment: { name: 'production' }, configPool: { EMAIL_FROM: 'shop@example.com' } });
       console.log('loaded');
     } catch (error) {
       console.log(error instanceof Error ? error.message : error);
     }
     ```

     `bun src/s9-qa-root.ts` in `examples/email` prints exactly `the input binding of module "shop.email" depends on the whole input of module "shop". A module body's input is a dictionary of values, not a value, so it cannot be passed on whole. The root's input is every value the \`config\` adapters return, which by default is every variable of the process environment, secrets included. Pass its fields on by name, such as input.from.` Record it, then delete the file.
  3. **The examples still type-check.** `pnpm --filter @prisma/example-email typecheck` and `pnpm --filter @prisma/example-storefront-auth typecheck` exit 0, and `git status` shows only this slice's changes.

## 13. Checks the spec author ran

One scratch worktree of this branch, at its git-ignored `wip/s9-scratch`, with its own `pnpm install --frozen-lockfile`, removed afterwards. No process was left running from it. The whole change to code and tests, as one patch against this branch, is kept at `wip/s9-spec-probe/final.patch` (git-ignored) for the review to compare with; the spec, not the patch, is what the implementer follows.

- **The types.** A probe file in core's tests checked, for an ArkType and a Zod schema with a wrapped field, a plain field, an optional wrapped field, a `secretString()` field and a nested object with a wrapped leaf and an optional nested object: each field read, nested or optional, keeps its `ModuleInputField` type and binds into a child module, a service binding, a service param, a `resolve()` and a resource's props; and the whole input fails to compile in a child module's binding, a service's binding, nested at any depth in a service binding, a service param, `resolve()`, a resource prop, and as a resource's whole props. The probe also confirmed the limit: a child whose schema is typed `unknown` accepts the whole input. Before § 3.3 item 4, `resource({ props: input })` compiled for a schema of plain fields.
- **The message.** With `NotInputDictionary`'s property typed `never`, the error ended `Type 'true' is not assignable to type 'never'`. Typed as the message, it ends with the message (§ 1).
- **Everything green after the whole change**, after `pnpm lint:fix`: `pnpm build`, 39 of 39 tasks; `pnpm turbo run typecheck test:types --continue`, 84 of 84 tasks; `pnpm lint`, 40 warnings and 20 infos; `pnpm lint:casts`, `current=18 merge-base=18 delta=0`; core's `bun test`, 413 pass; core's `vitest --typecheck`, 81 pass; the target's `input-serializer.test.ts`, 59 pass, and its other test files that call `Load` (`control-lowering`, `env-key-clash`, `local-target-preflight`, `orm-postgres`, `param`, `pack-preflight`, `preflight`, `provisioned-edges`, `preflight-payload`, `public-url`, `raw-http`, `secret`, `extension`), green except two files that could not load `@internal/local-target` in the scratch copy, which do not pass a whole input; `bun test` in auth (132), cron (26), email (99), storage (49), streams (22) and the CLI (411); and `examples/storefront-auth/module.test.ts`.
- **Before the change**, with only the Load check of § 4.1 applied, core's `bun test` showed exactly the 13 failures that § 9.1 fixes, and the target's `input-serializer.test.ts` the 2.
- **Not run:** `pnpm test` at the root, and the target's and local-target's whole `bun test`, which start emulator daemons.
- **Manual QA steps 1 and 2** were run as written; their output is quoted in § 12.

## 14. Decisions this spec records, for the review

1. **The brand is a type-only property refused by an intersection on every object branch** (§ 3). A brand alone does not refuse anything: a type with an extra property is still assignable to an object type. So each binding type declares the brand's key optional, with a type the brand's `true` cannot fit. The dictionary also stops being a `Value`, which refuses it in `resolve()` and in every `Value<…>` branch with no further change. Design section 3 says `input` itself is not a value.
2. **The property's type is the message** (§ 3.1), as S8 did with `NotDeployTime`. TypeScript prints the target type of a failed assignment.
3. **A slot typed `unknown` or `any` is not refused by the compiler** (§ 2). Nothing is refused by `unknown`. Mapping `unknown` to "any data but the dictionary" was considered and not taken: it would catch only the top level, not the dictionary nested in an object or array under that slot, and `any` would still pass. Load refuses all of these.
4. **At run time the dictionary still carries the value brand, at path `[]`** (§ 2). That is how Load finds it in any binding and refuses it in one place, with one message. Making it answer no value brand would send it into Load's object walk, where `ownKeys` throws the misuse error "its keys were listed", and make `resolve()` throw its generic "is not a value" error instead of the designed one. So `isValue(input)` stays `true` at run time; the existing test that asserted it no longer does, because the design says `input` is not a value.
5. **One Load message for every module, with one more sentence for the root** (§ 4.1). The design asks for one error that says to pass the fields by name. The root's sentence is the reason its input matters most, and the old root message carried it.
6. **The example field in the advice is `input.from`** (§ 6), a generic name, because Load cannot list a schema's keys and so cannot name a real field.
7. **The misuse and `readPath` advice change** (§ 4.2, § 4.3). Both advised `resolve([input], …)`, which this slice refuses. No plan line names them, but leaving them would have the framework give advice that fails.
8. **ADR-0061 is rewritten in full, not amended** (§ 7.1), following Will's instruction for decision records and the ADR-0062 precedent. Its six amendment notes are folded in. The rewrite uses "the app configuration", the design's term, though the code says "config pool" until S12 and ADR-0062 says "the configuration".
9. **`ParamBindings` and `resolve()` are not changed** (§ 3.3). They already refuse the dictionary once it is not a `Value`; test 9 shows it.
10. **Tests that forwarded a whole input only as a fixture now pass named fields** (§ 9.1). What those tests check, a source or a pointer reaching a service through a module, does not depend on forwarding the whole input.
11. **No `.drive/deferred.md` entry.** Nothing is deferred beyond what § 15 reports.

## 15. What the design does not say, found while checking it against the code

1. **"Every binding type refuses" the brand holds only where the binding has a type.** A child module or a field whose schema is typed `unknown` or `any` accepts the whole `input` at compile time, and so will a service whose schema has no type information once S10 types service bindings from schemas. Load refuses all of these. The design's "a field typed `unknown`" caveat for `resolve()` applies here too, but section 3 does not say so. This spec says so in the docs (§ 7.4) and the decision record (§ 7.1). For the orchestrator: the design text could gain the same caveat.
2. **For a service binding, the type error does not show the message.** `provision()` has four overloads, and TypeScript reports the last one, the module overload, for a failed service call: `Argument of type 'ServiceNode<…>' is not assignable to parameter of type 'ModuleNode<…>'`. It still fails to compile. `resolve()`'s error says the dictionary lacks `[VALUE]` and `[VALUE_ORIGIN]`, and a resource prop's names the index signature. Only a module child's error ends with the message, and only when its keys match. S10 rewrites the service overloads and could make that error clearer; this spec does not.
3. **The plan says nothing about the misuse and `readPath` advice** that pointed at `resolve([input], …)` (§ 14, decision 7). This spec changes both.
4. **ADR-0062 already describes this slice's behaviour** ("Passing the whole `input` where a value is accepted fails to compile"), written before the code did. It needs no edit.
