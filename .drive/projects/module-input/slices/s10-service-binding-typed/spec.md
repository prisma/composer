# S10 — A service's binding is typed from its schema

Parent: [module-input spec](../../spec.md) and [plan](../../plan.md). Design: [design.md](../../design.md), which is authoritative; this slice builds section 3 "A service's binding", requirement 4 of section 2 for services, the section 10 item "A service binding's loose type, `InputBinding`", and the section 12 reversal "A service's binding is also now typed from its schema". Decisions: the service input decision ([ADR-0042](../../../../../docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md)) and the module boundary decision ([ADR-0016](../../../../../docs/design/90-decisions/ADR-0016-a-module-has-the-same-boundary-as-a-service.md)). It builds on branch `claude/module-input-s9`, which holds S9, open as prisma/composer#412. S10 is added to the same branch and the same pull request.

This spec leaves nothing to the implementer's judgement. Every type, signature, name, error message, file, test, document edit and commit is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose. § 16 lists the decisions this spec takes, and § 17 what it found that the design does not say.

Every code change and test in § 3 to § 6 and § 11 was applied in a scratch copy of this branch, with TypeScript 6.0.3, ArkType 2.2.7 and Zod 4.4.3; § 15 lists what ran and what passed.

Read for this spec: `CLAUDE.md`; `docs/design/01-principles/`; `design.md` (all); `plan.md`; `spec.md`; `deferred.md`; the S9 slice spec; ADR-0016, ADR-0042, ADR-0061, ADR-0062 and ADR-0063 in full; the glossary entries Input, Value, RuntimeValue and `field()`; `module-composition.md` and `config-params.md`; `.agents/rules/user-facing-surface-changes.mdc`; `skills/README.md`; and the code each section names.

## 1. At a glance

```ts
const relayService = compute({
  name: 'relay',
  deps: {},
  build: node({ module: import.meta.url, entry: 'relay.mjs' }),
  input: type({ from: field(type('string')), host: 'string', deliveryCredential: secretString() }),
});

module('shop', ({ provision }) => {
  provision(relayService, {
    input: { from: serviceOrigin('shop.web'), host: 'mail.example.com', deliveryCredential: envSecret('KEY') },
  }); // compiles
  provision(relayService, {
    id: 'two',
    input: {
      from: envSecret('FROM'),           // fails to compile: a secret in a wrapped text field
      host: serviceOrigin('shop.web'),   // fails to compile: a runtime value in a plain field
      deliveryCredential: envSecret('KEY'),
    },
  });
});
```

Before this slice both calls compiled: a service's binding had one loose type, `InputBinding`, which took any source in any key. The second call failed only at deploy. Now a service's binding is typed from the service's schema with the mapping a module's binding already used, so it fails to compile.

A module's whole `input` passed into a service's binding now shows S9's message, where before it showed `ServiceNode … is not assignable to … ModuleNode`:

```text
error TS2769: No overload matches this call.
  The last overload gave the following error.
    …
          Types of property '[MODULE_INPUT]' are incompatible.
            Type 'true' is not assignable to type '"the whole input of a module is not a value; pass its fields on by name"'.
```

## 2. The model

- **One binding type for modules and services.** `InputBinding<T>` is what `provision(node, { input })` accepts where the node's schema expects `T`, its Standard Schema input type. It is the mapping S2 to S9 called `ModuleInputBinding<T>`, renamed, with two changes: a `Pointer` is a leaf that no literal fills, and an array no longer takes its element type's literals unchecked. `InputBindingOf<I>` is `InputBinding<StandardSchemaV1.InferInput<NonNullable<I>>>`, the binding of a node whose schema is `I`. The loose `InputBinding` and `InputBindingData` go.
- **What a leaf takes.** For a field typed `T`, a binding takes a `Value<T>`, such as a module's field of the same type, a `resolve()` result, `envParam()` for text, or a runtime value whose pointer `T` admits. Beside a value: for `SecretString`, a `SecretSource` (a target's secret source, such as a raw `secretSource()`), never a `SecretBox`; for `Pointer<…>`, nothing, so no pointer is written as a literal; for an array, an array of bindings of its element; for a plain object, an object of bindings of its keys, which refuses a module's whole `input` (S9); for anything else, the literal `T`.
- **So the design's cases fail to compile.** A wrong literal; an `envSecret()` in a plain or wrapped text field, because `Pointer<SecretString>` is neither text nor `Pointer<string>`; a `serviceOrigin()` or plain `generatedParam()` in a plain field, because `Pointer<string>` is not text; a `serviceOrigin()` in a `secretString()` field; a `SecretBox` or a pointer written in the code; and an `envParam()`, which may hold any text, in a field of a narrower type.
- **A schema without type information takes any binding.** `InputBinding<unknown>` is `unknown`. The deploy check catches what the compiler cannot see, as S7 built it, and Load still refuses a module's whole `input` (S9). This is the limit S9 recorded for modules.
- **The deferred S9 items are closed.** An object field with a wrapped leaf binds into a service's binding, because `InputBinding<T>` maps the field's type instead of requiring loose data. A field may be a service's whole binding, `input: input.smtp`: the top level of `InputBinding<T>` takes a `Value<T>`, and Load and the serializer already handle it (tests 9 and 12). A module's whole `input` in a service's binding shows the message, because the last `provision()` overload is now one generic overload for services and modules, and TypeScript reports the last overload's error.
- **The `provision()` overloads.** Eight, in this order: the resource overload; the two primary overloads, one for a service and one for a module, typed with `InputBindingOf<I>`, which infer the node's type parameters separately, so a generic wrapper without `deps` resolves; two service overloads and two module overloads with `deps` written out, for generic wrappers such as `cron()`, of which one requires `input` and the other, for a node without an input schema, refuses it; and one overload for every service and module, `provision<N extends ServiceNode | ModuleNode>(node: N, ...args: ProvisionArgs<N>)`, declared last. TypeScript reports the last overload's error when more than three overloads apply, so a failed service or module call reports the generic overload's error, which names the binding key that does not fit or shows S9's message. Placing the service overload last instead would have hidden the module's message, which S9 shows. (Changed by the review fixes, § 18.)
- **`service.input()` does not change.** It already returns the schema's output with every pointer removed (S7, `InputValueOf<I>`), and `mockService()`'s input double has the same type. `field.test-d.ts` already pins both.
- **Deploy output does not change.** No input document, stack file or deploy report changes. The auth example's delivery mode moves from `envParam('EMAIL_DELIVERY_MODE')` to a root input field reading the same configuration value, which reaches the service's input document as the same text.

## 3. Core

### 3.1 `packages/0-framework/1-core/core/src/node.ts`

1. The block from the doc comment `/** What a value in a service's input binding may stand for: …` through the end of `type ModuleInputOf<I …> = StandardSchemaV1.InferInput<\n  NonNullable<I>\n>;`, that is `InputBindingData`, `InputBinding`, `ModuleInputBinding` and `ModuleInputOf` with their doc comments, becomes:

   ```ts
   /**
    * What `provision(node, { input })` accepts, for a module or a service, where
    * the node's input schema expects `T` (its Standard Schema input type): the
    * data, a value standing for it, or, for a `SecretString` field, a secret
    * source. A `SecretString` or a `Pointer` is never written as a literal. An
    * optional key also takes a value that may stand for `undefined`.
    */
   export type InputBinding<T> =
     | Value<T>
     | (T extends Pointer<unknown>
         ? never
         : T extends SecretString
           ? SecretSource
           : T extends readonly (infer E)[]
             ? readonly InputBinding<E>[]
             : T extends { readonly [key: string]: unknown }
               ? {
                   readonly [K in keyof T]:
                     | InputBinding<T[K]>
                     | (Record<never, never> extends Pick<T, K> ? Value<T[K] | undefined> : never);
                 } & NotModuleInput
               : T);

   /** What `provision()` accepts as the `input` of a node whose input schema is `I`. */
   export type InputBindingOf<I extends StandardSchemaV1 | undefined> = InputBinding<
     StandardSchemaV1.InferInput<NonNullable<I>>
   >;
   ```

2. In `ServiceProvisionArgs`, both `input: InputBinding;` become `input: InputBindingOf<I>;`.
3. In `ModuleProvisionOptions`, `{ input: ModuleInputBinding<ModuleInputOf<I>> }` becomes `{ input: InputBindingOf<I> }`.
4. Directly after `ModuleProvisionArgs` and before `export interface ModuleBuilder`:

   ```ts
   /** The options `provision()` takes after a service or module node `N`. */
   type ProvisionArgs<N> =
     N extends ServiceNode<infer D, infer P, Expose, infer I>
       ? ServiceProvisionArgs<D, I, ParamBindings<P>>
       : N extends ModuleNode<infer D, Expose, infer I>
         ? ModuleProvisionArgs<D, I>
         : never;

   /** The contracts a service or module node `N` exposes. */
   type ExposeOf<N> =
     N extends ServiceNode<Deps, Params, infer E, StandardSchemaV1 | undefined>
       ? E
       : N extends ModuleNode<Deps, infer E, StandardSchemaV1 | undefined>
         ? E
         : never;
   ```

5. `ModuleBuilder` becomes, in full (as changed by the review fixes, § 18):

   ```ts
   export interface ModuleBuilder {
     /** Provisions an owned resource; its id defaults to the node's `name`. */
     provision<C extends AnyContract | undefined>(
       resource: ResourceNode<C>,
       opts?: { id?: string },
     ): { readonly id: string } & (C extends AnyContract ? RefPort<C> : Record<never, never>);
     /** Registers an owned service; … */
     provision<D extends Deps, P extends Params, E extends Expose, I extends StandardSchemaV1 | undefined>(
       service: ServiceNode<D, P, E, I>,
       ...args: ServiceProvisionArgs<D, I, ParamBindings<P>>
     ): ProvisionedRef<E>;
     /** Registers an owned child module; … */
     provision<D extends Deps, E extends Expose, I extends StandardSchemaV1 | undefined>(
       child: ModuleNode<D, E, I>,
       ...args: ModuleProvisionArgs<D, I>
     ): ProvisionedRef<E>;
     /** The service call with `deps` written out, for a generic wrapper such as `cron()`. */
     provision<D extends Deps, P extends Params, E extends Expose, I extends StandardSchemaV1 | undefined>(
       service: ServiceNode<D, P, E, I>,
       opts: { id?: string; deps: DepBindings<D>; input: InputBindingOf<I>; params?: ParamBindings<P> },
     ): ProvisionedRef<E>;
     provision<D extends Deps, P extends Params, E extends Expose>(
       service: ServiceNode<D, P, E, undefined>,
       opts: { id?: string; deps: DepBindings<D>; input?: never; params?: ParamBindings<P> },
     ): ProvisionedRef<E>;
     /** The child-module call with `deps` written out. */
     provision<D extends Deps, E extends Expose, I extends StandardSchemaV1 | undefined>(
       child: ModuleNode<D, E, I>,
       opts: { id?: string; deps: DepBindings<D>; input: InputBindingOf<I> },
     ): ProvisionedRef<E>;
     provision<D extends Deps, E extends Expose>(
       child: ModuleNode<D, E, undefined>,
       opts: { id?: string; deps: DepBindings<D>; input?: never },
     ): ProvisionedRef<E>;
     /** Any service or child module. Declared last, so a call no overload accepts reports this overload's error. */
     provision<N extends ServiceNode | ModuleNode>(
       node: N,
       ...args: ProvisionArgs<N>
     ): ProvisionedRef<ExposeOf<N>>;
   }
   ```

No other line of `node.ts` changes. `Pointer`, `SecretString` and `SecretSource` are already imported or declared in the file.

### 3.2 `packages/0-framework/1-core/core/src/graph-types.ts`

1. The import from `./node.ts` becomes `import type { DependencyEnd, ModuleNode, ResourceNode, SecretSource, ServiceNode } from './node.ts';`.
2. In `ServiceInputBinding`, `readonly binding: InputBinding;` becomes `readonly binding: unknown;`. The review fixes (§ 18) rename the type `InputBindingUse` and rewrite its doc comment. The binding is recorded data that the target walks; no type describes every service's binding.

### 3.3 `packages/0-framework/1-core/core/src/load-module.ts`

In `flatten`, the block

```ts
        inputBindings.push({
          serviceAddress: fullAddress,
          binding: blindCast<
            ServiceInputBinding['binding'],
            'the provision overloads type the binding as InputBinding; the collector receives it untyped'
          >(provisionInput),
        });
```

becomes `        inputBindings.push({ serviceAddress: fullAddress, binding: provisionInput });`. The cast is no longer needed, because the field is `unknown`.

### 3.4 `packages/0-framework/1-core/core/src/exports/index.ts`

In the type export from `../node.ts`, `  InputBindingData,` becomes `  InputBindingOf,`, and the line `  ModuleInputBinding,` is removed. `InputBinding` stays exported, now generic. `@prisma/composer` re-exports all of `@internal/core`, so these are public changes (§ 10).

## 4. Prisma Cloud target: `packages/1-prisma-cloud/1-extensions/target/src/testing.ts`

1. In the type import from `@internal/core`, `  InputBinding,` becomes `  InputBindingOf,`, and after that import: `import type { StandardSchemaV1 } from '@standard-schema/spec';`. The package already depends on `@standard-schema/spec`.
2. `BootstrapConfig` becomes:

   ```ts
   export interface BootstrapConfig<
     I extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
   > extends Config {
     readonly input?: InputBindingOf<I>;
   }
   ```

3. `bootstrapService`'s signature becomes:

   ```ts
   export async function bootstrapService<
     D extends Deps,
     P extends Params,
     E extends Expose,
     I extends StandardSchemaV1 | undefined,
   >(
     service: RunnableServiceNode<D, P, E, I>,
     config: BootstrapConfig<I>,
     boot?: () => Promise<void>,
   ): Promise<BootstrappedService> {
   ```

   Its body and doc comments do not change.

## 5. Shared modules

### 5.1 `packages/1-prisma-cloud/2-shared-modules/cron/src/module.ts`

1. The first type import becomes `import type { Deps, InputBindingOf, ModuleNode, Params, ServiceNode } from '@internal/core';`.
2. `RunnerInput` becomes:

   ```ts
   type RunnerInput<I extends ServiceNode['inputSchema']> = I extends undefined
     ? { input?: never }
     : { input: InputBindingOf<I> };
   ```

3. In the body, `    const runner = provision(opts.runner, {` becomes:

   ```ts
       const runnerNode: ServiceNode<RD, RP, { trigger: TriggerContract }> = opts.runner;
       const runner = provision(runnerNode, {
   ```

   The review fixes (§ 18) replace the conditional spread of `opts.input` with `input: opts.input`, so the call matches the overload that requires `input`.

   The widening is needed: inside `cron()`, `opts.input` reads as `unknown`, because `InputBindingOf<I>` of an unbound `I` resolves to `InputBinding<unknown>`. Widened to the default schema type, the runner's binding is `unknown` too, so `opts.input` fits it. The caller's binding is still checked against the runner's schema, at the `cron({ … })` call.

### 5.2 `packages/1-prisma-cloud/2-shared-modules/email/src/email-module.ts`

`  deliveryMode: field(type('string')),` becomes `  deliveryMode: field(type("'resend'|'smtp'|'none'")),`. The review fixes (§ 18) build both schemas from the exported `emailDeliveryModes` instead: `field(type.enumerated(...emailDeliveryModes))`.

The email service's schema declares `deliveryMode: field(type("'resend'|'smtp'|'none'"))`. With the service's binding typed, the module's `input.deliveryMode`, a `Value<string | Pointer<string>>`, no longer fits it: any text would fail the service's schema at deploy. So the module declares the same three values. An `envParam()` may hold any text, so it no longer binds to `deliveryMode` (§ 10, item 4).

## 6. Example: `examples/auth/module.ts`

The file becomes, in full:

```ts
import { module } from '@prisma/composer';
import { envParam, envSecret, serviceOrigin } from '@prisma/composer-prisma-cloud';
import { auth } from '@prisma/composer-prisma-cloud/auth';
import { email } from '@prisma/composer-prisma-cloud/email';
import { postgres } from '@prisma/composer-prisma-cloud/orm';
import { type } from 'arktype';
import apiService from './src/api/service.ts';
import { appContract } from './src/contract.ts';
import opsService from './src/ops/service.ts';

/**
 * The auth example: a database carrying only the auth extension pack, the
 * `auth()` module wired to it, and the `email()` module as auth's email
 * dependency. `api` holds the `api` and `session` ports and the verifier; `ops`
 * holds `admin` and the smoke's read-only outbox. `baseUrl` is the api
 * service's public origin. The email module's delivery mode comes from the
 * root's input and its sender from envParam(), both read from the config
 * adapters in prisma.config.ts; the root's schema checks the delivery mode
 * before anything is created. The credential is required even in `none` mode.
 */
export default module(
  'auth-example',
  { input: type({ EMAIL_DELIVERY_MODE: "'resend' | 'smtp' | 'none'" }) },
  ({ input, provision }) => {
    const db = provision(
      postgres({ name: 'database', contract: appContract, config: './prisma.config.ts' }),
      { id: 'database' },
    );
    const mail = provision(email(), {
      id: 'mail',
      input: {
        deliveryMode: input.EMAIL_DELIVERY_MODE,
        from: envParam('EMAIL_FROM'),
        deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
      },
    });
    const identity = provision(auth(), {
      id: 'auth',
      deps: { db, email: mail.send },
      input: { baseUrl: serviceOrigin('auth-example.api') },
    });
    provision(apiService, {
      id: 'api',
      deps: { authApi: identity.api, verifier: identity.api, session: identity.session },
    });
    provision(opsService, { id: 'ops', deps: { admin: identity.admin, outbox: mail.outbox } });
  },
);
```

The review fixes (§ 18) declare `EMAIL_DELIVERY_MODE` as `type.enumerated(...emailDeliveryModes)`, imported from `@prisma/composer-prisma-cloud/email`.

The example already depends on `arktype`, and its `prisma.config.ts` already lists `dotenv()` and `environmentVariables()` as config adapters, and its `.env.example` sets `EMAIL_DELIVERY_MODE=none`. `examples/auth/tests/module.test.ts` already passes `EMAIL_DELIVERY_MODE` in `configPool` and does not change. The example keeps `serviceOrigin()` and `envParam()` inside `input`, as design section 10 says.

## 7. What breaks, and what does not

Breaks, each shown in the release note (§ 10):

1. A service binding that type-checked only because of the loose type: a wrong literal, an `envSecret()` in a plain or wrapped text field, a `serviceOrigin()` or plain `generatedParam()` in a plain or `secretString()` field, a `SecretBox`, an `envParam()` in a field narrower than text, a missing required key, or a key the schema does not declare.
2. A pointer written as a literal in any binding, a module's included. A module's binding took one before.
3. The types: `InputBinding` takes a type parameter; `ModuleInputBinding` is renamed `InputBinding`; `InputBindingData` is removed; `InputBindingOf<I>` is new; `ServiceInputBinding` is renamed `InputBindingUse`, and its `binding` is `unknown`; `BootstrapConfig` takes the schema's type and `bootstrapService()`'s `input` is typed from the service's schema; `ModuleBuilder['provision']` has eight overloads, of which the last is generic over the node.
4. `email()`'s `deliveryMode` is `'resend' | 'smtp' | 'none'`, exported as `emailDeliveryModes` and `EmailDeliveryMode`: an `envParam()` or a field typed as text no longer binds to it.
5. A service or module that declares both dependencies and an input schema, provisioned without `input`, fails to compile. Before, it compiled and Load refused it. A generic wrapper must pass `input` whenever its node's type may declare a schema.

Unchanged:

1. Every binding in the repo outside the tests and files § 5, § 6 and § 11 name. `pnpm turbo run typecheck test:types` passed on all 84 tasks after only those edits: every example, every shared module, the integration tests' package and the website.
2. What Load and the deploy do. No runtime code changes except the removed cast (§ 3.3), so every graph, input document, stack file and deploy report is the same for the same app.
3. `service.input()`'s type and `mockService()`'s input double.
4. The messages of S9's Load errors.

The only existing tests this slice changes are listed in § 11.1. If any other existing test fails, the implementer stops and reports.

## 8. Compile errors, verbatim

What `tsc` prints for the QA file of § 14 (paths shortened to the file name):

```text
src/s10-qa.ts(21,29): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'ModuleInput<Type<{ from: string | Pointer<string>; host: string; deliveryCredential: SecretString | Pointer<SecretString>; }, {}>>' is not assignable to type 'InputBindingOf<Type<{ from: string | Pointer<string>; host: string; deliveryCredential: SecretString | Pointer<SecretString>; }, {}>>'.
      Type 'ModuleInput<Type<{ from: string | Pointer<string>; host: string; deliveryCredential: SecretString | Pointer<SecretString>; }, {}>>' is not assignable to type '{ readonly from: InputBinding<string | Pointer<string>>; readonly host: InputBinding<string>; readonly deliveryCredential: InputBinding<SecretString | Pointer<...>>; } & NotModuleInput'.
        Type 'ModuleInput<Type<{ from: string | Pointer<string>; host: string; deliveryCredential: SecretString | Pointer<SecretString>; }, {}>>' is not assignable to type 'NotModuleInput'.
          Types of property '[MODULE_INPUT]' are incompatible.
            Type 'true' is not assignable to type '"the whole input of a module is not a value; pass its fields on by name"'.
src/s10-qa.ts(35,7): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>' is not assignable to type 'InputBinding<string | Pointer<string>>'.
```

and a third error at `(36,7)` whose chain ends `Type 'ParamSource<OriginParamPayload> & RuntimeValue<string>' is not assignable to type 'InputBinding<string>'.` and `Type 'Pointer<string>' is not assignable to type 'string'.` TypeScript joins the chains of the two errors on lines 35 and 36 in its output; the line and column numbers and the first and last lines of each chain are what QA compares. No new error message is written in code: these are TypeScript's.

## 9. Documentation

All in the same pull request (`.agents/rules/user-facing-surface-changes.mdc`). Each edit replaces the quoted text exactly; `\n` marks a line break in the quoted original. Every replacement is written without hard wraps: one paragraph or one list item per line.

### 9.1 The service input decision, rewritten as one current record

`docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md` is replaced in full by the text between the two `~~~` lines. Its four amendment notes are folded in: modules take secrets as input fields (fifth slice), `field()` and `secretString()` with pointers (sixth), pointers at deploy and the ArkType copy check (seventh), and this slice's typed binding. The reversed positions, opaque stand-ins at deploy and a loosely typed binding, move to "Alternatives considered".

~~~markdown
# ADR-0042: Service input is one Standard Schema, and the binding is typed from it

```ts
// service.ts: the service declares what shapes are legal, in its own schema library
import { field, secretString } from '@prisma/composer/zod';
import { compute } from '@prisma/composer-prisma-cloud';
import { z } from 'zod';

const chatInput = z.discriminatedUnion('stripeEnabled', [
  z.object({ stripeEnabled: z.literal(false), returnUrl: field(z.string()) }),
  z.object({ stripeEnabled: z.literal(true), returnUrl: field(z.string()), stripeSecretKey: secretString() }),
]);

export default compute({ name: 'chat', input: chatInput, deps: { /* … */ }, build });
```

```ts
// module.ts: whoever provisions the service binds where each value comes from
provision(chatService, {
  input: {
    stripeEnabled: true,
    returnUrl: serviceOrigin('shop.web'),
    stripeSecretKey: envSecret('STRIPE_SECRET_KEY'),
  },
});
```

```ts
// anywhere in the service: one call, one inferred type, narrowing included
const input = chatService.input();
if (input.stripeEnabled) stripe(input.stripeSecretKey.expose());
```

## Decision

A compute service declares all of its incoming configuration, plain values and secrets together, as **one [Standard Schema](https://standardschema.dev)** (Zod, ArkType or any conforming library), `input`, and reads it back through **one typed accessor**, `service.input()`. Whoever provisions the service binds that input with `provision(service, { input: { … } })`. Dependencies stay separate: they are declared with `deps` and read through `service.load()`. The reserved `port` param is read through `service.port()`.

- **Secret fields** are typed `secretString()`. **A leaf field that may receive a value known only at boot**, such as another service's origin, is wrapped in `field()`. `@prisma/composer/arktype` and `@prisma/composer/zod` export both helpers. For any other library, `@prisma/composer` exports the `Pointer` type, `isPlainPointer()`, `isSecretPointer()` and `isSecretString()`, from which an author writes the same two helpers.
- **The binding** mirrors the schema's shape. Each leaf is a literal, a value such as a `resolve()` result or a module's input field ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), or a source: `envParam()`, `envSecret()`, `generatedParam()` or `serviceOrigin()`, each of which is a value too.
- **The binding is typed from the schema's input type**, with the same mapping a module's binding uses ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)). So a wrong literal, an `envSecret()` in a text field, or a `serviceOrigin()` in a plain field fails to compile.
- **The deploy checks the binding with the schema** before anything is created, with each value known only at boot in place as its pointer, and writes the schema's output into one input document.
- **At boot** `service.input()` reads that document, puts each secret in a redacting box, checks the result with the schema again, and returns it.

## The binding's type

`InputBinding<T>` is what a binding accepts where the schema expects `T`. A leaf of type `T` takes a value of type `T`, or the literal `T`. Two kinds of leaf take no literal. A `SecretString` field takes a secret runtime value, such as `envSecret()` or a redacted `generatedParam()`, or a module's secret field passed on: a secret box written in a binding fails to compile, because a secret's value never sits in the code. A pointer is never written as a literal either: a field wrapped with `field()` takes `serviceOrigin()` or a plain `generatedParam()`, whose values are typed `RuntimeValue<string>`, which is `Value<Pointer<string>>`. A plain field takes neither kind of runtime value, and `envParam()`, whose value is text, fits only a field that accepts any text.

`InputBindingOf<I>` is the binding of a node whose input schema is `I`. `provision()` takes it for a service and for a module, so the two look the same to whoever provisions them, as the module boundary decision asks ([ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md)). A schema without type information has the input type `unknown`, and its binding takes anything; the deploy check below still applies.

## The deploy check

The deploy resolves the binding. A literal stays as written. A deploy-time value becomes its real value: `envParam('NAME')` reads `NAME` from the configuration that the `config` adapters return ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), and an unset or empty `NAME` leaves the key out. A value known only at boot becomes a **pointer**, an object that names the platform variable holding the data and records its kind: a secret pointer for `envSecret()` and a redacted `generatedParam()`, a plain pointer for `serviceOrigin()` and a plain `generatedParam()`.

The schema then checks the resolved binding, synchronously; a schema that returns a promise fails the deploy. `secretString()` accepts a secret box or a secret pointer. A wrapped field accepts what its inner schema accepts and a plain pointer. A plain field accepts neither pointer. So a plain field bound to `serviceOrigin()` fails the deploy with that field's own message, which catches a binding the compiler could not see: a schema without type information, or a cast. A schema may check a pointer but never replace it or move it to another field.

A schema may return a copy of a pointer: ArkType copies its input when a transform runs anywhere in it, a wrapped field's included, and when it deletes undeclared keys. The copy keeps the pointer's brand and the variable it names, so the deploy recognises a pointer by those, never by object identity. A copied secret box, though, loses its value, so a service whose binding holds a secret pointer is checked a second time, with a stand-in box holding a known text in place of each secret pointer. If a box in the output no longer gives back that text, the deploy refuses the service, naming the field and saying that the schema copies its input. A Zod schema keeps the box when it transforms. A schema whose output holds a secret box its binding did not supply, such as a default, is refused too: no platform variable stands behind it.

## The input document

The deploy writes the schema's output, with defaults applied, into one environment row per service, `COMPOSER_<address>_INPUT`. Each pointer is written as a marker. A secret pointer from `envSecret()` becomes `{"$secret": "<VARIABLE>"}`, naming the operator's platform variable, which preflight checks exists. A `generatedParam()` and a `serviceOrigin()` become `{"$generated": "<VARIABLE>", "redacted": <true|false>}`, naming a variable in Composer's reserved `COMPOSER_` namespace that the deploy fills: with a value it generates once and keeps in deploy state, or with the other service's public origin. A marker records `redacted` because boot cannot ask the schema which fields are secret.

```json
{
  "stripeEnabled": true,
  "returnUrl": { "$generated": "COMPOSER_SHOP_CHAT_RETURNURL_GENERATED", "redacted": false },
  "stripeSecretKey": { "$secret": "STRIPE_SECRET_KEY" }
}
```

No secret's value and no generated value appears in the document, so the deploy report prints it verbatim, with every key that resolved absent. A user key spelled like a marker, such as `$secret` or `$generated`, gains one more leading `$` when written and loses it when read, so only Composer can place a marker. Every variable a service's markers name must be distinct once normalised, or the deploy fails naming both input paths. The document is JSON, so the schema's output must be plain objects, arrays, text, numbers, booleans, null and secret boxes. A schema that outputs a `Date`, a `BigInt` or another class instance is outside this contract; keep the field as text and convert it in the service.

At boot `service.input()` reads the one row, replaces each `$secret` marker with a box over the named variable and each `$generated` marker with a box or text as its `redacted` says, checks the result with the schema, and returns the schema's output. Its type is the schema's output type with every pointer removed, at any depth, because at boot each pointer has been replaced by the variable's text: a wrapped field reads as its inner type, and a `secretString()` field as `SecretString`. `mockService()`'s input double has the same type.

An `envParam()` field whose variable is unset or empty is a key left out, and whether that is allowed is the schema's call: an optional field, a union member, or an error with the schema's message. So an optional secret, or a field that exists only when another field is set, is an ordinary schema, with no flag of Composer's.

## Reasoning

**Legality is relational, and Composer should not invent a language for it.** A real service has inputs such as "no `stripeSecretKey` unless `stripeEnabled`". Per-key declarations cannot say that; a schema library says it with a union, and gives the service narrowing for free. Composer adopts the schema libraries the app already uses instead of growing its own.

**Composer never looks inside the schema.** Standard Schema exposes one capability, `validate`, and leaves out introspection on purpose. A framework that walked Zod's or ArkType's internals would be tied to their private representations. So the two halves split the work: the binding is plain data Composer can walk, and the schema is a black box that judges it, at deploy and again at boot. The binding's type comes from the schema's input type, which every Standard Schema publishes, so typing the binding needs no introspection either.

**If it type-checks, it deploys.** The deploy check catches every binding the schema refuses, but late: after the author has run a deploy. Typing the binding from the schema moves those failures to the editor wherever the schema has types. The two checks agree because both come from the schema: the type from its input type, the deploy check from its `validate`. The deploy check stays, for a schema without types and for a cast.

**Secretness is a type, checked both ways.** A secret field is typed `SecretString`, and a secret source gives a secret pointer. Binding a plain literal or a plain pointer to a secret field fails, and binding a secret source to a text field fails, at compile time and at deploy. Neither the service's author nor the operator can misclassify a credential without the other side noticing.

**Pointers, not stand-ins.** The schema sees each value known only at boot as the pointer that names its variable. A wrapped field accepts a plain pointer and a plain field does not, so a field that would receive text only at boot must say so in its schema, and the deploy can tell. A schema cannot check a secret's content, because at deploy it sees a pointer; content checks on credentials Composer never reads are impossible by construction.

**One document, not per-key rows.** Flattened key names collide (`stripe_secret` the key against `stripe.secret` the path), cannot express union members or nesting, and require the boot side to know every key. A self-describing document needs none of that, and because it holds the schema's output with defaults applied, deploy and boot judge the same data.

## Consequences

- `compute()` takes `input`, one Standard Schema, and `provision()` takes one `input` binding typed `InputBindingOf<I>`. `service.input()` returns the checked input. The service-level `params` and `secrets` declarations and the `config()` and `secrets()` accessors are gone. The reserved `port` and `origin()` keep their own accessors.
- The type `InputBinding<T>` is shared by modules and services. A binding that would fail the deploy fails to compile, except where the schema has no type information.
- Errors about a binding's data are the schema library's own messages, at compile time as a type error and at deploy as the library's issue text.
- A schema that copies its input cannot hold a secret field in ArkType; the deploy refuses it and names the field.
- The deploy report prints each service's input document and every key that resolved absent.
- Composer's own per-service values, such as another service's URL wired as a dependency, still travel on per-key rows ([ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md)). Moving them into a document like this one is a separate decision.

## Alternatives considered

- **Introspect the schema** (walk Zod's or ArkType's internal nodes, or use per-library metadata). Rejected: it ties Composer to private internals and versions, and Standard Schema's authors excluded introspection on purpose.
- **A framework language for conditional configuration** (`secret({ when: … })`, conditional maps). Rejected: it reimplements a fraction of what schema languages do, and every app would have to learn it.
- **Per-key rows with key names rebuilt at boot**, the model before this decision. Rejected: boot would need to enumerate keys the schema cannot list, and nesting and union members cannot be expressed.
- **An `optional` flag on secret slots.** Rejected: it covers presence only, not conditions, and an optional field in the schema already says it.
- **Opaque stand-ins at deploy**, which an earlier version of this decision used: the schema saw a stand-in box for each secret and a stand-in string for each generated value. Rejected: a plain text field accepted the stand-in for `serviceOrigin()`, so the deploy passed a binding that the service could only read as text at boot, and the schema never learned which fields wait for a value known only at boot. Pointers make the schema say so.
- **A loosely typed binding**, which an earlier version of this decision used: one type that took any literal or source in any key, because the binding's exact shape seemed to need introspection. Rejected: a binding that type-checked could fail the deploy, and a service's binding looked different from a module's. The schema's input type gives the shape without introspection.

## Related

- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): a module declares its input the same way, and its binding has the same type.
- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md): a module has the same boundary as a service.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): values, runtime values and pointers, and the configuration `envParam()` reads.
- [ADR-0021](ADR-0021-params-are-read-through-config-not-load.md), superseded: `config()` is replaced by `service.input()`; dependencies still read through `load()`.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md), partly superseded: `envSecret()` survives as a binding leaf; the `secrets()` read and per-slot pointer rows are replaced.
- [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md), partly superseded: binding at `provision()` and `envParam()` survive; the `config()` read and per-key pointer rows are replaced.
- [ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md): Composer's own provider params, still on per-key rows.
- [config-params.md](../10-domains/config-params.md): the sources, and where each is accepted.
~~~

### 9.2 The module boundary decision, rewritten as one current record

`docs/design/90-decisions/ADR-0016-a-module-has-the-same-boundary-as-a-service.md` is replaced in full by the text between the two `~~~` lines. Its three amendment notes are folded in: the words of ADR-0063, the `input` of ADR-0061, and the removal of the module slots. This slice adds that one binding type serves both kinds of node. Its old example used `provision("auth", authModule)`, a signature that no longer exists; the new one uses today's.

~~~markdown
# ADR-0016: A module has the same boundary as a service

```ts
// the app's topology
import { auth } from '@acme/auth-module'; // a module, installed from npm
import { serviceOrigin } from '@prisma/composer-prisma-cloud';
import storefront from './storefront/service.ts';

export default module('shop', { expose: { web: storeContract } }, ({ provision }) => {
  const identity = provision(auth(), { input: { baseUrl: serviceOrigin('shop.storefront') } });
  const store = provision(storefront, { deps: { auth: identity.verify } });
  return { web: store.web };
});
```

`auth()` returns a module. `shop` provisions it exactly as it provisions the `storefront` service: the same `provision()` call, an `input` binding typed from the node's schema, and a reference whose exposed interfaces, such as `identity.verify`, wire into another node's dependencies.

## Decision

A module declares the same boundary a service does:

- **dependencies**, `deps`: typed slots, each wired to an interface another node exposes ([ADR-0063](ADR-0063-a-node-depends-on-an-interface-or-exposes-one.md));
- **exposed interfaces**, `expose`: the contracts the module offers, each returned by its body as a port of a node it provisions;
- **input**, `input`: its configuration, one Standard Schema, as a compute service's is ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md), [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).

`provision()` accepts a module wherever it accepts a service. It takes the same options, `deps` and `input`, each required exactly when the node declares it, and it returns the same `ProvisionedRef`, with one port per exposed interface. The `input` binding has one type for both kinds of node, `InputBindingOf<I>`, built from the schema's input type. So modules nest, and a consumer cannot tell a provisioned module from a provisioned service. The two differ only in what the framework can see: a service's body is a black box that boots, and a module's body is topology that runs at Load.

## Reasoning

**What this makes possible is installing a whole bounded context from a package.** In the example, `@acme/auth-module` deploys its own compute and owns its own data inside the app's topology, and everything reaches it through typed interfaces. The app never learns how many services it contains or what its database looks like. That is a reusable module: not a hosted service you call, and not a library you embed in your process, but a deployable component with a typed boundary.

**A module needs a boundary, and the model already has one.** A service declares dependencies and exposed interfaces, and `provision()` returns a reference with one typed port per exposed interface, which the wiring checks against the dependency it fills. Reusing that boundary for modules is the whole decision. It keeps wiring the same at every level of the tree, which is what lets composition compose: an enclosing module wires "a node with typed dependencies, exposed interfaces and input" without asking which kind of node it is.

**One binding type keeps the boundary the same for configuration too.** A module's input binding and a service's are typed from the schema by the same mapping. A binding that type-checks for a module with some schema type-checks for a service with that schema, and a binding the schema would refuse fails to compile for either. Replacing a service with a module that has the same schema, or the reverse, changes no binding.

**Forwarding is data flow, with no mechanism of its own.** The body is a function. It receives its dependencies as `deps`, its configuration as `input` and the environment's facts as `environment`, and passes them into the `provision()` calls that need them: they flow down by being passed. Its exposed interfaces are its return value: they flow up by being returned. Both directions are checked by the types and by the same contract check the flat wiring uses. An input field is a value, not data, so the body passes fields on by name and never reads them ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).

**The boundary makes a module replaceable by a fake.** A consumer depends on a contract, never on a module. The storefront above requires something that satisfies `identity.verify`'s contract, and the module that wires it decides what that is. Replace `auth()` with a one-service fake that exposes the same contract and the storefront does not change a line: a test topology is a different wiring file.

**Distribution follows from decisions already made.** A module package ships its services with their built runnables. Paths resolve relative to the file that writes them ([ADR-0004](ADR-0004-paths-resolve-relative-to-the-authoring-file.md)), so assembly finds output inside `node_modules/@acme/auth-module/` as it would in the app's own tree, and built output exists before deploy because the package was built when it was published ([ADR-0005](ADR-0005-users-build-the-framework-assembles.md)). The boot wrapper inlines each service's imports from that package's own dependencies ([ADR-0008](ADR-0008-wrapper-inlines-everything-except-runtime-builtins.md)). Version compatibility is the package manager's job: a module declares `@prisma/composer` packages as peer dependencies, and its declared range says that the reader code in its published runnables understands the input document the app's deploy writes.

**A module's build choices stay inside it.** A consuming app must not have to declare `@prisma/composer/nextjs` because a module it installed uses Next.js inside. How the deploy loads build adapters and targets is a separate decision ([ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md)); this one only states the requirement. The deploy target stays the application's own declaration, one per application ([ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)).

## Consequences

- The authoring surface is `module(name, { deps?, input?, expose? }, body)`. The body receives `{ deps, input, environment, provision }` and returns one port per declared exposed interface. A module with an empty boundary, also written `module(name, body)`, is the closed form a deploy root takes.
- `module()` refuses a `params` or `secrets` key, and `provision()` of a module refuses a `params` or `secrets` map, each with an error naming `input`. A module takes its configuration only through `input`; a service keeps its reserved `params`, such as `port`.
- Load checks the boundary, and each failure is a Load error that names its fix: a declared dependency the body neither passes on nor returns; a declared exposed interface the body does not return, or returns a port that does not satisfy; a root that declares dependencies, since nothing above it can wire them; and a dependency cycle. A declared input field the body never uses is not an error, because Load cannot list a schema's keys.
- Deploy addresses are hierarchical: a child's address is its parent's plus its provision id, and assembled bundles are keyed by the full address.
- The input document's format is public surface: a module published against a target freezes its reader code, so a format change is a breaking release of the target.
- A reusable module is written in one target's vocabulary, such as `@prisma/composer-prisma-cloud`'s, and deploys only to that target.
- Nothing about a module exists at runtime. Load flattens modules into the graph, and services remain the only things that boot.

## Alternatives considered

- **Modules stay root-only wiring scripts**, with no boundary. Rejected: a module that cannot be wired cannot be installed, faked or nested, so every application would inline the topology of everything it uses.
- **A separate "package" or "component" concept beside the module.** Rejected: a second boundary to learn, wire and check, duplicating what services already have.
- **Forwarding as declared mappings**, a table linking each dependency to a child and each child's port to an exposed interface. Rejected: it is easier to inspect, but it adds a wiring language where a function already serves, and the body still has to exist for `provision()`.
- **Per-key `params` and `secrets` slots on modules**, which an earlier version of the module boundary had. Rejected: a module would take configuration in a different shape from a service ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).
- **A typed binding for modules and a loosely typed one for services**, which an earlier version had. Rejected: the same binding would type-check for one kind of node and not the other, and a service binding that type-checked could still fail the deploy.
- **Naming the two ends of a connection "input" and "output"**, which an earlier version did. Rejected: two traditions give the same ends opposite names ([ADR-0063](ADR-0063-a-node-depends-on-an-interface-or-exposes-one.md)).

## Related

- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): a module's input.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): a service's input, and the binding type both share.
- [ADR-0063](ADR-0063-a-node-depends-on-an-interface-or-exposes-one.md): dependencies and exposed interfaces.
- [ADR-0013](ADR-0013-resources-are-provisioned-by-modules-deps-are-declarations.md): a resource reaches a dependency as the same contract-carrying reference a service's port does, so forwarding handles both.
- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md), [ADR-0004](ADR-0004-paths-resolve-relative-to-the-authoring-file.md), [ADR-0005](ADR-0005-users-build-the-framework-assembles.md), [ADR-0008](ADR-0008-wrapper-inlines-everything-except-runtime-builtins.md) and [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md): why an installed module deploys.
- [module-composition.md](../10-domains/module-composition.md): the full design of modules.
~~~

### 9.3 The decision index, `docs/design/90-decisions/README.md`

The README already states that each record is kept as one current record (S9). Only the two index lines change.

1. The whole ADR-0016 line, from `- [ADR-0016](` to the end of the line, becomes:

   ```markdown
   - [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md) — A module has the same boundary as a service: dependencies (`deps`), exposed interfaces (`expose`) and input (`input`, one Standard Schema). `provision()` accepts a module wherever it accepts a service, with the same options, an `input` binding of the same type, and the same returned reference, so modules nest and a consumer cannot tell the two apart. Forwarding is data flow through the body. A module has no `params` or `secrets` slots; reusable modules follow.
   ```

2. The whole ADR-0042 line, from `- [ADR-0042](` to the end of the line, becomes:

   ```markdown
   - [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) — A compute service declares its whole configuration, plain values and secrets together, as one Standard Schema (`input`), read back through `service.input()`. The binding at `provision()` is typed from the schema's input type, with the same type a module's binding has, so a wrong literal or a source in the wrong kind of field fails to compile. Secret fields are `secretString()`; a field that may receive a value known only at boot is wrapped in `field()`. The deploy checks the binding with the schema, each value known only at boot in place as a pointer, and writes one self-describing input document per service with `$secret` and `$generated` markers; boot reads it, boxes the secrets and checks it again. Composer never introspects the schema. An unset `envParam()` leaves its key out, and the schema decides whether that is allowed.
   ```

### 9.4 Glossary, `docs/design/03-domain-model/glossary.md`, the Input entry

The paragraph `A field typed \`secretString()\` takes only a secret: a secret box, or the\nsecret pointer of \`envSecret()\` or a redacted \`generatedParam()\`. A\n[wrapped field](#field) also takes a plain pointer, from \`serviceOrigin()\`\nor a plain \`generatedParam()\`. A plain field takes neither: at deploy a\nschema checks each value known only at boot as its pointer, so a plain\nfield bound to one fails the deploy.` becomes:

```markdown
A binding is typed from the schema's input type, for a Service as for a Module. In a binding, a field typed `secretString()` takes only a secret: the secret pointer of `envSecret()` or a redacted `generatedParam()`, or a module's own secret field passed on. A secret box written in a binding fails to compile, because a secret's value never sits in the code, and no pointer is ever written as a literal. A [wrapped field](#field) also takes a plain runtime value, from `serviceOrigin()` or a plain `generatedParam()`. A plain field takes neither, and a binding that gives it one fails to compile. Where the compiler sees no type, such as a schema without type information or a cast, the deploy checks each value known only at boot as its pointer, so a plain field bound to one fails the deploy.
```

### 9.5 `docs/design/10-domains/module-composition.md`

1. In the section `## \`provision()\` accepts modules`, everything from `A module overload mirrors the service forms:` through the end of the code block that follows it becomes:

   ````markdown
   One overload provisions a service or a module, with the same options for both:

   ```ts
   provision<N extends ServiceNode | ModuleNode>(
     node: N,
     ...args: ProvisionArgs<N>, // `deps` required when the node declares dependencies, `input` when it declares an input schema
   ): ProvisionedRef<ExposeOf<N>>;
   ```

   The `input` option has the type `InputBindingOf<I>`, the same for a service and a module: it is typed from the schema's input type, so a binding the schema would refuse fails to compile ([ADR-0042](../90-decisions/ADR-0042-service-input-is-one-standard-schema.md)). Two more overloads spell out `deps` and take `input` as optional, for a generic wrapper such as `cron()` whose node type is still a type parameter. The overload above is declared last, so a call no overload accepts reports its error, which names the binding key that does not fit.
   ````

   The paragraph after it, `The returned ref is indistinguishable from a provisioned service's. …`, stays.

### 9.6 `docs/design/10-domains/config-params.md`, § Sources are values

1. The table row `| A service's \`input\` binding | kept; read at serialize from the config pool | kept | kept | kept |` becomes:

   ```markdown
   | A service's `input` binding | its string, read at serialize from the config pool; unset or empty leaves the key out | its pointer, which a `secretString()` field accepts | its pointer: a `secretString()` field accepts it when redacted, a wrapped field otherwise | its pointer, which a wrapped field accepts |
   ```

2. The paragraph `In a service's and a module's input, the schema checks each of the three\nruntime sources as its pointer. A plain field refuses a pointer, so a field\nbound to \`generatedParam()\` or \`serviceOrigin()\` is wrapped with \`field()\`,\nor is a \`secretString()\` field for a redacted \`generatedParam()\`\n([glossary](../03-domain-model/glossary.md#field)).` becomes:

   ```markdown
   In a service's and a module's input, the schema checks each of the three runtime sources as its pointer. A plain field refuses a pointer, so a field bound to `generatedParam()` or `serviceOrigin()` is wrapped with `field()`, or is a `secretString()` field for a redacted `generatedParam()` ([glossary](../03-domain-model/glossary.md#field)). Both bindings are typed from the schema, so a source bound to a field that refuses it fails to compile, and so does an `envParam()` bound to a field narrower than text. The deploy check catches what the compiler cannot see: a schema without type information, or a cast.
   ```

### 9.7 The guide, `docs/guides/building-an-app.md`, § Binding the input at provision

1. The paragraph from `The service declares what shapes are legal; the place that provisions it` to `([below](#values-that-differ-per-environment)):` becomes:

   ```markdown
   The service declares what shapes are legal; the place that provisions it decides where each value comes from. The binding is a plain object mirroring the schema's shape whose leaves are literals, `envParam(...)`, `envSecret(...)`, or values from `resolve()` ([below](#values-that-differ-per-environment)). It is typed from the schema, as a module's binding is, so a binding the schema would refuse fails to compile:
   ```

2. The paragraph from `Secretness is enforced by validation, not annotation: binding a plain` to `misclassify a credential.` becomes:

   ```markdown
   Secretness is checked twice. The binding's type refuses a plain literal where the schema expects a `SecretString`, an `envSecret()` where it expects text, and a `SecretString` box written in the code, so each fails to compile. The deploy checks the binding with the schema too, so where the schema has no type information, or a cast hides the mistake, the deploy fails before anything is created. Neither side can silently misclassify a credential.
   ```

3. The paragraph from `**A field bound to \`serviceOrigin()\` or \`generatedParam({ redacted: false })\`` to `double in the same shape.` becomes:

   ```markdown
   **A field bound to `serviceOrigin()` or `generatedParam({ redacted: false })` is wrapped.** Their value exists only at boot, so at deploy the schema sees a pointer to the platform variable, and only a field wrapped with `field()`, from `@prisma/composer/arktype` (or `@prisma/composer/zod`), accepts it: `type({ returnUrl: field(type('string')) })`. Binding one to a plain `'string'` field fails to compile, in a service's binding as in a module's, and the deploy refuses it where the compiler cannot see the schema's types. A redacted `generatedParam()` is a secret, so its field is `secretString()`. In the service a wrapped field reads as its inner type: `service.input().returnUrl` is a `string`, because at boot the pointer has been replaced by the variable's text. `mockService()` takes the input double in the same shape.
   ```

4. The paragraph from `**\`envParam('NAME')\`** is for plain values the code *can't* know.` to `version, including a smoke script that proves the per-environment split.` becomes:

   ```markdown
   **`envParam('NAME')`** is for plain values the code *can't* know. An app origin is the canonical case: it's different on production and on every preview environment. The deploy reads the variable from the config pool: by default the shell that runs `prisma deploy` or `prisma dev`, or the `config` adapters you list ([Values from outside the code](#values-from-outside-the-code)), and writes its value into the service's input. So set it in that shell for every deploy; in CI, export it per environment. An unset or empty variable leaves the key out, and the schema decides ([below](#absence-is-the-schemas-call)). The value is text, so bind `envParam` to text fields. Binding it to a field of a narrower type, such as `'resend' | 'smtp' | 'none'`, fails to compile, because the variable may hold any text: declare that field in your root's `input` with the same type instead, and the root's schema checks the variable before anything is created. To change the value, deploy again with the new value. [`examples/env-param`](../../examples/env-param/) is the minimal working version, including a smoke script that proves the per-environment split.
   ```

### 9.8 The agent skill, `skills/prisma-composer-core-concepts/SKILL.md`, § Two channels

Written to `skills/README.md`'s requirements: every claim here is checked against the code of § 3 to § 5.

1. Item 1, from `1. **Secretness is enforced by validation.** A literal bound where the schema` to `keeps the box.`, becomes one line:

   ```markdown
   1. **Secretness is checked by the binding's type and by the deploy.** A `provision()` binding, a service's or a module's, is typed from the schema: a literal or a `SecretBox` where the schema expects `SecretString`, or `envSecret` in a text field, fails to compile, and the deploy refuses it where the schema has no types. An ArkType schema with a `SecretString` field cannot also transform its input: a morph anywhere in it (`'string.trim'`, `.pipe()`, `field(type('string.integer.parse'))`) or `'+': 'delete'` copies the input, the copied secret loses its value, and the deploy refuses it. Transform in the service code instead; a Zod schema keeps the box.
   ```

2. Item 2, from `2. **\`envParam\` values arrive as raw strings**; bind them to string fields. In` to `name (the deploy fails early, naming the variable, when both lack it).`, becomes one line: `2. **\`envParam\` values arrive as raw strings**; bind them to string fields. A field of a narrower type, such as \`'none' | 'smtp'\`, refuses \`envParam\` at compile time; declare that field in the root's \`input\` instead. In a service's \`input\`, the deploy reads the variable from the config pool on every deploy and writes its value into the input document. As a service param, the deploy writes a pointer row to a platform variable, which the service reads at boot. \`envSecret\` always lives on the platform: each environment keeps its own copy, and the secrets pool only seeds a missing name (the deploy fails early, naming the variable, when both lack it).`
3. Item 7, from `7. **A field bound to \`serviceOrigin()\` or a plain \`generatedParam()\` is` to `double read the field as its inner type.`, becomes one line: `7. **A field bound to \`serviceOrigin()\` or a plain \`generatedParam()\` is wrapped**: \`field(type('string'))\`. At deploy the schema sees a pointer, and a plain \`'string'\` field refuses it: a compile error in a service's or a module's binding, and a deploy error where the schema has no types. \`service.input()\` and \`mockService\`'s input double read the field as its inner type.`

### 9.9 `packages/1-prisma-cloud/2-shared-modules/email/README.md`

1. The code block under `Provision \`email()\` in a module and declare template-typed dependencies on\nits two ports:` that begins `// module.ts — the deploy root` becomes:

   ```ts
   // module.ts — the deploy root
   import { module } from '@prisma/composer';
   import { email } from '@prisma/composer-prisma-cloud/email';
   import { envParam, envSecret } from '@prisma/composer-prisma-cloud';
   import { type } from 'arktype';

   export default module(
     'app',
     { input: type({ EMAIL_DELIVERY_MODE: "'resend' | 'smtp' | 'none'" }) },
     ({ input, provision }) => {
       const mail = provision(email(), {
         id: 'email',
         input: {
           deliveryMode: input.EMAIL_DELIVERY_MODE,
           from: envParam('EMAIL_FROM'),
           deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
         },
       });
       provision(appService, { deps: { email: mail.send } });
       provision(adminService, { deps: { outbox: mail.outbox } });
     },
   );
   ```

2. The paragraph that begins `\`deliveryMode\`, \`from\` and \`deliveryCredential\` are the module's \`input\`.` under `## Platform env vars (per environment)` becomes:

   ```markdown
   `deliveryMode`, `from` and `deliveryCredential` are the module's `input`. `deliveryMode` is `resend`, `smtp` or `none`: bind it to one of those literals, or to a field of your root's input declared with the same three values, as above, so the root's schema checks it before anything is created. An `envParam(...)` may hold any text, so binding it to `deliveryMode` fails to compile. Bind `from` to a literal, an `envParam(...)` or a field of your root's input, so it can vary per environment. `deliveryCredential` is a `secretString()` field: bind it with `envSecret(...)`. `deliveryMode` and `from` are wrapped fields (`field()`), so a module that passes its own wrapped field of the same type on can bind them too. `deliveryUrl` is a factory option (`email({ deliveryUrl })`), static per app: it defaults to `https://api.resend.com` and follows the mode.
   ```

### 9.10 The project's deferred items, `.drive/projects/module-input/deferred.md`

1. The line `- S10: an object field with a \`field()\` leaf (for example \`input.smtp\` with a wrapped \`user\`) does not compile as a service binding, because \`Pointer<string>\` is not accepted as \`InputBindingData\`. Pre-existing.` gains, at its end: ` Closed in S10: \`InputBinding<T>\` maps the field's type, and \`field.test-d.ts\` passes \`input.smtp\` into a service's binding in both libraries.`
2. The line `- S10: check the docs' claim that a field may be a whole service binding (\`input: input.smtp\`) once service bindings are typed from schemas.` gains: ` Closed in S10: the claim holds; type test 7 of the S10 spec compiles it, and runtime tests 9 and 12 show Load and the serializer handle it.`
3. The line `- S10: a service binding of the whole input fails to compile with "ServiceNode is not assignable to ModuleNode" instead of the message.` gains: ` Closed in S10: the last \`provision()\` overload is generic over services and modules, so the error shows the message (§ 8 of the S10 spec).`
4. A new line after them: `- Later: a service or module that declares both dependencies and an input schema, provisioned with \`deps\` but without \`input\`, compiles, because the overload kept for generic wrappers takes \`input\` as optional. Load refuses it. Pre-existing; found in S10.`

## 10. The release note

S9 and S10 ship as one pull request, prisma/composer#412, whose description already carries S9's release note under `## Breaking change`. This slice changes the pull request:

- **Title**: `feat(core)!: every input binding is typed from its schema, and only named fields pass on`.
- **Description**: the heading `## Breaking change` becomes `## Breaking changes`. S9's three items stay first, unchanged. After them, in this order:

  4. The before and after:

     ```ts
     // before: a service's binding took any source in any key, and failed only at deploy
     const relay = compute({ name: 'relay', deps: {}, build, input: type({ host: 'string', key: secretString() }) });
     provision(relay, { input: { host: serviceOrigin('shop.web'), key: envSecret('KEY') } });

     // after: it is typed from the schema, so a runtime value in a plain field fails to compile;
     // wrap the field that waits for a value known only at boot
     const relay = compute({ name: 'relay', deps: {}, build, input: type({ host: field(type('string')), key: secretString() }) });
     provision(relay, { input: { host: serviceOrigin('shop.web'), key: envSecret('KEY') } });
     ```

  5. The sentence: `A service's input binding is now typed from the service's schema, with the same type a module's binding has. A wrong literal, a missing or undeclared key, envSecret() in a text field, serviceOrigin() or a plain generatedParam() in a plain or secretString() field, and envParam() in a field narrower than text now fail to compile; before, they failed at deploy. A schema without type information still takes any binding, and the deploy still checks it.`
  6. The sentence: `A SecretBox or a pointer written as a literal in any binding fails to compile. A module's binding took a pointer literal before.`
  7. The sentence: `The type InputBinding now takes the schema's input type, InputBinding<T>, and replaces ModuleInputBinding<T>, which is removed. InputBindingData is removed. InputBindingOf<I> is the binding of a node whose input schema is I. ServiceInputBinding is renamed InputBindingUse, and its binding is unknown. bootstrapService()'s input is typed from the service's schema, and BootstrapConfig takes the schema's type. ModuleBuilder's provision() has eight overloads, of which the last is generic over a service or module node.`
  8. The before and after for `email()`:

     ```ts
     // before
     provision(email(), { input: { deliveryMode: envParam('EMAIL_DELIVERY_MODE'), from: envParam('EMAIL_FROM'), deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') } });

     // after: deliveryMode is 'resend' | 'smtp' | 'none'; read it through the root's input
     export default module('app', { input: type({ EMAIL_DELIVERY_MODE: type.enumerated(...emailDeliveryModes) }) }, ({ input, provision }) => {
       provision(email(), { input: { deliveryMode: input.EMAIL_DELIVERY_MODE, from: envParam('EMAIL_FROM'), deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') } });
     });
     ```

  9. The sentence: `email()'s deliveryMode is now typed 'resend' | 'smtp' | 'none', as the email service's schema always required. An envParam() may hold any text, so it no longer binds to deliveryMode; bind a literal, or a root input field declared from emailDeliveryModes, which the email package now exports with the type EmailDeliveryMode.`
  10. The sentence: `A service or module that declares both dependencies and an input schema must be bound: provision() without input fails to compile. Before, it compiled and Load refused it.`

The implementer edits the pull request with `gh pr edit 412 --title … --body-file <file>`, with the body file written under the worktree's git-ignored `wip/`, after reading the current body with `gh pr view 412 --json body`. Only the title and the breaking-changes section change; the rest of the body stays as it is. The description ends with the line `Agent: <name>` directly above the closing attribution line, as it does now.

## 11. Tests

Runtime tests use `bun test`; type tests use vitest `expectTypeOf` and `@ts-expect-error`. Test files are exempt from the no-bare-casts instruction. Every code block below is as `pnpm lint:fix` formats it. A `@ts-expect-error` sits on the line directly above the line TypeScript reports. With the generic overload last, TypeScript reports the binding key that does not fit, so for a call that spans lines the comment sits above the `input:` or `params:` line, not above `provision(`.

### 11.1 Existing tests this slice changes

**Core** (`packages/0-framework/1-core/core/src/__tests__/`), all in commit 1.

- `module-input.test-d.ts`:
  - In the type import from `../exports/index.ts`, the line `  ModuleInputBinding,` is removed.
  - After `declare const plainSchema: StandardSchemaV1<unknown, { host: string; port: number }>;`:

    ```ts
    declare const echoSchema: StandardSchemaV1<{
      host: string;
      port: number;
      nested?: { host: string; port: number };
    }>;
    ```

  - In `no binding accepts the whole input, even where its fields would fit`, the `echo` service's `input: plainSchema,` becomes `input: echoSchema,`. Its input type was `unknown`, which under S10 takes the whole input, so its three `@ts-expect-error` lines became unused. In the second `module('shop', …)` body, the lines from `provision(echo, { input: { host: input.host }, params: { label: input.host } });` through `provision(echo, { id: 'four', input: {}, params: { label: input } });` become:

    ```ts
        provision(echo, {
          input: { host: input.host, port: input.port },
          params: { label: input.host },
        });
        resolve([input.host], ([host]) => host);
        resource({ name: 'site', extension: 'test/pack', props: { host: input.host } });
        // @ts-expect-error the whole input is not a value
        provision(echo, { id: 'two', input });
        // @ts-expect-error the whole input is not a value, at any depth
        provision(echo, { id: 'three', input: { host: input.host, port: input.port, nested: input } });
        provision(echo, {
          id: 'four',
          input: { host: input.host, port: input.port },
          // @ts-expect-error the whole input is not a value
          params: { label: input },
        });
    ```

    The rest of the test does not change. `nested` takes `{ host, port }`, which the dictionary's fields would fit, so the refusal is the brand's doing.
  - In `the same input without the brand fits, so the brand alone refuses it`, `type FitsBinding = ModuleInputBinding<{ EMAIL_FROM: string }>;` becomes `type FitsBinding = InputBinding<{ EMAIL_FROM: string }>;`.
  - The test `a service's input binding takes values standing for a secret, an optional field, or a nested object holding a secret` becomes:

    ```ts
    test('a binding takes values standing for a secret, an optional field, or a nested object holding a secret', () => {
      expectTypeOf<{ k: Value<SecretString> }>().toExtend<InputBinding<{ k: SecretString }>>();
      expectTypeOf<{ k: Value<string | undefined> }>().toExtend<InputBinding<{ k?: string }>>();
      expectTypeOf<{ smtp: Value<{ host: string; key: SecretString }> }>().toExtend<
        InputBinding<{ smtp: { host: string; key: SecretString } }>
      >();
    });
    ```

- `value.test-d.ts`: the type import from `../exports/index.ts` gains `  SecretString,` after `  SecretSource,`, and the test `a value standing for input data is an input binding leaf; a Date or a source is not` becomes:

  ```ts
  test('a value fits a binding field of its own type only', () => {
    expectTypeOf({ greeting: name }).toExtend<InputBinding<{ greeting: string }>>();
    expectTypeOf({ when: date }).not.toExtend<InputBinding<{ when: string }>>();
    expectTypeOf({ key: secretValue }).not.toExtend<InputBinding<{ key: SecretString }>>();
  });
  ```

- `source-value.test-d.ts`: `  ModuleInputBinding,` in the type import becomes `  InputBinding,`; every `ModuleInputBinding<` becomes `InputBinding<`; the title `a param source fits a module input field of its type, and a bare ParamSource fits none` becomes `a param source fits a binding field of its type, and a bare ParamSource fits none`.
- `secrets.test.ts`: the line `import type { InputBinding } from '../node.ts';` is removed; in `a cyclic service input binding completes Load`, `input: blindCast<\n            InputBinding,\n            'a deliberately self-referential binding to exercise the cycle guard'\n          >(cyclic),` becomes `input: cyclic,`, because the service's schema has no type information and its binding takes anything; and both `{ id: string; input: InputBinding }` become `{ id: string; input: unknown }`.

**Cron** (`packages/1-prisma-cloud/2-shared-modules/cron/src/__tests__/`), commit 3. Both files bound `envSecret('INGEST_TOKEN')` to a runner field typed `'string'`, which the deploy would refuse; under S10 it fails to compile.

- `module.test-d.ts` and `module.test.ts`: after `import { Load, LoadError, module } from '@internal/core';` in `module.test.ts`, and after `import type { ModuleNode } from '@internal/core';` in `module.test-d.ts`, add `import { secretString } from '@internal/foundation/arktype';`. Every `input: type({ token: 'string' }),` (one in `module.test-d.ts`, two in `module.test.ts`) becomes `input: type({ token: secretString() }),`. No assertion changes.

**Email** (`packages/1-prisma-cloud/2-shared-modules/email/src/__tests__/`), commit 4.

- `module.test-d.ts`:
  - In `email()'s input is the wrapped fields deliveryMode and from, and a secret deliveryCredential`, `    deliveryMode: string | Pointer<string>;` becomes `    deliveryMode: 'resend' | 'smtp' | 'none' | Pointer<'resend' | 'smtp' | 'none'>;`.
  - In `the module's send port wires into a consumer's emailSender() slot` and `the module's outbox port wires into a consumer's rpc(emailOutboxContract) slot`, `        deliveryMode: envParam('EMAIL_DELIVERY_MODE'),` becomes `        deliveryMode: 'none',`.
  - The test title `email() needs its input, takes a value of the root's narrower type, and refuses a plain string credential` becomes `email() needs its input, takes a value of the root's narrower type, and refuses a plain string credential or a delivery mode that may be any text`, and directly before its `provision(email(), {\n      id: 'plain',` call:

    ```ts
        provision(email(), {
          id: 'any-text',
          input: {
            // @ts-expect-error envParam() may hold any text; deliveryMode is resend, smtp or none
            deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
            from: envParam('EMAIL_FROM'),
            deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
          },
        });
    ```

- `module.test.ts`:
  - `const configPool = { EMAIL_DELIVERY_MODE: 'none', EMAIL_FROM: 'shop@example.com' };` becomes `const configPool = { EMAIL_FROM: 'shop@example.com' };`.
  - In `emailInput`, `  deliveryMode: envParam('EMAIL_DELIVERY_MODE'),` becomes `  deliveryMode: 'none' as const,`.
  - The title `the module's input reaches the service's input: envParam() fields as their values, envSecret() as its source` becomes `the module's input reaches the service's input: a literal and an envParam() as their values, envSecret() as its source`. Its assertions do not change.
  - In `the module's schema refuses a missing from before the service's does`, `Load(rootWithEmail(), { configPool: { EMAIL_DELIVERY_MODE: 'none' } });` becomes `Load(rootWithEmail(), { configPool: {} });`. The expected message does not change.

No other existing test changes. Checked: every `.test.ts` and `.test-d.ts` in `packages/`, `examples/` and `test/` compiled after the edits above (§ 15).

### 11.2 New core type tests, at the end of `field.test-d.ts` (commit 1)

The file's existing `arkSchema`, `zodSchema`, `arkNested`, `zodNested`, `arkChild`, `build`, `plainRuntime`, `secretRuntime`, `text` and `secretValue` are used. Append, in this order:

```ts
const arkService = service({
  name: 'ark-service',
  extension: 'test/pack',
  type: 'fake/compute',
  inputs: {},
  params: {},
  input: arkSchema,
  build,
});
const zodService = service({
  name: 'zod-service',
  extension: 'test/pack',
  type: 'fake/compute',
  inputs: {},
  params: {},
  input: zodSchema,
  build,
});
const arkNestedService = service({
  name: 'ark-nested-service',
  extension: 'test/pack',
  type: 'fake/compute',
  inputs: {},
  params: {},
  input: arkNested,
  build,
});
const zodNestedService = service({
  name: 'zod-nested-service',
  extension: 'test/pack',
  type: 'fake/compute',
  inputs: {},
  params: {},
  input: zodNested,
  build,
});
```

1. `a service's binding takes a literal, a deploy-time value and a plain runtime value in a wrapped field, and a secret runtime value in a secretString() field`:

   ```ts
   test("a service's binding takes a literal, a deploy-time value and a plain runtime value in a wrapped field, and a secret runtime value in a secretString() field", () => {
     module('shop', ({ provision }) => {
       provision(arkService, {
         id: 'a',
         input: { from: 'x', port: '1', host: 'h', key: secretRuntime },
       });
       provision(arkService, {
         id: 'b',
         input: { from: text, port: text, host: text, key: secretValue },
       });
       provision(arkService, {
         id: 'c',
         input: { from: plainRuntime, port: plainRuntime, host: 'h', key: secretRuntime },
       });
       provision(zodService, {
         id: 'd',
         input: { from: 'x', port: '1', host: 'h', key: secretRuntime },
       });
       provision(zodService, {
         id: 'e',
         input: { from: text, port: text, host: text, key: secretValue },
       });
       provision(zodService, {
         id: 'f',
         input: { from: plainRuntime, port: plainRuntime, host: 'h', key: secretRuntime },
       });
     });
   });
   ```

2. `a service's binding refuses a wrong literal`:

   ```ts
   test("a service's binding refuses a wrong literal", () => {
     module('shop', ({ provision }) => {
       provision(arkService, {
         id: 'a',
         // @ts-expect-error a text field takes no number
         input: { from: 'x', port: '1', host: 4, key: secretRuntime },
       });
       provision(zodService, {
         id: 'b',
         // @ts-expect-error a text field takes no number
         input: { from: 4, port: '1', host: 'h', key: secretRuntime },
       });
       // @ts-expect-error a required field must be bound
       provision(arkService, { id: 'c', input: { from: 'x', port: '1', key: secretRuntime } });
     });
   });
   ```

3. `a service's binding refuses a secret runtime value in a plain or a wrapped text field`:

   ```ts
   test("a service's binding refuses a secret runtime value in a plain or a wrapped text field", () => {
     module('shop', ({ provision }) => {
       provision(arkService, {
         id: 'a',
         // @ts-expect-error a plain field takes no runtime value
         input: { from: 'x', port: '1', host: secretRuntime, key: secretRuntime },
       });
       provision(arkService, {
         id: 'b',
         // @ts-expect-error a wrapped text field takes no secret runtime value
         input: { from: secretRuntime, port: '1', host: 'h', key: secretRuntime },
       });
       provision(zodService, {
         id: 'c',
         // @ts-expect-error a plain field takes no runtime value
         input: { from: 'x', port: '1', host: secretRuntime, key: secretRuntime },
       });
       provision(zodService, {
         id: 'd',
         // @ts-expect-error a wrapped text field takes no secret runtime value
         input: { from: secretRuntime, port: '1', host: 'h', key: secretRuntime },
       });
     });
   });
   ```

4. `a service's binding refuses a plain runtime value in a plain or a secretString() field`:

   ```ts
   test("a service's binding refuses a plain runtime value in a plain or a secretString() field", () => {
     module('shop', ({ provision }) => {
       provision(arkService, {
         id: 'a',
         // @ts-expect-error a plain field takes no runtime value
         input: { from: 'x', port: '1', host: plainRuntime, key: secretRuntime },
       });
       provision(arkService, {
         id: 'b',
         // @ts-expect-error a secret field takes no plain runtime value
         input: { from: 'x', port: '1', host: 'h', key: plainRuntime },
       });
       provision(zodService, {
         id: 'c',
         // @ts-expect-error a plain field takes no runtime value
         input: { from: 'x', port: '1', host: plainRuntime, key: secretRuntime },
       });
       provision(zodService, {
         id: 'd',
         // @ts-expect-error a secret field takes no plain runtime value
         input: { from: 'x', port: '1', host: 'h', key: plainRuntime },
       });
     });
   });
   ```

5. `no binding takes a SecretBox or a pointer written as a literal`, with three declarations before it:

   ```ts
   declare const pointer: Pointer<string>;
   declare const secretPointer: Pointer<SecretString>;
   declare const box: SecretString;

   test('no binding takes a SecretBox or a pointer written as a literal', () => {
     module('shop', ({ provision }) => {
       // @ts-expect-error a secret's value never sits in the code
       provision(arkService, { id: 'a', input: { from: 'x', port: '1', host: 'h', key: box } });
       provision(arkService, {
         id: 'b',
         // @ts-expect-error a pointer is never a literal
         input: { from: pointer, port: '1', host: 'h', key: secretRuntime },
       });
       provision(arkService, {
         id: 'c',
         // @ts-expect-error a pointer is never a literal
         input: { from: 'x', port: '1', host: 'h', key: secretPointer },
       });
       // @ts-expect-error a secret's value never sits in the code
       provision(arkChild, { id: 'd', input: { from: 'x', port: '1', host: 'h', key: box } });
       provision(arkChild, {
         id: 'e',
         // @ts-expect-error a pointer is never a literal
         input: { from: pointer, port: '1', host: 'h', key: secretRuntime },
       });
       provision(arkChild, {
         id: 'f',
         // @ts-expect-error a pointer is never a literal
         input: { from: 'x', port: '1', host: 'h', key: secretPointer },
       });
       provision(arkNestedService, {
         id: 'g',
         // @ts-expect-error a pointer is never a literal, in an array either
         input: { smtp: { user: 'u', password: secretRuntime }, tags: [pointer] },
       });
     });
   });
   ```

6. `a module passes its fields on into a service's binding, nested, optional or whole, in both libraries` (closes deferred item 1):

   ```ts
   test("a module passes its fields on into a service's binding, nested, optional or whole, in both libraries", () => {
     module('m', { input: arkNested }, ({ input, provision }) => {
       provision(arkNestedService, {
         input: { smtp: input.smtp, replyTo: input.replyTo, tags: input.tags },
       });
       provision(arkNestedService, {
         id: 'two',
         input: { smtp: { user: input.smtp.user, password: input.smtp.password }, tags: input.tags },
       });
       // @ts-expect-error the whole input is not a value
       provision(arkNestedService, { id: 'three', input });
     });
     module('m', { input: zodNested }, ({ input, provision }) => {
       provision(zodNestedService, {
         input: { smtp: input.smtp, replyTo: input.replyTo, tags: input.tags },
       });
       provision(zodNestedService, {
         id: 'two',
         input: { smtp: { user: input.smtp.user, password: input.smtp.password }, tags: input.tags },
       });
       // @ts-expect-error the whole input is not a value
       provision(zodNestedService, { id: 'three', input });
     });
   });
   ```

7. `a module's object field may be a service's whole binding` (closes deferred item 2):

   ```ts
   const arkSmtp = type({ user: arkField(type('string')), password: arkSecretString() });
   const smtpService = service({
     name: 'smtp',
     extension: 'test/pack',
     type: 'fake/compute',
     inputs: {},
     params: {},
     input: arkSmtp,
     build,
   });

   test("a module's object field may be a service's whole binding", () => {
     module('m', { input: arkNested }, ({ input, provision }) => {
       provision(smtpService, { input: input.smtp });
       // @ts-expect-error a wrapped field is not an object
       provision(smtpService, { id: 'two', input: input.replyTo });
     });
   });
   ```

8. `a service whose schema carries no type information takes any binding, the whole input included; Load refuses that`:

   ```ts
   test('a service whose schema carries no type information takes any binding, the whole input included; Load refuses that', () => {
     const untyped = service({
       name: 'untyped',
       extension: 'test/pack',
       type: 'fake/compute',
       inputs: {},
       params: {},
       input: {} as StandardSchemaV1,
       build,
     });
     module('m', { input: arkNested }, ({ input, provision }) => {
       provision(untyped, { input: { anything: 4, key: secretRuntime } });
       provision(untyped, { id: 'two', input });
     });
   });
   ```

Tests 2 to 5 cover the design's requirement 4 for services in both libraries: a wrong literal, a secret pointer in a plain or wrapped text field, a plain pointer in a plain or `secretString()` field. Test 5 also covers modules for the literal box and pointer. § 15 records that each `@ts-expect-error` fails for the reason its comment states, checked by removing the comments and reading `tsc`'s errors.

### 11.3 New core runtime test, in `module-input.test.ts` (commit 1)

9. `an object field passed on as a service's whole binding reaches it as the module's validated output`. In describe `forwarding and the second pass`, directly before `test("a real value is the schema's output", () => {`:

```ts
  test("an object field passed on as a service's whole binding reaches it as the module's validated output", () => {
    const email = module(
      'email',
      { input: type({ smtp: { user: 'string', password: secretString() } }) },
      ({ input, provision }) => {
        provision(echoService(), { input: input.smtp });
      },
    );
    const password = secretSource({ name: 'SMTP_PASSWORD' });

    const graph = Load(shopWith(email, { smtp: { user: 'mailer', password } }));

    expect(bindingOf(graph)).toEqual({ user: 'mailer', password });
    expect(bindingOf(graph)['password']).toBe(password);
  });
```

### 11.4 New Prisma Cloud target tests (commit 2)

10. In `packages/1-prisma-cloud/1-extensions/target/src/__tests__/sources.test-d.ts`, at the end of the file, using its existing imports and `build`:

   ```ts
   test("each source fits a service's input field of its type", () => {
     const relay = compute({
       name: 'relay',
       deps: {},
       build,
       input: type({
         origin: 'string',
         token: secretString(),
         base: field(type('string')),
         plainToken: field(type('string')),
         key: secretString(),
       }),
     });
     module('shop', ({ provision }) => {
       provision(relay, {
         input: {
           origin: envParam('ORIGIN'),
           token: generatedParam(),
           base: serviceOrigin('shop.web'),
           plainToken: generatedParam({ redacted: false }),
           key: envSecret('KEY'),
         },
       });
     });
   });
   ```

11. After test 10, in the same file:

    ```ts
    test("a service's binding refuses a wrong literal, a runtime value in a plain field, envSecret() in a wrapped text field and serviceOrigin() in a secret field", () => {
      const relay = compute({
        name: 'relay',
        deps: {},
        build,
        input: type({ host: 'string', from: field(type('string')), key: secretString() }),
      });
      module('shop', ({ provision }) => {
        // @ts-expect-error host is text, not a number
        provision(relay, { input: { host: 4, from: 'x', key: envSecret('KEY') } });
        provision(relay, {
          // @ts-expect-error serviceOrigin() is a runtime value; a plain field takes deploy-time data only
          input: { host: serviceOrigin('shop.web'), from: 'x', key: envSecret('KEY') },
        });
        // @ts-expect-error envSecret() is a runtime value; a plain field takes deploy-time data only
        provision(relay, { input: { host: envSecret('HOST'), from: 'x', key: envSecret('KEY') } });
        // @ts-expect-error envSecret() is a secret runtime value; a wrapped text field takes a plain pointer only
        provision(relay, { input: { host: 'h', from: envSecret('FROM'), key: envSecret('KEY') } });
        // @ts-expect-error serviceOrigin() is a plain runtime value; a secretString() field takes a secret only
        provision(relay, { input: { host: 'h', from: 'x', key: serviceOrigin('shop.web') } });
      });
    });
    ```

12. In `packages/1-prisma-cloud/1-extensions/target/src/__tests__/input-serializer.test.ts`, inside describe `a secret forwarded through a module input`, after its existing test:

    ```ts
      test("an object field passed on as a service's whole binding serializes with its pointers", () => {
        const smtp = type({ user: field(type('string')), password: secretString() });
        const email = module('email', { input: type({ smtp }) }, ({ input, provision }) => {
          provision(svc(smtp), { input: input.smtp });
        });
        const graph = Load(
          module('shop', ({ provision }) => {
            provision(email, {
              input: {
                smtp: { user: serviceOrigin('shop.web'), password: envSecret('SMTP_PASSWORD') },
              },
            });
          }),
        );
        const node = graph.nodes.find((entry) => entry.id === 'shop.email.web')?.node as ServiceNode;

        const row = serializeInput(node, 'shop.email.web', graph.inputBindings[0]?.binding, {
          env: {},
        });

        expect(JSON.parse(row?.value ?? '')).toEqual({
          user: { $generated: 'COMPOSER_SHOP_EMAIL_WEB_USER_GENERATED', redacted: false },
          password: { $secret: 'SMTP_PASSWORD' },
        });
      });
    ```

## 12. Scope

In: `packages/0-framework/1-core/core` (§ 3, tests); the Prisma Cloud target's `testing.ts` and tests (§ 4, § 11.4); the cron and email shared modules (§ 5, tests) and the email README; `examples/auth/module.ts` (§ 6); `docs/`; `skills/`; `deferred.md`; the pull request's title and description.

Out: `dotenv-flow` (S11); the configuration file and the "pool" names (S12), so the docs keep "config pool"; redaction (S13); the other decision records the project touched (secrets, params, the `composer` config section, dev secrets), whose behaviour this slice does not change; `module-composition.md`'s and `config-params.md`'s own amendment notes at their tops.

## 13. Commits, in order

Each commit is made with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"` and has no `Co-Authored-By` line. Before each commit, run `pnpm lint:fix` and keep the formatting it writes. Only the tip has to build and pass.

1. `feat(core)!: a service's input binding is typed from its schema` — § 3; the core changes of § 11.1; § 11.2; § 11.3.
2. `feat(prisma-cloud)!: bootstrapService() types its input binding from the service's schema` — § 4; § 11.4.
3. `fix(cron): the runner's binding is typed from its schema` — § 5.1; the cron changes of § 11.1.
4. `fix(email)!: email()'s deliveryMode is resend, smtp or none, as its service requires` — § 5.2; § 6; § 9.9; the email changes of § 11.1.
5. `docs(design): a service's binding is typed from its schema, and the service input and module boundary decisions are one current record each` — § 9.1 to § 9.6.
6. `docs: a service's binding is typed from its schema, in the guide and the agent skill` — § 9.7, § 9.8.
7. `docs(drive): module-input S10 closes S9's deferred items and records manual QA` — § 9.10; `qa.md` in this slice's folder (§ 14).

## 14. Done when

- Tests 1 to 12 pass, and every test changed in § 11.1 passes. At the root: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm lint:deps`, `pnpm test`, `pnpm turbo run test:types`, `pnpm check:floor-imports`, `pnpm check:publish-deps` and `pnpm check:skill-packaging` are green. `pnpm lint:casts` reports `delta=0`. `pnpm lint` reports 40 warnings and 20 infos, as the branch does before this slice.
- Run `pnpm test` from this worktree, not from a scratch copy. Some target and local-target tests start emulator daemons. Stop no emulator you did not start. If tests fail because of an emulator this run did not start, record it and report; do not stop it. Never run `pnpm test:integration`, `pnpm test:e2e` or `pnpm test:all`.
- The four tests under `a hostname public URL under the Alchemy apply engine` in the Prisma Cloud target fail when `bun test` runs alone in that package, on main too (S7 spec § 16), and pass under `pnpm test`. If any other test fails, stop and report.
- Every document in § 9 is updated, and the pull request carries § 10.
- `/drive-code-review` runs on the branch after the slice is built, without the walkthrough, and its findings are fixed, as the Drive process requires. Its artifacts are not committed.
- **Manual QA**, recorded in `qa.md` in this slice's folder, after `pnpm build`. No Prisma Cloud deploy: no input document, stack file or deploy report changes (§ 2, § 7).
  1. **The compile errors an author sees.** Write `examples/email/src/s10-qa.ts` with exactly:

     ```ts
     import { Load, module } from '@prisma/composer';
     import { field, secretString } from '@prisma/composer/arktype';
     import node from '@prisma/composer/node';
     import { compute, envSecret, serviceOrigin } from '@prisma/composer-prisma-cloud';
     import { type } from 'arktype';

     const schema = type({
       from: field(type('string')),
       host: 'string',
       deliveryCredential: secretString(),
     });

     const relayService = compute({
       name: 'relay',
       deps: {},
       build: node({ module: import.meta.url, entry: 'relay.mjs' }),
       input: schema,
     });

     const relay = module('relay', { input: schema }, ({ input, provision }) => {
       provision(relayService, { input });
     });

     const root = module('shop', ({ provision }) => {
       provision(relay, {
         input: {
           from: 'shop@example.com',
           host: 'mail.example.com',
           deliveryCredential: envSecret('KEY'),
         },
       });
       provision(relayService, {
         id: 'direct',
         input: {
           from: envSecret('FROM'),
           host: serviceOrigin('shop.web'),
           deliveryCredential: envSecret('KEY'),
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

     Run `pnpm --filter @prisma/example-email typecheck` and record its output. It holds three `TS2769` errors, at `src/s10-qa.ts(21,29)`, `(35,7)` and `(36,7)`, as § 8 quotes: the first ends with `Type 'true' is not assignable to type '"the whole input of a module is not a value; pass its fields on by name"'.` Then run `bun src/s10-qa.ts` in `examples/email`, which does not check types. It prints exactly `the input binding of service "shop.relay.relay" depends on the whole input of module "shop.relay". A module body's input is a dictionary of values, not a value, so it cannot be passed on whole. Pass its fields on by name, such as input.from.` Record it, then delete `src/s10-qa.ts`.
  2. **The examples still type-check, and the auth example loads.** `pnpm --filter @prisma/example-email typecheck`, `pnpm --filter @prisma/example-auth typecheck`, `pnpm --filter @prisma/example-storefront-auth typecheck` and `pnpm --filter @prisma/example-cron typecheck` exit 0. `bun test tests/module.test.ts` in `examples/auth` passes. `git status` shows only this slice's changes.

## 15. Checks the spec author ran

One scratch worktree of this branch, at its git-ignored `wip/s10-scratch`, with its own `pnpm install --frozen-lockfile`, removed afterwards. No process was left running from it. The whole change to code, tests and the auth example, as one patch against this branch, is kept at `wip/s10-spec-probe/final.patch` (git-ignored) for the review to compare with; the spec, not the patch, is what the implementer follows. The documentation of § 9 was not applied in the scratch copy.

- **Everything green after the whole change**, after `pnpm lint:fix`: `pnpm build`, 39 of 39 tasks; `pnpm turbo run typecheck test:types --continue`, 84 of 84 tasks; `pnpm lint`, 40 warnings and 20 infos; `pnpm lint:casts`, `current=18 merge-base=18 delta=0`; `pnpm lint:deps`, `pnpm check:floor-imports`, `pnpm check:publish-deps` and `pnpm check:skill-packaging`, all OK; core's `bun test`, 415 pass; core's `vitest --typecheck`, 91 pass; the target's `vitest --typecheck`, 20 pass; the target's `input-serializer.test.ts`, `secret.test.ts`, `param.test.ts` and `bootstrap-service.test.ts`, 78 pass; `bun test` in auth (132), cron (26), email (99), storage (49), streams (22) and the CLI (411); `examples/auth/tests/module.test.ts`, `examples/email/tests/module.test.ts` and `examples/storefront-auth/module.test.ts`. The two integration test files of `examples/cron` were also run once by a glob, and passed; they are not part of the slice's checks.
- **Each expected type error fails for the stated reason.** With the `@ts-expect-error` comments of § 11.2 and of test 11 removed, `tsc` reported each line with the expected mismatch: `number` against `InputBinding<string>`; a missing `host`; `RuntimeValue<SecretString>` against `InputBinding<string>` and `InputBinding<string | Pointer<string>>`; `RuntimeValue<string>` against `InputBinding<string>` and `InputBinding<SecretString | Pointer<SecretString>>`; `SecretString`, `Pointer<string>` and `Pointer<SecretString>` against their fields' bindings; `ModuleInput<…>` against `NotModuleInput`; and `Value<string | Pointer<string> | undefined>` against the object binding.
- **What broke before the fixes.** With only § 3 applied, `typecheck` failed in core's tests (§ 11.1), in cron (`RunnerInput` and the generic call), in the target's `testing.ts`, in email (`deliveryMode`), in the email tests, and in `examples/auth`. With the two primary overloads removed and none added, a failed call listed three overloads and reported its error at `provision(`, not at the key; the generic last overload reports at the key and keeps every existing `@ts-expect-error` in place except the ones § 11.1 moves.
- **The old module binding took a pointer literal.** `ModuleInputBinding<{ from: string | Pointer<string> }>` accepted `{ from: Pointer<string> }`, and the same for a secret pointer; it refused a `SecretBox`. Checked with a copy of the old type.
- **The ADR-0042 example compiles**: the Zod discriminated union with `field()` and `secretString()`, its binding with `serviceOrigin()` and `envSecret()`, narrowing on `chatService.input()`, and `returnUrl` read as `string`; binding `envSecret()` to `returnUrl` fails.
- **The gap in § 9.10 item 4**: a `compute()` with `deps` and an input schema, provisioned with `{ deps: { db } }` and no `input`, compiles before and after this slice.
- **Manual QA step 1** was run as written; its output is quoted in § 8 and § 14.
- **Not run:** `pnpm test` at the root, and the target's and local-target's whole `bun test`, which start emulator daemons.

## 16. Decisions this spec records, for the review

1. **`ModuleInputBinding<T>` is renamed `InputBinding<T>`, and the loose `InputBinding` goes.** The mapping now serves both kinds of node, so a name with "Module" in it would be wrong for a service. Reusing the name, now with a required type parameter, makes every old use fail to compile with "Generic type 'InputBinding' requires 1 type argument", which points the author at the change. The design names the mapping `ModuleInputBinding` only to identify it.
2. **`InputBindingOf<I>` is added and exported.** `cron()` and `bootstrapService()` need the binding of a schema type without importing `@standard-schema/spec` themselves, and a user's own generic wrapper needs the same.
3. **A `Pointer` field takes no literal, and an array takes no unchecked literal of its own type** (§ 3.1). The design says a pointer is never written as a literal. The old array branch, `T | readonly ModuleInputBinding<E>[]`, let a literal array of pointers through; `readonly InputBinding<E>[]` takes every literal element `InputBinding<E>` takes.
4. **The `SecretSource` branch stays.** A raw `secretSource()` has the value type `unknown` and is not a `Value<SecretString>`; S2 to S9's tests bind one to a secret field. The design's "a secret runtime value, or a module's secret field passed on" is met: a `SecretSource` is always a secret pointer at deploy.
5. **The two primary overloads become one generic overload, declared last** (§ 2). It is the only order that shows S9's message for both a service and a module. Dropping the spelled-out overloads instead, to get to three, made TypeScript list every overload and report at `provision(`, moving every existing `@ts-expect-error` and making errors less precise. The spelled-out overloads stay for generic wrappers.
6. **`cron()` widens its runner's type** (§ 5.1), the one call site in the repo that provisions a service whose type is generic. The alternative, a cast, would add to `lint:casts`.
7. **`ServiceInputBinding['binding']` is `unknown`** (§ 3.2), and the cast in `load-module.ts` goes. No single type describes every service's binding once bindings are typed per schema.
8. **`bootstrapService()` types its `input` from the service's schema** (§ 4), because it takes a binding exactly like `provision()`'s, and the loose type it used is removed.
9. **`email()` declares `deliveryMode` as the three values its service accepts** (§ 5.2). The new type refused the module passing a `string` to the service's enum, which is the class of mistake requirement 4 targets. The alternative, the service accepting any text, would move the check to boot.
10. **The auth example reads the delivery mode through its root's input** (§ 6), because `envParam()` no longer fits `deliveryMode`. It keeps `envParam()` for `from` and `serviceOrigin()` for `baseUrl`, as design section 10 says.
11. **ADR-0042 and ADR-0016 are rewritten in full, not amended** (§ 9.1, § 9.2), following Will's instruction and the ADR-0061 and ADR-0062 precedent. ADR-0042's rewrite also corrects text that had gone stale: `envParam()` reads the configuration, not "the deploy shell"; `serviceOrigin()` is written as a `$generated` marker; the sentinels are gone. ADR-0016's example used a `provision()` signature that no longer exists. Both use "the configuration", as ADR-0062 does, and say "config pool" nowhere.
12. **The cron tests' runner schema becomes `secretString()`** (§ 11.1). They bound `envSecret()` to a text field, which the deploy refuses; the new type caught it.
13. **The missing-`input` gap is recorded, not fixed** (§ 9.10). It is outside "a service's binding is typed from its schema", and making `input` required in the spelled-out overloads would change every generic wrapper's call. Reversed by the review fixes (§ 18): the gap is closed.

## 17. What the design does not say, found while checking it against the code

1. **The email module's schema contradicted its service's.** `email()` declared `deliveryMode` as any text and passed it to a service that accepts three values; the README said so on purpose ("The module's schema checks only that `deliveryMode` is a string"). Typed service bindings refuse that, and the fix (§ 5.2) means an `envParam()` no longer binds to `email()`'s `deliveryMode`. That is a breaking change for users the design's section 10 does not list. This spec lists it in the release note (§ 10, items 8 and 9). For the orchestrator: design section 10's list of what breaks could gain "a binding of `envParam()` to a field narrower than text, such as `email()`'s `deliveryMode`".
2. **Design section 10 says the auth example keeps `envParam()`**, and it does, for `from`; its `deliveryMode` moves to a root input field (§ 6). A side effect: the auth example's `destroy` now needs `EMAIL_DELIVERY_MODE` in its configuration, because the root's schema runs at Load. The email example already needed that. Will ruled `destroy` needing a valid configuration out of scope.
3. **A raw `SecretSource` and a `Value<SecretString>` still fit a `secretString()` field** (§ 16, decision 4). The design lists "a secret runtime value, or a module's secret field passed on". A `Value<SecretString>` that is not a pointer is a deploy-time secret, which the design says does not exist yet, so nothing produces one today.
4. **A node with dependencies and an input schema, provisioned without `input`, compiles** (§ 9.10 item 4). Load refuses it. It predates this project and is a gap in requirement 4 that the design does not mention.
5. **The design's "`ModuleInputBinding`" is renamed** (§ 16, decision 1). design.md does not use the name for any other purpose, so no design text needs to change.
6. **ADR-0042 still said the deploy reads `envParam()` "from the deploy shell" and that `serviceOrigin()` used sentinels**, though S4 and S7 changed both. The rewrite (§ 9.1) states the current behaviour.

## 18. Review fixes

The system-design and code reviews of this slice (`reviews/`, not committed) found defects that the sections above now reflect where they changed names, overloads or files. Each fix, and its commit:

1. **F01.** The bundled types of `@prisma/composer-prisma-cloud` carried their own copy of `SecretBox`, so a redacted `generatedParam()` did not fit a `secretString()` field in an app using the published packages. `packages/9-public/composer-prisma-cloud/tsdown.config.ts` and `scripts/rewrite-internal-dts.mjs` map `@internal/foundation/secret` and `@internal/foundation/pointer` to `@prisma/composer`. `examples/email/tests/secret-bindings.ts`, compiled by the example's typecheck against the built packages, binds a redacted `generatedParam()` and an `envSecret()` to a service's `secretString()` field. Of the other public packages, `@prisma/composer` holds the one copy, and `@prisma/composer-cli` inlines its own copy of core, whose types no user value crosses. Commit `fix(prisma-cloud): the published types import SecretBox and Pointer from @prisma/composer`.
2. **F02, D02 and D03.** The two primary overloads are back, typed with `InputBindingOf<I>` (§ 3.1 item 5), so a generic wrapper without `deps` compiles. Each overload with `deps` written out is split in two: one requires `input`, one, for a node without an input schema, refuses it. So a node with dependencies and an input schema, provisioned without `input`, fails to compile. `cron()` passes `input: opts.input`. `field.test-d.ts` adds a service and a module with dependencies and an input schema, refused with a wrong literal, the wrong kind of runtime value, a missing `input` and the whole input, and generic wrappers with and without dependencies. Commit `fix(core)!: a generic wrapper provisions a node without deps, and a node with deps and an input schema must be bound`.
3. **D04.** `ServiceInputBinding` is `InputBindingUse`. Commit `refactor(core)!: ServiceInputBinding is InputBindingUse`.
4. **D06.** The email package exports `emailDeliveryModes` and `EmailDeliveryMode` from `src/delivery-mode.ts`; the service's and the module's schemas, the handlers, the delivery URL check, the README and the auth and email examples use them. Commit `feat(email): export emailDeliveryModes and EmailDeliveryMode`.
5. **D01, D05, D10 and D12.** ADR-0042, ADR-0016, `module-composition.md` and `config-params.md` say the type checks shape and kind, and that a refinement such as a URL format is checked only at deploy. ADR-0042 and ADR-0016 say "input" for a node's input and "the app configuration" for what the config adapters return. ADR-0061's and ADR-0063's Related lines and the index say ADR-0016's and ADR-0042's current text includes their changes. `module-composition.md` lists the overloads and says how to write a generic wrapper with `InputBindingOf<I>`. Commit `docs(design): …`.
6. **D07 and D08.** The guide's `chatInput` declares `appOrigin`, and `gotchas.md` binds `deliveryMode` through the root's input. Commit `docs: …`.
7. **D09 and D11.** `design.md` section 10 lists the `envParam()` break; `deferred.md` records the missing-`input` gap as closed, and `InputRef` and `ModuleOutputs` as later work. Committed with this section.

Round 2 of both reviews found these, each fixed in its own commit:

1. **F04.** `ModuleProvisionArgs` and `ModuleProvisionOptions` test `I extends StandardSchemaV1` as the service's type does, so a wrapper that widens a module to `ModuleNode<D, E>` can pass `input: opts.input`. `field.test-d.ts` covers it for a service and a module. Commit `fix(core): a generic wrapper can pass input on to a module widened to the default schema type`.
2. **F05.** The pull request's breaking-change item on a missing `input` tells wrapper authors to widen the node and pass `input: opts.input`, as `cron()` does. Not committed; the description draft is in `wip/`.
3. **D13.** ADR-0061 (Decision, Reasoning, Alternatives), its index entry and ADR-0016's alternatives say "input" for a node's input. Commit `docs(design): ADR-0061 and ADR-0016 say input for a node's input`.
4. **D14.** `module-composition.md` lists the `provision()` overloads in the order TypeScript tries them, and the wrapper recipe names `ModuleNode<D, E>`. Commit `docs(design): list the provision() overloads …`.
5. **D15.** The agent skill and the guide point to `emailDeliveryModes`, and the skill's email row says `deliveryMode` no longer takes `envParam()`. Commit `docs: the guide and the agent skill point to emailDeliveryModes …`.
6. **D16.** The cloud package's build maps `@internal/foundation/arktype` and `/zod` to `@prisma/composer/arktype` and `/zod`. Its library entries no longer inline foundation's arktype, secret or pointer code, and no mapped import needs `POINTER`, `POINTER_TYPE` or `PointerKind`, so `@prisma/composer`'s root exports are unchanged. What foundation code is still inlined is in `deferred.md`. Commit `build(prisma-cloud): import foundation's arktype and zod helpers from @prisma/composer …`.
7. The two pre-existing gaps the code review deferred are in `deferred.md`.
