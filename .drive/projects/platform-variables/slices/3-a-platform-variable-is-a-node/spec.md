# 3. A platform variable is a node

Parent: [project spec](../../spec.md), [plan](../../plan.md) section 3, [design](../../design.md) sections 4, 5, 6, 10, 12 and 14.

This document is the whole design for slice 3. It states what must be true when the slice is done: every public and extension-facing type and signature, every rule and where it runs, every user-facing message, the behaviour at deploy, boot and under `prisma dev`, what leaves the public surface, and every record and guide that changes. It does not say which internal code changes to get there. Rejected options are in section 12, not in the design sections.

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
7. **`prisma dev` fills the values.** The target's dev preflight reads each plain node's text from the app configuration. `prisma dev` writes those texts into the app configuration file for the second process. A rebuild that changes what the app reads pauses until `prisma dev` restarts (5.6).

## 4. Core

### 4.1 A resource can be a value

A platform variable must be a node in the graph, and provisioning it must give the author a value to bind. Core supports this with one new kind of resource node, the value resource.

A value resource keeps its value hidden inside the node. Only `provision()` can take it out. So no module can use a platform variable without provisioning it, and only the app root can provision one (4.3).

What must be true:

- The node is a `ResourceNode` that holds its value under a symbol key, `VALUE_RESOURCE`.
- The key is `Symbol.for('prisma:value-resource')`, like core's other brands, so `isValueResource()` works across two installed copies of core.
- Only the key's type is exported, from `@prisma/composer` and `@internal/core`, as for `NODE`. Declaration files that name `ValueResourceNode`, such as the target's, can then be built. The key's value stays internal to core.
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
- `extension` means what it means on every node: the extension whose registry holds the node's descriptor ([ADR-0017](../../../../../docs/design/90-decisions/ADR-0017-control-plane-loads-through-the-app-config.md)). A value resource has a descriptor like any other resource (5.3).
- A value resource takes no `deps`, `input`, `params` or `secrets` on `provision()`, like every resource today.

An extension can build a node without `valueResource()`, so Load also refuses a value resource that breaks these rules. It fails with `COMPOSE.GRAPH_INVALID`:

```text
Resource "<address>" is a value and also <provides a contract | declares dependency slots>. A resource that is a value provides no contract and has no dependencies.
```

### 4.2 What `provision()` returns for a value resource

Each provisioned value must carry the address of the node it came from. Load uses that address to find which service reads which node (4.6).

`provision(node)` returns a copy of the node's value. These must be true of the copy:

- It has the same brand, payload and pointer kind as the node's value.
- Its origin keeps the original origin's `sourceKind`, `label` and `secretsKey`, and adds `resource`, the node's full address. Both source variants of `ValueOrigin` gain `readonly resource: NodeId | undefined`. A source no node provisioned, such as a `generatedParam()`, has `undefined`.
- It has `id`, the node's full address, such as `shop.emailFrom`, like every other `provision()` return. `id` is not enumerable, so walkers and `JSON.stringify` of bindings see no new key.
- It is frozen.
- Turning it into text in a body, such as `${value}`, throws the source-misuse error, as for every other source.
- Wherever core recovers a source after a schema has copied it, such as a module input's schema, it recovers this copy, not the node's own value. So the address survives any number of module inputs.
- Two provisions of one node give two copies, each recorded on its own.

### 4.3 Only the root provisions a value resource, and the compiler enforces it

A value resource names something outside the app, which the operator supplies. Those names form one space per deployed app. The app root is the app, so it is the one module whose scope matches that space. A module below the root declares what it needs in its input instead, and the app's author wires the value down.

The provision types change as follows.

**`ModuleBuilder['provision']`** (a `module()` body).

- Its resource overload becomes `ResourceNode<C> & { readonly [VALUE_RESOURCE]?: undefined }`, so a value resource no longer matches it.
- The last overload, the catch-all, takes the refusal in its parameter type. This is the pattern of `NotDeployTime` in `value.ts` and `ModuleInputIsNotAValue` in `module-input.ts`:

  ```ts
  type OnlyInAppRoot = "Only appRoot() can provision a resource that is a value, such as a platform variable. Provision it in the app root and pass its value down through this module's input.";

  provision<N extends ServiceNode | ModuleNode | ValueResourceNode>(
    node: N extends ValueResourceNode ? OnlyInAppRoot : N,
    ...args: ProvisionArgs<N>
  ): ProvisionedRef<ExposeOf<N>>;
  ```

- `ProvisionArgs<N>` gains a value resource case, `[opts?: { id?: string }]`. This makes `provision(variable(…), { id: 'x' })` show the same message. Without it, TypeScript infers `N` as a service, and the error names a missing property instead of `appRoot()`.
- A service, a module and a plain resource still match their own overloads.

**`AppRootContext['provision']`** (an `appRoot()` body) becomes its own type instead of `ModuleBuilder['provision']`. Its first overload accepts a value resource:

```ts
provision<V extends SourceValue>(node: ValueResourceNode<V>, opts?: { readonly id?: string }): V & { readonly id: string };
```

After it come `ModuleBuilder`'s overloads, except `ModuleBuilder`'s catch-all. In its place, the last overload of an `appRoot()` body is a catch-all without the refusal, so it accepts a value resource:

```ts
provision<N extends ServiceNode | ModuleNode | ValueResourceNode>(node: N, ...args: ProvisionArgs<N>): ProvisionedRef<ExposeOf<N>>;
```

When a call fails every overload, TypeScript reports the last one. So in an `appRoot()` body, a bad option on a value resource, such as `provision(variable(…), { id: 'x', input: {} })`, reports the bad option, not `OnlyInAppRoot`, which would tell the author to do what they already did. Only `ModuleBuilder`'s catch-all carries `OnlyInAppRoot`.

**Run time.** In an `appRoot()` body, `provision()` returns the copy from 4.2. A cast can get a value resource past the types into a body whose module answers `isRoot()` false. Then Load fails with `COMPOSE.GRAPH_INVALID`:

```text
Module "<module address>" provisions "<id>", a resource that is a value. Only the app root, built with appRoot(), can provision one. Provision it in the root and pass its value down through this module's input.
```

**A `module()` root.** An entry built with `module()` is accepted, as slice 1 decided. It is not an app root: its body uses `ModuleBuilder`, and `isRoot()` is false. So it cannot provision a value resource, at compile time or at run time. The error names `appRoot()` as the fix. An app that names a platform variable must therefore have an `appRoot()` root.

**What the compile error must show.** For both `provision(v)` and `provision(v, { id: 'x' })` in a `module()` body, the compiler's diagnostic contains the `OnlyInAppRoot` text, which names `appRoot()`. In an `appRoot()` body, a bad option on a value resource gives a diagnostic that names the option and not `appRoot()`. A test compiles a small fixture with the TypeScript compiler API and checks this, so a later change to the overloads cannot drop the hint silently. The messages users already see for a bad service or module call, which the catch-all also produces, do not change.

### 4.4 Duplicate provision ids

A platform variable's default id comes from its name (5.2), so two names can give one id. The user then sees a duplicate id that appears nowhere in their code. The error must name what already holds the id.

The duplicate-id error changes for every node, because core cannot tell which nodes take a derived id. It names the node already at that id:

```text
Duplicate provision id "<id>" in module "<module address>": "<address>" already holds <what>. Give one of them a different id with provision(node, { id: '…' }).
```

- `<what>` is the source's label for a value resource, such as `the platform variable "EMAIL_FROM"`.
- `<what>` is `<kind> "<name>"` for any other node.

### 4.5 No source reads the app configuration

After this slice, Load reads the app configuration for one thing only: the root's input. No source carries an app configuration key any more. Today only `envParam()` builds such a source, so when it goes, core's support for it goes too. A param source is then always known only at boot, and its value at deploy is a pointer.

Root input fields do not use any of this. Load fills them through the root's schema and records them in `rootInput`. The check that a root input field and a secret do not share a name stays (4.6).

What changes on core's public and extension-facing surface:

- **`paramSource()`.** `ParamSourceOptions.configurationKey` goes. `paramSource()` sets the pointer kind from `redacted` alone.
- **`ValueOrigin`.** The param variant loses `configurationKey`.
- **The source-misuse message** keeps only its "known only at boot" text. There is no deploy-time source left for its other branch to describe.
- **`AppConfigurationRead`** becomes `{ rootInput }`. Its `configurationKeyText` goes, because Load reads no configuration key.
- **The check between a configuration key and a secret** goes, because no source reads a key. The check of a root input field against a secret stays.
- **`LocalTargetProvidersInput.configurationKeyText`** becomes `plainVariableText`, and so does the matching parameter of `localTargetProviders()`. It holds the text of each plain platform variable a service reads, by name, which the target's dev preflight found (5.6). It never holds a secret: platform secrets travel in memory as named secrets and are never written to a file ([ADR-0058](../../../../../docs/design/90-decisions/ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md)). `namedSecrets` beside it holds the values of the graph's platform secrets.

Core's messages that name a removed function say instead:

- the `resolve()` refusal of a returned source, which says "such as envSecret() or envParam()", names `generatedParam()`, `serviceOrigin()` and a platform variable node's value;
- the refusal of `secrets` on a service's `provision()`, which says a service takes its secrets "as envSecret(...) leaves", says the service takes its secrets as values bound to `secretString()` fields of its `input` binding;
- the unbound-param error at deploy, which suggests "e.g. envParam('NAME')", says "a literal value or a value such as a platform variable".

No doc comment in core names either function after this slice.

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
- Load builds the list from each service's resolved input binding and per-key params, at any depth, through objects and arrays. It records every source whose origin has a `resource`.
- A value passed through any number of module inputs is still recorded, because the copy keeps its address (4.2).
- Every `Graph` core builds has `valueReads`, empty when nothing reads a value resource.

**Secret nodes in the graph's secret sources.** A secret node must be a known secret even when nothing binds it, so that its value is redacted. So `Graph.secretSources` holds every secret source a binding names, and every secret value resource, once each.

- For a secret node, `SecretSourceUse.address` is a service whose final binding holds it, if one does. Otherwise it is the node itself, with `nodeKind: 'resource'`, also when a module receives the value and no service reads it.
- `secretsKeys(graph)` includes every platform secret the root provisions.
- Core's check of a root input field against a secret covers every entry of `secretSources`, so it covers an unread secret node too.

**Known limit: the root input fields the checks see.** `rootInput` holds only the root input fields that the root's body passes on to a binding. Composer cannot list a schema's keys, because the record on service input ([ADR-0042](../../../../../docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md)) says Composer never looks inside a schema. So core's check of a root input field against a secret, and the graph check's rule 2 (5.4), do not see a field the root's schema declares and its body never passes on. Such a field reaches no service, so no service reads the name two ways, but nothing refuses the app for declaring the name twice. Slice 2's check had the same limit. It is recorded in `deferred.md` (section 10).

## 5. The Prisma Cloud target

### 5.1 The payload

Every platform variable value carries the same payload: the variable's name and whether it is a secret. The serializer, preflight and `prisma dev` read the name from it.

```ts
interface PlatformVariablePayload {
  readonly [PLATFORM_VARIABLE]: true;
  readonly name: string;
  readonly secret: boolean;
}
```

- `PlatformVariablePayload` is exported as a type from `@prisma/composer-prisma-cloud`.
- `PLATFORM_VARIABLE` is a `Symbol.for` brand, as the removed `envSecret()` and `envParam()` brands were.
- Wherever the target needs a platform variable's name and the source has no such payload, it fails, naming the place:

  ```text
  <where> is bound to a source that is not a platform variable. Provision variable() or variable.secret() from @prisma/composer-prisma-cloud in the app root and pass its value down.
  ```

  `<where>` names the place in the binding and the service. This replaces `secretName()`, which is no longer exported.
- `paramName()` stays exported from `@prisma/composer-prisma-cloud`. It takes a param binding, which carries the service's address, the param slot and the bound value. It returns the name of a plain platform variable bound there. It refuses any other bound source with the same kind of message, naming the param slot and the service.

### 5.2 The constructors

The constructors are how the author declares a platform variable. Both are exported from `@prisma/composer-prisma-cloud`. `variable` is a function with a `secret` property:

```ts
export const variable: {
  (options: { readonly name: string }): ValueResourceNode<ParamSource<PlatformVariablePayload> & RuntimeValue<string>>;
  secret(options: { readonly name: string }): ValueResourceNode<SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString>>;
};
```

**Name.** Each constructor calls slice 2's `assertVariableName(name, factory, example)`, with `factory` set to `variable` or `variable.secret`. So a bad or reserved name fails when the root's body runs, with slice 2's messages. `assertVariableName` gains the `example` argument, because its empty-name message writes `${factory}('API_KEY')`, which is wrong for `variable({ name: 'API_KEY' })`. The empty-name message for `variable` shows `variable({ name: 'API_KEY' })`.

**The node.** Built with core's `valueResource()`:

- `type: 'platform-variable'`, a bare name like every other key in the extension's node registry;
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
- A plain value in a secret field, and a secret in a `field()`, already fail to compile, because the pointer kinds differ.
- A secret node does not compile in per-key params, because `ParamBindings` admits no secret source.

### 5.3 The descriptor, the deploy report and the application topology

The node must be lowered like every other resource, but it creates nothing and must not look as if it did.

- **Descriptor.** The target registers a descriptor for `platform-variable` in `prismaCloud().nodes`. Its lowering returns `{ outputs: {}, entities: [] }`. It creates nothing and writes no row. `prisma dev` lowers through the same registry, so the node needs no other registration.
- **One lookup.** The deploy walk and registry coverage treat the node as every other resource: one lookup, `extensions[node.extension].nodes[node.type]`, with no special case. This is what [ADR-0017](../../../../../docs/design/90-decisions/ADR-0017-control-plane-loads-through-the-app-config.md) records, and it does not change.
- **The deploy report.** Core's deploy adds no report entry for a value resource, using `isValueResource()`. So the printed deploy report and the deploy command's table have no empty line for the node. An empty line would read as something Composer deployed. Unread nodes still appear in the preflight findings (5.7).
- **Topology.** `composeApplicationTopology` skips every value resource, using `isValueResource()`. The node is not sent to the platform's application topology. The platform has no node kind for it, and Composer owns nothing it names. A value resource has no slots and no ports, so no edge or port points at it.
- **Other readers of `graph.nodes`** select nodes by kind or by their own types, so they see no change.

### 5.4 The graph check

These rules span more than one node, so they run in the graph check, not in a constructor.

- Each runs on the loaded graph, after Load, in `deploy`, `destroy` and `prisma dev`.
- Each fails with `GraphCheckError` (`COMPOSE.GRAPH_INVALID`).
- Each error names the variable and every address involved.
- The platform variable nodes are the value resources in `graph.nodes`. Each node's name is `props.name`.

The target's graph check holds the three rules below. Slice 2's rule, which refused an `envParam()` and a root input field with one name, goes with `envParam()`; rule 2 takes its place.

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
| Secret node | Root input field | Core's existing check in Load, also when no service reads the node (4.6) |
| Any node | Another node | Rule 1 |

The graph check's message:

```text
"EMAIL_FROM" is used two ways: as the platform variable "shop.emailFrom", which services read at boot, and as input.EMAIL_FROM of root module "shop", which the deploy reads. A name has one meaning in an app. Use one of them, or give the other a different name.
```

The rule finds root input fields in `graph.appConfigurationRead.rootInput`, by each field's first path segment. Like core's check, it sees only the root input fields the root's body passes on, because Composer cannot list a schema's keys (4.6, "Known limit").

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

Slice 2's handling of a platform variable applies to a node's value, with these changes.

**Serializer.**

- A platform variable value, plain or secret, stays in place in the binding and is written as a `$platform` marker with the variable's name, and `secret: true` for a secret.
- Any other param source except `generatedParam()` and `serviceOrigin()` is refused, naming the platform variable nodes as the fix.
- The serializer no longer reads the app configuration.

**Variables left out of the document.** The dev preflight's list of variables to leave out, `absentVariables`, covers plain platform variables as well as secrets. A variable named in it is left out of the document, as an unset secret is in slice 2.

**Schema failure naming the variable.** The service's schema may refuse its input with an issue whose path equals a platform variable's path in the binding, or lies under it. Then the error ends with `The field "<path>" reads the platform variable "<NAME>".`

**Per-key params.** A plain node in a service's per-key params writes a pointer row read at boot, with the variable's name. Deploy preflight checks that row, and `prisma dev` fills it (5.6).

**Deploy preflight.**

- Preflight finds the platform variable names, plain and secret, from the same walk of each service's binding, without serializing the service. An invalid input still fails after preflight reports the platform variables, as in slice 2.
- The names also include every node no service reads: the value resources not in `valueReads`.
- The dev preflight finds names the same way.
- Existence, resolution, triggers, the required error and the findings are slice 2's, unchanged.

**Unread variables, each once.** Preflight finds unread variables only from the value resources not in `valueReads`. Their reader is `{ kind: 'unread', node: <the node's address>, nodeKind: 'resource' }`. So a secret node that a module receives and no service reads is listed once, named by its node.

**Boot.** Unchanged. The input-document package already reads plain markers, and boot already reads a per-key pointer row.

**Messages that name a removed function.** Each names the platform variable node instead:

- the message for an array position that reads a platform variable with no value, plain or secret, and its fallback for a value that should not be absent;
- the refusal of a binding value that is not plain data, which says a binding's leaves are literals, `envParam(...)` or `envSecret(...)`, and to "bind envSecret('NAME') instead";
- the schema-failure note, which says "envSecret() included";
- the refusal of a `SecretBox` in a binding, in the target and in core;
- the messages given where the serializer and preflight need a variable's name and the source has none, which become the message in 5.1;
- the app configuration file's known-secret refusal in the CLI, which says "which an envSecret() in the graph reads" and whose fix says "Read the secret with envSecret('NAME')". It says "which a platform secret in the graph reads", and the fix says to provision `variable.secret({ name: 'NAME' })` in the app root;
- the `prisma dev` advice on where to set a missing variable, which says "the `config` list for an env-sourced param". It says "the `config` list for a plain platform variable".

No doc comment in the target or the shared modules names either function after this slice.

### 5.6 `prisma dev`

Under `prisma dev`, Composer plays the platform's part: it gives each service the value of each plain node it reads. The target's dev preflight reads the values from the app configuration, and the CLI hands them to the second process in the app configuration file. This one path serves a plain node in an input field and in a per-key param.

**Filling a plain platform variable.** The target's dev preflight runs in the first process with the app configuration. For each plain node a service reads (from `valueReads`), it reads the app configuration under the variable's name, once. It decides one of three outcomes:

- **Text.** The name and text go into the texts it returns. The value counts toward its readers' fingerprints, so a changed value restarts only its readers.
- **Unset or empty.** What happens depends on where each reader reads it, from the reader's `valueReads` entries:
  - **An input field.** The name joins `absentVariables`, so the dev document leaves the field out, as for an unset secret. Slice 2's requirement check decides whether the service's schema needs it.
  - **A per-key param.** The param is judged as slice 2 judges a per-key param. A required one is reported as a required param and stops dev. An optional one, or one with a default, is skipped: the second process writes no text for it, so the param takes its default or is left out. A per-key read has no marker in the input document, so the name joins `absentVariables` only when an input field also reads it.
- **Present but not text.** `prisma dev` stops before any service starts:

  ```text
  The `config` adapters return a number for "SMTP_PORT", not text. prisma dev cannot start, because the platform variable "shop.smtpPort", which service "shop.mail.service" reads, takes text. Make the adapter return a string.
  ```

  With several readers it says `which services "shop.mail.service" and "shop.digest.service" read`.

**How the texts reach the second process.** The app configuration file holds the root's input, as today, and a new top-level member for these texts. The graph's `appConfigurationRead` stays as Load built it, so it still shows that Load read no platform variable's value.

- `LocalTargetDescriptor.preflight` returns `Promise<DevPreflightResult>` instead of `Promise<PreflightPayload>`:

  ```ts
  interface DevPreflightResult {
    readonly payload: PreflightPayload;
    readonly plainVariableText: Readonly<Record<string, string>>; // as in 4.5
  }
  ```

  `DevPreflightResult` is exported as a type from the same entry point as `LocalTargetDescriptor`, in `@prisma/composer` and `@internal/core`. The deploy preflight's type does not change.
- `prisma dev` keeps the texts from the preflight it runs at start, and writes them into the file on the first converge and on every rebuild. The deploy writes `{}`.
- The file is `{ appConfigurationRead: { rootInput }, plainVariableText, nodeAddresses }`. Reading a file without `plainVariableText` fails.
- Before the file is written, every plain value in it, the root's input and each member of `plainVariableText`, is checked against the known secrets. A plain value equal to a secret's value fails with `CONFIG.SECRET_AS_PLAIN_VALUE`. For a member of `plainVariableText`, the message names the platform variable:

  ```text
  The platform variable "EMAIL_FROM", which prisma dev read from the `config` adapters, holds the value of the secret "EMAIL_DELIVERY_CREDENTIAL". Composer hands the second process every plain value in a file, and never writes a secret to a file.
  Fix: keep the value of "EMAIL_DELIVERY_CREDENTIAL" out of the platform variable "EMAIL_FROM", or give "EMAIL_FROM" a different value.
  ```

**The second process.** It reads `plainVariableText` from the file and passes it to the local target's providers. The local target fills a plain `$platform` marker and a per-key pointer from `plainVariableText`, and a secret marker from the named secrets.

**Isolation, the missing-value rule and restarts.** These are slice 2's, extended to plain variables. The dev preflight's requirement check uses `absentVariables`. A changed value pauses rebuilds until `prisma dev` restarts, as any change to the app configuration already does.

**A change to what the app reads while `prisma dev` runs.** A rebuild after a code change runs no preflight, as today, and the values and the list of unset variables come from the preflight at start. A read that the change adds therefore has neither: its service would fail at boot with advice to run `prisma project env add`, which is wrong locally. To prevent that, after a rebuild's Load, `prisma dev` compares two sets from the rebuilt graph with the same two sets at start:

1. **The reads.** One key per `valueReads` entry: reader, resource and site.
2. **The read nodes.** Each read value resource's address together with its `props`, compared as plain data.

Both are sets, so their order does not matter: reordering two `provision()` calls changes neither. Core's graph gives both, so the CLI reads no target payload. If either set differs, `prisma dev` does not converge. It reports the change and pauses rebuilds until it is restarted, as it already does when a value in the app configuration or the app secrets changes. So a variable renamed under an explicit id, and a node changed from plain to secret under the same id, pause rebuilds like an added read. The message is a warning in the same form as the existing one:

```text
The platform variables the app reads changed since dev started: reads of "shop.smtpPort" were added, reads of "shop.emailFrom" were removed, and "shop.sender" was changed. Restart dev to apply them; rebuilds are paused until then.
```

- It names each node by address.
- A node whose reads were only added goes in the first clause, and one whose reads were only removed goes in the second.
- A node whose `props` changed, or whose reads were both added and removed, such as a read moved to another field, goes in the third clause.
- A node appears in one clause only. A clause with no nodes is left out.
- It is reported once. Rebuilds stay paused until restart.
- This covers a plain node and a secret node, and a new reader of a node already read.

Running the dev preflight on every rebuild, so a changed read needs no restart, is recorded in `deferred.md` (section 10).

Load reads no platform variable's value, so the deploy reads none.

### 5.7 The deploy report and findings

A platform variable node no service reads is reported in "Platform variables with no value", with the existing `unread` reader: `named by resource "shop.emailFrom", read by no service`. It is not required. The node has no line among the deployed resources (5.3).

### 5.8 What leaves the target's public surface

`envSecret()` and `envParam()` go, with everything that exists only for them. `generatedParam()` and `serviceOrigin()` stay.

- `@prisma/composer-prisma-cloud` no longer exports `envParam`, `envSecret` or `secretName`, or their payload types. It adds `variable` and the `PlatformVariablePayload` type. `paramName` stays (5.1).
- The deploy reads nothing from the app configuration for a source: not in the serializer, not in preflight, not in the per-key params.
- The Prisma Cloud deploy preflight reads nothing from `PrismaCloudPreflightInput.configuration`. The member stays, because it comes from core's `PreflightInput`, which every extension's preflight receives, and the dev preflight still reads the app configuration.

## 6. Examples

The examples show the two ways to get a value, so new apps copy them.

- **`examples/email`.** `envSecret('EMAIL_DELIVERY_CREDENTIAL')` becomes `provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }))` in the root. `EMAIL_FROM` is already a root input field and stays one. Its tests find the variable a binding reads through the public graph: they look up the entry in `graph.valueReads` by reader and site path, take the node at its `resource` from `graph.nodes`, and read `props.name`. The examples cannot use the target's internal name lookup.
- **`examples/auth`.** `envParam('EMAIL_FROM')` becomes `provision(variable({ name: 'EMAIL_FROM' }))`, and `envSecret('EMAIL_DELIVERY_CREDENTIAL')` becomes `provision(variable.secret(…))`. `EMAIL_FROM` is now read from the platform at boot, not from the deploy's shell. Its doc comment and `.env.example` say where to set it. Its tests assert through `graph.valueReads` and the node's `props.name`, as `examples/email` does.
- **`examples/storefront-auth`.** `envSecret('AUTH_SIGNING_SECRET')` becomes `provision(variable.secret({ name: 'AUTH_SIGNING_SECRET' }))`. Its tests assert as `examples/email` does. The CI flow from slice 2 is unchanged.
- **`examples/env-param` becomes `examples/root-input`.** Its `envParam('ENV_PARAM_GREETING')` in a service binding becomes a root input field, `ROOT_INPUT_GREETING`, declared in the root's `input` schema and passed to the service. The example keeps its meaning: a value the deploy reads from the shell, different per environment. Its package becomes `@prisma/example-root-input`, its app `root-input-example`, and its scripts' `ENV_PARAM_…` variables become `ROOT_INPUT_…`. Its doc comments and smoke script describe a root input field, and the smoke script checks for the greeting the deploy shell held. No CI workflow names the example. Its deployed stack has a new name, so the old `env-param-example` stack on the test workspace is destroyed by hand once, with the old name.
- **The integration fixture** `test/integration/test/fixtures/local-dev/module.ts`. Its two `envSecret()` calls become two secret nodes, `LOCALDEV_FIXTURE_API_KEY` and `LOCALDEV_FIXTURE_WEBHOOK_SECRET`. Its per-key `envParam('LOCALDEV_FIXTURE_GREETING')` becomes a plain node.
- **The shared modules.** The auth, cron and email modules write neither function in their code. Their READMEs and tests take values through the module's input. `auth/README.md`'s `envParam('AUTH_BASE_URL')` becomes `serviceOrigin()` or a root input field, whichever the surrounding text describes.

No example, fixture or test in this repository uses `envSecret()`, `envParam()`, `secretName()` or a `configurationKey` source after this slice.

## 7. Records, guides and skill

Each record is rewritten in place as the current statement, with no history and no supersession notes. After this slice, every record, guide and the skill teach the two ways to get a value: a root input field for a value the deploy reads, and a platform variable node for a value the service reads at boot. No record names `envSecret()` or `envParam()`.

- **ADR-0062** (environment values come from `resolve()` and the config adapters), Values section. Core's record for values gains core's rules:
  - the value resource and its rules (4.1), `valueResource()` and `isValueResource()`;
  - root-only provisioning, with its core reason and its compile error (4.3);
  - the address on the origin (4.2);
  - the reads list (4.6), with the known limit on the root input fields the checks see;
  - no source reads the app configuration: `paramSource()` takes no `configurationKey`, and a configuration value is a root input field only (4.5).

  The table of runtime-value origins gains a third origin, a value resource given by `provision()`, and loses `envSecret()`. The list of deploy-time values loses `envParam('NAME')` in a binding. The list of sources becomes `generatedParam()`, `serviceOrigin()` and a platform variable node's value. The app configuration file holds the root's input, and under `prisma dev` the platform variable texts. The check "a name that both an `envParam()` and an `envSecret()` read" goes; the check of a root input field against a secret stays. The code sample at the top uses a node. Its alternatives gain design section 15's rejection of a new node kind, with the reason that still holds: it changes core's node union. Its line in the ADR index changes with it.
- **ADR-0064** (the deploy does not copy local values to platform variables). Gains the Prisma Cloud use: the constructors, the default id, the graph check's rules, the per-key params rule, the serializer, preflight and dev handling of plain values, and design section 15's other alternatives. "The shortcuts" section is replaced by the two ways to get a value. "Names" says `variable()` and `variable.secret()` check the name. "One name has one meaning" lists the node and the root input field. The code sample uses a node. Its title stays. Its line in the ADR index changes with it.
- **ADR-0032** (params bind at provision; a platform variable is a target-owned source). A per-key param takes a literal or a plain platform variable node's value. The node's value writes a pointer row that the service reads at boot. The code sample provisions `variable({ name: 'APP_ORIGIN' })` in the root and binds it. The title stays. Its line in the ADR index changes with it.
- **ADR-0029** (a secret is a value the framework never stores). A secret is any value handled as one. A platform secret, built with `variable.secret()`, is the kind Composer never sees during a deploy. Its ADR index line changes with it.
- **ADR-0058** (`prisma dev` reads secrets from the app secrets). The named secrets are the values under the secrets keys of the graph's secret sources, which are the platform secret nodes. The app configuration file it describes holds, under `prisma dev`, the text of each plain platform variable a service reads, in `plainVariableText`, checked against the known secrets like every other plain value. Its line in the ADR index changes with it.
- **ADR-0042, ADR-0039 and ADR-0061.** Every mention of `envSecret()` or `envParam()` becomes the node or a root input field. ADR-0042's marker says `secret: true` for a platform secret. Their lines in the ADR index change with them.
- **ADR-0041.** Its "Value sourcing (secrets/env-params)" says "platform variables".
- **ADR-0063** (a node depends on an interface or exposes one). A service also reads a platform variable: a third relationship, recorded as `valueReads`, not as an edge.
- **ADR-0017.** Unchanged. The platform variable node has a descriptor and is looked up like every other node. Only the application topology and the deploy report skip a value resource.
- **ADR-0057 and the principle "A node's address is its identity, everywhere"** (`docs/design/01-principles/architectural-principles.md`). The rule stays as it is. Each gains one sentence: a node that names something Composer does not own, such as a platform variable node, records no platform row and no topology node, and the thing it names keeps its owner's handle, such as the variable's name. ADR-0057's line in the ADR index gains the same clause.
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

### Terminology sweep

The two terms:

- "Platform variable" means a variable on the platform that a service reads by name at boot, declared by a node.
- "A variable on the platform" means any row, including Composer's `COMPOSER_` rows.

Most existing uses of "platform variable" stay correct, such as the boot errors in the input-document package, the required-variables text, and the refusal of a name Prisma Cloud manages, in preflight and `deploy-cli.md`.

These uses name rows the app does not declare, so they are wrong. They change to "a variable on the platform", or "variables on the platform":

- the reserved-name message: "names starting with COMPOSER_ are Composer's own platform variables";
- the destroy message: "Removed the Project (…), with every platform variable set on it";
- the boot message for a `$generated` row: "The platform variable "<name>", which the deploy writes, has no value";
- the doc comments of `Pointer` and `RuntimeValue`, which say a pointer names the platform variable: a `generatedParam()` or `serviceOrigin()` pointer names a `COMPOSER_` row;
- ADR-0039's "PATCH the platform variable" (a `COMPOSER_` origin row);
- ADR-0042's and ADR-0062's statement that a pointer "names the platform variable holding the data", for every pointer kind;
- `docs/design/05-prisma-cloud/alchemy-lowering.md`'s "The rows are plain platform variables" (the `DATABASE_URL` rows Composer claims).

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
- **For extension authors:** core's `paramSource()` no longer takes `configurationKey`. Read a deploy-time value through a root input field. `AppConfigurationRead` has no `configurationKeyText`, `LocalTargetProvidersInput.configurationKeyText` is now `plainVariableText`, and `LocalTargetDescriptor.preflight` returns the new exported type `DevPreflightResult`, `{ payload, plainVariableText }`.

**Follow-ups in other repositories.** These are not work in this slice. Each repository moves when it upgrades Composer:

- Internal Prisma apps call the removed functions: the deploy apps in `prisma/streams`, and the apps in `prisma/asks`, `prisma/program` and `prisma/pdp-control-plane`.
- `prisma/skills` and `prisma/web` document them, and change in their own repositories.

They are recorded in `deferred.md` (section 10).

## 9. Acceptance: expected behaviour

Everything below is observable without reading the code. Each item says what must be true and the package whose tests prove it. The numbers are stable, so reviews can refer to them; 9 and 10 are not used.

### Root-only provisioning and binding types (4.3, 5.2)

- **1.** In an `appRoot()` body, `provision(variable({ name: 'X' }))` compiles and has type `ParamSource<PlatformVariablePayload> & RuntimeValue<string> & { readonly id: string }`. `provision(variable.secret({ name: 'X' }))` has type `SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString> & { readonly id: string }`. Tested in the target.
- **2.** In a `module()` body, at the root or below it, `provision(variable(…))` and `provision(variable(…), { id: 'x' })` do not compile, and the diagnostic contains `appRoot()`. In an `appRoot()` body, `provision(variable(…), { id: 'x', input: {} })` does not compile, and the diagnostic names `input`, not `appRoot()`. A type test proves the calls do not compile, and a fixture compiled with the TypeScript compiler API proves the diagnostic's text. The existing messages for a bad service or module call do not change. Tested in core.
- **3.** A plain node value bound to a secret field, or a secret one bound to a `field()`, does not compile. A plain node value in a service's per-key params compiles; a secret one does not. Tested in the target.

### The constructors (5.2)

- **4.** `variable({ name: 'email_from' })` and `variable({ name: 'PORT' })` fail when the body runs, with slice 2's name messages naming `variable`. The example in `variable({ name: '' })`'s message reads `variable({ name: 'API_KEY' })`. Tested in the target.
- **5.** The default id of `variable({ name: 'EMAIL_FROM' })` is `emailFrom`. `SMTP_PORT`, `EMAIL_2FA` and `A__B` give `smtpPort`, `email2fa` and `aB`. `provision(node, { id: 'sender' })` gives `shop.sender`. Tested in the target.

### Value resources, the provisioned copy and the reads list (4.1, 4.2, 4.6)

- **11.** The loaded graph has a resource node of type `platform-variable` for each node. `valueReads` lists each service that reads it, with the site, in each of these cases: at depth inside objects and arrays; through two module inputs; through a module input whose schema copies its object (an ArkType morph); through a module factory's argument; and in a per-key param. The provisioned value has a non-enumerable `id` and is frozen. `${value}` in a body throws the source-misuse error. Tested in core.
- **12.** Load refuses a value resource that provides a contract or declares dependency slots. Load also refuses a value resource provisioned in a `module()` body through a cast, including a `module()` root. Tested in core.
- **14.** A core message that names a node's value reads the node's label, for example "Bind the platform variable "EMAIL_FROM" directly into the input of the service that reads it". Tested in core.

### Duplicate ids and the graph check's rules (4.4, 5.4)

- **6.** Two nodes named `EMAIL_FROM` with different ids fail with rule 1's message, also when one is plain and one secret. The same node object provisioned twice with two ids fails rule 1. With the default id it fails the duplicate-id error, which names the node already at the id. Two names that give one id fail the duplicate-id error naming both. Tested in the target and core.
- **7.** A plain node and a root input field with one name, where the root's body passes the field on, fail with rule 2's message. A secret node and such a root input field fail with core's message, also when no service reads the secret node. Tested in the target and core.
- **8.** A node value bound as a service's whole input fails with rule 3's message. Tested in the target.

### Secrets (4.6, 5.5)

- **13.** A platform secret node the root provisions and binds nowhere is a known secret: a value under its name in the app secrets is redacted from every output, and `secretsKeys(graph)` includes it. Tested in core.
- **20.** A planted secret under a secret node's name appears in no deploy output, report, stack file or boot error. Tested in the target, by the serializer's planted-secret test using a secret node and by a preflight case that searches the findings and the rendered report; and by the manual QA search in section 11.

### Deploy: serializer, topology, report and preflight (5.3, 5.5, 5.7)

- **15.** Deploying writes `$platform` markers for plain and secret nodes, and a pointer row for a plain node in a per-key param. A schema failure on a field that reads a node ends with the variable's name. Tested in the target.
- **16.** The application topology sent to Prisma Cloud has no platform variable node. The node is lowered through its descriptor, which creates nothing. The deploy report and the deploy command's table have no line for it. Registry coverage finds its descriptor. Tested in the lowering package, core and the CLI.
- **17.** Preflight refuses a required unset node and reports an optional unset node. It lists an unread plain node and an unread secret node once each, named by their node. A secret node that a module receives and no service reads is listed once. Changing a node's row redeploys exactly its readers. Tested in the target.

### `prisma dev` (5.6)

- **18.** Under `prisma dev`:
  - a plain node is filled from the app configuration, in an input field and in a per-key param;
  - a required unset per-key param stops dev;
  - an unset optional per-key param, or one with a default, does not stop dev and takes its default;
  - an unset optional input field is left out of the input document;
  - a required unset input field stops dev;
  - a non-text value stops dev before any service starts, with the message in 5.6;
  - a changed value changes only its readers' fingerprints;
  - a rebuild whose reads or read nodes differ from those at start, because a code change added or removed a node, a reader or a site, does not converge, reports the message in 5.6, and pauses rebuilds until restart. A variable renamed under an explicit id pauses rebuilds. A plain node changed to a secret under the same id pauses rebuilds. Reordering two `provision()` calls does not.

  Tested in the target, and the rebuild case in the CLI. The target tests run with a plain node bound to a required param, an optional param and a param with a default.
- **19.** Under `prisma dev`, a plain node's text that holds a secret's value fails with `CONFIG.SECRET_AS_PLAIN_VALUE`. The deploy's app configuration file has an empty `plainVariableText`. The graph's `appConfigurationRead` holds the root's input only. The file written on the first converge and on a rebuild holds the texts from the preflight run at start. The second process reads `plainVariableText` from the file and passes it to the local target. Tested in the CLI.
- **21.** The integration fixture `test/integration/test/fixtures/local-dev/module.ts` provisions two secret nodes and one plain node in a per-key param, and `prisma dev` serves their values. Run only that integration file locally, not the full integration suite.

### The removal (4.5, 5.8)

- **22.** `@prisma/composer-prisma-cloud` exports no `envSecret`, `envParam` or `secretName`, at run time or in its types. Tested in the target.
- **23.** Core's `paramSource()` takes no `configurationKey`: passing one does not compile. Every param source is known only at boot, and listing one in `resolve()` fails with the pointer refusal. `AppConfigurationRead` has no `configurationKeyText`. Tested in core.
- **24.** `examples/root-input` deploys, and its smoke script finds the greeting the deploy shell held. Checked by the manual QA in section 11.

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
- New: moving Prisma's other repositories off `envSecret()` and `envParam()`: the deploy apps in `prisma/streams`, the apps in `prisma/asks`, `prisma/program` and `prisma/pdp-control-plane`, and the docs in `prisma/skills` and `prisma/web`, each in its own repository.
- New: running the dev preflight on every rebuild, so a change to what the app reads needs no restart of `prisma dev`. Reason to wait: it is a separate change to the dev loop.
- New: the check of a node against a root input field with one name sees only the root input fields the root's body passes on, because Composer cannot list a schema's keys (4.6).
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

**Keep `envSecret()` and `envParam()` as deprecated spellings.** An earlier version of this spec kept both, deprecated, and removed them later. That leaves two ways to name one platform variable. The graph would not list an `envSecret()` as a node, so R1 would hold only for apps that use the node. Supporting it below the root also needed core to record, for every secret source, which module body built it and which bound it, using state kept on `globalThis` while bodies run, plus a graph check rule with two messages and a known false refusal for a file-level constant. Will chose one mechanism and no leftover function. The apps that use the functions are internal to Prisma, and each moves in its own repository (section 8).

**Remove only `envSecret()`.** `envParam()` would stay, for its two uses. In an input binding it duplicates a root input field. In per-key params it duplicates a plain node. Keeping it would keep core's `configurationKey`, Load's reads of the app configuration for sources, the serializer's read of the app configuration at deploy, and the `envParam()` rows of the one-meaning rule. Removing both leaves exactly one way for each kind of value.

**The address in the pointer's data.** An earlier version of the plan and the design put the provisioned address into "the pointer's data", as ordinary data, "so it survives the copy a schema library may make". The pointer has no data member: it carries only its kind, and the payload belongs to the target. The stated reason also does not hold: object spread copies symbol keys, and core already recovers a source through its origin after a schema has copied it. The address goes on the source's origin instead (4.2), where core keeps everything else it knows about a source.

**A public `value` member on the node.** An earlier draft gave `ValueResourceNode` a public `value`. Any module body could then write `input: { key: variable.secret({ name: 'X' }).value }`, which compiles and bypasses both root-only provisioning and one node per name. The value is held under the core-only key `VALUE_RESOURCE` instead, and only `provision()` reads it (4.1).

**A core helper to read the node's address.** An earlier draft exported `resourceAddressOf(source)` so the target could tell a node's value from an `envSecret()`. With `envSecret()` gone, every platform variable value comes from a node, and the target needs no such test. Only core reads `origin.resource`, to build `valueReads`.

**No descriptor for the node.** A reviewer proposed no descriptor at all, with core skipping value resources in lowering, in registry coverage and in the topology. That would remove a no-op descriptor and the empty report line. It also reverses ADR-0017, which records one lookup for every node with no special case. The spec keeps a descriptor that creates nothing (5.3), so ADR-0017 does not change. Core skips value resources only in the deploy report, and the topology composer skips them.

**A descriptor flag to leave the topology.** An earlier version of the design said the descriptor is not written to the application topology, which suggests a flag on the descriptor. The topology composer reads no descriptor. The rule is on the node instead: core's `isValueResource()` decides it, and the same predicate keeps the node out of the deploy report (5.3).

**A prefixed node type, `prisma-cloud/platform-variable`.** The registry key already sits under the extension, through `node.extension`, and every existing key in `prismaCloud().nodes` is a bare name, such as `compute` and `public-url`. The node's type is `platform-variable`, like the others (5.2).

**Refusing a node value in a plain field in the graph check.** An earlier version of the design put this refusal in the graph check, naming the variable and the place, and an earlier version of the plan said it fails Load. The graph cannot see a schema's field kinds, because Composer does not look inside a schema (ADR-0042). The compiler refuses it, and the service's own schema refuses what a cast gets past, with the variable's name added to its error (5.4 rule 3, 5.5).

**Checking every root input field the schema declares.** Rule 2 and core's secret check could compare a node against every field the root's schema declares, not only the fields its body passes on. That needs Composer to list a schema's keys, which ADR-0042 rules out: Standard Schema leaves out introspection on purpose, and walking a library's internals would tie Composer to them. The checks see the fields the body passes on, which are the ones a service can read, and the limit is recorded (4.6, `deferred.md`).

**The array-position rule in the graph check.** An earlier version of design section 5 listed it among the graph check's rules. Slice 2 placed it in the serializer, where the array positions are known, and it stays there (5.5).

**Rules that "fail Load".** An earlier version of the plan said that two declarations "fail Load". This is a Prisma Cloud rule, so it belongs to the target, not to core's Load. It runs in the graph check, which runs right after Load and before any preflight or service (5.4).

**Refusing a node value in per-key params.** An earlier version of the design listed per-key params among the places a platform variable may not go, on the grounds that they need data the deploy has. They do not: a per-key param bound to a platform variable writes a pointer row that the service reads at boot (ADR-0032, ADR-0064). With `envParam()` removed, refusing the node there would leave per-key params with no way to read a platform variable. A plain node in per-key params is accepted (5.2, 5.5), as `design.md` states.

**Keeping `configurationKeyText` in the graph's record for the dev texts.** `AppConfigurationRead.configurationKeyText` could stay, filled by nothing at Load and by the dev texts in the file. That gives one field two meanings: what Load read, and what the dev preflight found. The field goes, and the file carries `plainVariableText`, named for what it holds (5.6).

**The CLI filling dev values.** An earlier version of the plan said plain values go into the app configuration file "beside the keys it already carries", without saying who writes them. Load cannot, because Load also runs for deploy, and the deploy does not read these values. The CLI cannot, because only the target reads the payload that holds the name. A core field such as `devConfigurationKey`, mirroring `secretsKey`, would let the CLI find the names, but it adds a core concept for one target's need. The target's dev preflight works the values out, and the CLI writes them into the file (5.6).

**Moving `examples/env-param` to the nodes.** That would change what the example shows, from a value the deploy reads to a value read at boot, and its smoke test would need a row set on the platform first. `examples/auth` already shows a plain node. Moving `env-param` to a root input field, and renaming it `root-input`, keeps what it shows and gives the second way to get a value its own example (6).

**A new node kind instead of a value resource.** A new node kind, such as a "reference", is more honest in the types. It changes core's node union. An earlier version of the design also gave the platform's list of topology node kinds as a cost; the node stays out of the topology, so that cost does not apply. A resource that is a value costs less and says the same thing (4.1). ADR-0062 records this.

**Core's rules in ADR-0064.** ADR-0064 is the Prisma Cloud target's record. Core's rules, the value resource and root-only provisioning, are core's, so they go in ADR-0062, core's record for values, and ADR-0064 records only the Prisma Cloud use (7).

**The variable's name as an exception to the address principle.** The principle says a node's address is its identity everywhere. Making the name the node's identity would need an exception. It does not: the node is identified by its address everywhere Composer refers to it, and only the row it names keeps the variable's name. ADR-0057 and the principle gain one clarifying sentence instead (7).

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

## 13. References

- Design: [../../design.md](../../design.md) sections 4, 5, 6, 10, 12, 14 and 15.
- Grounding against `main` at `ab3b4f7a`, just after slice 2 merged: `wip/pv-review/slice3-grounding.md`.
- Design reviews, in `reviews/`: `reviews/design-architect.md`, `reviews/design-principal-engineer.md`. They explain why several choices in section 12 were made. Their findings about `envSecret()` below the root (A08, A17, F03, F13, F14) no longer apply, because the function is removed.
- Core: `packages/0-framework/1-core/core/src/`, in particular `node.ts`, `value.ts`, `module-input.ts`, `load-module.ts`, `resolve-values.ts`, `graph-types.ts` and `control/`.
- Target: `packages/1-prisma-cloud/1-extensions/target/src/`; lowering: `packages/1-prisma-cloud/0-lowering/lowering/`; input document: `packages/1-prisma-cloud/0-lowering/input-document/`; local target: `packages/1-prisma-cloud/0-lowering/local-target/`.
- CLI: `packages/0-framework/3-tooling/cli/src/`.
- Records: ADR-0017, ADR-0029, 0032, 0039, 0042, 0057, 0058, 0061, 0062, 0063, 0064; `docs/design/01-principles/architectural-principles.md`; `docs/design/03-domain-model/glossary.md` and `domain-map.md`.
