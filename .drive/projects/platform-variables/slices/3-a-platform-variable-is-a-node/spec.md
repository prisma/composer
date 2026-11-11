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

We are adding a platform variable node to the app's graph. The app root provisions one with `variable({ name })` for a plain value, or `variable.secret({ name })` for a secret, both from `@prisma/composer-prisma-cloud`. `provision()` returns the value itself, with `id` on it, so the root passes `from` and `deliveryCredential` down through module inputs to the services that read them. Only `appRoot()` can provision one: in a `module()` body the call does not compile, and the error names `appRoot()`. The loaded graph lists every node and, for each service, the variables it reads, without deploying. Deploy, preflight, boot and `prisma dev` handle a node's variable as slice 2 handles an `envSecret()`'s, and `envSecret()` becomes a deprecated spelling of a platform secret that fails below the root.

There is no `schema` in this slice. Every value is text. Slice 4 adds `schema`.

### What each part satisfies

The requirements and decisions are the project spec's.

| Part of the design | Requirements | Decisions |
|---|---|---|
| A resource can be a value; `provision()` returns it with the node's address (4.1, 4.2) | R1 "The graph shows every platform variable" | D3, D4 |
| Only `appRoot()` provisions one, enforced by the compiler (4.3) | R1 | D1, D2 |
| Duplicate ids name the node already at the id (4.4) | R1 | D4 |
| Telling where an `envSecret()` was written (4.5) | R1, R2 "The deploy needs no value" | D7, D14 |
| The reads relation, and secret nodes in the graph's secret sources (4.6) | R1, R7 "A secret's text never appears in an error" | D6, D13 |
| The constructors, names and default ids (5.1, 5.2) | R1, R2 | D2, D4, D5, D8 |
| A descriptor that creates nothing; the topology and the deploy report skip the node (5.3) | R2, R6 "Nothing waits for the platform" | D3, D15 |
| The graph check's four rules (5.4) | R1, R2 | D5, D7, D8, D14 |
| Serializer, preflight, per-key params and boot (5.5, 5.7) | R2, R7 | D5, D10, D11 |
| `prisma dev` fills plain values (5.6) | R5 "The same app behaves the same locally", R7 | D12, D13 |
| `envSecret()` deprecated (5.8) | R2 | D14 |
| Examples, records, guides and skill (6, 7) | R1, R8 "Every record matches the code" | D15 |

This slice does not touch R3 "The type travels as data" or R4 "No value is guessed". Slice 4 satisfies them, with `schema`.

## 2. Terms

These follow the project spec's terms. Slice 3 makes the glossary match them.

- **Platform variable.** A variable on the platform that the app reads by name at boot, declared by a node, by `envSecret()`, or by a per-key `envParam()`. The node, built with `variable({ name })`, is how an app declares one; it is called a **platform variable node**. The term lets every message name what the app reads, whichever way the app declared it.
- **Platform secret.** A platform variable whose value is handled as a secret: boxed in the service and redacted wherever Composer prints. Built with `variable.secret({ name })`, or written inline with the deprecated `envSecret('NAME')`. The term marks the variables whose text must never appear in output.
- **A variable on the platform**, or **row.** Any entry in a Prisma Cloud project's environment variables: a name and a non-empty text, at a class and optionally a branch. That includes Composer's own `COMPOSER_` rows, which are not platform variables. The term names the platform's storage, as distinct from what the app reads.
- **Value resource.** Core's name for a resource node that is also a value: provisioning it returns a runtime value, not a reference to a port. A platform variable is the one value resource today. The term lets core state its rules without knowing about Prisma Cloud.

## 3. How it works, end to end

This is the map. Each step links to the section that holds its detail.

1. **The author writes the root.** In an `appRoot()` body, `provision(variable({ name: 'EMAIL_FROM' }))` returns the value with `id` set. The author binds it into a module's or a service's input like any other value (4.2, 5.2).
2. **The compiler checks two things.** A `module()` body cannot provision a value resource, and the error names `appRoot()` (4.3). A plain value fits a `field()` field or a per-key param; a secret fits a secret field only (5.2).
3. **Load runs the root's body.**
   - The constructor checks the name (5.2).
   - `provision()` returns a copy of the node's source whose origin holds the node's address (4.2). A duplicate id fails, naming the node already at that id (4.4).
   - Load refuses a malformed value resource (4.1), and a value resource provisioned outside an `appRoot()` body through a cast (4.3).
   - Load records, for every secret source, the module whose body created it and the modules whose bodies bound it (4.5).
   - After resolving values, Load builds the reads list, `valueReads`, and adds each secret node to the graph's secret sources (4.6).
4. **The graph check runs.** It refuses two declarations of one name, a name used two ways, a node value bound as a service's whole input, and an `envSecret()` written below the root (5.4).
5. **Deploy runs.**
   - The node's descriptor creates nothing. The application topology and the deploy report leave the node out (5.3).
   - The serializer writes a `$platform` marker for each node value, plain or secret, and a pointer row for a plain node in a per-key param (5.5).
   - Preflight checks that each required variable has a row, and reports the variables with no value, including nodes no service reads (5.5, 5.7).
6. **Boot reads the value.** It reads the marker or the pointer row, as in slice 2. Nothing changes at boot (5.5).
7. **`prisma dev` fills the values.** The target's dev preflight reads each plain node's text from the app configuration. `prisma dev` writes those texts into the app configuration file for the second process (5.6).

## 4. Core

### 4.1 A resource can be a value

A platform variable must be a node in the graph, and provisioning it must give the author a value to bind. Core supports this with one new kind of resource node, the value resource.

A value resource is a `ResourceNode` that holds a source under a core-only symbol key, `VALUE_RESOURCE`, in `packages/0-framework/1-core/core/src/value.ts`, declared beside `VALUE_ORIGIN`.

- The key is `Symbol.for('prisma:value-resource')`, like the other brands, so `isValueResource()` works across two installed copies of core.
- As with `NODE` in `node.ts`, only the key's type is exported (`export type { VALUE_RESOURCE }`, from `@prisma/composer` and `@internal/core`). This lets declaration files that name `ValueResourceNode`, such as the target's, be built. The value stays internal.
- The node has no public member that holds the source. So module code cannot read the value off the node and bind it without provisioning it. Only `provision()` reads the key.

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

- `SourceValue` is a source known only at boot: a secret source, or a param source with a pointer kind (built without a `configurationKey`).
- `valueResource()` builds a frozen resource node with no `provides`, no `inputs` and no `deps`. It throws when `value` is not a source, or is a param source with a `configurationKey`.
- `isValueResource()` is true for a resource node that holds a source under `VALUE_RESOURCE`.
- Both functions are exported from `@prisma/composer` and `@internal/core`.
- `extension` means what it means on every node (ADR-0017): the extension whose registry holds the node's descriptor. A value resource has a descriptor like any other resource (5.3).
- A value resource takes no `deps`, `input`, `params` or `secrets` on `provision()`, as every resource today.

An extension can build a node without `valueResource()`, so Load also refuses a value resource that breaks these rules. It fails with `COMPOSE.GRAPH_INVALID`:

```text
Resource "<address>" is a value and also <provides a contract | declares dependency slots | holds a value known at deploy>. A resource that is a value provides no contract, has no dependencies, and holds a value known only at boot.
```

### 4.2 What `provision()` returns for a value resource

Each provisioned value must carry the address of the node it came from. Load uses that address to find which service reads which node (4.6), and the target uses it to tell a node's value from an `envSecret()` (5.4).

`provision(node)` for a value resource returns a new source: a copy of the node's source whose origin also records the provisioned node's address, with `id` set on it.

- **The copy.** The `provision` closure in `load-module.ts` builds it with `buildSource`. The copy has the same brand, payload and pointer kind as the node's source. Its origin has the original origin's `sourceKind`, `label` and `secretsKey` or `configurationKey`, plus `resource`, the node's full address.
- **What `buildSource` gives the copy.** It sets `origin.source` to the copy itself, so `restore` and `canonicalSecret` in `resolve-values.ts` recover the copy, not the node's own source. It installs the `toString`, `valueOf` and `Symbol.toPrimitive` traps, so `${value}` in a body throws the source-misuse error. The copy is frozen, like every source.
- **`resource` on the origin.** Both source variants of `ValueOrigin` in `value.ts` gain `readonly resource: NodeId | undefined`. A source no node provisioned, such as an `envSecret()`, has `undefined`.
- **`id`.** The node's full address, such as `shop.emailFrom`, the same as every other `provision()` return today. It is defined as a non-enumerable property before the copy is frozen. So walkers and `JSON.stringify` of bindings see no new key.
- **Two provisions, two copies.** Each provision builds its own copy, so `secretUses` (keyed by `origin.source`) keeps one entry per provision.
- **Reading the address from outside core.** The origin is internal to core. So core exports a helper, `resourceAddressOf(source): NodeId | undefined`, which returns `origin.resource`. The target uses it to tell a node's value from an `envSecret()`.

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

**A `module()` root.** An entry built with `module()` is accepted, as slice 1 decided. It is not an app root: its body uses `ModuleBuilder`, and `isRoot()` is false. So it cannot provision a value resource, at compile time or at run time. The error names `appRoot()` as the fix.

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

### 4.5 Telling where an `envSecret()` was written

The graph check refuses an `envSecret()` written below the root (5.4, rule 4). To do that, it needs to know which module's body created each secret source, and which modules' bodies bound it.

`SecretSourceUse` in `graph-types.ts` (`{ source, address, nodeKind }`) gains two fields. Only `Graph.secretSources` carries them, because only rule 4 reads them.

**`createdIn: NodeId | undefined`.** The module whose body was running when the source was built. It records when the source was built, not where its code is written.

- Load keeps the address of the body it is running on `globalThis`, under the key `Symbol.for('prisma:running-module-body')`. So a source built through a second installed copy of core sees the same address, as the `Symbol.for` brands do.
- Load sets it when a body starts. It restores the enclosing body's address in a `finally` block, because a child's body runs inside its parent's `provision()` call and a body can throw.
- `secretSource()` and `paramSource()` read it and put it on the origin as `createdIn`.
- A source built outside any body, such as a module-level constant, has `undefined`.

**`boundIn: readonly NodeId[]`.** Every module whose body passed the source object in a `provision()` binding: a service's `input` or `params`, or a module's `input`.

- Load walks the binding at any depth, through plain objects and arrays. So `input: { smtp: { credential: envSecret('X') } }` counts.
- The walk stops at a value whose origin kind is `input`. That is a field of the module's own input, which is not a source.
- Load collects one entry per binding site, in `provision()`, before the binding is recorded. So a source bound in two bodies lists both.

`resolveValues` copies both fields into every `SecretSourceUse` it writes for a source. That includes the replacement `secretSourcesReceivedBy` makes when a service holds the source.

### 4.6 The reads relation

The graph must show, without deploying, which services read each platform variable node (R1). Preflight and `prisma dev` also use this list to find the readers of each node.

`Graph` gains one list:

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

**Secret nodes in `Graph.secretSources`.** A secret node must be a known secret even when nothing binds it, so its value is redacted. So `Graph.secretSources` also holds every secret value resource.

- `resolveValues` takes the provisioned copies as a new input, `valueResources: ReadonlyMap<NodeId, SourceValue>`.
- Before it collects any binding, it inserts each secret one into `secretUses`: `{ source: <the copy>, address: <the node's address>, nodeKind: 'resource' }`.
- A service that reads it replaces that entry with the service, as `secretSourcesReceivedBy` does today.
- A module that receives it, when no service reads it, leaves the node's entry in place, because `recordSecret` keeps the first entry.
- `appConfigurationReadOf` iterates `secretSources`, so core's one-meaning check covers an unread platform secret too.
- `secretsKeys(graph)` includes every platform secret the root provisions, so its value is redacted even when nothing binds it.

The doc comments change to match:

- `Graph.secretSources` is "every secret source a binding names, and every secret value resource, once each".
- `SecretSourceUse.address` is "a service whose final binding holds it, if one does; otherwise the secret value resource itself, or the module whose input holds it".

## 5. The Prisma Cloud target

### 5.1 The payload

All platform variables share one payload brand, so slice 2's code can handle a node's value and an `envSecret()` the same way. It lives in `packages/1-prisma-cloud/1-extensions/target/src/platform-variable.ts` (new):

```ts
interface PlatformVariablePayload {
  readonly [PLATFORM_VARIABLE]: true;
  readonly name: string;
  readonly secret: boolean;
}
```

- `envSecret('NAME')` builds its source with this payload (`secret: true`), replacing its own brand.
- An `envSecret()` source is a platform variable source whose origin has no `resource`, from `resourceAddressOf()`. A provisioned node's value has one.
- `secretName()` is renamed `platformVariableName(source, where)`. It accepts any source with this payload, plain or secret.
- `secretName` stays exported from `@prisma/composer-prisma-cloud` as a deprecated alias that accepts only secret sources, because three example tests import it. Its refusal for any other source names both spellings:

  ```text
  <where> is bound to a source that is not a platform variable. Bind a platform variable from @prisma/composer-prisma-cloud: provision variable() or variable.secret() in the app root and pass its value down.
  ```

- `paramName()` in `param.ts` accepts a plain platform variable source as well as an `envParam()` source, and returns its name.
- `isEnvParamSource()` is unchanged. A new `isPlatformVariableSource()` covers the shared payload.

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

- `variable()` builds a plain source with `paramSource(payload, { label: 'the platform variable "NAME"' })`, with no `configurationKey`. So it is a pointer at deploy.
- `variable.secret()` builds `secretSource(payload, { label: 'the platform secret "NAME"', secretsKey: name })`. So its value is a known secret, and it reaches `prisma dev`'s second process as a named secret, as `envSecret()`'s does.
- Core's messages print the label where they name a source. For example: "Bind the platform variable "EMAIL_FROM" directly into the input of the service that reads it". So the label names what the user binds, not the constructor call.

**Types.**

- `provision(variable({ name }))` is `ParamSource<PlatformVariablePayload> & RuntimeValue<string> & { readonly id: string }`. That is the same shape as `serviceOrigin()`, plus `id`. It fits a `field()` field. Because it is a `ParamSource`, it also fits a per-key param in `ParamBindings`.
- `provision(variable.secret({ name }))` is `SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString> & { readonly id: string }`. It binds to a `secretString()` field until module-input S18 ships `secret(inner)`.
- A plain value in a secret field, and a secret in a `field()`, already fail to compile, because the pointer kinds differ (`sources.test-d.ts`).
- A secret node does not compile in per-key params, because `ParamBindings` admits no secret source, as for `envSecret()` today.

### 5.3 The descriptor, the deploy report and the application topology

The node must be lowered like every other resource, but it creates nothing and must not look as if it did.

- **Descriptor.** `descriptors/platform-variable.ts` registers `prisma-cloud/platform-variable` in `prismaCloud().nodes`. Its lowering returns `{ outputs: {}, entities: [] }`. It creates nothing and writes no row. The local target registers the same lowering.
- **One lookup, as ADR-0017 records.** The deploy walk and registry coverage treat the node as every other resource: one lookup, `extensions[node.extension].nodes[node.type]`, with no special case. ADR-0017 does not change.
- **The deploy report.** The lowering loop in `packages/0-framework/1-core/core/src/control/deploy.ts` adds no report entry for a value resource, using `isValueResource()`. So the printed deploy report and the deploy command's table have no empty line for the node. An empty line would read as something Composer deployed. Unread nodes still appear in the preflight findings (5.7).
- **Topology.** `composeApplicationTopology` in `packages/1-prisma-cloud/0-lowering/lowering/src/builds/application-topology.ts` skips every value resource, using `isValueResource()`. The node is not sent to the platform's application topology. The platform has no node kind for it, and Composer owns nothing it names. A value resource has no slots and no ports, so no edge or port points at it.
- **Other readers of `graph.nodes`.** `env-key-clash.ts`, `public-url.ts`, the local target's emulators, and the dev server and watch lists in the CLI each select nodes by kind or type. None selects `prisma-cloud/platform-variable`, so they need no change.

### 5.4 The graph check

These rules span more than one node, so they run in the graph check, not in a constructor. `graph-check.ts` gains four rules.

- Each runs on the loaded graph, after Load, in `deploy`, `destroy` and `prisma dev`.
- Each fails with `GraphCheckError` (`COMPOSE.GRAPH_INVALID`).
- Each error names the variable and every address involved.
- The platform variable nodes are the value resources in `graph.nodes`. Each node's name is `props.name`.

#### Rule 1. One declaration per name

Two platform variable nodes of the same kind, both plain or both secret, with one variable name fail, whatever their ids. A plain node and a secret node with one name are rule 2's case.

```text
The platform variable "EMAIL_FROM" is declared twice in the app root, by "shop.emailFrom" and "shop.sender". Declare each platform variable once and pass its value to every module that needs it.
```

- Two nodes with one name and the default id get the same id. So Load's duplicate-id error (4.4) fires first, and this rule does not run.
- The same node object provisioned twice with two explicit ids is two declarations, and fails here.
- The same node object provisioned twice with the default id fails the duplicate-id error.

#### Rule 2. One meaning per name

A name can be used in these ways:

- a plain platform variable node;
- a per-key `envParam()`, which reads the same variable at boot as a plain node;
- a platform secret node;
- `envSecret()`;
- `envParam()` in an input binding, which is a value read at deploy;
- a field of the root's input.

The table lists every pair of ways for one name, and who refuses it. "Core" is the existing check in Load (`appConfigurationReadOf` in `resolve-values.ts`). "Graph check" is `graph-check.ts`.

| First way | Second way | Result |
|---|---|---|
| Plain node | Plain node | Refused by the graph check, rule 1 |
| Plain node | Per-key `envParam()` | Allowed: they read the same variable at boot. For example, a per-key `envParam('REGION')` and a plain node `REGION` |
| Plain node | Secret node | Refused by the graph check, rule 2 |
| Plain node | `envSecret()` | Refused by the graph check, rule 2 |
| Plain node | `envParam()` in an input binding | Refused by the graph check, rule 2 |
| Plain node | Root input field | Refused by the graph check, rule 2 |
| Secret node | Secret node | Refused by the graph check, rule 1 |
| Secret node | `envSecret()` | Refused by the graph check, rule 2 |
| Secret node | Per-key `envParam()` | Refused by core |
| Secret node | `envParam()` in an input binding | Refused by core |
| Secret node | Root input field | Refused by core |
| Per-key `envParam()` | Per-key `envParam()` | Allowed, as today (ADR-0064) |
| Per-key `envParam()` | `envParam()` in an input binding | Allowed, as today (ADR-0064) |
| Per-key `envParam()` | `envSecret()` | Refused by core, as today |
| Per-key `envParam()` | Root input field | Refused by the graph check, as today |
| `envSecret()` | `envSecret()` | Allowed, as today (ADR-0064) |
| `envSecret()` | `envParam()` in an input binding | Refused by core, as today |
| `envSecret()` | Root input field | Refused by core, as today |
| `envParam()` in an input binding | `envParam()` in an input binding | Allowed, as today (ADR-0064) |
| `envParam()` in an input binding | Root input field | Refused by the graph check, as today |

Core refuses a name read from the app configuration (`envParam()` in either place, or a root input field) that a secret source also names. A secret node is a secret source, and every secret node is in `secretSources` (4.6). So core covers a secret node against `envParam()` or a root field, also when no service reads the secret node.

Rule 2's message:

```text
"EMAIL_FROM" is used two ways: as the platform variable "shop.emailFrom" and as envParam('EMAIL_FROM') in the input of service "shop.email.service", field "from". A name has one meaning in an app. Use one of them, or give the other a different name.
```

Where the rule finds each use:

- The `envSecret()` uses come from `secretSources` entries with no resource address.
- The `envParam()` uses come from the binding walk the check already does.
- Root fields come from `graph.appConfigurationRead.rootInput`.

#### Rule 3. A service's whole input

A node value bound as a service's whole input fails. The rule reads `valueReads` entries with `site.kind` `serviceInput` and `site.path` `''`:

```text
The platform variable "EMAIL_FROM" is bound as the whole input of service "shop.email.service". Bind it to one field of the input instead.
```

The other places a node value may not go are refused elsewhere:

- The compiler refuses a node value in a `resolve()` dependency, in a plain field (a schema member written without `field()`), and in a field of the other secrecy.
- Core's Load refuses a `resolve()` dependency and a resource's props at run time.
- A plain field reached through a cast is refused by the service's own schema at serialize or preflight. 5.5 adds the variable's name to that error.

#### Rule 4. `envSecret()` below the root

This rule uses `createdIn` and `boundIn` from 4.5. It refuses a secret source with the platform variable payload and no resource address when either:

- `createdIn` is set and is not the root; or
- `createdIn` is `undefined`, and `boundIn` has an entry other than the root.

When `createdIn` is a module other than the root:

```text
envSecret('EMAIL_DELIVERY_CREDENTIAL') is created in module "shop.email". A platform variable is declared only in the app root. Provision variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }) in the root, built with appRoot(), and pass its value through this module's input.
```

When `createdIn` is `undefined`:

```text
envSecret('INGEST_TOKEN') was called outside any module body and is bound in module "shop.cron". Call it inside the app root's body, or provision variable.secret({ name: 'INGEST_TOKEN' }) in the root and pass its value down.
```

Cases:

- An `envSecret()` written in the root and passed down through module inputs is allowed.
- An `envSecret()` written in the root's body as a module factory's argument is allowed, even when the factory's body binds it. For `cron({ runner, input: { token: envSecret('X') } })` written in the root's body, `envSecret('X')` runs while the root's body runs. So `createdIn` is the root and the rule passes, although `boundIn` is `["shop.cron"]`.
- A file-level `const token = envSecret('INGEST_TOKEN')` passed to `cron()` in the root fails with the second message. The graph cannot tell it apart from a constant in a shared module's file. The refusal is acceptable for a deprecated spelling, and the message says how to fix it.
- A file-level constant bound in the root and in a nested module fails, naming the nested module.
- In the root, `envSecret()` is deprecated (5.8), not refused.

### 5.5 Serializer, preflight, per-key params and boot

Slice 2's code handles a node's value, with these changes.

**Serializer** (`serializer.ts`).

- `resolveInputBinding` keeps a platform variable source in place, plain or secret.
- `substitutePointers` calls `platformVariableName()` and writes `platformMarker(name, secret)`. Slice 2 wrote only secret markers.
- `resolveInputBinding`'s refusal of any other param source names the node as well as `envParam()`.

**The leave-out option.** `absentSecrets` becomes `absentVariables`, and covers plain platform variables too. A variable named in it is left out of the document, as an unset secret is today. It is renamed in its writer and its reader together:

- `SerializeInputOptions` in `serializer.ts`;
- `required-variables.ts`;
- the dev preflight in `local-target/preflight.ts`;
- the dev payload's writer and parser in `control/preflight-payload.ts`;
- its reader in `descriptors/compute.ts`.

**Schema failure naming the variable.** `standardValidate` in `serializer.ts` keeps each issue's path, not only its message. The service's schema may refuse its input with an issue whose path equals a platform variable's path in the binding, or lies under it. Then the error ends with `The field "<path>" reads the platform variable "<NAME>".`

**Per-key params.** A plain node in a service's per-key params writes a pointer row read at boot, exactly as a per-key `envParam()` does.

- The descriptor's `serialize` in `descriptors/compute.ts` already writes `encodeParamPointer(paramName(…))` for any param source. `paramName()` accepts the plain node (5.1).
- The per-key walk `envParamBindings()` in `preflight-names.ts` becomes `perKeyVariableBindings()`. It returns every per-key param bound to `envParam()` or a plain node. So deploy preflight checks the row, and dev fills it.

**Deploy preflight names** (`preflight.ts`, `preflight-names.ts`).

- `inputSecretNames()` becomes `inputVariableNames()`. It returns plain and secret platform variable names from the same walk of each service's binding.
- So preflight does not serialize a service to find them. An invalid input still fails after preflight reports the platform variables, as in slice 2.
- The dev preflight uses the same function.
- The names also include every platform variable node no service reads: the value resources not in `valueReads`.
- `checkRequirements` leaves plain ones out through `absentVariables`.
- Existence, resolution, triggers, the required error and the findings are slice 2's, unchanged.

**Unread variables, each once.**

- Unread nodes, plain and secret, come only from the value resources not in `valueReads`. Their reader is `{ kind: 'unread', node: <the node's address>, nodeKind: 'resource' }`.
- Preflight skips every `secretSources` entry whose source has a resource address.
- An unread `envSecret()` in a module's input still comes from `secretSources`, as today.
- So a secret node that a module receives and no service reads is listed once, named by its resource.

**The readers of an `envSecret()`.** The target gets them from the walk of each service's input binding and per-key params, as slice 2 does. It does not use `secretSources`, which holds one entry per source.

**Boot.** Unchanged. The input-document package already reads plain markers, and boot already reads a per-key pointer row.

**Messages that name only `envSecret()`.** Each now names the node, and keeps `envSecret()` as the older spelling where it is still accepted:

- the array-position message in `serializer.ts`, which calls `platformVariableName()` and covers the plain case;
- the binding walk's refusal of a value that is not plain data (`serializer.ts`), which says a binding's leaves are literals, `envParam(...)` or `envSecret(...)`, and to "bind envSecret('NAME') instead";
- the schema-failure note in `serializeInput`, which says "envSecret() included";
- the `SecretBox` refusal in `serializer.ts` and core's `refuseSecretBoxes`;
- core's refusal of `secrets` on a service's `provision()` in `load-module.ts`, which says a service takes its secrets "as envSecret(...) leaves". Core names no target constructor: it says the service takes its secrets as values bound to `secretString()` fields of its `input` binding;
- the `where` texts that `preflight.ts` and `preflight-names.ts` pass to `platformVariableName()`, which say "a secret source" and "a secret in the input";
- the app configuration file's known-secret refusal in `cli/src/app-configuration-file.ts`, whose message says "which an envSecret() in the graph reads" and whose fix says "Read the secret with envSecret('NAME')";
- the `cron()` doc comment in `packages/1-prisma-cloud/2-shared-modules/cron/src/module.ts`, which tells users to put `envSecret(...)` in `opts.input`.

### 5.6 `prisma dev`

Under `prisma dev`, Composer plays the platform's part: it must give each service the value of each plain node it reads. The target's dev preflight finds the values, and the CLI hands them to the second process.

**Filling a plain platform variable.** The target's dev preflight, `runDevPreflight` in `local-target/preflight.ts`, already runs in the first process with the app configuration. For each plain platform variable node that a service reads (from `valueReads`), it reads the app configuration under the variable's name, once. It decides one of three outcomes from that read:

- **Text.** The name and text go into the texts it returns. The value joins `pointerVersions`, so a changed value restarts only its readers.
- **Unset or empty.** The name joins `absentVariables`, so the dev document leaves it out, as for an unset secret. The requirement check decides whether a reader needs it.
- **Present but not text.** `prisma dev` stops before any service starts:

  ```text
  The `config` adapters return a number for "SMTP_PORT", not text. prisma dev cannot start, because the platform variable "shop.smtpPort", which service "shop.mail.service" reads, takes text. Make the adapter return a string.
  ```

  With several readers it says `which services "shop.mail.service" and "shop.digest.service" read`.

**How the texts reach the second process.**

- `LocalTargetDescriptor.preflight` in `packages/0-framework/1-core/core/src/control/app-config.ts` returns `Promise<DevPreflightResult>`, `{ readonly payload: PreflightPayload; readonly platformVariableText: Readonly<Record<string, string>> }`, instead of `Promise<PreflightPayload>`.
- The deploy preflight's type does not change, and the deploy path does not compute these texts.
- The graph does not change. `graph.appConfigurationRead` stays a record of what Load read, so it still shows that Load read no platform variable's value.
- `executeDev` in `cli/src/operations/execute-dev.ts` keeps the texts from the start-time preflight. It passes them to `prepareSecondProcess` in `cli/src/app-configuration-file.ts` as a new input, `platformVariableText`, on the first converge and on every rebuild.
- `prepareSecondProcess` merges them into `configurationKeyText` when it builds the file's content, and runs `refuseSecretsIn` on the merged content. So every plain value is checked against the known secrets before the file is written. A plain value equal to a secret's value fails with `CONFIG.SECRET_AS_PLAIN_VALUE`.
- The deploy passes no texts.
- A key Load already read, such as a per-key `envParam('X')` beside a plain node `X`, has the same text, because both read the same app configuration. The second process reads one `configurationKeyText` map from the file, as today.

**The second process.** Unchanged. The local target already fills a plain `$platform` marker and a per-key pointer from `configurationKeyText` in the app configuration file, and a secret marker from the named secrets.

**Isolation, the missing-value rule and restarts.** These are slice 2's, extended to plain variables. The dev preflight's requirement check uses `absentVariables`. A changed value pauses rebuilds until `prisma dev` restarts, as `sameValues` already does for any change to the app configuration.

**A node added while `prisma dev` runs.** A rebuild after a code change runs no preflight, as today. So a plain node the change adds gets its value when `prisma dev` restarts. This is recorded in `deferred.md` (section 10).

Load does not read a plain platform variable's value, so the deploy reads none.

### 5.7 The deploy report and findings

A platform variable node no service reads is reported in "Platform variables with no value", with the existing `unread` reader: `named by resource "shop.emailFrom", read by no service`. It is not required. The node has no line among the deployed resources (5.3).

### 5.8 `envSecret()` deprecated

`envSecret()` gains a JSDoc tag:

```ts
/** @deprecated Provision `variable.secret({ name })` in the app root and pass its value down. */
```

It keeps working in the root. Below the root it fails the graph check (5.4, rule 4).

## 6. Examples

The examples show the nodes, so new apps copy the new form.

- **`examples/email`.** `envSecret('EMAIL_DELIVERY_CREDENTIAL')` becomes `provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }))` in the root. `examples/email/tests/secret-bindings.ts` uses the node.
- **`examples/auth`.** `envParam('EMAIL_FROM')` becomes `provision(variable({ name: 'EMAIL_FROM' }))`, and `envSecret('EMAIL_DELIVERY_CREDENTIAL')` becomes `provision(variable.secret(…))`. `EMAIL_FROM` is now read from the platform at boot, not from the deploy's shell. Its `.env.example` and README say where to set it.
- **`examples/storefront-auth`.** `envSecret('AUTH_SIGNING_SECRET')` becomes `provision(variable.secret({ name: 'AUTH_SIGNING_SECRET' }))`. The CI flow from slice 2 is unchanged.
- **The example tests that import `secretName`**: `examples/auth/tests/module.test.ts`, `examples/storefront-auth/module.test.ts` and `examples/email/tests/module.test.ts`. They switch to `platformVariableName`.
- **`examples/env-param`.** Its `envParam('ENV_PARAM_GREETING')` in a service binding becomes a field of the root's input, the replacement that `envParam()`'s deprecation names. So the example keeps its meaning: a value the deploy reads from the shell. Its doc comment in `module.ts`, which describes binding the env var at provision, is rewritten to describe a root input field. `scripts/smoke.ts` is unchanged.
- **Below the root in packages.** The email and cron shared modules have no `envSecret()` in code. Their tests and `email/README.md` that write `envSecret()` move to passing a value through the module's input.

## 7. Records, guides and skill

Each record is rewritten in place as the current statement, with no history and no supersession notes.

- **ADR-0062, Values section.** Core's record for values gains core's rules:
  - the value resource and its rules (4.1), `valueResource()` and `isValueResource()`;
  - root-only provisioning, with its core reason and its compile error (4.3);
  - the address on the origin (4.2);
  - the reads list (4.6);
  - where a secret source was created and bound (4.5), including that `createdIn` records when a source was built, not where its code is written.

  The table of runtime-value origins gains a third origin: a value resource, given by `provision()`. Line 82's list of sources gains the note that a value resource's value is a source too. Its alternatives gain design section 15's rejection of a new node kind, with the reason that still holds: it changes core's node union. Its line in the ADR index changes with it.
- **ADR-0064.** Gains the Prisma Cloud use only: the constructors, the default id, the graph check's rules, the per-key params rule, the serializer, preflight and dev handling of plain values, and design section 15's other alternatives. Its title stays: the deploy does not copy local values to what the nodes name, so it reads correctly under the new meaning. Its line in the ADR index changes with it.
- **ADR-0063.** A service also reads a platform variable: a third relationship, recorded as `valueReads`, not as an edge.
- **ADR-0029.** A secret is any value handled as one. A platform secret is the kind Composer never sees during a deploy, spelled as `variable.secret()` or the deprecated `envSecret()`. Its ADR index line (README line 53) changes with it.
- **ADR-0058.** The named secrets are the values under the secrets keys of the graph's secret sources, which include every platform secret node. The app configuration file it describes also holds, under `prisma dev`, the text of each plain platform variable a service reads, which the target's dev preflight reads. That text is checked against the known secrets like every other plain value.
- **ADR-0017.** Unchanged. The platform variable node has a descriptor and is looked up like every other node. Only the application topology and the deploy report skip a value resource.
- **ADR-0032.** A per-key param also takes a plain platform variable node, which writes the same pointer row as `envParam()`.
- **ADR-0057 and the principle "A node's address is its identity, everywhere"** (`docs/design/01-principles/architectural-principles.md`). The rule stays as it is. Each gains one sentence: a node that names something Composer does not own, such as a platform variable node, records no platform row and no topology node, and the thing it names keeps its owner's handle, such as the variable's name. ADR-0057's line in the ADR index gains the same clause. ADR-0051 is superseded by ADR-0057 and is not changed. Design section 14 names ADR-0051 for this change; whoever next edits the design corrects it to ADR-0057.
- **`design.md` line 161.** Per-key params leave the list of places a platform variable may not go (5.4).
- **Glossary.**
  - Rewritten: Platform variable (a variable on the platform the app reads by name at boot, declared by a node, `envSecret()` or a per-key `envParam()`), The app configuration file (under `prisma dev` it also holds the text of each plain platform variable a service reads, which the target's dev preflight reads), Module (App), Core nouns, Resource, Topology, Address and logical ID, Input, Value, RuntimeValue, The app configuration, The app secrets, Secrets key, Named secrets, Known secrets.
  - New: Platform variable node, Platform secret, Value resource, A variable on the platform.
- **Domain map** (`docs/design/03-domain-model/domain-map.md`). "Every node carries a managed lifecycle" and "Configuration is not a node" gain the platform variable node, which names a value the operator sets.
- **Domain docs.** `docs/design/10-domains/config-params.md` and `local-dev.md`, wherever they describe `envSecret()` as the way to name a platform secret.
- **Guides.**
  - `docs/guides/building-an-app.md` and `deploying.md` show the nodes and the mental model: a name, the services that read it, and where the operator sets it. They give one sentence on why only the root provisions them: a platform variable names something outside the app, the names form one space per deployed app, and the root is the app.
  - `running-locally.md` says a plain platform variable comes from the `config` adapters under `prisma dev`.
- **Skill.** `skills/prisma-composer-core-concepts/SKILL.md` shows the nodes. It is staged with `scripts/stage-skills.mjs`, run from `packages/9-public/composer`.

### Terminology sweep

The two terms:

- "Platform variable" means a variable on the platform that the app reads by name at boot, declared by a node, by `envSecret()` or by a per-key `envParam()`.
- "A variable on the platform" means any row, including Composer's `COMPOSER_` rows.

Most existing uses of "platform variable" stay correct, because they name a variable the app declares and a service reads by name. That includes the messages every `envSecret()` and per-key `envParam()` reaches, such as the boot errors in `document.ts` and the required-variables text. It also includes the refusal of a name Prisma Cloud manages, in `preflight.ts` and `deploy-cli.md`.

These uses name rows the app does not declare, so they are wrong. They change to "a variable on the platform", or "variables on the platform":

- `packages/1-prisma-cloud/1-extensions/target/src/variable-name.ts`: "names starting with COMPOSER_ are Composer's own platform variables".
- `packages/1-prisma-cloud/1-extensions/target/src/container.ts`: "Removed the Project, with every platform variable set on it".
- `packages/1-prisma-cloud/0-lowering/input-document/src/document.ts`: "The platform variable "<name>", which the deploy writes, has no value" (a `$generated` row).
- The `Pointer` doc comments in `packages/0-framework/0-foundation/foundation/src/pointer.ts` and the `RuntimeValue` doc comment in `packages/0-framework/1-core/core/src/value.ts`, which say a pointer names the platform variable: a `generatedParam()` or `serviceOrigin()` pointer names a `COMPOSER_` row.
- ADR-0039 line 38: "PATCH the platform variable" (a `COMPOSER_` origin row).
- ADR-0042 line 54 and ADR-0062's Values section: a pointer "names the platform variable holding the data", for every pointer kind.
- `docs/design/05-prisma-cloud/alchemy-lowering.md` line 69: "The rows are plain platform variables" (the `DATABASE_URL` rows Composer claims).

## 8. The release note

For the PR description, before and after:

- **`envSecret('X')` becomes a node.** Before: `input: { key: envSecret('X') }`. After: `const key = provision(variable.secret({ name: 'X' }))` in the app root, then `input: { key }`. Nothing on the platform changes: the variable's name is the same.
- **A plain platform variable is a node too.** `provision(variable({ name: 'X' }))` in the app root gives a value read at boot, for a `field()` field or a per-key param.
- **`envSecret()` below the root fails.** It fails with a message that says to provision `variable.secret()` in the root and pass the value through the module's input.
- **`envSecret()` is deprecated** in the root.
- **`secretName()` is deprecated.** Use `platformVariableName()`, which also reads a plain platform variable.
- **The duplicate-id error** names the node already at the id and says to pass `id`.

## 9. Acceptance: expected behaviour and its tests

Everything below is observable without reading the code. Each item names its test. The numbers are stable, so reviews can refer to them. Test files without a path are in the package the item belongs to:

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
- **12.** Load refuses a value resource that provides a contract, declares dependency slots or holds a value known at deploy. Load also refuses a value resource provisioned in a `module()` body through a cast, including a `module()` root. Test: core `value-resource.test.ts`.
- **14.** A core message that names a node's value reads the node's label, for example "Bind the platform variable "EMAIL_FROM" directly into the input of the service that reads it". Test: core `resolve-values.test.ts`.

### Duplicate ids and the graph check's rules 1 to 3 (4.4, 5.4)

- **6.** Two nodes named `EMAIL_FROM` with different ids fail with rule 1's message. The same node object provisioned twice with two ids fails rule 1. With the default id it fails the duplicate-id error, which names the node already at the id. Two names that give one id fail the duplicate-id error naming both. Tests: target `graph-check.test.ts`; core `module.test.ts`.
- **7.** These pairs with one name fail with rule 2's message: a plain node and `envSecret()`; a plain node and a secret node; a plain node and `envParam()` in an input binding; a plain node and a root input field. A plain node and a per-key `envParam()` with one name are allowed. A secret node and `envParam()`, or a secret node and a root input field, fail with core's message, also when no service reads the secret node. Tests: target `graph-check.test.ts`; core `resolve-values.test.ts`.
- **8.** A node value bound as a service's whole input fails with rule 3's message. Test: target `graph-check.test.ts`.

### Where an `envSecret()` was written, and rule 4 (4.5, 5.4)

- **9.** Each of these cases:
  - `envSecret()` written in a nested module's body fails with rule 4's first message, also when it sits deep inside the binding (`input: { smtp: { credential: envSecret('X') } }`).
  - Written in the root and passed down through module input, it works.
  - Written in the root's body as a module factory's argument (`cron()`), it works.
  - A file-level `envSecret()` constant passed to `cron()` in the root fails with rule 4's second message, which says it was called outside any module body.
  - A file-level constant bound in the root and in a nested module fails, naming the nested module.

  Tests: core `resolve-values.test.ts` for `createdIn` and `boundIn`; target `graph-check.test.ts` for the rule and both messages.
- **10.** A source built through a second import of core while a body runs gets that body as `createdIn`. `isValueResource()` is true for a value resource built by the other copy. A body that throws leaves no `createdIn` on a source built afterwards outside Load. Test: core `resolve-values.test.ts`.

### Secrets (4.6, 5.5)

- **13.** A platform secret node the root provisions and binds nowhere is a known secret: a value under its name in the app secrets is redacted from every output, and `secretsKeys(graph)` includes it. Test: core `secrets.test.ts`.
- **20.** A planted secret under a secret node's name appears in no deploy output, report, stack file or boot error. Tests: the planted-secret test in target `input-serializer.test.ts`, extended to a secret node; a planted-secret case in target `preflight.test.ts` that searches the findings and the rendered report; and the manual QA search in section 11.

### Deploy: serializer, topology, report and preflight (5.3, 5.5, 5.7)

- **15.** Deploying writes `$platform` markers for plain and secret nodes, and a pointer row for a plain node in a per-key param. A schema failure on a field that reads a node ends with the variable's name. Tests: target `serializer.test.ts` and `control-lowering.test.ts`.
- **16.** The application topology sent to Prisma Cloud has no platform variable node. The node is lowered through its descriptor, which creates nothing. The deploy report and the deploy command's table have no line for it. Registry coverage finds its descriptor. Tests: `packages/1-prisma-cloud/0-lowering/lowering/src/__tests__/application-topology.test.ts`; core `lowering.test.ts`; CLI `render-deployment.test.ts`.
- **17.** Preflight refuses a required unset node and reports an optional unset node. It lists an unread plain node and an unread secret node once each, named by their resource. A secret node that a module receives and no service reads is listed once. Changing a node's row redeploys exactly its readers. Tests: target `preflight.test.ts` and `control-lowering.test.ts`.

### `prisma dev` (5.6)

- **18.** Under `prisma dev`:
  - a plain node is filled from the app configuration, in an input field and in a per-key param;
  - a required unset per-key param stops dev;
  - an unset optional input field is left out of the input document;
  - a required unset input field stops dev;
  - a non-text value stops dev before any service starts, with the message in 5.6;
  - a changed value changes only its readers' fingerprints.

  Test: target `local-target-preflight.test.ts`.
- **19.** Under `prisma dev`, a plain node's text that holds a secret's value fails with `CONFIG.SECRET_AS_PLAIN_VALUE`. The deploy's app configuration file holds no plain node value. The graph's `appConfigurationRead` holds no plain node value. A rebuild's handover holds the texts from the start-time preflight. Tests: CLI `app-configuration-file.test.ts`, and an `executeDev` test of the merge on the first converge and on a rebuild.
- **21.** The integration fixture `test/integration/test/fixtures/local-dev/module.ts` gains one plain node read by a service, and `prisma dev` serves its value. Run only that file locally, with `bun run test/local-dev.integration.ts` from `test/integration`, not the full integration suite.

## 10. Scope

### In

Sections 4 to 8.

### Out

- `schema` on `variable()`. Slice 4.
- A carried secret and `secret(inner)`. Module-input S18.
- Removing `envSecret()` or `envParam()`.
- An edge kind for the reads relation, and a topology node kind for the platform variable. Recorded in `deferred.md`.

### Changes to `deferred.md`, made with the build

- Under "Removing `envSecret()` and `envParam()`": rename or remove `examples/env-param` at the same time.
- New: a plain platform variable node added by a code change while `prisma dev` runs gets its value only when `prisma dev` restarts, because a rebuild runs no preflight.
- Remove "Renaming `absentSecrets`": this slice does it.
- Rewrite "A value given by a resource that also provides a contract": the value is held under a core-only key, so the conflict is the return of `provision()`, which would have to carry both the contract's ports and the value.

## 11. Done when

CI is green, `/drive-code-review` has run with its findings fixed, and QA on Prisma Cloud shows:

- an app with a plain node, a secret node and a module that receives both through its input, deployed with the secret unset and required (preflight refuses), then set (the service boots with the value);
- a plain node in a service's per-key param, read at boot;
- a fresh preview branch of that app;
- a nested module calling `provision(variable(…))`, and a `module()` root's body, both failing to compile with `appRoot()` in the error;
- the same app under `prisma dev`, with its values in `.env.dev`;
- the planted-secret search, repeated with a secret node.

## 12. Alternatives considered

Each entry gives the option, what this spec chose instead, and why.

**The address in the pointer's data.** The plan put the provisioned address into "the pointer's data", as ordinary data, "so it survives the copy a schema library may make". The pointer has no data member: it carries only its kind, and the payload belongs to the target. The stated reason also does not hold: object spread copies symbol keys, and core already recovers a source through its origin after a schema has copied it. The address goes on the source's origin instead (4.2), where core keeps everything else it knows about a source.

**A public `value` member on the node.** An earlier draft gave `ValueResourceNode` a public `value`. Any module body could then write `input: { key: variable.secret({ name: 'X' }).value }`, which compiles and bypasses both root-only provisioning and one declaration per name. The source is held under the core-only key `VALUE_RESOURCE` instead, and only `provision()` reads it (4.1).

**A `spelling` field in the payload.** An earlier draft marked each source as written by a node or by `envSecret()`. The origin's `resource` already says this: a provisioned copy has one, and an `envSecret()` has none. Two records of one fact can disagree, so the payload has no `spelling`, and the target calls `resourceAddressOf()` (4.2, 5.1).

**One `writtenIn` field.** An earlier draft recorded, for each source, the one module whose binding held it. That blames the wrong module when a module factory binds an argument the root wrote, such as `cron({ input: { token: envSecret('X') } })`. It also holds one module for a source bound in two bodies, so the result depends on which body Load met first. A separate `Graph.sourceWrites` list was also proposed. The spec uses two fields on `SecretSourceUse` instead (4.5): `createdIn`, which records the body running when the source was built, and `boundIn`, which lists every binding site.

**No descriptor for the node (ADR-0017).** A reviewer proposed no descriptor at all, with core skipping value resources in lowering, in registry coverage and in the topology. That would remove two no-op descriptors and the empty report line. It also reverses ADR-0017, which records one lookup for every node with no special case. The spec keeps a descriptor that creates nothing (5.3), so ADR-0017 does not change. Core skips value resources only in the deploy report, and the topology composer skips them.

**A descriptor flag to leave the topology.** The plan said the descriptor is "not sent to the application topology", which suggests a flag on the descriptor. The topology composer reads no descriptor. The rule is on the node instead: core's `isValueResource()` decides it, and the same predicate keeps the node out of the deploy report (5.3).

**Refusing a node value in a plain field in the graph check.** The design puts this refusal in the graph check, naming the variable and the place, and the plan says it fails Load. The graph cannot see a schema's field kinds, because Composer does not look inside a schema (ADR-0042). The compiler refuses it, and the service's own schema refuses what a cast gets past, with the variable's name added to its error (5.4 rule 3, 5.5).

**The array-position rule in the graph check.** Design section 5 lists it among the graph check's rules. Slice 2 placed it in the serializer, where the array positions are known, and it stays there (5.5).

**Rules that "fail Load".** The plan says that two declarations, and `envSecret()` below the root, "fail Load". Both are Prisma Cloud rules, so they belong to the target, not to core's Load. They run in the graph check, which runs right after Load and before any preflight or service (5.4).

**Refusing a node value in per-key params.** The design lists per-key params among the places a platform variable may not go, because they "need data the deploy has". They do not: a per-key `envParam()` writes a pointer row that the service reads at boot (ADR-0032, ADR-0064). Refusing the node there would also leave an app with no supported spelling for a name it needs in a per-key param and in an input field. A plain node in per-key params writes the same pointer row and is accepted (5.2, 5.5). Rule 2 treats it and a per-key `envParam()` as one meaning (5.4). The build corrects `design.md` line 161 in place.

**The CLI filling dev values.** The plan said plain values go into the app configuration file "beside the keys it already carries", without saying who writes them. Load cannot, because Load also runs for deploy, and the deploy does not read these values. The CLI cannot, because only the target reads the payload that holds the name. A core field such as `devConfigurationKey`, mirroring `secretsKey`, would let the CLI find the names, but it adds a core concept for one target's need. The target's dev preflight works the values out, and `prepareSecondProcess` merges them into the file (5.6).

**Merging dev texts into the graph's `appConfigurationRead`.** A reviewer proposed merging the dev texts into `graph.appConfigurationRead.configurationKeyText` before `prepareSecondProcess`. That record says what Load read. After such a merge it would hold values Load never read, and would hide that the deploy reads no variable's value. The texts travel as `DevPreflightResult.platformVariableText`, and are merged only into the file's content, where `refuseSecretsIn` checks them (5.6).

**Moving `examples/env-param` to the nodes.** The plan moves `env-param` to the nodes. That would change what the example shows, from a deploy-time value to a value read at boot, and its smoke test would need a row set on the platform first. Moving it to a root input field keeps what it shows and drops the deprecated use (6). Renaming or removing the example belongs with removing `envParam()` (section 10).

**Removing `secretName()`.** Renaming it outright removes a public export of `@prisma/composer-prisma-cloud` that three example tests import. It stays as a deprecated alias that accepts only secret sources (5.1).

**A new node kind instead of a value resource.** A new node kind, such as a "reference", is more honest in the types. The design also rejected it because it changes the platform's topology kind list; the node now stays out of the topology, so that cost is gone. The reason that still holds is that it changes core's node union. A resource that is a value costs less and says the same thing (4.1). ADR-0062 records this.

**From design section 15.** These alternatives apply to this slice, and their reasons stand:

- **A platform variable as a property of an input field,** such as `field(type('number'), { env: 'SMTP_PORT' })`. Rejected by Will: a platform input is part of the topology, so it is a node.
- **A source with no node,** as `envSecret()` is. It leaves nothing for Load to list as a node, and no address.
- **"Resource outputs" as a new core concept, with Load asking the target for the pointer.** Core already has the source, which carries what redaction and `prisma dev` need. "Output" already means Alchemy's attributes and the retired end of a connection. Load calling a target would be core's first dependency on one.
- **A platform variable node anywhere in the tree.** A variable's name is one space per project. A nested module naming one claims it for every app and instance, and hides from the module's input what the module needs.
- **Root-only enforced by a Load check alone,** with `module()` as the root. Rejected by Will: the rule is structural, so the type system carries it. A Load check would let a library ship a module that compiles and fails every app that uses it.
- **Two nodes for one name reconciled when they agree.** That rule existed only because nodes could sit below the root. With root-only, two declarations of one name are two lines in one body, and refusing them is simpler (5.4 rule 1).
- **The node declares its scope,** such as `variable({ name, scope: 'service' })`. Where a value lives is the operator's decision in the platform's terms, not the author's.
- **`provision()` returning `{ id, value }`.** The value itself with `id` on it matches `generatedParam()` and `serviceOrigin()`, so a binding reads `{ from, smtpPort }`.
- **Make `envSecret()` a node provisioned where it is written.** Load would have to create a node from a value found in a binding, with an owner and an id nobody has defined, for a form this slice deprecates.
- **"Subscription" as the word for a service reading a variable.** It names a platform mechanism that does not exist, and reads as "receives updates as they happen", which is false. The spec says "reads".

### Where this spec departs from `plan.md` section 3 and `design.md`

- The address goes on the source's origin, not in the pointer's data. See "The address in the pointer's data".
- `provision(variable({ name }))` is typed `ParamSource<PlatformVariablePayload> & RuntimeValue<string> & { readonly id: string }`, not only `RuntimeValue<string> & { id: string }`, so it fits per-key params. See "Refusing a node value in per-key params".
- The topology skip is decided on the node by `isValueResource()`, not by the descriptor. See "A descriptor flag to leave the topology".
- A plain field is refused by the compiler and the service's schema, not the graph check. See "Refusing a node value in a plain field in the graph check".
- The array-position rule stays in the serializer. See "The array-position rule in the graph check".
- Two declarations and `envSecret()` below the root fail the graph check, not Load. See "Rules that 'fail Load'".
- Per-key params accept a plain node, and `design.md` line 161 is corrected. See "Refusing a node value in per-key params".
- The target's dev preflight finds plain dev values, not the CLI or the local target's second process. See "The CLI filling dev values".
- The target finds an `envSecret()`'s readers from the walk of each service's binding, not from the list of secret sources, as plan section 3 and design section 5 say (5.5). That list holds one entry per source, so it cannot give every reader.
- `examples/env-param` moves to a root input field, not to the nodes. See "Moving `examples/env-param` to the nodes".
- Core's rules are recorded in ADR-0062, not ADR-0064 (7). ADR-0064 records the Prisma Cloud use only, because it is the target's record.
- ADR-0057 and the address principle gain one clarifying sentence, not a name-as-identity exception, and ADR-0051 is not changed (7). The node is still identified by its address everywhere Composer refers to it; only the row it names keeps the variable's name.

## 13. References

- Design: [../../design.md](../../design.md) sections 4, 5, 6, 10, 12, 14 and 15.
- Grounding against `main` at `ab3b4f7a`, just after slice 2 merged: `wip/pv-review/slice3-grounding.md`.
- Design reviews, in `reviews/`: `reviews/design-architect.md`, `reviews/design-principal-engineer.md`. They explain why several choices in section 12 were made.
- Core: `packages/0-framework/1-core/core/src/node.ts`, `value.ts`, `load-module.ts`, `module-input.ts`, `resolve-values.ts`, `graph-types.ts`, `graph.ts`, `control/app-config.ts`, `control/deploy.ts`.
- Target: `packages/1-prisma-cloud/1-extensions/target/src/secret.ts`, `descriptors/platform-variable.ts` (new), `param.ts`, `variable-name.ts`, `graph-check.ts`, `serializer.ts`, `preflight.ts`, `preflight-names.ts`, `required-variables.ts`, `local-target/preflight.ts`, `control/preflight-payload.ts`, `descriptors/compute.ts`, `container.ts`; `packages/1-prisma-cloud/2-shared-modules/cron/src/module.ts`.
- Lowering: `packages/1-prisma-cloud/0-lowering/lowering/src/builds/application-topology.ts`; input document: `packages/1-prisma-cloud/0-lowering/input-document/src/document.ts`; local target: `packages/1-prisma-cloud/0-lowering/local-target/src/compute.ts`.
- CLI: `packages/0-framework/3-tooling/cli/src/app-configuration-file.ts`, `operations/execute-dev.ts`, `pipeline.ts`.
- Records: ADR-0017, ADR-0029, 0032, 0039, 0042, 0057, 0058, 0062, 0063, 0064; `docs/design/01-principles/architectural-principles.md`; `docs/design/03-domain-model/glossary.md` and `domain-map.md`.
