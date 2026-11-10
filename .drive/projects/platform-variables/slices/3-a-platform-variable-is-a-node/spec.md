# 3. A platform variable is a node

Parent: [project spec](../../spec.md), [plan](../../plan.md) section 3, [design](../../design.md) sections 4, 5, 6, 10, 12 and 14. Grounded against `main` at `ab3b4f7a`, just after slice 2 merged: `wip/pv-review/slice3-grounding.md`. Revised after the architect's and the principal engineer's reviews in `reviews/`.

This document is the whole design for slice 3. It names every type, function, check, message, file and record the slice changes. Where it departs from the plan or the project design, the entry says so and why, under **Changed from the plan**.

## 1. At a glance

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

- The root provisions two platform variable nodes. `provision()` returns the value itself, with `id` on it, so the root passes `from` and `deliveryCredential` into the email module's input like any other value.
- A plain platform variable goes into a `field()` field, or into a service's per-key param. A platform secret goes into a secret field and reaches the service boxed.
- A module below the root cannot provision one. The compiler refuses it, and its error names `appRoot()`. The module declares what it needs in its input, and the app's author wires the value down.
- The loaded graph lists both nodes and, for each service, the variables it reads, without deploying.
- Deploy, preflight, boot and `prisma dev` treat a node's variable exactly as slice 2 treats an `envSecret()`'s. Under `prisma dev`, the target's dev preflight also fills a plain platform variable from the app configuration.
- `envSecret()` becomes a deprecated spelling of a platform secret. Below the root it fails with a message that says to provision the node in the root.
- There is no `schema` yet. Every value is text. Slice 4 adds `schema`.

## 2. Terms

These follow the project spec's terms. Slice 3 makes the glossary match them.

- **Platform variable.** A variable on the platform that the app reads by name at boot, declared by a node, by `envSecret()`, or by a per-key `envParam()`. The node, built with `variable({ name })`, is how an app declares one; it is called a **platform variable node**.
- **Platform secret.** A platform variable whose value is handled as a secret: boxed in the service and redacted wherever Composer prints. Built with `variable.secret({ name })`, or written inline with the deprecated `envSecret('NAME')`.
- **A variable on the platform**, or **row.** Any entry in a Prisma Cloud project's environment variables: a name and a non-empty text, at a class and optionally a branch. That includes Composer's own `COMPOSER_` rows, which are not platform variables.
- **Value resource.** Core's name for a resource node that is also a value: provisioning it returns a runtime value, not a reference to a port. A platform variable is the one value resource today.

## 3. Core

### 3.1 A resource can be a value

A value resource is a `ResourceNode` that holds a source under a core-only symbol key, `VALUE_RESOURCE` in `packages/0-framework/1-core/core/src/value.ts`, declared beside `VALUE_ORIGIN`. It is `Symbol.for('prisma:value-resource')`, like the other brands, so `isValueResource()` works across two installed copies of core. As `NODE` is in `node.ts`, only the key's type is exported (`export type { VALUE_RESOURCE }`, from `@prisma/composer` and `@internal/core`), so declaration files that name `ValueResourceNode`, such as the target's, can be built; the value stays internal. The node has no public member that holds the source, so module code cannot read the value off the node and bind it without provisioning it. Only `provision()` reads the key.

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
- `isValueResource()` is true for a resource node that holds a source under `VALUE_RESOURCE`. Both are exported from `@prisma/composer` and `@internal/core`.
- `extension` means what it means on every node (ADR-0017): the extension whose registry holds the node's descriptor. A value resource has a descriptor like any other resource (4.3).

Load refuses a value resource that breaks these rules, because an extension can build a node without `valueResource()`. It fails with `COMPOSE.GRAPH_INVALID`:

```text
Resource "<address>" is a value and also <provides a contract | declares dependency slots | holds a value known at deploy>. A resource that is a value provides no contract, has no dependencies, and holds a value known only at boot.
```

It takes no `deps`, `input`, `params` or `secrets` on `provision()`, as every resource today.

### 3.2 What `provision()` returns for a value resource

`provision(node)` for a value resource returns a new source: a copy of the node's source whose origin also records the provisioned node's address, with `id` set on it.

- **The copy.** The `provision` closure in `load-module.ts` builds it with `buildSource`, with the same brand, payload and pointer kind, and an origin with the original origin's `sourceKind`, `label` and `secretsKey` or `configurationKey`, plus `resource`, the node's full address. `buildSource` sets `origin.source` to the copy itself, so `restore` and `canonicalSecret` in `resolve-values.ts` recover the copy, not the node's own source. It also installs the `toString`, `valueOf` and `Symbol.toPrimitive` traps, so `${value}` in a body throws the source-misuse error. The copy is frozen, like every source.
- **`resource` on the origin.** Both source variants of `ValueOrigin` in `value.ts` gain `readonly resource: NodeId | undefined`. A source no node provisioned, such as an `envSecret()`, has `undefined`.
- **`id`.** The node's full address, such as `shop.emailFrom`, the same as every other `provision()` return today. It is defined as a non-enumerable property before the copy is frozen, so walkers and `JSON.stringify` of bindings see no new key.
- **Two provisions, two copies.** Each provision builds its own copy, so `secretUses` (keyed by `origin.source`) keeps one entry per provision.
- **Why the origin, not the pointer.** A pointer carries only its kind, and the payload belongs to the target, so core has no other place for the address. The origin is a symbol-keyed member; object spread copies symbol keys, and core already recovers a source through its origin after a schema has copied it.
- **A core helper.** `resourceAddressOf(source): NodeId | undefined` returns `origin.resource`. The target uses it to tell a node's value from an `envSecret()`, because the origin is internal to core.

**Changed from the plan.** The design said the address goes into "the pointer's data" as ordinary data, "so it survives the copy a schema library may make". The pointer has no data member, and the stated reason does not hold: spread copies symbol keys, and core already relies on that. The origin is where core keeps everything else it knows about a source.

### 3.3 Only the root provisions a value resource, and the compiler enforces it

**Why only the root.** A value resource names something outside the app, which the operator supplies, and those names form one space per deployed app. The app root is the app, so it is the one module whose scope matches that space. A module below the root declares what it needs in its input instead.

The provision types change as follows.

- **`ModuleBuilder['provision']`** (a `module()` body). Its resource overload becomes `ResourceNode<C> & { readonly [VALUE_RESOURCE]?: undefined }`, so a value resource no longer matches it. The last overload, the catch-all, takes the refusal in its parameter type, the pattern `NotDeployTime` and `ModuleInputIsNotAValue` use in `value.ts`:

  ```ts
  type OnlyInAppRoot = "Only appRoot() can provision a resource that is a value, such as a platform variable. Provision it in the app root and pass its value down through this module's input.";

  provision<N extends ServiceNode | ModuleNode | ValueResourceNode>(
    node: N extends ValueResourceNode ? OnlyInAppRoot : N,
    ...args: ProvisionArgs<N>
  ): ProvisionedRef<ExposeOf<N>>;
  ```

  `ProvisionArgs<N>` gains a value resource case, `[opts?: { id?: string }]`. Without it, `provision(variable(…), { id: 'x' })` infers `N` as a service and the error names a missing property instead of `appRoot()`. For `provision(v, { id: 'x' })`, TypeScript reports only the last overload's error. For the one-argument `provision(v)`, it lists the two overloads that take one argument, the resource overload and the catch-all, and the catch-all's line carries the text. So the text appears for both calls. This was checked with the repo's TypeScript 6.0.3: the message reads `Argument of type '…' is not assignable to parameter of type '"Only appRoot() can provision a resource that is a value, …"'`, and a service, a module and a plain resource still match their own overloads.
- **`AppRootContext['provision']`** (an `appRoot()` body) becomes its own type instead of `ModuleBuilder['provision']`. It has every `ModuleBuilder` overload, plus, first:

  ```ts
  provision<V extends SourceValue>(node: ValueResourceNode<V>, opts?: { readonly id?: string }): V & { readonly id: string };
  ```

- **Run time.** The `provision` closure in `load-module.ts` returns the stamped copy for a value resource. If it reaches a value resource in a body whose module answers `isRoot()` false, through a cast, Load fails with `COMPOSE.GRAPH_INVALID`:

  ```text
  Module "<module address>" provisions "<id>", a resource that is a value. Only the app root, built with appRoot(), can provision one. Provision it in the root and pass its value down through this module's input.
  ```

- **A `module()` root.** An entry built with `module()` is accepted, as slice 1 decided. It is not an app root: its body uses `ModuleBuilder`, and `isRoot()` is false, so it cannot provision a value resource, at compile time or at run time. The error names `appRoot()` as the fix.

**The error text is tested.** A type test with `@ts-expect-error` proves the call does not compile, with and without `{ id }`. A second test compiles a small fixture with the TypeScript compiler API and checks that the diagnostic contains `appRoot()`, so a later change to the overloads cannot drop the hint silently. The existing catch-all error tests (`app-root.test-d.ts` and the binding-key messages) must still pass, because the catch-all's messages are what users see for every bad service or module call.

### 3.4 Duplicate provision ids

A platform variable's default id comes from its name (4.2), so two names can give one id. The duplicate-id error in `load-module.ts` changes for every node, because core cannot tell which nodes take a derived id. It names the node already at that id, from `byId`:

```text
Duplicate provision id "<id>" in module "<module address>": "<address>" already holds <what>. Give one of them a different id with provision(node, { id: '…' }).
```

`<what>` is the source's label for a value resource, such as `the platform variable "EMAIL_FROM"`, and `<kind> "<name>"` for any other node. This matters most for two variable names that give one id, where neither id appears in the user's code. Its tests in `module.test.ts` and `module-composition.test.ts` change with it.

### 3.5 Where each secret source was created and bound

`SecretSourceUse` in `graph-types.ts` (`{ source, address, nodeKind }`) gains two fields. Only `Graph.secretSources` carries them, because only the graph check's rule 4 (4.4) reads them.

- **`createdIn: NodeId | undefined`.** The module whose body was running when the source was built. It records when the source was built, not where its code is written. Load keeps the address of the body it is running on `globalThis`, under the key `Symbol.for('prisma:running-module-body')`, so a source built through a second installed copy of core sees the same address, as the `Symbol.for` brands do. Load sets it when a body starts and restores the enclosing body's address in a `finally` block, because a child's body runs inside its parent's `provision()` call and a body can throw. `secretSource()` and `paramSource()` read it and put it on the origin as `createdIn`. A source built outside any body, such as a module-level constant, has `undefined`.
- **`boundIn: readonly NodeId[]`.** Every module whose body passed the source object in a `provision()` binding: a service's `input` or `params`, or a module's `input`. Load walks the binding at any depth, through plain objects and arrays, and stops at a value whose origin kind is `input`, a field of the module's own input, which is not a source. So `input: { smtp: { credential: envSecret('X') } }` counts. Load collects one entry per binding site, in `provision()`, before the binding is recorded, so a source bound in two bodies lists both.

`resolveValues` copies both fields into every `SecretSourceUse` it writes for a source, including the replacement `secretSourcesReceivedBy` makes when a service holds the source.

### 3.6 The reads relation

`Graph` gains one list:

```ts
interface ValueRead {
  readonly reader: NodeId;     // the service whose resolved binding holds the value
  readonly resource: NodeId;   // the address of the value resource
  readonly site: { readonly kind: 'serviceInput' | 'param'; readonly path: string };
}
readonly valueReads: readonly ValueRead[];
```

- `site.kind` uses the names core's `ValueBindingSite` already gives these two places: `serviceInput` for the service's input binding and `param` for a per-key param. `site.path` is the dot-joined key path inside the input binding, `''` for the whole binding, or the param's name.
- Load builds it after `resolveValues`: it walks each service's resolved input binding and per-key params at any depth, through objects and arrays, and records every source whose origin has a `resource`. A value passed through any number of module inputs still carries the address, because `restore` puts back the provisioned copy.

`Graph.secretSources` also holds every **secret** value resource. `resolveValues` takes the provisioned copies as a new input, `valueResources: ReadonlyMap<NodeId, SourceValue>`, and inserts each secret one into `secretUses` before it collects any binding: `{ source: <the copy>, address: <the node's address>, nodeKind: 'resource' }`. Then:

- A service that reads it replaces that entry with the service, as `secretSourcesReceivedBy` does today.
- A module that receives it and no service reads leaves the node's entry in place, because `recordSecret` keeps the first entry.
- `appConfigurationReadOf` iterates `secretSources`, so core's one-meaning check covers an unread platform secret too.
- `secretsKeys(graph)` includes every platform secret the root provisions, so its value is redacted even when nothing binds it.

The doc comments change to match: `Graph.secretSources` is "every secret source a binding names, and every secret value resource, once each"; `SecretSourceUse.address` is "a service whose final binding holds it, if one does; otherwise the secret value resource itself, or the module whose input holds it".

## 4. The Prisma Cloud target

### 4.1 The payload

One payload brand covers every platform variable, in `packages/1-prisma-cloud/1-extensions/target/src/platform-variable.ts` (new):

```ts
interface PlatformVariablePayload {
  readonly [PLATFORM_VARIABLE]: true;
  readonly name: string;
  readonly secret: boolean;
}
```

- `envSecret('NAME')` builds its source with this payload (`secret: true`), replacing its own brand.
- An `envSecret()` source is a platform variable source whose origin has no `resource`, from `resourceAddressOf()`. A provisioned node's value has one.
- `secretName()` is renamed `platformVariableName(source, where)` and accepts any source with this payload, plain or secret. `secretName` stays exported from `@prisma/composer-prisma-cloud` as a deprecated alias that accepts only secret sources, because three example tests import it. Its refusal for any other source names both spellings:

  ```text
  <where> is bound to a source that is not a platform variable. Bind a platform variable from @prisma/composer-prisma-cloud: provision variable() or variable.secret() in the app root and pass its value down.
  ```

- `paramName()` in `param.ts` accepts a plain platform variable source as well as an `envParam()` source, and returns its name. `isEnvParamSource()` is unchanged; a new `isPlatformVariableSource()` covers the shared payload.

### 4.2 The constructors

In `platform-variable.ts`, exported from `@prisma/composer-prisma-cloud`. `variable` is a function with a `secret` property, built with `Object.assign`:

```ts
export const variable: {
  (options: { readonly name: string }): ValueResourceNode<ParamSource<PlatformVariablePayload> & RuntimeValue<string>>;
  secret(options: { readonly name: string }): ValueResourceNode<SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString>>;
};
```

- **Name.** Each calls slice 2's `assertVariableName(name, factory, example)`, with `factory` `variable` or `variable.secret`, so a bad or reserved name fails when the root's body runs, with slice 2's messages. `assertVariableName` gains the `example` argument, because its empty-name message writes `${factory}('API_KEY')`, which is wrong for `variable({ name: 'API_KEY' })`.
- **The node.** Built with core's `valueResource()`: `type: 'prisma-cloud/platform-variable'`, `extension` the Prisma Cloud extension, `props: { name, secret }`, `value` the source.
- **The node's `name`** (its default provision id) is the variable's name in camel case: split on `_`, drop empty parts, lower-case each part, capitalise each part after the first. `EMAIL_FROM` → `emailFrom`, `SMTP_PORT` → `smtpPort`, `EMAIL_2FA` → `email2fa`, `A__B` → `aB`. An explicit id goes on `provision(node, { id })`.
- **The source.** `variable()` builds a plain source with `paramSource(payload, { label: 'the platform variable "NAME"' })`, with no `configurationKey`, so it is a pointer at deploy. `variable.secret()` builds `secretSource(payload, { label: 'the platform secret "NAME"', secretsKey: name })`, so its value is a known secret and reaches `prisma dev`'s second process as a named secret, as `envSecret()`'s does. Core's messages print the label where they name a source, for example "Bind the platform variable "EMAIL_FROM" directly into the input of the service that reads it", so the label names what the user binds, not the constructor call.
- **Types.** `provision(variable({ name }))` is `ParamSource<PlatformVariablePayload> & RuntimeValue<string> & { readonly id: string }`, the same shape as `serviceOrigin()` plus `id`. It fits a `field()` field and, because it is a `ParamSource`, a per-key param in `ParamBindings`. `provision(variable.secret({ name }))` is `SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString> & { readonly id: string }`, which binds to a `secretString()` field until module-input S18 ships `secret(inner)`. A plain value in a secret field, and a secret in a `field()`, already fail to compile, because the pointer kinds differ (`sources.test-d.ts`). A secret node does not compile in per-key params, because `ParamBindings` admits no secret source, as for `envSecret()` today.

### 4.3 The descriptor, the deploy report and the application topology

- **Descriptor.** `descriptors/platform-variable.ts` registers `prisma-cloud/platform-variable` in `prismaCloud().nodes`, with a lowering that returns `{ outputs: {}, entities: [] }`. It creates nothing and writes no row. The local target registers the same lowering. The deploy walk and registry coverage treat the node as every other resource, as ADR-0017 records: one lookup, `extensions[node.extension].nodes[node.type]`, with no special case. ADR-0017 does not change.
- **The deploy report.** The lowering loop in `packages/0-framework/1-core/core/src/control/deploy.ts` adds no report entry for a value resource, using `isValueResource()`. So the printed deploy report and the deploy command's table have no empty line for the node, which an operator would read as something Composer deployed. Unread nodes still appear in the preflight findings (4.7).
- **Topology.** `composeApplicationTopology` in `packages/1-prisma-cloud/0-lowering/lowering/src/builds/application-topology.ts` skips every value resource, using `isValueResource()`. It is not sent to the platform's application topology, because the platform has no node kind for it and Composer owns nothing it names. A value resource has no slots and no ports, so no edge or port points at it.
- **Other readers of `graph.nodes`.** `env-key-clash.ts`, `public-url.ts`, the local target's emulators and the dev server and watch lists in the CLI each select nodes by kind or type, and none selects `prisma-cloud/platform-variable`. They need no change.

**Changed from the plan.** The plan said the descriptor is "not sent to the application topology". The topology composer reads no descriptor, so the rule is on the node: core's `isValueResource()` decides it. The same predicate keeps the node out of the deploy report.

### 4.4 The graph check

`graph-check.ts` gains these rules. Each runs on the loaded graph, after Load, in `deploy`, `destroy` and `prisma dev`, and fails with `GraphCheckError` (`COMPOSE.GRAPH_INVALID`). Each error names the variable and every address involved. The platform variable nodes are the value resources in `graph.nodes`; each node's name is `props.name`.

1. **One declaration per name.** Two platform variable nodes with one variable name fail, whatever their ids, plain or secret:

   ```text
   The platform variable "EMAIL_FROM" is declared twice in the app root, by "shop.emailFrom" and "shop.sender". Declare each platform variable once and pass its value to every module that needs it.
   ```

   Two nodes with one name and the default id get the same id, so Load's duplicate-id error (3.4) fires first and this rule does not run. The same node object provisioned twice with two explicit ids is two declarations and fails here; with the default id it fails the duplicate-id error.

2. **One meaning per name.** The ways a name can be used are: a plain platform variable node or a per-key `envParam()`, which read the same variable at boot and count as one meaning; a platform secret node; `envSecret()`; `envParam()` in an input binding, which is a value read at deploy; and a field of the root's input. The rule refuses a name used two ways when at least one of them is a node:

   ```text
   "EMAIL_FROM" is used two ways: as the platform variable "shop.emailFrom" and as envParam('EMAIL_FROM') in the input of service "shop.email.service", field "from". A name has one meaning in an app. Use one of them, or give the other a different name.
   ```

   - A per-key `envParam('REGION')` and a plain node `REGION` are allowed together, as two `envParam('X')` are today (ADR-0064).
   - Pairs without a node keep today's checks: core refuses a secret against a value read from the app configuration, and the graph check refuses `envParam()` against a root input field.
   - Core's Load already refuses a name read from the app configuration (`envParam()` in either place, or a root input field) that a secret source also names. A secret node is a secret source, and every secret node is in `secretSources` (3.6), so that core check covers `envParam()` or a root field against a secret node. The graph check covers the other pairs with a node: a plain node against a secret node, `envSecret()`, `envParam()` in an input binding or a root field, and a secret node against `envSecret()`.
   - The `envSecret()` uses come from `secretSources` entries with no resource address. The `envParam()` uses come from the binding walk the check already does. Root fields come from `graph.appConfigurationRead.rootInput`.

3. **A service's whole input.** A node value bound as a service's whole input fails. From `valueReads` with `site.kind` `serviceInput` and `site.path` `''`:

   ```text
   The platform variable "EMAIL_FROM" is bound as the whole input of service "shop.email.service". Bind it to one field of the input instead.
   ```

   The compiler refuses a node value in a `resolve()` dependency, a plain field (a schema member written without `field()`) and a field of the other secrecy. Core's Load refuses a `resolve()` dependency and a resource's props at run time. A plain field reached through a cast is refused by the service's own schema at serialize or preflight, and 4.5 adds the variable's name to that error.

4. **`envSecret()` below the root.** A secret source with the platform variable payload and no resource address fails when it was created in a module other than the root, or, when it was created outside any body, when any module other than the root bound it directly. In terms of 3.5: `createdIn` is set and is not the root, or `createdIn` is `undefined` and `boundIn` has an entry other than the root.

   When `createdIn` is a module other than the root:

   ```text
   envSecret('EMAIL_DELIVERY_CREDENTIAL') is created in module "shop.email". A platform variable is declared only in the app root. Provision variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }) in the root, built with appRoot(), and pass its value through this module's input.
   ```

   When `createdIn` is `undefined`:

   ```text
   envSecret('INGEST_TOKEN') was called outside any module body and is bound in module "shop.cron". Call it inside the app root's body, or provision variable.secret({ name: 'INGEST_TOKEN' }) in the root and pass its value down.
   ```

   - An `envSecret()` written in the root and passed down through module inputs is allowed.
   - An `envSecret()` written in the root's body as a module factory's argument is allowed, even when the factory's body binds it. For `cron({ runner, input: { token: envSecret('X') } })` written in the root's body, `envSecret('X')` runs while the root's body runs, so `createdIn` is the root and the rule passes, although `boundIn` is `["shop.cron"]`.
   - A file-level `const token = envSecret('INGEST_TOKEN')` passed to `cron()` in the root fails with the second message. The graph cannot tell it apart from a constant in a shared module's file, and the refusal is acceptable for a deprecated spelling, so the message says how to fix it.
   - A file-level constant bound in the root and in a nested module fails, naming the nested module.
   - `envSecret()` is deprecated (4.8), not refused, in the root.

**Changed from the plan.** Four rules differ from the plan or the design:

- **The plain field.** The design puts the refusal of a node value in a plain field in the graph check, naming the variable and the place. The graph cannot see a schema's field kinds, because Composer does not look inside a schema (ADR-0042). The compiler refuses it, and the service's schema refuses what a cast gets past, with the variable's name added (4.5).
- **The array position.** Design section 5 lists the array-position rule among the graph check's rules. Slice 2 placed it in the serializer, where the array positions are known, and it stays there.
- **"Fails Load".** The plan says two declarations, and `envSecret()` below the root, "fail Load". They run in the graph check, which runs right after Load and before any preflight or service. Both are Prisma Cloud rules, so they belong to the target, not to core's Load.
- **Per-key params.** The design lists a service's per-key params among the places a platform variable may not go, because they "need data the deploy has". They do not: a per-key `envParam()` writes a pointer row that the service reads at boot (ADR-0032, ADR-0064). A plain node in per-key params writes the same pointer row and is accepted (4.5). The build corrects `design.md` line 161 in place.

### 4.5 Serializer, preflight, per-key params and boot

Slice 2's machinery handles the node with these changes:

- **Serializer** (`serializer.ts`). `resolveInputBinding` keeps a platform variable source in place, plain or secret, and `substitutePointers` calls `platformVariableName()` and writes `platformMarker(name, secret)`. Slice 2 wrote only secret markers. `resolveInputBinding`'s refusal of any other param source names the node as well as `envParam()`.
- **The leave-out option.** `absentSecrets` becomes `absentVariables`, and covers plain platform variables too. A variable named in it is left out of the document, as an unset secret is today. It is renamed in its writer and its reader together: `SerializeInputOptions` in `serializer.ts`, `required-variables.ts`, the dev preflight in `local-target/preflight.ts`, the dev payload's writer and parser in `control/preflight-payload.ts`, and its reader in `descriptors/compute.ts`.
- **Schema failure naming the variable.** `standardValidate` in `serializer.ts` keeps each issue's path, not only its message. When the service's schema refuses its input and an issue's path equals a platform variable's path in the binding or lies under it, the error ends with `The field "<path>" reads the platform variable "<NAME>".`
- **Per-key params.** A plain node in a service's per-key params writes a pointer row read at boot, exactly as a per-key `envParam()` does. The descriptor's `serialize` in `descriptors/compute.ts` already writes `encodeParamPointer(paramName(…))` for any param source; `paramName()` accepts the plain node (4.1). The per-key walk `envParamBindings()` in `preflight-names.ts` becomes `perKeyVariableBindings()` and returns every per-key param bound to `envParam()` or a plain node, so deploy preflight checks the row and dev fills it.
- **Deploy preflight names** (`preflight.ts`, `preflight-names.ts`). `inputSecretNames()` becomes `inputVariableNames()`. It returns plain and secret platform variable names from the same walk of each service's binding, so preflight does not serialize a service to find them, and an invalid input still fails after preflight reports the platform variables, as in slice 2. The dev preflight uses the same function. The names also include every platform variable node no service reads, from the value resources not in `valueReads`. `checkRequirements` leaves plain ones out through `absentVariables`. Existence, resolution, triggers, the required error and the findings are slice 2's, unchanged.
- **Unread variables, each once.** Unread nodes, plain and secret, come only from the value resources not in `valueReads`, with the reader `{ kind: 'unread', node: <the node's address>, nodeKind: 'resource' }`. Preflight skips every `secretSources` entry whose source has a resource address. An unread `envSecret()` in a module's input still comes from `secretSources`, as today. So a secret node that a module receives and no service reads is listed once, as named by its resource.
- **The readers of an `envSecret()`.** The target gets them from the walk of each service's input binding and per-key params, as slice 2 does, not from `secretSources`, which holds one entry per source.
- **Boot.** Unchanged. The input-document package already reads plain markers, and boot already reads a per-key pointer row.

**Messages that name only `envSecret()`.** Each now names the node, and keeps `envSecret()` as the older spelling where it is still accepted:

- the array-position message in `serializer.ts`, which calls `platformVariableName()` and covers the plain case;
- the binding walk's refusal of a value that is not plain data (`serializer.ts`), which says a binding's leaves are literals, `envParam(...)` or `envSecret(...)` and to "bind envSecret('NAME') instead";
- the schema-failure note in `serializeInput`, which says "envSecret() included";
- the `SecretBox` refusal in `serializer.ts` and core's `refuseSecretBoxes`;
- core's refusal of `secrets` on a service's `provision()` in `load-module.ts`, which says a service takes its secrets "as envSecret(...) leaves". Core names no target constructor: it says the service takes its secrets as values bound to `secretString()` fields of its `input` binding;
- the `where` texts that `preflight.ts` and `preflight-names.ts` pass to `platformVariableName()`, which say "a secret source" and "a secret in the input";
- the app configuration file's known-secret refusal in `cli/src/app-configuration-file.ts`, whose message says "which an envSecret() in the graph reads" and whose fix says "Read the secret with envSecret('NAME')";
- the `cron()` doc comment in `packages/1-prisma-cloud/2-shared-modules/cron/src/module.ts`, which tells users to put `envSecret(...)` in `opts.input`.

### 4.6 `prisma dev`

- **Filling a plain platform variable.** The target's dev preflight, `runDevPreflight` in `local-target/preflight.ts`, already runs in the first process with the app configuration. For each plain platform variable node that a service reads (from `valueReads`), it reads the app configuration under the variable's name, once, and decides three things from that one read:
  - text: the name and text go into the texts it returns, and the value joins `pointerVersions`, so a changed value restarts only its readers;
  - unset or empty: the name joins `absentVariables`, so the dev document leaves it out, as for an unset secret, and the requirement check decides whether a reader needs it;
  - present but not text: `prisma dev` stops before any service starts:

    ```text
    The `config` adapters return a number for "SMTP_PORT", not text. prisma dev cannot start, because the platform variable "shop.smtpPort", which service "shop.mail.service" reads, takes text. Make the adapter return a string.
    ```

    With several readers it says `which services "shop.mail.service" and "shop.digest.service" read`.
- **How the texts reach the second process.** `LocalTargetDescriptor.preflight` in `packages/0-framework/1-core/core/src/control/app-config.ts` returns `Promise<DevPreflightResult>`, `{ readonly payload: PreflightPayload; readonly platformVariableText: Readonly<Record<string, string>> }`, instead of `Promise<PreflightPayload>`. The deploy preflight's type does not change, and the deploy path does not compute these texts.
  - The graph does not change. `graph.appConfigurationRead` stays a record of what Load read, so it still shows that Load read no platform variable's value.
  - `executeDev` in `cli/src/operations/execute-dev.ts` keeps the texts from the start-time preflight and passes them to `prepareSecondProcess` in `cli/src/app-configuration-file.ts` as a new input, `platformVariableText`, on the first converge and on every rebuild.
  - `prepareSecondProcess` merges them into `configurationKeyText` when it builds the file's content, and runs `refuseSecretsIn` on the merged content. So every plain value is checked against the known secrets before the file is written, and a plain value equal to a secret's value fails with `CONFIG.SECRET_AS_PLAIN_VALUE`. The deploy passes no texts.
  - A key Load already read, such as a per-key `envParam('X')` beside a plain node `X`, has the same text, because both read the same app configuration. The second process reads one `configurationKeyText` map from the file, as today.
- **The second process.** Unchanged. The local target already fills a plain `$platform` marker and a per-key pointer from `configurationKeyText` in the app configuration file, and a secret marker from the named secrets.
- **Isolation, the missing-value rule and restarts.** Slice 2's, extended to plain variables: the dev preflight's requirement check uses `absentVariables`, and a changed value pauses rebuilds until `prisma dev` restarts, as `sameValues` already does for any change to the app configuration.
- **A node added while `prisma dev` runs.** A rebuild after a code change runs no preflight, as today. A plain node the change adds gets its value when `prisma dev` restarts. Recorded in `deferred.md` (section 9).

Load does not read a plain platform variable's value, so the deploy reads none.

**Changed from the plan.** The plan said plain values go into the app configuration file "beside the keys it already carries" without saying who writes them. Load cannot, because Load also runs for deploy, and the deploy does not read these values. The CLI cannot, because only the target reads the payload that holds the name. The target's dev preflight works them out, and `prepareSecondProcess` merges them into the file.

### 4.7 The deploy report and findings

A platform variable node no service reads is reported in "Platform variables with no value" with the existing `unread` reader: `named by resource "shop.emailFrom", read by no service`. It is not required. The node has no line among the deployed resources (4.3).

### 4.8 `envSecret()` deprecated

`envSecret()` gains a JSDoc tag:

```ts
/** @deprecated Provision `variable.secret({ name })` in the app root and pass its value down. */
```

It keeps working in the root. Below the root it fails the graph check (4.4, rule 4).

## 5. Examples

- **`examples/email`.** `envSecret('EMAIL_DELIVERY_CREDENTIAL')` becomes `provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }))` in the root. `examples/email/tests/secret-bindings.ts` uses the node.
- **`examples/auth`.** `envParam('EMAIL_FROM')` becomes `provision(variable({ name: 'EMAIL_FROM' }))`, and `envSecret('EMAIL_DELIVERY_CREDENTIAL')` becomes `provision(variable.secret(…))`. `EMAIL_FROM` is now read from the platform at boot, not from the deploy's shell; its `.env.example` and README say where to set it.
- **`examples/storefront-auth`.** `envSecret('AUTH_SIGNING_SECRET')` becomes `provision(variable.secret({ name: 'AUTH_SIGNING_SECRET' }))`. The CI flow from slice 2 is unchanged.
- **The example tests that import `secretName`**: `examples/auth/tests/module.test.ts`, `examples/storefront-auth/module.test.ts` and `examples/email/tests/module.test.ts`. They switch to `platformVariableName`.
- **`examples/env-param`.** Its `envParam('ENV_PARAM_GREETING')` in a service binding becomes a field of the root's input, the replacement `envParam()`'s deprecation names, so the example keeps its meaning: a value the deploy reads from the shell. Its doc comment in `module.ts`, which describes binding the env var at provision, is rewritten to describe a root input field. `scripts/smoke.ts` is unchanged.

**Changed from the plan.** The plan moves `env-param` to the nodes. That would change what the example shows, from a deploy-time value to a value read at boot, and its smoke test would need a row set on the platform first. Moving it to a root input field keeps what it shows and drops the deprecated use. Renaming or removing the example belongs with removing `envParam()` (section 9).

- **Below the root in packages.** The email and cron shared modules have no `envSecret()` in code; their tests and `email/README.md` that write `envSecret()` move to passing a value through the module's input.

## 6. Records, guides and skill

Each is rewritten in place as the current statement, with no history and no supersession notes.

- **ADR-0062, Values section.** Core's record for values gains core's rules, including that `createdIn` records when a source was built, not where its code is written: the value resource and its rules (3.1), `valueResource()` and `isValueResource()`, root-only provisioning with its core reason and its compile error (3.3), the address on the origin (3.2), the reads list (3.6), and where a secret source was created and bound (3.5). The table of runtime-value origins gains a third origin: a value resource, given by `provision()`. Line 82's list of sources gains the note that a value resource's value is a source too. Its alternatives gain design section 15's rejection of a new node kind, with the reason that still holds: it changes core's node union. Its line in the ADR index changes with it.
- **ADR-0064.** Gains the Prisma Cloud use only: the constructors, the default id, the graph check's rules, the per-key params rule, the serializer, preflight and dev handling of plain values, and design section 15's other alternatives. Its title stays: the deploy does not copy local values to what the nodes name, so it reads correctly under the new meaning. Its line in the ADR index changes with it.
- **ADR-0063.** A service also reads a platform variable: a third relationship, recorded as `valueReads`, not as an edge.
- **ADR-0029.** A secret is any value handled as one. A platform secret is the kind Composer never sees during a deploy, spelled as `variable.secret()` or the deprecated `envSecret()`. Its ADR index line (README line 53) changes with it.
- **ADR-0058.** The named secrets are the values under the secrets keys of the graph's secret sources, which include every platform secret node. The app configuration file it describes also holds, under `prisma dev`, the text of each plain platform variable a service reads, which the target's dev preflight reads; it is checked against the known secrets like every other plain value.
- **ADR-0017.** Unchanged. The platform variable node has a descriptor and is looked up like every other node; only the application topology and the deploy report skip a value resource.
- **ADR-0032.** A per-key param also takes a plain platform variable node, which writes the same pointer row as `envParam()`.
- **ADR-0057 and the principle "A node's address is its identity, everywhere"** (`docs/design/01-principles/architectural-principles.md`). The rule stays as it is. Each gains one sentence: a node that names something Composer does not own, such as a platform variable node, records no platform row and no topology node, and the thing it names keeps its owner's handle, such as the variable's name. ADR-0057's line in the ADR index gains the same clause. ADR-0051 is superseded by ADR-0057 and is not changed. Design section 14 names ADR-0051 for this change; whoever next edits the design corrects it to ADR-0057.
- **`design.md` line 161.** Per-key params leave the list of places a platform variable may not go (4.4).
- **Glossary.** Rewritten: Platform variable (a variable on the platform the app reads by name at boot, declared by a node, `envSecret()` or a per-key `envParam()`), The app configuration file (under `prisma dev` it also holds the text of each plain platform variable a service reads, which the target's dev preflight reads), Module (App), Core nouns, Resource, Topology, Address and logical ID, Input, Value, RuntimeValue, The app configuration, The app secrets, Secrets key, Named secrets, Known secrets. New: Platform variable node, Platform secret, Value resource, A variable on the platform.
- **Domain map** (`docs/design/03-domain-model/domain-map.md`). "Every node carries a managed lifecycle" and "Configuration is not a node" gain the platform variable node, which names a value the operator sets.
- **Domain docs.** `docs/design/10-domains/config-params.md` and `local-dev.md`, wherever they describe `envSecret()` as the way to name a platform secret.
- **Guides.** `docs/guides/building-an-app.md` and `deploying.md` show the nodes, the mental model (a name, the services that read it, and where the operator sets it), and one sentence on why only the root provisions them: a platform variable names something outside the app, the names form one space per deployed app, and the root is the app. `running-locally.md` says a plain platform variable comes from the `config` adapters under `prisma dev`.
- **Skill.** `skills/prisma-composer-core-concepts/SKILL.md` shows the nodes; staged with `scripts/stage-skills.mjs` run from `packages/9-public/composer`.

**Terminology sweep.** "Platform variable" means a variable on the platform that the app reads by name at boot, declared by a node, by `envSecret()` or by a per-key `envParam()`; "a variable on the platform" means any row, including Composer's `COMPOSER_` rows. Most existing uses stay correct, because they name a variable the app declares and a service reads by name, including the messages every `envSecret()` and per-key `envParam()` reaches, such as the boot errors in `document.ts` and the required-variables text, and the refusal of a name Prisma Cloud manages in `preflight.ts` and `deploy-cli.md`. These name rows the app does not declare, so they are wrong and change to "a variable on the platform", or "variables on the platform":

- `packages/1-prisma-cloud/1-extensions/target/src/variable-name.ts`: "names starting with COMPOSER_ are Composer's own platform variables".
- `packages/1-prisma-cloud/1-extensions/target/src/container.ts`: "Removed the Project, with every platform variable set on it".
- `packages/1-prisma-cloud/0-lowering/input-document/src/document.ts`: "The platform variable "<name>", which the deploy writes, has no value" (a `$generated` row).
- The `Pointer` doc comments in `packages/0-framework/0-foundation/foundation/src/pointer.ts` and the `RuntimeValue` doc comment in `packages/0-framework/1-core/core/src/value.ts`, which say a pointer names the platform variable: a `generatedParam()` or `serviceOrigin()` pointer names a `COMPOSER_` row.
- ADR-0039 line 38: "PATCH the platform variable" (a `COMPOSER_` origin row).
- ADR-0042 line 54 and ADR-0062's Values section: a pointer "names the platform variable holding the data", for every pointer kind.
- `docs/design/05-prisma-cloud/alchemy-lowering.md` line 69: "The rows are plain platform variables" (the `DATABASE_URL` rows Composer claims).

## 7. The release note

For the PR description, before and after:

- **`envSecret('X')` becomes a node.** Before: `input: { key: envSecret('X') }`. After: `const key = provision(variable.secret({ name: 'X' }))` in the app root, then `input: { key }`. Nothing on the platform changes: the variable's name is the same.
- **A plain platform variable is a node too.** `provision(variable({ name: 'X' }))` in the app root gives a value read at boot, for a `field()` field or a per-key param.
- **`envSecret()` below the root fails.** It fails with a message that says to provision `variable.secret()` in the root and pass the value through the module's input.
- **`envSecret()` is deprecated** in the root.
- **`secretName()` is deprecated.** Use `platformVariableName()`, which also reads a plain platform variable.
- **The duplicate-id error** names the node already at the id and says to pass `id`.

## 8. Expected behaviour

Everything below is observable without reading the code. Each item names its test. Test files without a path are in the package the item belongs to: core in `packages/0-framework/1-core/core/src/__tests__/`, the target in `packages/1-prisma-cloud/1-extensions/target/src/__tests__/`, the CLI in `packages/0-framework/3-tooling/cli/src/__tests__/`.

1. In an `appRoot()` body, `provision(variable({ name: 'X' }))` compiles and has type `ParamSource<PlatformVariablePayload> & RuntimeValue<string> & { readonly id: string }`; `provision(variable.secret({ name: 'X' }))` has type `SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString> & { readonly id: string }`. Test: target `platform-variable.test-d.ts` (new).
2. In a `module()` body, at the root or below it, `provision(variable(…))` and `provision(variable(…), { id: 'x' })` do not compile, and the diagnostic contains `appRoot()`. Tests: core `value-resource.test-d.ts` (new, `@ts-expect-error`) and core `value-resource-diagnostic.test.ts` (new, compiler API). `app-root.test-d.ts` and the binding-key message tests still pass.
3. A plain node value bound to a secret field, or a secret one bound to a `field()`, does not compile. A plain node value in a service's per-key params compiles; a secret one does not. Test: target `sources.test-d.ts`.
4. `variable({ name: 'email_from' })` and `variable({ name: 'PORT' })` fail when the body runs, with slice 2's name messages naming `variable`; `variable({ name: '' })`'s example reads `variable({ name: 'API_KEY' })`. Test: target `platform-variable.test.ts` (new).
5. The default id of `variable({ name: 'EMAIL_FROM' })` is `emailFrom`, and `SMTP_PORT`, `EMAIL_2FA` and `A__B` give `smtpPort`, `email2fa` and `aB`; `provision(node, { id: 'sender' })` gives `shop.sender`. Test: target `platform-variable.test.ts`.
6. Two nodes named `EMAIL_FROM` with different ids fail with rule 1's message. The same node object provisioned twice with two ids fails rule 1; with the default id it fails the duplicate-id error, which names the node already at the id. Two names that give one id fail the duplicate-id error naming both. Tests: target `graph-check.test.ts`; core `module.test.ts`.
7. A plain node and `envSecret()` with one name fail with rule 2's message, as do a plain node and a secret node, a plain node and `envParam()` in an input binding, and a plain node and a root input field. A plain node and a per-key `envParam()` with one name are allowed. A secret node and `envParam()`, or a secret node and a root input field, fail with core's message, also when no service reads the secret node. Tests: target `graph-check.test.ts`; core `resolve-values.test.ts`.
8. A node value bound as a service's whole input fails with rule 3's message. Test: target `graph-check.test.ts`.
9. `envSecret()` written in a nested module's body fails with rule 4's first message, also when it sits deep inside the binding (`input: { smtp: { credential: envSecret('X') } }`). Written in the root and passed down through module input, it works. Written in the root's body as a module factory's argument (`cron()`), it works. A file-level `envSecret()` constant passed to `cron()` in the root fails with rule 4's second message, which says it was called outside any module body. A file-level constant bound in the root and in a nested module fails, naming the nested module. Tests: core `resolve-values.test.ts` for `createdIn` and `boundIn`; target `graph-check.test.ts` for the rule and both messages.
10. A source built through a second import of core while a body runs gets that body as `createdIn`, and `isValueResource()` is true for a value resource built by the other copy. A body that throws leaves no `createdIn` on a source built afterwards outside Load. Test: core `resolve-values.test.ts`.
11. The loaded graph has a resource node of type `prisma-cloud/platform-variable` for each node, and `valueReads` lists each service that reads it with the site: at depth inside objects and arrays, through two module inputs, through a module input whose schema copies its object (an ArkType morph), through a module factory's argument, and in a per-key param. `${value}` in a body throws the source-misuse error. Test: core `value-resource.test.ts` (new).
12. Load refuses a value resource that provides a contract, declares dependency slots or holds a value known at deploy, and a value resource provisioned in a `module()` body through a cast, including a `module()` root. Test: core `value-resource.test.ts`.
13. A platform secret node the root provisions and binds nowhere is a known secret: a value under its name in the app secrets is redacted from every output, and `secretsKeys(graph)` includes it. Test: core `secrets.test.ts`.
14. A core message that names a node's value reads the node's label, for example "Bind the platform variable "EMAIL_FROM" directly into the input of the service that reads it". Test: core `resolve-values.test.ts`.
15. Deploying writes `$platform` markers for plain and secret nodes, and a pointer row for a plain node in a per-key param. A schema failure on a field that reads a node ends with the variable's name. Tests: target `serializer.test.ts` and `control-lowering.test.ts`.
16. The application topology sent to Prisma Cloud has no platform variable node. The node is lowered through its descriptor, which creates nothing, and the deploy report and the deploy command's table have no line for it. Registry coverage finds its descriptor. Tests: `packages/1-prisma-cloud/0-lowering/lowering/src/__tests__/application-topology.test.ts`; core `lowering.test.ts`; CLI `render-deployment.test.ts`.
17. Preflight refuses a required unset node, reports an optional unset node, and lists an unread plain node and an unread secret node once each, named by their resource. A secret node that a module receives and no service reads is listed once. Changing a node's row redeploys exactly its readers. Tests: target `preflight.test.ts` and `control-lowering.test.ts`.
18. Under `prisma dev`, a plain node is filled from the app configuration, in an input field and in a per-key param; a required unset per-key param stops dev; an unset optional one is left out; a required unset one stops dev; a non-text value stops dev before any service starts, with the message in 4.6; a changed value changes only its readers' fingerprints. Test: target `local-target-preflight.test.ts`.
19. Under `prisma dev`, a plain node's text that holds a secret's value fails with `CONFIG.SECRET_AS_PLAIN_VALUE`, and the deploy's app configuration file holds no plain node value. The graph's `appConfigurationRead` holds no plain node value. A rebuild's handover holds the texts from the start-time preflight. Tests: CLI `app-configuration-file.test.ts` and an `executeDev` test of the merge on the first converge and on a rebuild.
20. A planted secret under a secret node's name appears in no deploy output, report, stack file or boot error. Tests: the planted-secret test in target `input-serializer.test.ts`, extended to a secret node; a planted-secret case in target `preflight.test.ts` that searches the findings and the rendered report; and the manual QA search in section 10.
21. The integration fixture `test/integration/test/fixtures/local-dev/module.ts` gains one plain node read by a service, and `prisma dev` serves its value. Run only that file locally, with `bun run test/local-dev.integration.ts` from `test/integration`, not the full integration suite.

## 9. Scope

### In

Sections 3 to 7.

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

## 10. Done when

CI is green, `/drive-code-review` has run with its findings fixed, and QA on Prisma Cloud shows:

- an app with a plain node, a secret node and a module that receives both through its input, deployed with the secret unset and required (preflight refuses), then set (the service boots with the value);
- a plain node in a service's per-key param, read at boot;
- a fresh preview branch of that app;
- a nested module calling `provision(variable(…))`, and a `module()` root's body, both failing to compile with `appRoot()` in the error;
- the same app under `prisma dev`, with its values in `.env.dev`;
- the planted-secret search, repeated with a secret node.

## 11. Open questions

None that block the build. Eight choices in this document change the plan or the design, and each is marked **Changed from the plan** above: the address on the source's origin (3.2); the topology rule on the node, decided by `isValueResource()` (4.3); the plain field left to the schema, the array position left in the serializer, the graph check after Load, and per-key params accepting a plain node (4.4); the target's dev preflight filling plain values (4.6); and `env-param` moving to a root input field (5).

## 12. References

- Design: [../../design.md](../../design.md) sections 4, 5, 6, 10, 12, 14 and 15. Grounding: `wip/pv-review/slice3-grounding.md`. Reviews: `reviews/design-architect.md`, `reviews/design-principal-engineer.md`.
- Core: `packages/0-framework/1-core/core/src/node.ts`, `value.ts`, `load-module.ts`, `module-input.ts`, `resolve-values.ts`, `graph-types.ts`, `graph.ts`, `control/app-config.ts`, `control/deploy.ts`.
- Target: `packages/1-prisma-cloud/1-extensions/target/src/secret.ts`, `descriptors/platform-variable.ts` (new), `param.ts`, `variable-name.ts`, `graph-check.ts`, `serializer.ts`, `preflight.ts`, `preflight-names.ts`, `required-variables.ts`, `local-target/preflight.ts`, `control/preflight-payload.ts`, `descriptors/compute.ts`, `container.ts`; `packages/1-prisma-cloud/2-shared-modules/cron/src/module.ts`.
- Lowering: `packages/1-prisma-cloud/0-lowering/lowering/src/builds/application-topology.ts`; input document: `packages/1-prisma-cloud/0-lowering/input-document/src/document.ts`; local target: `packages/1-prisma-cloud/0-lowering/local-target/src/compute.ts`.
- CLI: `packages/0-framework/3-tooling/cli/src/app-configuration-file.ts`, `operations/execute-dev.ts`, `pipeline.ts`.
- Records: ADR-0017, ADR-0029, 0032, 0039, 0042, 0057, 0058, 0062, 0063, 0064; `docs/design/01-principles/architectural-principles.md`; `docs/design/03-domain-model/glossary.md` and `domain-map.md`.
