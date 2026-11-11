# 3. A platform variable is a node

Parent: [project spec](../../spec.md), [plan](../../plan.md) section 3, [design](../../design.md) sections 4, 5, 6, 10, 12 and 14.

This document is the whole design for slice 3. It names every type, function, check, message, file and record the slice changes. Rejected options and departures from the plan are in section 12, not in the design sections.

## 1. The decision

```ts
// module.ts, the app's root
import { appRoot } from '@prisma/composer';
import { variable } from '@prisma/composer-prisma-cloud';
import { email } from './modules/email/module.ts';

export default appRoot('shop', ({ provision }) => {
  const from = provision(variable({ name: 'EMAIL_FROM' }));
  const deliveryCredential = provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }));

  provision(email(), { input: { from, deliveryCredential } });
});
```

```ts
// modules/email/module.ts, a module below the root
export const email = () =>
  module('email', { input: type({ from: field(type('string')), deliveryCredential: secretString() }) }, ({ input, provision }) => {
    provision(emailService(), { input: { from: input.from, deliveryCredential: input.deliveryCredential } });
    // provision(variable({ name: 'OTHER' }))   ← does not compile: only appRoot() can provision it
  });
```

We are adding a platform variable node to the app's graph, and removing `envSecret()` and `envParam()`.

The app root provisions a node with `variable({ name })` for a plain value, or `variable.secret({ name })` for a secret, both from `@prisma/composer-prisma-cloud`. `provision()` returns the value itself, with `id` on it, so the root passes `from` and `deliveryCredential` down through module inputs to the services that read them. Only `appRoot()` can provision one: in a `module()` body the call does not compile, and the error names `appRoot()`. The loaded graph lists every node and, for each service, the variables it reads, without deploying. Deploy, preflight, boot and `prisma dev` handle a node's variable under slice 2's rules.

After this slice a value the operator supplies reaches the app in exactly two ways:

- **A value the deploy reads** is a field of the app root's `input`. The `config` adapters fill it when the deploy runs, and module-input S18 adds secret fields filled from the `secrets` adapters. This replaces `envParam()` in an input binding.
- **A value the service reads at boot** is a platform variable node, provisioned in the app root. This replaces `envSecret()` everywhere, and `envParam()` in a service's per-key params. A plain node in a per-key param writes the same pointer row a per-key `envParam()` wrote.

The environment's facts, such as `environment.name`, and the values Composer creates for its own use, through `generatedParam()` and `serviceOrigin()`, are separate and do not change.

`envSecret()`, `envParam()` and `secretName()` are no longer exported. There is one way to name a platform variable, so every platform variable is a node in the graph, and the code that existed only to support the two functions goes (4.5, 5.8).

There is no `schema` in this slice. Every value is text. Slice 4 adds `schema`.

### What each part satisfies

The requirements and decisions are the project spec's.

| Part of the design | Requirements | Decisions |
|---|---|---|
| A resource can be a value; `provision()` returns it with the node's address (4.1, 4.2) | R1 "The graph shows every platform variable" | D3, D4 |
| Only `appRoot()` provisions one, enforced by the compiler (4.3) | R1 | D1, D2 |
| Duplicate ids name the node already at the id (4.4) | R1 | D4 |
| No source reads the app configuration (4.5) | R2 "The deploy needs no value" | D14 |
| The reads relation, and secret nodes in the graph's secret sources (4.6) | R1, R7 "A secret's text never appears in an error" | D6, D13 |
| The constructors, names and default ids (5.1, 5.2) | R1, R2 | D2, D4, D5, D8 |
| A descriptor that creates nothing; the topology and the deploy report skip the node (5.3) | R2, R6 "Nothing waits for the platform" | D3, D15 |
| The graph check's three rules (5.4) | R1, R2 | D5, D7, D8 |
| Serializer, preflight, per-key params and boot (5.5, 5.7) | R2, R7 | D5, D10, D11 |
| `prisma dev` fills plain values (5.6) | R5 "The same app behaves the same locally", R7 | D12, D13 |
| `envSecret()` and `envParam()` removed (4.5, 5.8) | R1, R2 | D14 |
| Examples, records, guides and skill (6, 7) | R1, R8 "Every record matches the code" | D15 |

This slice does not touch R3 "The type travels as data" or R4 "No value is guessed". Slice 4 satisfies them, with `schema`.

## 2. Terms

These follow the project spec's terms. Slice 3 makes the glossary match them.

- **Platform variable.** A variable on the platform that a service reads by name at boot. The app declares each one with a node in its root, so every message can name the node. "Plain platform variable" means the non-secret kind.
- **Platform variable node.** The node that declares a platform variable, built with `variable({ name })` or `variable.secret({ name })` and provisioned in the app root.
- **Platform secret.** A platform variable whose value is handled as a secret: boxed in the service and redacted wherever Composer prints. Built with `variable.secret({ name })`. The term marks the variables whose text must never appear in output.
- **A variable on the platform**, or **row.** Any entry in a Prisma Cloud project's environment variables: a name and a non-empty text, at a class and optionally a branch. That includes Composer's own `COMPOSER_` rows, which are not platform variables. The term names the platform's storage, as distinct from what the app reads.
- **Value resource.** Core's name for a resource node that is also a value: provisioning it returns a value, not a reference to a port. A platform variable node is the one value resource today. The term lets core state its rules without knowing about Prisma Cloud.
- **Root input field.** A field of the app root's `input`. The `config` adapters fill it when the deploy or `prisma dev` runs; module-input S18 adds secret fields filled from the `secrets` adapters. It is the one way for the operator to supply a value the deploy reads.

## 3. How it works, end to end

This is the map. Each step links to the section that holds its detail.

1. **The author writes the root.** In an `appRoot()` body, `provision(variable({ name: 'EMAIL_FROM' }))` returns the value with `id` set. The author binds it into a module's or a service's input like any other value (4.2, 5.2).
2. **The compiler checks two things.** A `module()` body cannot provision a value resource, and the error names `appRoot()` (4.3). A plain value fits a `field()` field or a per-key param; a secret fits a secret field only (5.2).
3. **Load runs the root's body.**
   - The constructor checks the name (5.2).
   - `provision()` returns a copy of the node's value that records the node's address (4.2). A duplicate id fails, naming the node already at that id (4.4).
   - Load refuses a malformed value resource (4.1), and a value resource provisioned outside an `appRoot()` body through a cast (4.3).
   - Load reads nothing from the app configuration except the root's input (4.5).
   - After resolving values, Load builds the reads list and adds each secret node to the graph's secret sources (4.6).
4. **The graph check runs.** It refuses two nodes with one name, a node and a root input field with one name, and a node value bound as a service's whole input (5.4).
5. **Deploy runs.**
   - The node's descriptor creates nothing. The application topology and the deploy report leave the node out (5.3).
   - The serializer writes a `$platform` marker for each node value, plain or secret, and a pointer row for a plain node in a per-key param (5.5).
   - Preflight checks that each required variable has a row, and reports the variables with no value, including nodes no service reads (5.5, 5.7).
6. **Boot reads the value.** It reads the marker or the pointer row, as in slice 2. Nothing changes at boot (5.5).
7. **`prisma dev` fills the values.** The target's dev preflight reads each plain node's text from the app configuration. `prisma dev` writes those texts into the app configuration file for the second process (5.6).

## 4. Core

### 4.1 A resource can be a value

A platform variable must be a node in the graph, and provisioning it must give the author a value to bind. Core supports this with one new kind of resource node, the value resource.

A value resource keeps its value hidden inside the node. Only `provision()` can take it out. So no module can use a platform variable without provisioning it, and only the app root can provision one (4.3).

What an implementer needs:

- The node is a `ResourceNode` that holds its value under a symbol key, `VALUE_RESOURCE`, declared in `packages/0-framework/1-core/core/src/value.ts` beside `VALUE_ORIGIN`.
- The key is `Symbol.for('prisma:value-resource')`, like the other brands, so `isValueResource()` works across two installed copies of core.
- As with `NODE` in `node.ts`, only the key's type is exported (`export type { VALUE_RESOURCE }`, from `@prisma/composer` and `@internal/core`). Declaration files that name `ValueResourceNode`, such as the target's, can then be built. The key's value stays internal.
- The node has no public member that holds the value. Only `provision()` reads the key.

```ts
type SourceValue = (SecretSource | ParamSource) & RuntimeValue<unknown>;
type ValueResourceNode<V extends SourceValue = SourceValue> = ResourceNode<undefined, Record<never, never>> & { readonly [VALUE_RESOURCE]: V };

export function valueResource<V extends SourceValue>(def: {
  readonly name: string;
  readonly extension: string;
  readonly type: string;
  readonly props?: ResourceProps;
  readonly value: V;
}): ValueResourceNode<V>;

export function isValueResource(node: unknown): node is ValueResourceNode;
```

- `SourceValue` is a secret source or a param source. After 4.5 every source is known only at boot.
- `valueResource()` builds a frozen resource node with no `provides`, no `inputs` and no `deps`. It throws when `value` is not a source.
- `isValueResource()` is true for a resource node that holds a source under `VALUE_RESOURCE`.
- Both functions are exported from `@prisma/composer` and `@internal/core`.
- `extension` means what it means on every node (ADR-0017): the extension whose registry holds the node's descriptor. A value resource has a descriptor like any other resource (5.3).
- A value resource takes no `deps`, `input`, `params` or `secrets` on `provision()`, like every resource today.

An extension can build a node without `valueResource()`, so Load also refuses a value resource that breaks these rules. It fails with `COMPOSE.GRAPH_INVALID`:

```text
Resource "<address>" is a value and also <provides a contract | declares dependency slots>. A resource that is a value provides no contract and has no dependencies.
```

### 4.2 What `provision()` returns for a value resource

Each provisioned value must carry the address of the node it came from. Load uses that address to find which service reads which node (4.6).

`provision(node)` returns a copy of the node's value. The copy records the node's address, and has `id` set on it. It behaves like every other source: turning it into text in a body throws, and it is frozen.

What an implementer needs:

- **The copy.** The `provision` closure in `load-module.ts` builds it with `buildSource`. The copy has the same brand, payload and pointer kind as the node's source. Its origin has the original origin's `sourceKind`, `label` and `secretsKey`, plus `resource`, the node's full address.
- **What `buildSource` gives the copy.** It sets `origin.source` to the copy itself, so `restore` and `canonicalSecret` in `resolve-values.ts` recover the copy, not the node's own source. It installs the `toString`, `valueOf` and `Symbol.toPrimitive` traps, so `${value}` in a body throws the source-misuse error.
- **`resource` on the origin.** Both source variants of `ValueOrigin` in `value.ts` gain `readonly resource: NodeId | undefined`. A source no node provisioned, such as a `generatedParam()`, has `undefined`.
- **`id`.** The node's full address, such as `shop.emailFrom`, like every other `provision()` return. It is a non-enumerable property defined before the copy is frozen, so walkers and `JSON.stringify` of bindings see no new key.
- **Two provisions, two copies.** Each provision builds its own copy, so `secretUses` (keyed by `origin.source`) keeps one entry per provision.

### 4.3 Only the root provisions a value resource, and the compiler enforces it

A value resource names something outside the app, which the operator supplies. Those names form one space per deployed app. The app root is the app, so it is the one module whose scope matches that space. A module below the root declares what it needs in its input instead, and the app's author wires the value down.

The provision types change as follows.

**`ModuleBuilder['provision']`** (a `module()` body).

- Its resource overload becomes `ResourceNode<C> & { readonly [VALUE_RESOURCE]?: undefined }`, so a value resource no longer matches it.
- The last overload, the catch-all, takes the refusal in its parameter type. This is the pattern `NotDeployTime` and `ModuleInputIsNotAValue` use in `value.ts`:

  ```ts
  type OnlyInAppRoot = "Only appRoot() can provision a resource that is a value, such as a platform variable. Provision it in the app root and pass its value down through this module's input.";

  provision<N extends ServiceNode | ModuleNode | ValueResourceNode>(
    node: N extends ValueResourceNode ? OnlyInAppRoot : N,
    ...args: ProvisionArgs<N>
  ): ProvisionedRef<ExposeOf<N>>;
  ```

- `ProvisionArgs<N>` gains a value resource case, `[opts?: { id?: string }]`. This makes `provision(variable(…), { id: 'x' })` show the same message. Without it, TypeScript infers `N` as a service, and the error names a missing property instead of `appRoot()`.
- What TypeScript reports, with the repo's TypeScript 6.0.3:
  - For `provision(v, { id: 'x' })`, it reports only the last overload's error.
  - For the one-argument `provision(v)`, it lists the two overloads that take one argument, the resource overload and the catch-all. The catch-all's line carries the text.
  - In both cases the message reads `Argument of type '…' is not assignable to parameter of type '"Only appRoot() can provision a resource that is a value, …"'`.
  - A service, a module and a plain resource still match their own overloads.

**`AppRootContext['provision']`** (an `appRoot()` body) becomes its own type instead of `ModuleBuilder['provision']`. It has every `ModuleBuilder` overload, plus, first:

```ts
provision<V extends SourceValue>(node: ValueResourceNode<V>, opts?: { readonly id?: string }): V & { readonly id: string };
```

**Run time.** The `provision` closure in `load-module.ts` returns the copy from 4.2 for a value resource. A cast can get a value resource past the types into a body whose module answers `isRoot()` false. Then Load fails with `COMPOSE.GRAPH_INVALID`:

```text
Module "<module address>" provisions "<id>", a resource that is a value. Only the app root, built with appRoot(), can provision one. Provision it in the root and pass its value down through this module's input.
```

**A `module()` root.** An entry built with `module()` is accepted, as slice 1 decided. It is not an app root: its body uses `ModuleBuilder`, and `isRoot()` is false. So it cannot provision a value resource, at compile time or at run time. The error names `appRoot()` as the fix. An app that names a platform variable must therefore have an `appRoot()` root.

**The error text is tested.**

- A type test with `@ts-expect-error` proves the call does not compile, with and without `{ id }`.
- A second test compiles a small fixture with the TypeScript compiler API and checks that the diagnostic contains `appRoot()`. So a later change to the overloads cannot drop the hint silently.
- The existing catch-all error tests (`app-root.test-d.ts` and the binding-key messages) must still pass. The catch-all's messages are what users see for every bad service or module call.

### 4.4 Duplicate provision ids

A platform variable's default id comes from its name (5.2), so two names can give one id. The user then sees a duplicate id that appears nowhere in their code. The error must name what already holds the id.

The duplicate-id error in `load-module.ts` changes for every node, because core cannot tell which nodes take a derived id. It names the node already at that id, from `byId`:

```text
Duplicate provision id "<id>" in module "<module address>": "<address>" already holds <what>. Give one of them a different id with provision(node, { id: '…' }).
```

- `<what>` is the source's label for a value resource, such as `the platform variable "EMAIL_FROM"`.
- `<what>` is `<kind> "<name>"` for any other node.
- Its tests in `module.test.ts` and `module-composition.test.ts` change with it.

### 4.5 No source reads the app configuration

After this slice, Load reads the app configuration for one thing only: the root's input. No source carries an app configuration key any more. Today only `envParam()` builds such a source, so when it goes, core's support for it goes too. A param source is then always known only at boot, and its value at deploy is a pointer.

Root input fields do not use any of this. Load fills them through the root's schema and records them in `rootInput`, separately from the configuration keys sources read. The check that a root input field and a secret do not share a name stays (4.6).

What core removes:

- **The option.** `ParamSourceOptions.configurationKey` in `node.ts`, and `paramSource()`'s checks on it: the non-empty check and the "not both `configurationKey` and `redacted`" check. `paramSource()` sets the pointer kind from `redacted` alone.
- **The origin field.** `configurationKey` on the param variant of `ValueOrigin` in `value.ts`.
- **The deploy-time branch of the misuse message.** `sourceMisuse()` in `node.ts` keeps only the "known only at boot" text.
- **Reading configuration keys in `resolve-values.ts`.** The `configurationText` helper, the `keysRead` map, the `source` case's branch that reads a key, the `computed` case's message about an unset configuration key, and the loop in `appConfigurationReadOf` that re-reads keys for kept bindings.
- **The check between a configuration key and a secret.** `appConfigurationReadOf` refuses a key that a source reads from the app configuration when a secret names it. No source reads a key any more, so this check goes. Its other check stays: a root input field and a secret with one name.
- **The record of key texts.** `AppConfigurationRead.configurationKeyText` in `graph-types.ts`. `AppConfigurationRead` becomes `{ rootInput }`. `load-service.ts` builds it without the field.

What core renames:

- **The texts a local deployment reads.** `LocalTargetProvidersInput.configurationKeyText` in `control/app-config.ts` becomes `plainVariableText`, and so does `localTargetProviders()`'s parameter in `control/local-target.ts`. It holds the text of each plain platform variable a service reads, which the target's dev preflight found (5.6). Its doc comment reads: "Text of each plain platform variable a service reads, by name. Never a secret." The name says the values are plain, because platform secrets travel in memory as named secrets and are never written to a file (ADR-0058). The doc comment of `namedSecrets` beside it, which says "the graph's `envSecret()`s", says "the graph's platform secrets".

What core rewords, because it names a removed function:

- the `resolve()` refusal of a returned source in `resolve-values.ts`, which says "such as envSecret() or envParam()";
- the refusal of `secrets` on a service's `provision()` in `load-module.ts`, which says a service takes its secrets "as envSecret(...) leaves". It now says the service takes its secrets as values bound to `secretString()` fields of its `input` binding;
- the unbound-param error in `control/deploy.ts`, which suggests "e.g. envParam('NAME')". It now says "a literal value or a value such as a platform variable";
- the doc comments that name either function: `value.ts` (the `Value` and origin comments), `node.ts` (`SecretSource`, `SourceOptions`, `SecretSourceOptions`, `ParamSource`, `paramSource()`, `isParamSource()`), `config.ts`, `graph-types.ts`, `control/app-config.ts` (including line 274, "Value sourcing (secrets/env-params)") and `control/deploy.ts`.

This is a breaking change to core's public extension interface: a target that passed `configurationKey` to `paramSource()` must read the value through a root input field instead. No target outside this repository is known to pass it. The release note says so (8).

### 4.6 The reads relation

The graph must show, without deploying, which services read each platform variable node (R1). Preflight and `prisma dev` use the same list to find each node's readers.

`Graph` gains one list, `valueReads`. Each entry says that one service reads one node's value, and where in the service's binding it reads it:

```ts
interface ValueRead {
  readonly reader: NodeId;     // the service whose resolved binding holds the value
  readonly resource: NodeId;   // the address of the value resource
  readonly site: { readonly kind: 'serviceInput' | 'param'; readonly path: string };
}
readonly valueReads: readonly ValueRead[];
```

- `site.kind` uses the names core's `ValueBindingSite` already gives these two places: `serviceInput` for the service's input binding, and `param` for a per-key param.
- `site.path` is the dot-joined key path inside the input binding, `''` for the whole binding, or the param's name.
- Load builds the list after `resolveValues`. It walks each service's resolved input binding and per-key params at any depth, through objects and arrays. It records every source whose origin has a `resource`.
- A value passed through any number of module inputs still carries the address, because `restore` puts back the provisioned copy.

**Secret nodes in the graph's secret sources.** A secret node must be a known secret even when nothing binds it, so its value is redacted. So `Graph.secretSources` also holds every secret value resource.

- `resolveValues` takes the provisioned copies as a new input, `valueResources: ReadonlyMap<NodeId, SourceValue>`.
- Before it collects any binding, it inserts each secret one into `secretUses`: `{ source: <the copy>, address: <the node's address>, nodeKind: 'resource' }`.
- A service that reads it replaces that entry with the service, as `secretSourcesReceivedBy` does today.
- A module that receives it, when no service reads it, leaves the node's entry in place, because `recordSecret` keeps the first entry.
- `appConfigurationReadOf` iterates `secretSources`, so core's check of a root input field against a secret covers an unread secret node too.
- `secretsKeys(graph)` includes every platform secret the root provisions.

The doc comments change to match:

- `Graph.secretSources` is "every secret source a binding names, and every secret value resource, once each".
- `SecretSourceUse.address` is "a service whose final binding holds it, if one does; otherwise the secret value resource itself, or the module whose input holds it".

## 5. The Prisma Cloud target

### 5.1 The payload

Every platform variable value carries the same payload: the variable's name and whether it is a secret. The serializer, preflight and `prisma dev` read the name from it.

What an implementer needs. The payload lives in `packages/1-prisma-cloud/1-extensions/target/src/platform-variable.ts` (new):

```ts
interface PlatformVariablePayload {
  readonly [PLATFORM_VARIABLE]: true;
  readonly name: string;
  readonly secret: boolean;
}
```

- `PLATFORM_VARIABLE` is a `Symbol.for` brand, as the removed `envSecret()` and `envParam()` brands were.
- `isPlatformVariableSource(value)` is true for a source with this payload, plain or secret.
- `platformVariableName(source, where)` returns the name. It replaces `secretName()`. A source without the payload fails, naming `where`:

  ```text
  <where> is bound to a source that is not a platform variable. Provision variable() or variable.secret() from @prisma/composer-prisma-cloud in the app root and pass its value down.
  ```

- `paramName()` in `param.ts` accepts a plain platform variable source and returns its name. It refuses any other source with the same kind of message, naming the param slot and the service.
- `platformVariableName` is internal. `paramName` stays exported from `@prisma/composer-prisma-cloud`.

### 5.2 The constructors

The constructors are how the author declares a platform variable. They are in `platform-variable.ts`, exported from `@prisma/composer-prisma-cloud`. `variable` is a function with a `secret` property, built with `Object.assign`:

```ts
export const variable: {
  (options: { readonly name: string }): ValueResourceNode<ParamSource<PlatformVariablePayload> & RuntimeValue<string>>;
  secret(options: { readonly name: string }): ValueResourceNode<SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString>>;
};
```

**Name.** Each constructor calls slice 2's `assertVariableName(name, factory, example)`, with `factory` set to `variable` or `variable.secret`. So a bad or reserved name fails when the root's body runs, with slice 2's messages. `assertVariableName` gains the `example` argument, because its empty-name message writes `${factory}('API_KEY')`, which is wrong for `variable({ name: 'API_KEY' })`.

**The node.** Built with core's `valueResource()`:

- `type: 'prisma-cloud/platform-variable'`;
- `extension` the Prisma Cloud extension;
- `props: { name, secret }`;
- `value` the source.

**The node's `name`** is its default provision id. It is the variable's name in camel case: split on `_`, drop empty parts, lower-case each part, capitalise each part after the first.

- `EMAIL_FROM` → `emailFrom`, `SMTP_PORT` → `smtpPort`, `EMAIL_2FA` → `email2fa`, `A__B` → `aB`.
- An explicit id goes on `provision(node, { id })`.

**The source.**

- `variable()` builds a plain source with `paramSource(payload, { label: 'the platform variable "NAME"' })`. So its value at deploy is a pointer.
- `variable.secret()` builds `secretSource(payload, { label: 'the platform secret "NAME"', secretsKey: name })`. So its value is a known secret, and it reaches `prisma dev`'s second process as a named secret.
- Core's messages print the label where they name a source. For example: "Bind the platform variable "EMAIL_FROM" directly into the input of the service that reads it". So the label names what the user binds, not the constructor call.

**Types.**

- `provision(variable({ name }))` is `ParamSource<PlatformVariablePayload> & RuntimeValue<string> & { readonly id: string }`. That is the same shape as `serviceOrigin()`, plus `id`. It fits a `field()` field. Because it is a `ParamSource`, it also fits a per-key param in `ParamBindings`.
- `provision(variable.secret({ name }))` is `SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString> & { readonly id: string }`. It binds to a `secretString()` field until module-input S18 ships `secret(inner)`.
- A plain value in a secret field, and a secret in a `field()`, already fail to compile, because the pointer kinds differ (`sources.test-d.ts`).
- A secret node does not compile in per-key params, because `ParamBindings` admits no secret source.

### 5.3 The descriptor, the deploy report and the application topology

The node must be lowered like every other resource, but it creates nothing and must not look as if it did.

- **Descriptor.** `descriptors/platform-variable.ts` registers `prisma-cloud/platform-variable` in `prismaCloud().nodes`. Its lowering returns `{ outputs: {}, entities: [] }`. It creates nothing and writes no row. The local target registers the same lowering.
- **One lookup, as ADR-0017 records.** The deploy walk and registry coverage treat the node as every other resource: one lookup, `extensions[node.extension].nodes[node.type]`, with no special case. ADR-0017 does not change.
- **The deploy report.** The lowering loop in `packages/0-framework/1-core/core/src/control/deploy.ts` adds no report entry for a value resource, using `isValueResource()`. So the printed deploy report and the deploy command's table have no empty line for the node. An empty line would read as something Composer deployed. Unread nodes still appear in the preflight findings (5.7).
- **Topology.** `composeApplicationTopology` in `packages/1-prisma-cloud/0-lowering/lowering/src/builds/application-topology.ts` skips every value resource, using `isValueResource()`. The node is not sent to the platform's application topology. The platform has no node kind for it, and Composer owns nothing it names. A value resource has no slots and no ports, so no edge or port points at it.
- **Other readers of `graph.nodes`.** `env-key-clash.ts`, `public-url.ts`, the local target's emulators, and the dev server and watch lists in the CLI each select nodes by kind or type. None selects `prisma-cloud/platform-variable`, so they need no change.

### 5.4 The graph check

These rules span more than one node, so they run in the graph check, not in a constructor.

- Each runs on the loaded graph, after Load, in `deploy`, `destroy` and `prisma dev`.
- Each fails with `GraphCheckError` (`COMPOSE.GRAPH_INVALID`).
- Each error names the variable and every address involved.
- The platform variable nodes are the value resources in `graph.nodes`. Each node's name is `props.name`.

`graph-check.ts` holds the three rules below. Slice 2's rule there, which refuses an `envParam()` and a root input field with one name, is replaced by rule 2.

#### Rule 1. One node per name

Two platform variable nodes with one variable name fail, whatever their ids, and whether each is plain or secret.

```text
The platform variable "EMAIL_FROM" is declared twice in the app root, by "shop.emailFrom" and "shop.sender". Declare each platform variable once and pass its value to every module that needs it.
```

When one node is plain and the other secret, the message adds: `"shop.emailFrom" is plain and "shop.sender" is a secret.`

- Two nodes with one name and the default id get the same id. So Load's duplicate-id error (4.4) fires first, and this rule does not run.
- The same node object provisioned twice with two explicit ids is two declarations, and fails here.
- The same node object provisioned twice with the default id fails the duplicate-id error.

#### Rule 2. A node and a root input field with one name

A name is either a value the service reads at boot or a value the deploy reads. A platform variable node and a root input field with one name would be both.

| Node | Other use of the name | Who refuses it |
|---|---|---|
| Plain node | Root input field | The graph check, with the message below |
| Secret node | Root input field | Core's existing check in Load (`appConfigurationReadOf` in `resolve-values.ts`), also when no service reads the node (4.6) |
| Any node | Another node | Rule 1 |

The graph check's message:

```text
"EMAIL_FROM" is used two ways: as the platform variable "shop.emailFrom", which services read at boot, and as input.EMAIL_FROM of root module "shop", which the deploy reads. A name has one meaning in an app. Use one of them, or give the other a different name.
```

The rule finds root fields in `graph.appConfigurationRead.rootInput`, by each field's first path segment.

#### Rule 3. A service's whole input

A node value bound as a service's whole input fails. The rule reads `valueReads` entries with `site.kind` `serviceInput` and `site.path` `''`:

```text
The platform variable "EMAIL_FROM" is bound as the whole input of service "shop.email.service". Bind it to one field of the input instead.
```

The other places a node value may not go are refused elsewhere:

- The compiler refuses a node value in a `resolve()` dependency, in a plain field (a schema member written without `field()`), and in a field of the other secrecy.
- Core's Load refuses a `resolve()` dependency and a resource's props at run time.
- A plain field reached through a cast is refused by the service's own schema at serialize or preflight. 5.5 adds the variable's name to that error.

### 5.5 Serializer, preflight, per-key params and boot

Slice 2's code handles a node's value, with these changes.

**Serializer** (`serializer.ts`).

- `resolveInputBinding` keeps a platform variable source in place, plain or secret.
- It refuses any other param source except `generatedParam()` and `serviceOrigin()`, naming the platform variable nodes as the fix.
- `substitutePointers` calls `platformVariableName()` and writes `platformMarker(name, secret)`.
- The serializer no longer reads the app configuration. The `envParam()` branch of `resolveInputBinding` and the `env` member of `SerializeInputOptions` go (5.8).

**The leave-out option.** `absentSecrets` becomes `absentVariables`, and covers plain platform variables too. A variable named in it is left out of the document, as an unset secret is today. It is renamed in its writer and its reader together:

- `SerializeInputOptions` in `serializer.ts`;
- `required-variables.ts`;
- the dev preflight in `local-target/preflight.ts`;
- the dev payload's writer and parser in `control/preflight-payload.ts`;
- its reader in `descriptors/compute.ts`.

**Schema failure naming the variable.** `standardValidate` in `serializer.ts` keeps each issue's path, not only its message. The service's schema may refuse its input with an issue whose path equals a platform variable's path in the binding, or lies under it. Then the error ends with `The field "<path>" reads the platform variable "<NAME>".`

**Per-key params.** A plain node in a service's per-key params writes a pointer row read at boot.

- The descriptor's `serialize` in `descriptors/compute.ts` writes `encodeParamPointer(paramName(…))` for any param source. `paramName()` reads the plain node's name (5.1).
- `envParamBindings()` in `preflight-names.ts` becomes `perKeyVariableBindings()`. It returns every per-key param bound to a plain node. So deploy preflight checks the row, and dev fills it.

**Deploy preflight names** (`preflight.ts`, `preflight-names.ts`).

- `inputSecretNames()` becomes `inputVariableNames()`. It returns plain and secret platform variable names from the same walk of each service's binding. So preflight does not serialize a service to find them. An invalid input still fails after preflight reports the platform variables, as in slice 2.
- The dev preflight uses the same function.
- The names also include every node no service reads: the value resources not in `valueReads`.
- `checkRequirements` leaves plain ones out through `absentVariables`.
- Existence, resolution, triggers, the required error and the findings are slice 2's, unchanged.

**Unread variables, each once.** Preflight finds unread variables only from the value resources not in `valueReads`. Their reader is `{ kind: 'unread', node: <the node's address>, nodeKind: 'resource' }`. Preflight no longer reads `secretSources` for this. So a secret node that a module receives and no service reads is listed once, named by its node.

**Boot.** Unchanged. The input-document package already reads plain markers, and boot already reads a per-key pointer row.

**Messages that name a removed function.** Each now names the platform variable node:

- the array-position message in `serializer.ts`, which calls `platformVariableName()` and covers plain and secret nodes;
- the binding walk's refusal of a value that is not plain data (`serializer.ts`), which says a binding's leaves are literals, `envParam(...)` or `envSecret(...)`, and to "bind envSecret('NAME') instead";
- the schema-failure note in `serializeInput`, which says "envSecret() included";
- the `SecretBox` refusal in `serializer.ts` and core's `refuseSecretBoxes`;
- the `where` texts that `preflight.ts` and `preflight-names.ts` pass to `platformVariableName()`;
- the app configuration file's known-secret refusal in `cli/src/app-configuration-file.ts`, which says "which an envSecret() in the graph reads" and whose fix says "Read the secret with envSecret('NAME')". It now says "which a platform secret in the graph reads", and the fix says to provision `variable.secret({ name: 'NAME' })` in the app root;
- the doc comments of `cron()` in `packages/1-prisma-cloud/2-shared-modules/cron/src/module.ts` and `auth()` in `auth/src/auth-module.ts`, which name `envSecret(...)` and `envParam(...)`.

### 5.6 `prisma dev`

Under `prisma dev`, Composer plays the platform's part: it gives each service the value of each plain node it reads. The target's dev preflight reads the values from the app configuration, and the CLI hands them to the second process in the app configuration file. This one path serves a plain node in an input field and in a per-key param.

**Filling a plain platform variable.** The target's dev preflight, `runDevPreflight` in `local-target/preflight.ts`, runs in the first process with the app configuration. For each plain node a service reads (from `valueReads`), it reads the app configuration under the variable's name, once, with the existing `configuration-text.ts` helper. It decides one of three outcomes:

- **Text.** The name and text go into the texts it returns. The value joins `pointerVersions`, so a changed value restarts only its readers.
- **Unset or empty.** What happens depends on where each reader reads it, from the reader's `valueReads` entries:
  - **An input field.** The name joins `absentVariables`, so the dev document leaves the field out, as for an unset secret. `checkRequirements` decides whether the service's schema needs it, as in slice 2.
  - **A per-key param.** The loop judges the param with `paramIsRequired`. A required one is reported with `requiredParam` and stops dev, as the deleted `envParam()` loop did. An optional one, or one with a default, is skipped: the second process writes no text for it, so the param takes its default or is left out. A per-key read has no marker in the input document, so the name joins `absentVariables` only when an input field also reads it.
- **Present but not text.** `prisma dev` stops before any service starts:

  ```text
  The `config` adapters return a number for "SMTP_PORT", not text. prisma dev cannot start, because the platform variable "shop.smtpPort", which service "shop.mail.service" reads, takes text. Make the adapter return a string.
  ```

  With several readers it says `which services "shop.mail.service" and "shop.digest.service" read`.

The per-key `envParam()` path in the dev preflight, and its message `envParamNotTextError`, go (5.8). `paramIsRequired` and `requiredParam` stay, used by the plain node loop.

**How the texts reach the second process.** The app configuration file holds the root's input, as today, and a new top-level member for these texts. Load's record of what it read stays as it is, so it still shows that Load read no platform variable's value.

- `LocalTargetDescriptor.preflight` in `packages/0-framework/1-core/core/src/control/app-config.ts` returns `Promise<DevPreflightResult>`, `{ readonly payload: PreflightPayload; readonly plainVariableText: Readonly<Record<string, string>> }`, with the same doc comment as in 4.5,, instead of `Promise<PreflightPayload>`. The deploy preflight's type does not change.
- `executeDev` in `cli/src/operations/execute-dev.ts` keeps the texts from the start-time preflight. It passes them to `prepareSecondProcess` in `cli/src/app-configuration-file.ts` as a new input, `plainVariableText`, on the first converge and on every rebuild. The deploy passes `{}`.
- `prepareSecondProcess` writes the file as `{ appConfigurationRead: { rootInput }, plainVariableText, nodeAddresses }`. It runs `refuseSecretsIn` on the root's input and on `plainVariableText` before it writes. So every plain value is checked against the known secrets. A plain value equal to a secret's value fails with `CONFIG.SECRET_AS_PLAIN_VALUE`. For a member of `plainVariableText`, `refuseSecretsIn` names the place as the platform variable, not as a configuration key, which this slice removes:

  ```text
  The platform variable "EMAIL_FROM", which prisma dev read from the `config` adapters, holds the value of the secret "EMAIL_DELIVERY_CREDENTIAL". Composer hands the second process every plain value in a file, and never writes a secret to a file.
  Fix: keep the value of "EMAIL_DELIVERY_CREDENTIAL" out of the platform variable "EMAIL_FROM", or give "EMAIL_FROM" a different value.
  ```
- `readAppConfigurationFile` returns `plainVariableText` beside `appConfigurationRead` and `nodeAddresses`, and refuses a file without it.
- The generated dev stack (`cli/src/dev/generate-dev-stack.ts`) passes `file.plainVariableText` to `localTargetProviders()`, in place of `file.appConfigurationRead.configurationKeyText`.

**The second process.** The local target fills a plain `$platform` marker and a per-key pointer from `plainVariableText`, and a secret marker from the named secrets. In `packages/1-prisma-cloud/0-lowering/local-target/src/compute.ts`, `materializeEnv` takes `plainVariableText` where it took `configurationKeyText`. The lookup is the same.

**Isolation, the missing-value rule and restarts.** These are slice 2's, extended to plain variables. The dev preflight's requirement check uses `absentVariables`. A changed value pauses rebuilds until `prisma dev` restarts, as `sameValues` already does for any change to the app configuration.

**A node added while `prisma dev` runs.** A rebuild after a code change runs no preflight, as today. So a plain node the change adds gets its value when `prisma dev` restarts. This is recorded in `deferred.md` (section 10).

Load reads no platform variable's value, so the deploy reads none.

### 5.7 The deploy report and findings

A platform variable node no service reads is reported in "Platform variables with no value", with the existing `unread` reader: `named by resource "shop.emailFrom", read by no service`. It is not required. The node has no line among the deployed resources (5.3).

### 5.8 What the removal deletes in the target

`envSecret()` and `envParam()` go, with everything that exists only for them. `generatedParam()` and `serviceOrigin()` stay.

- **`secret.ts`.** The whole file: `envSecret()`, `EnvSecretPayload`, its brand, `isEnvSecretPayload()` and `secretName()`. `platformVariableName()` in `platform-variable.ts` replaces `secretName()` for every caller.
- **`param.ts`.** `envParam()`, `EnvParamPayload`, its brand, `isEnvParamPayload()` and `isEnvParamSource()`. `paramName()` stays and reads a plain node (5.1). The doc comments that call `generatedParam()` "the sibling of `envParam`" are reworded.
- **`exports/index.ts`.** The exports `envParam`, `envSecret` and `secretName` go. `variable` and the `PlatformVariablePayload` type are added.
- **`graph-check.ts`.** `EnvParamUse`, `bindingUses()`, `envParamUses()` and the `envParam()` against root input field rule. Rule 2 replaces it (5.4).
- **`preflight-names.ts`.** `envParamNotTextError`, `EnvParamBinding` and `envParamBindings()`. `perKeyVariableBindings()` replaces the last (5.5).
- **`local-target/preflight.ts`.** The loop over `envParamBindings()` that reads each per-key `envParam()` from the app configuration or, for a name a secret also uses, from the app secrets. The plain node loop in 5.6 replaces it.
- **`serializer.ts`.** The `envParam()` branch of `resolveInputBinding`, which reads the app configuration at deploy; the `env` member of `SerializeInputOptions` and its default, `process.env`; the import of `configuration-text.ts`; the `envParam()` case of `absentArrayPositionError`.
- **`descriptors/compute.ts`.** The `env: ctx.opts.appConfigurationRead.configurationKeyText` passed to `serializeInput`.
- **`required-variables.ts`.** `checkRequirements` loses its `env` parameter, which it passed only to the serializer for `envParam()` leaves. Its two callers, `preflight.ts` and `local-target/preflight.ts`, stop passing the app configuration.
- **The deploy preflight's input.** After this, the Prisma Cloud deploy preflight reads nothing from `PrismaCloudPreflightInput.configuration`. The member stays: it comes from core's `PreflightInput`, which every extension's preflight receives, and the dev preflight still reads the app configuration.
- **`configuration-text.ts`** stays. Only the dev preflight uses it now.

## 6. Examples

The examples show the two ways to get a value, so new apps copy them.

- **`examples/email`.** `envSecret('EMAIL_DELIVERY_CREDENTIAL')` becomes `provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }))` in the root. `EMAIL_FROM` is already a root input field and stays one. The doc comment in `module.ts`, `tests/secret-bindings.ts` and `tests/module.test.ts` (which imports `secretName`) use the node. The tests find the binding's variable through the public graph: they look up the entry in `graph.valueReads` by reader and site path, take the node at its `resource` from `graph.nodes`, and read `props.name`. `platformVariableName` is internal, so the examples cannot import it.
- **`examples/auth`.** `envParam('EMAIL_FROM')` becomes `provision(variable({ name: 'EMAIL_FROM' }))`, and `envSecret('EMAIL_DELIVERY_CREDENTIAL')` becomes `provision(variable.secret(…))`. `EMAIL_FROM` is now read from the platform at boot, not from the deploy's shell. The doc comment in `module.ts` and `.env.example` say where to set it. `tests/module.test.ts` stops importing `secretName` and asserts through `graph.valueReads` and the node's `props.name`, as `examples/email` does.
- **`examples/storefront-auth`.** `envSecret('AUTH_SIGNING_SECRET')` becomes `provision(variable.secret({ name: 'AUTH_SIGNING_SECRET' }))`. The comment in `modules/auth/src/service.ts` changes with it. `module.test.ts` stops importing `secretName` and asserts through `graph.valueReads` and the node's `props.name`, as `examples/email` does. The CI flow from slice 2 is unchanged.
- **`examples/env-param` becomes `examples/root-input`.** Its `envParam('ENV_PARAM_GREETING')` in a service binding becomes a root input field, `ROOT_INPUT_GREETING`, declared in the root's `input` schema and passed to the service. The example keeps its meaning: a value the deploy reads from the shell, different per environment. Every file that names it changes:
  - the directory, `examples/env-param` → `examples/root-input`;
  - `package.json`: the package name `@prisma/example-env-param` → `@prisma/example-root-input`, the turbo filter in its `deploy` script, and the variables `ENV_PARAM_STACK_NAME`, `ENV_PARAM_ENVIRONMENT` and `ENV_PARAM_REPORT` → `ROOT_INPUT_…`;
  - `module.ts`: the app name `env-param-example` → `root-input-example`, and the doc comment, rewritten to describe a root input field;
  - `src/service.ts`: the doc comment that says `greeting` is bound "via `envParam`";
  - `scripts/smoke.ts`: its doc comment, the default stack name, the `ENV_PARAM_…` variables, the asset marker `prisma-composer-env-param-asset`, and the sentence that says the greeting is what "the platform var carries", which becomes the deploy shell's value;
  - `src/assets`, wherever it holds the asset marker;
  - `pnpm-lock.yaml`, regenerated with `pnpm install`;
  - `docs/guides/building-an-app.md`, its three links to `examples/env-param`;
  - the comment in `test/integration/test/fixtures/local-dev/built/web-server.mjs` that names `examples/env-param`.

  No CI workflow names the example. Its deployed stack has a new name, so the old `env-param-example` stack on the test workspace is destroyed by hand once, with the old name.
- **The integration fixture** `test/integration/test/fixtures/local-dev/module.ts`. Its two `envSecret()` calls become two secret nodes, `LOCALDEV_FIXTURE_API_KEY` and `LOCALDEV_FIXTURE_WEBHOOK_SECRET`. Its per-key `envParam('LOCALDEV_FIXTURE_GREETING')` becomes a plain node. The doc comment changes with them. `test/integration/test/local-dev.integration.ts` and `local-dev-store.integration.ts` reword their comments that say "secret/env-param".
- **The CLI fixtures** `packages/0-framework/3-tooling/cli/src/__tests__/fixtures/pipeline-app-configuration/module.ts` and `pipeline-config-adapters/module.ts` build a raw `paramSource(…, { configurationKey: 'CONFIG_POOL_PROBE' })`. They move to a root input field, `CONFIG_POOL_PROBE`, which tests the same app configuration path. `stack-import/stub-composer.ts` changes its stubbed `readAppConfigurationFile` and `localTargetProviders` to the new file shape.
- **The shared modules.** The auth, cron and email modules write neither function in their code. Their READMEs (`auth/README.md`, `email/README.md`) and tests (`auth/src/__tests__/contract.test-d.ts` and `module.test.ts`, `cron/src/__tests__/module.test-d.ts` and `module.test.ts`, `email/src/__tests__/module.test-d.ts` and `module.test.ts`) move to values passed through the module's input. Where a test needs a secret or a plain value, its test root is an `appRoot()` that provisions a node and passes the value down. `auth/README.md`'s `envParam('AUTH_BASE_URL')` becomes `serviceOrigin()` or a root input field, whichever the surrounding text describes.

## 7. Records, guides and skill

Each record is rewritten in place as the current statement, with no history and no supersession notes. After this slice, every record, guide and the skill teach the two ways to get a value: a root input field for a value the deploy reads, and a platform variable node for a value the service reads at boot. No record names `envSecret()` or `envParam()`.

- **ADR-0062, Values section.** Core's record for values gains core's rules:
  - the value resource and its rules (4.1), `valueResource()` and `isValueResource()`;
  - root-only provisioning, with its core reason and its compile error (4.3);
  - the address on the origin (4.2);
  - the reads list (4.6);
  - no source reads the app configuration: `paramSource()` takes no `configurationKey`, and a configuration value is a root input field only (4.5).

  The table of runtime-value origins gains a third origin, a value resource given by `provision()`, and loses `envSecret()`. The list of deploy-time values loses `envParam('NAME')` in a binding. The list of sources on line 82 becomes `generatedParam()`, `serviceOrigin()` and a platform variable node's value. The app configuration file holds the root's input, and under `prisma dev` the platform variable texts. The check "a name that both an `envParam()` and an `envSecret()` read" goes; the check of a root input field against a secret stays. The code sample at the top uses a node. Its alternatives gain design section 15's rejection of a new node kind, with the reason that still holds: it changes core's node union. Its line in the ADR index changes with it.
- **ADR-0064.** Gains the Prisma Cloud use: the constructors, the default id, the graph check's rules, the per-key params rule, the serializer, preflight and dev handling of plain values, and design section 15's other alternatives. "The shortcuts" section is replaced by the two ways to get a value. "Names" says `variable()` and `variable.secret()` check the name. "One name has one meaning" lists the node and the root input field. The code sample uses a node. Its title stays: the deploy does not copy local values to what the nodes name. Its line in the ADR index changes with it.
- **ADR-0032.** A per-key param takes a literal or a plain platform variable node's value. The node's value writes a pointer row that the service reads at boot. The code sample provisions `variable({ name: 'APP_ORIGIN' })` in the root and binds it. The title stays: a platform variable is a target-owned source. Its line in the ADR index changes with it.
- **ADR-0029.** A secret is any value handled as one. A platform secret, built with `variable.secret()`, is the kind Composer never sees during a deploy. Its ADR index line changes with it.
- **ADR-0058.** The named secrets are the values under the secrets keys of the graph's secret sources, which are the platform secret nodes. The app configuration file it describes holds, under `prisma dev`, the text of each plain platform variable a service reads, in `plainVariableText`, checked against the known secrets like every other plain value. Its line in the ADR index changes with it.
- **ADR-0042, ADR-0039 and ADR-0061.** Every mention of `envSecret()` or `envParam()` becomes the node or a root input field. ADR-0042's marker says `secret: true` for a platform secret. Their lines in the ADR index change with them.
- **ADR-0041.** Line 39's "Value sourcing (secrets/env-params)" says "platform variables".
- **ADR-0063.** A service also reads a platform variable: a third relationship, recorded as `valueReads`, not as an edge.
- **ADR-0017.** Unchanged. The platform variable node has a descriptor and is looked up like every other node. Only the application topology and the deploy report skip a value resource.
- **ADR-0057 and the principle "A node's address is its identity, everywhere"** (`docs/design/01-principles/architectural-principles.md`). The rule stays as it is. Each gains one sentence: a node that names something Composer does not own, such as a platform variable node, records no platform row and no topology node, and the thing it names keeps its owner's handle, such as the variable's name. ADR-0057's line in the ADR index gains the same clause.
- **`design.md` line 161.** Per-key params leave the list of places a platform variable may not go (5.4).
- **Glossary.**
  - Rewritten: Platform variable, The app configuration file (it holds the root's input, and under `prisma dev` the text of each plain platform variable a service reads), Module (App), Core nouns, Resource, Topology, Address and logical ID, Input, Value, RuntimeValue, The app configuration (it fills the root's input; under `prisma dev` it also fills plain platform variables), The app secrets, Secrets key, Named secrets, Known secrets, and every other entry that names `envSecret()` or `envParam()`.
  - New: Platform variable node, Platform secret, Value resource, A variable on the platform, Root input field.
- **Domain map** (`docs/design/03-domain-model/domain-map.md`). "Every node carries a managed lifecycle" and "Configuration is not a node" gain the platform variable node, which names a value the operator sets.
- **Domain docs.** `docs/design/10-domains/config-params.md`, `core-model.md`, `deploy-cli.md`, `local-dev.md` and `module-composition.md`, wherever they name either function.
- **Guides.**
  - `docs/guides/building-an-app.md` teaches the two ways. Its `envParam('NAME')` section becomes a root input field section that links to `examples/root-input`. Its `envSecret()` passages become the nodes, with the mental model: a name, the services that read it, and where the operator sets it. It gives one sentence on why only the root provisions them: a platform variable names something outside the app, the names form one space per deployed app, and the root is the app.
  - `deploying.md` and `getting-started.md` show the nodes.
  - `running-locally.md` says a plain platform variable comes from the `config` adapters under `prisma dev`.
- **Skill.** `skills/prisma-composer-core-concepts/SKILL.md` teaches the two ways. It is staged with `scripts/stage-skills.mjs`, run from `packages/9-public/composer`.
- **Logs left as they are.** `gotchas.md` and `open-chat-port-friction.md` record past friction, so they keep the names they were written with.
- **The vendored skill is left as it is.** `.agents/skills/prisma-compute/references/` teaches both functions in five files. It is a copy of the `prisma-compute` skill from `prisma/skills`, recorded in `skills-lock.json`, so it changes upstream first. After `prisma/skills` changes, the copy is synced and `skills-lock.json` updated (`deferred.md`). Until then, agents in this repository can read the removed functions there.

### Terminology sweep

The two terms:

- "Platform variable" means a variable on the platform that a service reads by name at boot, declared by a node.
- "A variable on the platform" means any row, including Composer's `COMPOSER_` rows.

Most existing uses of "platform variable" stay correct, such as the boot errors in `document.ts`, the required-variables text, and the refusal of a name Prisma Cloud manages, in `preflight.ts` and `deploy-cli.md`.

These uses name rows the app does not declare, so they are wrong. They change to "a variable on the platform", or "variables on the platform":

- `packages/1-prisma-cloud/1-extensions/target/src/variable-name.ts`: "names starting with COMPOSER_ are Composer's own platform variables".
- `packages/1-prisma-cloud/1-extensions/target/src/container.ts`: "Removed the Project, with every platform variable set on it".
- `packages/1-prisma-cloud/0-lowering/input-document/src/document.ts`: "The platform variable "<name>", which the deploy writes, has no value" (a `$generated` row).
- The `Pointer` doc comments in `packages/0-framework/0-foundation/foundation/src/pointer.ts` and the `RuntimeValue` doc comment in `packages/0-framework/1-core/core/src/value.ts`, which say a pointer names the platform variable: a `generatedParam()` or `serviceOrigin()` pointer names a `COMPOSER_` row.
- ADR-0039 line 38: "PATCH the platform variable" (a `COMPOSER_` origin row).
- ADR-0042 line 54 and ADR-0062's Values section: a pointer "names the platform variable holding the data", for every pointer kind.
- `docs/design/05-prisma-cloud/alchemy-lowering.md` line 69: "The rows are plain platform variables" (the `DATABASE_URL` rows Composer claims).

## 8. The release note

The PR description carries this migration guide. Each case has a before and after.

**`envSecret()` and `envParam()` are removed.** A value the operator supplies now reaches the app in two ways. A value the deploy reads is a field of the app root's `input`. A value the service reads at boot is a platform variable node, provisioned in the app root. `environment.name`, `generatedParam()` and `serviceOrigin()` do not change. Nothing on the platform changes: each variable keeps its name and its rows.

**1. `envSecret('X')` in a binding becomes a secret node.**

```ts
// before
export default appRoot('shop', ({ provision }) => {
  provision(email(), { input: { deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') } });
});

// after
export default appRoot('shop', ({ provision }) => {
  const deliveryCredential = provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }));
  provision(email(), { input: { deliveryCredential } });
});
```

An `envSecret()` written in a module below the root moves to the root. The module declares a `secretString()` field in its input, and the root passes the value down.

**2. `envParam('X')` in an input binding becomes a root input field.** Its value is still read by the deploy from the `config` adapters, by default the shell.

```ts
// before
export default appRoot('shop', ({ provision }) => {
  provision(web, { input: { greeting: envParam('GREETING') } });
});

// after
export default appRoot('shop', { input: type({ GREETING: 'string' }) }, ({ input, provision }) => {
  provision(web, { input: { greeting: input.GREETING } });
});
```

An unset optional value: declare the field optional in the root's schema (`'GREETING?': 'string'`).

An `envParam('X')` written in a module below the root moves the same way: the module declares an input field, and the root reads `X` as a root input field and passes it down.

An `envParam('X')` was a value known at deploy, so it was also valid as a `resolve()` dependency and in a resource's props. There, use the root input field: `resolve([input.X], …)` or `props: { x: input.X }`. A platform variable node cannot go in either place, because its value is known only at boot.

**3. `envParam('X')` in a service's per-key params becomes a plain node.** The value still comes from the platform at boot, through the same pointer row.

```ts
// before
provision(web, { params: { appOrigin: envParam('APP_ORIGIN') } });

// after
const appOrigin = provision(variable({ name: 'APP_ORIGIN' }));
provision(web, { params: { appOrigin } });
```

**4. A root built with `module()` becomes `appRoot()`.** Only `appRoot()` can provision a node. An entry that is still `module('shop', …)` and names a platform variable must change to `appRoot('shop', …)`. `appRoot()` takes no `deps` and no `expose`, and its body receives `{ input, environment, provision }`. A `module()` root that declares either drops them: nothing provisions the root, so nothing wires its dependencies or reads what it exposes.

**Other changes.**

- **`secretName()` is removed.** No public replacement: the target reads a node's name itself. A test that used it to find which variable a binding reads finds the entry in `graph.valueReads`, takes the node at its `resource` from `graph.nodes`, and reads `props.name`.
- **The duplicate-id error** names the node already at the id and says to pass `id`.
- **For extension authors:** core's `paramSource()` no longer takes `configurationKey`. Read a deploy-time value through a root input field.

**Follow-ups in other repositories.** These are not work in this slice. Each repository moves when it upgrades Composer:

- Internal Prisma apps call the removed functions: the deploy apps in `prisma/streams`, and the apps in `prisma/asks`, `prisma/program` and `prisma/pdp-control-plane`.
- `prisma/skills` and `prisma/web` document them. This repository holds a copy of the `prisma-compute` skill from `prisma/skills`, under `.agents/skills/prisma-compute/`, which is synced after `prisma/skills` changes.

They are recorded in `deferred.md` (section 10).

## 9. Acceptance: expected behaviour and its tests

Everything below is observable without reading the code. Each item names its test. The numbers are stable, so reviews can refer to them; 9 and 10 are not used. Test files without a path are in the package the item belongs to:

- core: `packages/0-framework/1-core/core/src/__tests__/`;
- the target: `packages/1-prisma-cloud/1-extensions/target/src/__tests__/`;
- the CLI: `packages/0-framework/3-tooling/cli/src/__tests__/`.

### Root-only provisioning and binding types (4.3, 5.2)

- **1.** In an `appRoot()` body, `provision(variable({ name: 'X' }))` compiles and has type `ParamSource<PlatformVariablePayload> & RuntimeValue<string> & { readonly id: string }`. `provision(variable.secret({ name: 'X' }))` has type `SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString> & { readonly id: string }`. Test: target `platform-variable.test-d.ts` (new).
- **2.** In a `module()` body, at the root or below it, `provision(variable(…))` and `provision(variable(…), { id: 'x' })` do not compile, and the diagnostic contains `appRoot()`. Tests: core `value-resource.test-d.ts` (new, `@ts-expect-error`) and core `value-resource-diagnostic.test.ts` (new, compiler API). `app-root.test-d.ts` and the binding-key message tests still pass.
- **3.** A plain node value bound to a secret field, or a secret one bound to a `field()`, does not compile. A plain node value in a service's per-key params compiles; a secret one does not. Test: target `sources.test-d.ts`.

### The constructors (5.2)

- **4.** `variable({ name: 'email_from' })` and `variable({ name: 'PORT' })` fail when the body runs, with slice 2's name messages naming `variable`. The example in `variable({ name: '' })`'s message reads `variable({ name: 'API_KEY' })`. Test: target `platform-variable.test.ts` (new).
- **5.** The default id of `variable({ name: 'EMAIL_FROM' })` is `emailFrom`. `SMTP_PORT`, `EMAIL_2FA` and `A__B` give `smtpPort`, `email2fa` and `aB`. `provision(node, { id: 'sender' })` gives `shop.sender`. Test: target `platform-variable.test.ts`.

### Value resources, the provisioned copy and the reads list (4.1, 4.2, 4.6)

- **11.** The loaded graph has a resource node of type `prisma-cloud/platform-variable` for each node. `valueReads` lists each service that reads it, with the site, in each of these cases: at depth inside objects and arrays; through two module inputs; through a module input whose schema copies its object (an ArkType morph); through a module factory's argument; and in a per-key param. `${value}` in a body throws the source-misuse error. Test: core `value-resource.test.ts` (new).
- **12.** Load refuses a value resource that provides a contract or declares dependency slots. Load also refuses a value resource provisioned in a `module()` body through a cast, including a `module()` root. Test: core `value-resource.test.ts`.
- **14.** A core message that names a node's value reads the node's label, for example "Bind the platform variable "EMAIL_FROM" directly into the input of the service that reads it". Test: core `resolve-values.test.ts`.

### Duplicate ids and the graph check's rules (4.4, 5.4)

- **6.** Two nodes named `EMAIL_FROM` with different ids fail with rule 1's message, also when one is plain and one secret. The same node object provisioned twice with two ids fails rule 1. With the default id it fails the duplicate-id error, which names the node already at the id. Two names that give one id fail the duplicate-id error naming both. Tests: target `graph-check.test.ts`; core `module.test.ts`.
- **7.** A plain node and a root input field with one name fail with rule 2's message. A secret node and a root input field with one name fail with core's message, also when no service reads the secret node. Tests: target `graph-check.test.ts`; core `resolve-values.test.ts`.
- **8.** A node value bound as a service's whole input fails with rule 3's message. Test: target `graph-check.test.ts`.

### Secrets (4.6, 5.5)

- **13.** A platform secret node the root provisions and binds nowhere is a known secret: a value under its name in the app secrets is redacted from every output, and `secretsKeys(graph)` includes it. Test: core `secrets.test.ts`.
- **20.** A planted secret under a secret node's name appears in no deploy output, report, stack file or boot error. Tests: the planted-secret test in target `input-serializer.test.ts`, moved to a secret node; a planted-secret case in target `preflight.test.ts` that searches the findings and the rendered report; and the manual QA search in section 11.

### Deploy: serializer, topology, report and preflight (5.3, 5.5, 5.7)

- **15.** Deploying writes `$platform` markers for plain and secret nodes, and a pointer row for a plain node in a per-key param. A schema failure on a field that reads a node ends with the variable's name. Tests: target `serializer.test.ts` and `control-lowering.test.ts`.
- **16.** The application topology sent to Prisma Cloud has no platform variable node. The node is lowered through its descriptor, which creates nothing. The deploy report and the deploy command's table have no line for it. Registry coverage finds its descriptor. Tests: `packages/1-prisma-cloud/0-lowering/lowering/src/__tests__/application-topology.test.ts`; core `lowering.test.ts`; CLI `render-deployment.test.ts`.
- **17.** Preflight refuses a required unset node and reports an optional unset node. It lists an unread plain node and an unread secret node once each, named by their node. A secret node that a module receives and no service reads is listed once. Changing a node's row redeploys exactly its readers. Tests: target `preflight.test.ts` and `control-lowering.test.ts`.

### `prisma dev` (5.6)

- **18.** Under `prisma dev`:
  - a plain node is filled from the app configuration, in an input field and in a per-key param;
  - a required unset per-key param stops dev, judged by `paramIsRequired`;
  - an unset optional per-key param, or one with a default, does not stop dev and takes its default;
  - an unset optional input field is left out of the input document;
  - a required unset input field stops dev;
  - a non-text value stops dev before any service starts, with the message in 5.6;
  - a changed value changes only its readers' fingerprints.

  Test: target `local-target-preflight.test.ts`. Its per-key cases bind a plain node to a required param, an optional param and a param with a default, and check that only the required one stops dev.
- **19.** Under `prisma dev`, a plain node's text that holds a secret's value fails with `CONFIG.SECRET_AS_PLAIN_VALUE`. The deploy's app configuration file has an empty `plainVariableText`. The graph's `appConfigurationRead` holds the root's input only. A rebuild's handover holds the texts from the start-time preflight. The second process reads `plainVariableText` from the file and passes it to the local target. Tests: CLI `app-configuration-file.test.ts`, `stack-file-import.test.ts`, `dev/__tests__/generate-dev-stack.test.ts`, and an `executeDev` test of the merge on the first converge and on a rebuild.
- **21.** The integration fixture `test/integration/test/fixtures/local-dev/module.ts` provisions two secret nodes and one plain node in a per-key param, and `prisma dev` serves their values. Run only that file locally, with `bun run test/local-dev.integration.ts` from `test/integration`, not the full integration suite.

### The removal (4.5, 5.8)

- **22.** `@prisma/composer-prisma-cloud` exports no `envSecret`, `envParam` or `secretName`. Test: target `exports.test.ts` (new), which imports the package's entry and checks the three names are absent; and a type test with `@ts-expect-error` on each import.
- **23.** Core's `paramSource()` takes no `configurationKey`: passing one does not compile. Every param source is known only at boot, and listing one in `resolve()` fails with the pointer refusal. `AppConfigurationRead` has no `configurationKeyText`. Tests: core `source-value.test-d.ts` and `source-value.test.ts`.
- **24.** `examples/root-input` deploys, and its smoke script finds the greeting the deploy shell held. Test: the manual QA in section 11.

The tests that build `envSecret()`, `envParam()`, `secretName()` or a `configurationKey` source change to the nodes or to root input fields, or are deleted where they test removed behaviour. They are: target `secret.test.ts` (deleted; its name and redaction cases move to `platform-variable.test.ts`), `param.test.ts`, `sources.test-d.ts`, `graph-check.test.ts`, `input-serializer.test.ts`, `serializer.test.ts`, `preflight.test.ts`, `preflight-payload.test.ts`, `local-target-preflight.test.ts`, `dev-pointed-variables.test.ts`, `control-lowering.test.ts`, `bootstrap-service.test.ts` and `generated-param.test.ts`; core `source-value.test.ts`, `source-value.test-d.ts`, `source-load.test.ts`, `resolve-values.test.ts`, `root-input.test.ts`, `module-input.test.ts`, `pointer.test.ts`, `load-options.test-d.ts` and `lowering.test.ts`; CLI `app-configuration-file.test.ts`, `pipeline.test.ts`, `stack-file-import.test.ts`, `dev/__tests__/generate-dev-stack.test.ts` and `operations/__tests__/operations.test.ts`; target `orm-postgres-ordering.test.ts`, which builds a payload with `absentSecrets`; the local target's `bucket-providers.test.ts`, `compute-port-order.test.ts`, `custom-domain-provider.test.ts`, `emulator-instances.test.ts` and `postgres-providers.test.ts`, which pass `configurationKeyText` to the providers; and its `compute-materialize-env.test.ts`, whose cases named "param pointers from the app configuration" become the plain variable texts.

## 10. Scope

### In

Sections 4 to 8.

### Out

- `schema` on `variable()`. Slice 4.
- A carried secret and `secret(inner)`. Module-input S18.
- Moving apps and docs in other repositories off the removed functions (section 8). Each is a follow-up in its own repository.
- An edge kind for the reads relation, and a topology node kind for the platform variable. Recorded in `deferred.md`.

### Changes to `deferred.md`, made with this design

- Remove "Removing `envSecret()` and `envParam()`": this slice does it.
- Remove "A separate export for `envParam()` in per-key params": the function is gone.
- Remove "The one-meaning-per-name check misses an `envParam()` passed indirectly": the function is gone, and a node and a root input field are both declared in the root, where the check sees them.
- Remove "Renaming `absentSecrets`": this slice does it.
- New: moving Prisma's other repositories off `envSecret()` and `envParam()`: the deploy apps in `prisma/streams`, the apps in `prisma/asks`, `prisma/program` and `prisma/pdp-control-plane`, and the docs in `prisma/skills` and `prisma/web`. After `prisma/skills` changes, sync this repository's copy under `.agents/skills/prisma-compute/` and update `skills-lock.json`.
- New: a plain platform variable node added by a code change while `prisma dev` runs gets its value only when `prisma dev` restarts, because a rebuild runs no preflight.
- Rewrite "A value given by a resource that also provides a contract": the value is held under a core-only key, so the conflict is the return of `provision()`, which would have to carry both the contract's ports and the value.

## 11. Done when

CI is green, `/drive-code-review` has run with its findings fixed, and QA on Prisma Cloud shows:

- an app with a plain node, a secret node and a module that receives both through its input, deployed with the secret unset and required (preflight refuses), then set (the service boots with the value);
- a plain node in a service's per-key param, read at boot;
- a fresh preview branch of that app;
- a nested module calling `provision(variable(…))`, and a `module()` root's body, both failing to compile with `appRoot()` in the error;
- the same app under `prisma dev`, with its values in `.env.dev`;
- `examples/root-input` deployed, and its smoke script passing;
- the planted-secret search, repeated with a secret node.

## 12. Alternatives considered

Each entry gives the option, what this spec chose instead, and why.

**Keep `envSecret()` and `envParam()` as deprecated spellings.** The earlier version of this spec kept both, deprecated, and removed them later. That leaves two ways to name one platform variable. The graph would not list an `envSecret()` as a node, so R1 would hold only for apps that use the node. Supporting it below the root also needed core to record, for every secret source, which module body built it and which bound it, using state kept on `globalThis` while bodies run, plus a graph check rule with two messages and a known false refusal for a file-level constant. Will chose one mechanism and no leftover function. The apps that use the functions are internal to Prisma, and each moves in its own repository (section 8).

**Remove only `envSecret()`.** `envParam()` would stay, for its two uses. In an input binding it duplicates a root input field. In per-key params it duplicates a plain node. Keeping it would keep core's `configurationKey`, Load's reads of the app configuration for sources, the serializer's read of the app configuration at deploy, and the `envParam()` rows of the one-meaning rule. Removing both leaves exactly one way for each kind of value.

**The address in the pointer's data.** The plan put the provisioned address into "the pointer's data", as ordinary data, "so it survives the copy a schema library may make". The pointer has no data member: it carries only its kind, and the payload belongs to the target. The stated reason also does not hold: object spread copies symbol keys, and core already recovers a source through its origin after a schema has copied it. The address goes on the source's origin instead (4.2), where core keeps everything else it knows about a source.

**A public `value` member on the node.** An earlier draft gave `ValueResourceNode` a public `value`. Any module body could then write `input: { key: variable.secret({ name: 'X' }).value }`, which compiles and bypasses both root-only provisioning and one node per name. The value is held under the core-only key `VALUE_RESOURCE` instead, and only `provision()` reads it (4.1).

**A core helper to read the node's address.** An earlier draft exported `resourceAddressOf(source)` so the target could tell a node's value from an `envSecret()`. With `envSecret()` gone, every platform variable value comes from a node, and the target needs no such test. Only core reads `origin.resource`, to build `valueReads`.

**No descriptor for the node (ADR-0017).** A reviewer proposed no descriptor at all, with core skipping value resources in lowering, in registry coverage and in the topology. That would remove two no-op descriptors and the empty report line. It also reverses ADR-0017, which records one lookup for every node with no special case. The spec keeps a descriptor that creates nothing (5.3), so ADR-0017 does not change. Core skips value resources only in the deploy report, and the topology composer skips them.

**A descriptor flag to leave the topology.** The plan said the descriptor is "not sent to the application topology", which suggests a flag on the descriptor. The topology composer reads no descriptor. The rule is on the node instead: core's `isValueResource()` decides it, and the same predicate keeps the node out of the deploy report (5.3).

**Refusing a node value in a plain field in the graph check.** The design puts this refusal in the graph check, naming the variable and the place, and the plan says it fails Load. The graph cannot see a schema's field kinds, because Composer does not look inside a schema (ADR-0042). The compiler refuses it, and the service's own schema refuses what a cast gets past, with the variable's name added to its error (5.4 rule 3, 5.5).

**The array-position rule in the graph check.** Design section 5 lists it among the graph check's rules. Slice 2 placed it in the serializer, where the array positions are known, and it stays there (5.5).

**Rules that "fail Load".** The plan says that two declarations "fail Load". This is a Prisma Cloud rule, so it belongs to the target, not to core's Load. It runs in the graph check, which runs right after Load and before any preflight or service (5.4).

**Refusing a node value in per-key params.** The design lists per-key params among the places a platform variable may not go, because they "need data the deploy has". They do not: a per-key param bound to a platform variable writes a pointer row that the service reads at boot (ADR-0032, ADR-0064). With `envParam()` removed, refusing the node there would leave per-key params with no way to read a platform variable. A plain node in per-key params is accepted (5.2, 5.5). The build corrects `design.md` line 161 in place.

**Keeping `configurationKeyText` in the graph's record for the dev texts.** `AppConfigurationRead.configurationKeyText` could stay, filled by nothing at Load and by the dev texts in the file. That gives one field two meanings: what Load read, and what the dev preflight found. The field goes, and the file carries `plainVariableText`, named for what it holds (5.6).

**The CLI filling dev values.** The plan said plain values go into the app configuration file "beside the keys it already carries", without saying who writes them. Load cannot, because Load also runs for deploy, and the deploy does not read these values. The CLI cannot, because only the target reads the payload that holds the name. A core field such as `devConfigurationKey`, mirroring `secretsKey`, would let the CLI find the names, but it adds a core concept for one target's need. The target's dev preflight works the values out, and `prepareSecondProcess` writes them into the file (5.6).

**Moving `examples/env-param` to the nodes.** That would change what the example shows, from a value the deploy reads to a value read at boot, and its smoke test would need a row set on the platform first. `examples/auth` already shows a plain node. Moving `env-param` to a root input field, and renaming it `root-input`, keeps what it shows and gives the second way to get a value its own example (6).

**A new node kind instead of a value resource.** A new node kind, such as a "reference", is more honest in the types. The design also rejected it because it changes the platform's topology kind list; the node now stays out of the topology, so that cost is gone. The reason that still holds is that it changes core's node union. A resource that is a value costs less and says the same thing (4.1). ADR-0062 records this.

**From design section 15.** These alternatives apply to this slice, and their reasons stand:

- **A platform variable as a property of an input field,** such as `field(type('number'), { env: 'SMTP_PORT' })`. Rejected by Will: a platform input is part of the topology, so it is a node.
- **A source with no node.** It leaves nothing for Load to list as a node, and no address.
- **"Resource outputs" as a new core concept, with Load asking the target for the pointer.** Core already has the source, which carries what redaction and `prisma dev` need. "Output" already means Alchemy's attributes and the retired end of a connection. Load calling a target would be core's first dependency on one.
- **A platform variable node anywhere in the tree.** A variable's name is one space per project. A nested module naming one claims it for every app and instance, and hides from the module's input what the module needs.
- **Root-only enforced by a Load check alone,** with `module()` as the root. Rejected by Will: the rule is structural, so the type system carries it. A Load check would let a library ship a module that compiles and fails every app that uses it.
- **Two nodes for one name reconciled when they agree.** That rule existed only because nodes could sit below the root. With root-only, two declarations of one name are two lines in one body, and refusing them is simpler (5.4 rule 1).
- **The node declares its scope,** such as `variable({ name, scope: 'service' })`. Where a value lives is the operator's decision in the platform's terms, not the author's.
- **`provision()` returning `{ id, value }`.** The value itself with `id` on it matches `generatedParam()` and `serviceOrigin()`, so a binding reads `{ from, smtpPort }`.
- **"Subscription" as the word for a service reading a variable.** It names a platform mechanism that does not exist, and reads as "receives updates as they happen", which is false. The spec says "reads".

### Where this spec departs from `plan.md` section 3 and `design.md`

- The address goes on the source's origin, not in the pointer's data. See "The address in the pointer's data".
- `provision(variable({ name }))` is typed `ParamSource<PlatformVariablePayload> & RuntimeValue<string> & { readonly id: string }`, not only `RuntimeValue<string> & { id: string }`, so it fits per-key params. See "Refusing a node value in per-key params".
- The topology skip is decided on the node by `isValueResource()`, not by the descriptor. See "A descriptor flag to leave the topology".
- A plain field is refused by the compiler and the service's schema, not the graph check. See "Refusing a node value in a plain field in the graph check".
- The array-position rule stays in the serializer. See "The array-position rule in the graph check".
- Two declarations fail the graph check, not Load. See "Rules that 'fail Load'".
- Per-key params accept a plain node, and `design.md` line 161 is corrected. See "Refusing a node value in per-key params".
- The target's dev preflight finds plain dev values, not the CLI or the local target's second process. See "The CLI filling dev values".
- Core's rules are recorded in ADR-0062, not ADR-0064 (7). ADR-0064 records the Prisma Cloud use only, because it is the target's record.
- ADR-0057 and the address principle gain one clarifying sentence, not a name-as-identity exception (7). The node is still identified by its address everywhere Composer refers to it; only the row it names keeps the variable's name.

## 13. References

- Design: [../../design.md](../../design.md) sections 4, 5, 6, 10, 12, 14 and 15.
- Grounding against `main` at `ab3b4f7a`, just after slice 2 merged: `wip/pv-review/slice3-grounding.md`.
- Design reviews, in `reviews/`: `reviews/design-architect.md`, `reviews/design-principal-engineer.md`. They explain why several choices in section 12 were made. Their findings about `envSecret()` below the root (A08, A17, F03, F13, F14) no longer apply, because the function is removed.
- Core: `packages/0-framework/1-core/core/src/node.ts`, `value.ts`, `load-module.ts`, `load-service.ts`, `module-input.ts`, `resolve-values.ts`, `graph-types.ts`, `graph.ts`, `config.ts`, `control/app-config.ts`, `control/deploy.ts`, `control/local-target.ts`.
- Target: `packages/1-prisma-cloud/1-extensions/target/src/secret.ts` (deleted), `platform-variable.ts` (new), `descriptors/platform-variable.ts` (new), `param.ts`, `variable-name.ts`, `graph-check.ts`, `serializer.ts`, `configuration-text.ts`, `preflight.ts`, `preflight-names.ts`, `required-variables.ts`, `local-target/preflight.ts`, `control/preflight-payload.ts`, `descriptors/compute.ts`, `container.ts`, `exports/index.ts`; `packages/1-prisma-cloud/2-shared-modules/cron/src/module.ts`, `auth/src/auth-module.ts`.
- Lowering: `packages/1-prisma-cloud/0-lowering/lowering/src/builds/application-topology.ts`; input document: `packages/1-prisma-cloud/0-lowering/input-document/src/document.ts`; local target: `packages/1-prisma-cloud/0-lowering/local-target/src/compute.ts`.
- CLI: `packages/0-framework/3-tooling/cli/src/app-configuration-file.ts`, `operations/execute-dev.ts`, `dev/generate-dev-stack.ts`, `pipeline.ts`.
- Records: ADR-0017, ADR-0029, 0032, 0039, 0042, 0057, 0058, 0061, 0062, 0063, 0064; `docs/design/01-principles/architectural-principles.md`; `docs/design/03-domain-model/glossary.md` and `domain-map.md`.
