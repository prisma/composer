# C1 — Values, `resolve()` and the second evaluation pass

Parent: [public-urls spec](../../spec.md). Decisions: ADR-0062 (`resolve()`), ADR-0060 (a node with its edge already set), both amended by this slice as recorded below. Design settled with Will on 2026-10-29; see [design-notes.md](../../design-notes.md) entries 9 to 11. Builds on main at 26a403b1 and the design-docs branch at 5454abc2, both merged into this branch.

This spec leaves nothing to the implementer's judgement. Every type, signature, name, error message, file and test is pinned here. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose.

## 1. At a glance

```ts
import { module, resolve } from '@prisma/composer';

export default module('shop', ({ environment, provision }) => {
  const greeting = resolve([environment.name], ([name]) => `hello from ${name}`);
  const shout = resolve([greeting], ([text]) => text.toUpperCase());
  provision(echoService, { input: { greeting: shout } });
});
```

```sh
prisma deploy                          # echo's greeting input is "HELLO FROM PRODUCTION"
prisma deploy --environment staging    # "HELLO FROM STAGING"
prisma dev                             # "HELLO FROM DEV"
```

```ts
// the structure rule, enforced
resolve([environment.name], ([name]) => {
  provision(extraService);   // LoadError, see § 5.3
  return name;
});
```

## 2. The model

The terms below are the ubiquitous language for this slice. The glossary gains an entry for them (§ 9).

- **A value** is an opaque handle in a module body for something that has a real value once the graph is fully evaluated. The body can pass a value wherever a value of its type is accepted, and can do nothing else with it: it cannot read it, compare it or branch on it. This is what keeps the graph's structure the same whatever inputs Composer is given.
- **A value is provided or computed.** A provided value is handed to the module body; `environment.name` is one. A computed value is the result of `resolve(dependencies, fn)`: Load runs `fn` with its dependencies' values, after every module body has run.
- **A value is deploy-time or runtime.** A deploy-time value holds its real value by the end of Load. A runtime value is known only on the deployment system; its deploy-time form is a pointer to it. Every value in this slice is deploy-time. The runtime axis is recorded in the model so that `envSecret()` and `envParam()` can become values later without a redesign; they are not values in this slice.
- `resolve()` accepts values as dependencies, provided or computed, and returns a computed value.

Why one type and not two (a computed value and a reference): the prior art, Gradle's `Provider<T>`, Pulumi's `Output<T>` and CDK's `Token`, uses one type for a handle whose real value comes later, whether supplied or derived, and nothing that consumes a value cares which it is. The provided-or-computed difference is a discriminant on the value that Load reads and the body never sees.

Why the word "value": "lazy" puts the emphasis on evaluation on demand, which is not the point; the point is that the thing depends on a calculation over its inputs, and the simplest word for a calculated or supplied quantity is value. The repo already has a type `Values<P>` (the hydrated param values a connection receives, `config.ts`); the two do not collide in code because one is `Value<T>` and the other `Values<P>`, and the glossary entry defines the term by its opacity and its evaluation time.

## 3. Core: the value type and `resolve()`

### 3.1 File

New file `packages/0-framework/1-core/core/src/value.ts`. It imports nothing from `load-module.ts` or `node.ts`; `node.ts` and `load-module.ts` import from it.

### 3.2 Types, verbatim

```ts
const VALUE: unique symbol = blindCast<never, 'unique-symbol brand for a value'>(
  Symbol.for('prisma:value'),
);

/** How a value gets its real value: handed to the module body, or computed by `resolve()`. */
export type ValueOrigin<T> =
  | {
      readonly kind: 'environment';
      /** Which deploy-time fact of the environment this is. Only the name exists today. */
      readonly fact: 'name';
      readonly __type?: T;
    }
  | {
      readonly kind: 'computed';
      readonly dependencies: readonly Value<unknown>[];
      readonly compute: (values: readonly unknown[]) => T;
    };

/**
 * An opaque handle a module body can pass wherever a `T` is accepted. It has
 * its real value once Load has run every module body (ADR-0062). `environment.name`
 * is one; `resolve()` returns one computed from others.
 */
export interface Value<T> {
  readonly [VALUE]: true;
  readonly origin: ValueOrigin<T>;
}

/** The tuple of value types a dependency tuple stands for: what `resolve()`'s `fn` receives. */
export type ValuesOf<D extends readonly Value<unknown>[]> = {
  readonly [K in keyof D]: D[K] extends Value<infer T> ? T : never;
};
```

`__type` is a phantom member, never assigned: it makes `Value<T>` covariant in `T` for the environment branch, so a `Value<number>` is not assignable to a `Value<string>` and a `Value<string>` is assignable to a `Value<unknown>`. The `__` prefix follows `Contract.__cmp` and `RefPort.__providerId`. The computed branch gets its variance from `compute`'s return type. Both facts were checked with a probe compiled under `tsconfig.base.json` with TypeScript 6.0.3 on 2026-10-29; the probe is reproduced in § 11 as the type test.

### 3.3 Functions, verbatim

```ts
/**
 * A value computed from other values. `fn` receives the dependencies' real
 * values as one tuple, in order, and returns the value. Load runs it after
 * every module body, with `provision` disabled (ADR-0062).
 */
export function resolve<const D extends readonly Value<unknown>[], T>(
  dependencies: D,
  fn: (values: ValuesOf<D>) => T,
): Value<T>;
```

Implementation rules:

- Runtime checks, in this order, each throwing a plain `Error` (not a `LoadError`: construction is authoring, like `service()`), with exactly this text:
  - `dependencies` is not an array: `resolve() requires a tuple of values as its first argument.`
  - a member of `dependencies` is not a value (`isValue` false), naming its index: `resolve() dependency at index 1 is not a value — list environment.name or another resolve() result.`
  - `fn` is not a function: `resolve() requires a function as its second argument.`
- The dependency tuple is copied and frozen: `Object.freeze([...dependencies])`.
- The result is `Object.freeze({ [VALUE]: true as const, origin: Object.freeze({ kind: 'computed' as const, dependencies, compute }) })` where `compute` is `fn` cast to `(values: readonly unknown[]) => T` with `blindCast<..., 'fn is typed against ValuesOf<D>; Load supplies exactly that tuple'>`.

```ts
/** True if `value` is a `Value` (checks the brand only, never a prototype). */
export function isValue(value: unknown): value is Value<unknown>;
```

Same shape as `isSecretSource`: `typeof value === 'object' && value !== null && blindCast<Record<PropertyKey, unknown>, 'reading the value brand off an unknown object'>(value)[VALUE] === true`.

```ts
/** The deploy-time facts a module body receives as values. */
export interface EnvironmentValues {
  /** The environment's name, as `--environment` gave it. */
  readonly name: Value<string>;
}

/** The one `environment` object every module body receives. */
export const environmentValues: EnvironmentValues = Object.freeze({
  name: Object.freeze({
    [VALUE]: true as const,
    origin: Object.freeze({ kind: 'environment' as const, fact: 'name' as const }),
  }),
});
```

One frozen constant, shared by every Load and every module body. There is nothing per-body about it: it is a fact of the deploy, and identity does not matter to any check.

### 3.4 Exports

`packages/0-framework/1-core/core/src/exports/index.ts` adds, keeping the existing alphabetical grouping:

- types: `EnvironmentValues`, `Value`, `ValueOrigin`, `ValuesOf`;
- values: `isValue`, `resolve`.

`environmentValues` is not exported: the body reaches it through the module context. `@prisma/composer`'s index re-exports `@internal/core` wholesale, so nothing changes in `packages/9-public/composer`.

## 4. Core: where a value is accepted

### 4.1 The module context

`ModuleContext` in `node.ts` gains, after `params` and before `provision`:

```ts
  /** The deploy-time facts of the environment, as values (ADR-0062). List `environment.name` as a `resolve()` dependency. */
  readonly environment: EnvironmentValues;
```

`flatten` in `load-module.ts` sets `environment: environmentValues` on the `ctx` object it builds.

### 4.2 A service input binding

`InputBinding` in `node.ts` becomes:

```ts
export type InputBinding =
  | string
  | number
  | boolean
  | null
  | ParamSource
  | SecretSource
  | Value<InputBinding>
  | readonly InputBinding[]
  | { readonly [key: string]: InputBinding };
```

A value may sit at the root of the binding or at any depth inside objects and arrays. Its type parameter must itself be an `InputBinding`, so `Value<Date>` is refused by the compiler and `Value<string>` is accepted (probe § 11).

### 4.3 A service param binding

`ParamBindings<P>` in `node.ts` becomes:

```ts
export type ParamBindings<P extends Params> = {
  readonly [K in keyof P]?:
    | StandardSchemaV1.InferOutput<P[K]['schema']>
    | ParamSource
    | Value<StandardSchemaV1.InferOutput<P[K]['schema']>>;
};
```

### 4.4 A resource's options and dependency slots

See § 6.

### 4.5 Nowhere else

The following never accept a value. The compiler refuses the first three outright; Load refuses all of them at runtime with the error in § 5.3, because an untyped dependency slot (`required: undefined`, so `DepBindings` gives `unknown`) accepts anything at the type level.

- `provision()`'s `id` (typed `string`).
- A node's `name` (typed `string`).
- A module's `secrets` binding (typed `SecretSource`).
- A module's `params` binding (typed `ParamSource`).
- A `deps` entry, of a service, a module or a resource (§ 6).

## 5. Core: the second evaluation pass

### 5.1 `Load`'s option

`graph.ts`:

```ts
export interface LoadOptions {
  /** The root's address: the app name. Defaults to the root's `name`. */
  readonly id?: NodeId;
  /** The name of the environment being loaded, as `--environment` gave it. Required by any value over `environment.name`. */
  readonly environment?: string;
}

export function Load(root: ServiceNode | ModuleNode, opts?: LoadOptions): Graph;
```

`LoadOptions` is exported from `graph.ts` and from `exports/index.ts` (types). `loadModule(root, opts)` receives the same object. `loadService` is unchanged: a service root takes no bindings, so it has no values to run.

`environment` is optional because a graph that binds no value needs none, and every test that loads a graph today passes none. It is not defaulted: Load never invents an environment name.

### 5.2 Where the pass runs

In `loadModule`, after `for (const entry of pending) validateWiring(entry, byId);` and `assertDependencyDag(edges);`, and before the `Graph` is assembled. The pass is one function in a new file `packages/0-framework/1-core/core/src/evaluate-values.ts`:

```ts
export interface ValueBindingSite {
  /** The address of the node the binding belongs to. */
  readonly address: NodeId;
  /** `input` for a service input binding, `param` for a service param, `options` for a resource's options. */
  readonly channel: 'input' | 'param' | 'options';
  /** The param name for `param`; the dotted path inside the document for `input` and `options` (`''` at the root). */
  readonly path: string;
}

/**
 * Runs every value the graph binds, dependency-first, once each, and returns
 * each binding with its values replaced by their real values.
 */
export function evaluateValues(input: {
  readonly environment: string | undefined;
  readonly inputBindings: readonly ServiceInputBinding[];
  readonly params: readonly ParamBinding[];
  readonly resources: ReadonlyMap<NodeId, ResourceNode>;
}): {
  readonly inputBindings: readonly ServiceInputBinding[];
  readonly params: readonly ParamBinding[];
  readonly resourceOptions: ReadonlyMap<NodeId, Readonly<Record<string, unknown>>>;
};
```

The algorithm:

1. **Collect.** Walk every input binding, every param binding and every resource's `options` (§ 6.3) with the same walker `deepValues` already uses (arrays by index, plain objects by key, stopping at a `SecretSource`, a `ParamSource` or a `Value`). Each `Value` found is recorded with its binding site. The walk guards cycles in plain data with a `WeakSet`, as `deepValues` does.
2. **Evaluate**, with `const results = new Map<Value<unknown>, unknown>()` and `const visiting: Value<unknown>[] = []`:

   ```
   evaluate(value, site):
     if results.has(value): return results.get(value)
     if visiting includes value: throw cycle error (5.3)
     visiting.push(value)
     switch value.origin.kind:
       'environment':
         if environment === undefined: throw no-environment error (5.3)
         result = environment            // the only fact today is 'name'
       'computed':
         args = value.origin.dependencies.map(d => evaluate(d, site))
         result = value.origin.compute(args)
         check result (5.3): undefined, a Value anywhere inside, a Promise
     visiting.pop()
     results.set(value, result)
     return result
   ```

   `site` is the binding site the walk started from; a dependency reached through another value is reported under the same site, because the dependency has no site of its own.
3. **Substitute.** Rebuild each binding with every `Value` replaced by `results.get(value)`. Plain objects are rebuilt as plain objects, arrays as arrays, everything else kept by reference. A binding that contained no value is returned by reference, unchanged. The substituted bindings replace `inputBindings`, `paramBindings` and each resource's options before the `Graph` is built (§ 6.4 says how a resource's options reach the graph).

`fn` runs synchronously. An exception thrown by `fn` propagates out of `Load` unchanged: it is the author's own error and Load adds nothing to it.

### 5.3 Errors, verbatim

Every error below is a `LoadError` (code `COMPOSE.GRAPH_INVALID`, the one code Load uses until a finer taxonomy is carved out, per ADR-0044). `<site>` is rendered by one function `describeSite(site)`:

- channel `input`, path `''`: `the input binding of service "shop.echo"`
- channel `input`, path `greeting`: `input key "greeting" of service "shop.echo"`
- channel `param`: `param "port" of service "shop.echo"`
- channel `options`, path `url`: `option "url" of resource "shop.site"`
- channel `options`, path `''`: `the options of resource "shop.site"`

Paths inside arrays use the index: `hosts.0`.

| Condition | Message |
| --- | --- |
| `provision()` called after the first pass finished | `provision() was called after module "shop" was loaded, from inside a resolve() function. resolve() computes values, never structure: the graph is the same whatever inputs Composer is given (ADR-0062). Provision the node in the module body and pass the value into it.` |
| A value over `environment.name` when `Load` got no `environment` | `<site> depends on environment.name, but Load was given no environment — pass { environment } to Load (the deploy and dev commands do).` |
| A cycle | `<site> depends on itself: a resolve() value's dependencies lead back to it. Remove the cycle.` |
| `fn` returned `undefined` | `The resolve() function for <site> returned undefined. A value that does not exist for this environment must be expressed in the schema, not left undefined.` |
| `fn` returned a `Value`, or a plain object or array containing one | `The resolve() function for <site> returned a value instead of a plain result. List that value as a dependency and return its real value.` |
| `fn` returned a `Promise` | `The resolve() function for <site> returned a Promise. resolve() runs synchronously at Load.` |
| A `Value` found as `provision()`'s `id` | `provision() received a resolve() value as its id (module "shop"). A value computes a node's configuration, never its address: the graph is the same whatever inputs Composer is given (ADR-0062).` |
| A `Value` found in a `deps` entry | `The deps for "shop.web.db" are bound to a resolve() value. A value computes a node's configuration, never its edges: the graph is the same whatever inputs Composer is given (ADR-0062).` |
| A `Value` found in a module's `secrets` or `params` binding | `The secrets for "shop.auth" bind "signingKey" to a resolve() value. A value is not a secret source; bind envSecret('NAME') or a forwarded ctx.secrets ref.` and `The params for "shop.auth" bind "region" to a resolve() value. A module param slot takes a param source; bind envParam('NAME') or a forwarded ctx.params ref.` |

The `id` and `deps` checks run inside `provision()` at the top of the existing validation (before the `isConfigKeySegment` check for `id`; before `markUsed` for `deps`). The `secrets`/`params` checks run inside `validateSecretBinding` and `validateParamNeedBinding`, before their existing "non-secret value" / "non-source value" checks, so a value gets its own message.

### 5.4 Sealing `provision`

`flatten` declares `let sealed = false;` beside `localIds`. The first statement of the `provision` closure is `if (sealed) throw new LoadError(<the provision-after-load message>)`. `flatten` returns a `seal(): void` beside its outputs, and `loadModule` keeps every `seal` from every flattened module (the root's and every nested module's) in an array and calls them all after `assertDependencyDag(edges)` and before `evaluateValues`. The change to `flatten`'s return type is internal; `flatten` is not exported.

## 6. Core: a resource with its edge already set

### 6.1 Why

`publicUrl({ name, url, target })` (ADR-0060) is a resource: a RoutingUrl whose lifecycle Alchemy manages. It depends on the service it serves, and the dependency is known when the node is constructed, not at `provision()`. Today a resource declares no dependency slots and carries no options, so core must let a resource declare slots, wire them at construction, and carry options that the second pass resolves. Nothing here is specific to public URLs.

### 6.2 The node

`ResourceNode` in `node.ts` becomes:

```ts
export interface ResourceNode<
  C extends AnyContract = AnyContract,
  D extends Deps = Deps,
  O extends ResourceOptions = ResourceOptions,
> {
  readonly [NODE]: true;
  readonly kind: 'resource';
  readonly name: string;
  readonly extension: string;
  readonly type: C['kind'];
  readonly provides: C;
  /** Dependency slots, as a service's `inputs`; empty for a resource that depends on nothing. */
  readonly inputs: D;
  /** One wired producer ref per slot, fixed at construction. */
  readonly deps: DepBindings<D>;
  /** Plain data the factory records; Load resolves any value inside it. Empty for a resource with none. */
  readonly options: O;
}

/** The plain-data options a resource carries: literals and values, nested in objects and arrays. */
export type ResourceOptions = { readonly [key: string]: ResourceOption };
export type ResourceOption =
  | string
  | number
  | boolean
  | null
  | Value<ResourceOption>
  | readonly ResourceOption[]
  | { readonly [key: string]: ResourceOption };
```

`DepBindings<D>` is the existing unexported type in `node.ts`; it is exported now, since it appears in a public interface. The existing generic parameter `C` keeps its position so every current `ResourceNode<C>` still compiles; `D` and `O` default to the widest shapes.

### 6.3 The factory and the base class

```ts
export function resource<
  C extends AnyContract,
  D extends Deps = Record<never, never>,
  O extends ResourceOptions = Record<never, never>,
>(def: {
  name: string;
  extension: string;
  provides: C;
  inputs?: D;
  deps?: DepBindings<D>;
  options?: O;
}): ResourceNode<C, D, O>;
```

Rules, in order after the existing name, extension and `provides` checks:

- `inputs` keys pass `requireConfigKeySegmentNames(…, 'input', 'resource')`, as a service's do.
- Every `inputs` entry must be a branded dependency end; otherwise `Error`: `resource() input "target" is not a branded dependency end (construct it with the dependency() factory).`
- `deps` must name exactly the keys of `inputs`: a missing one is `Error`: `resource() declares input "target" but its deps do not wire it — a resource's slots are wired at construction.`; an extra one is `Error`: `resource() deps name "extra", which is not a declared input.`
- A `deps` entry that is a `Value` is `Error`: `resource() deps wire "target" to a resolve() value. A value computes a node's configuration, never its edges (ADR-0062).`
- `options`, when given, must be a plain object (prototype `Object.prototype` or `null`); otherwise `Error`: `resource() options must be a plain object.` Its contents are not validated at construction: a function or a class instance inside is rejected by the deploy target that reads it, as an input binding's is today.
- The node is frozen with `inputs: frozenShallowCopy(def.inputs ?? {})`, `deps: frozenShallowCopy(def.deps ?? {})`, `options: frozenShallowCopy(def.options ?? {})`.

`ResourceNodeBase<C, D, O>` takes the same three optional fields in its constructor `def`, runs the same checks, and assigns `inputs`, `deps`, `options`. `PostgresResourceNode` in the Prisma Cloud extension passes none and compiles unchanged.

### 6.4 Load

In `flatten`'s `provision` closure, the `child.kind === 'resource'` branch changes as follows. The four existing rejections stay (deps, secrets, input, params supplied at `provision()` are still errors; the wiring is the node's own). Then:

```
const localWiring = { ...child.deps };
markUsed(Object.values(localWiring));
byId.set(fullAddress, child);
const inputs = dependencySlots(child, fullAddress);
nodes.push(...inputs.nodes, { id: fullAddress, parent: selfId, node: child });
edges.push(...inputs.edges, ...wiringEdges(localWiring, fullAddress));
ports.push(...boundaryPortsOf(fullAddress, child));    // in ports for the slots
ports.push({ node: fullAddress, direction: 'out', name: RESOURCE_OUT_PORT, contractKind: child.provides.kind, style: contractStyleOf(child.provides) });
recordAuthoredWiring(fullAddress, localWiring);
pending.push({ deps: child.inputs, wiring: localWiring, targetId: fullAddress, targetKind: 'resource', enclosingModuleName: moduleNode.name });
return refForResource(fullAddress, child);
```

- `serviceInputs(service, serviceId)` in `load-service.ts` is renamed `dependencySlots(node: ServiceNode | ResourceNode, id: NodeId)`; its body is unchanged except the error texts say `Input "x" of "id"` as today (they do not name the kind). `loadService` calls it under the new name.
- `boundaryPortsOf(id, node)` in `load-service.ts` accepts `ModuleNode | ServiceNode | ResourceNode`; for a resource it reads `node.inputs` for the `in` ports and emits no `out` ports (the `$out` port is pushed by `flatten`, as today, so the port order on the wire is unchanged for a resource with no slots).
- `PendingWiring.targetKind` gains `'resource'`; `validateWiring`'s messages already interpolate `targetKind`, so no text changes.
- `assertDependencyDag` is unchanged: it walks every `dependency` edge. Its doc comment, which says only service and module edges can cycle, is rewritten: `A resource with dependency slots can take part in a cycle too.`
- `topoSort` is unchanged.
- In `evaluateValues` (§ 5.2), `resources` is every resource node in `byId` keyed by address. A resource whose `options` contain no value appears in the graph as the authored object. A resource whose `options` contain a value appears as a copy: `const copy = Object.create(Object.getPrototypeOf(node)); Object.defineProperties(copy, Object.getOwnPropertyDescriptors(node)); copy.options = resolvedOptions; Object.freeze(copy)`. The copy keeps the prototype, so a class built on `ResourceNodeBase` with methods still works, and keeps the brand, which is an own property. `loadModule` replaces the `GraphNode.node` for that address and the `byId` entry with the copy before building the `Graph`.

### 6.5 Lowering

`deploy.ts` is unchanged for resources: a resource descriptor receives `ctx.node` (the resolved copy when there was a value), `ctx.graph` and `ctx.lowered`, and finds its producers through `graph.edges` entries whose `to` is its address and `kind` is `'dependency'`. `buildConfig` stays service-only.

### 6.6 The application topology

`composeApplicationTopology` in `packages/1-prisma-cloud/0-lowering/lowering/src/builds/application-topology.ts` needs no change: it maps every `graph.ports` entry and every `graph.authoredEdges` entry. A resource with a slot submits an `in` port and an edge into it. The platform's `replaceApplicationTopology` interactor (pdp-control-plane, `packages/interactors/src/application-topology/replaceApplicationTopology.ts`, read 2026-10-29) checks only that ports are unique by node, direction and name, that every edge endpoint names a submitted port, and that a consuming endpoint has one incoming edge. It does not restrict which kinds carry `in` ports. The edge's `family` is `communication` when the producer is a service, which is what a public URL's edge is.

## 7. The environment name's path into Load

### 7.1 Lowering options

`LowerOptions` in `deploy.ts`: remove `readonly stage?: string;` and add, directly after `name`:

```ts
  /** The environment being deployed, as `--environment` gave it. Passed to Load for every value over `environment.name`. */
  readonly environment: string;
```

It is required. `lowering()` calls `Load(root, { id: opts.name, environment: opts.environment })`. Every `lowering()` and `lower()` call in tests gains `environment: 'test'`.

### 7.2 The generated stack files

- `generate-stack.ts`: `StackFileInput` gains `readonly environment: string;` and `renderOptions` renders `  environment: ${quote(input.environment)},` directly after the `name` line. The comment block in `StackFileInput` that says there is no `stage` field is deleted. `execute-deploy-destroy.ts` passes `environment` where it calls `writeStackFile`.
- `dev/generate-dev-stack.ts`: `renderOptions` renders `  environment: ${quote(input.environment)},` directly after the `name` line (the input already carries `environment`).

### 7.3 The CLI's own Load

`runPipeline` in `pipeline.ts` gains a parameter `environment: string` directly after `overrideName`, and calls `Load(entryModule.root, { id: name, environment })`. Its three callers pass the environment they already hold: `execute-deploy-destroy.ts` line 417 (`environment`), `execute-dev.ts` lines 177 and 480 (`environment`). `resolveAppIdentity` is unchanged: it does not Load.

With this, the graph the deploy target's preflight receives is the resolved graph, and `validateRegistryCoverage` sees resolved resource options.

## 8. The example app

`examples/env-param` gains a second input key so a real app proves the slice:

- `src/service.ts`: `input: type({ greeting: 'string', environment: 'string' })`.
- `module.ts`:

  ```ts
  export default module('env-param-example', ({ environment, provision }) => {
    const label = resolve([environment.name], ([name]) => `deployed to ${name}`);
    provision(echoService, { input: { greeting: envParam('ENV_PARAM_GREETING'), environment: label } });
  });
  ```

- `src/server.ts`: `Response.json({ greeting, environment })`.
- `scripts/smoke.ts`: beside `EXPECTED_GREETING`, asserts `body.environment === \`deployed to ${environment}\``.

## 9. Documentation

All in the same pull request, per `.agents/rules/user-facing-surface-changes.mdc`.

- **ADR-0062** gets an amendment note under its title, in the house form (`Amended 2026-10-29: …`): the type is `Value<T>`, not `ResolvedValue<T>`; a value is provided or computed, and deploy-time or runtime; `environment.name` is a provided deploy-time value; `envParam()` and `envSecret()` will become values in the module-input project, with the special handling of environment variables replaced by config and secret adapters, and the two functions then creating a persisted resource for a value. The index line in `docs/design/90-decisions/README.md` changes `ResolvedValue` to `Value`.
- **ADR-0060** gets an amendment note: core builds the public URL node as a resource with a dependency slot wired at construction and options the second pass resolves; the resource decision (ADR-0013) is amended by the same note to say a resource may declare dependency slots.
- **ADR-0013** gets the matching amendment note.
- **Glossary**: a new entry `### Value` under "Core nouns", after "Configuration — params and their sources", with the four paragraphs of § 2 in glossary register, plus one sentence that `envParam()` and `envSecret()` are not values yet.
- **`core-model.md`**: the `resource()` factory signature in "Node factories" gains `inputs`, `deps`, `options`; the "Graph and Load" section describes the second pass (one paragraph: provision sealed, values run dependency-first, results substituted, the errors) and replaces "resources take no wiring, so only service-to-service edges can cycle" with "a resource may declare slots wired at construction, so its edges take part in the cycle check like any other".
- **`module-composition.md`**: `ModuleContext` in "The authoring surface" gains `environment`, with one sentence on `resolve()`.
- **`docs/guides/building-an-app.md`**: a new section `## Values that differ per environment` directly before `## Builds`, with the § 1 example, the rule that a value is opaque and `provision` inside `fn` fails, and the four error cases an author can hit (no environment is not one of them: the commands always pass it). `## Reusable Modules` lists `environment` beside `provision` in what the builder receives.
- **`docs/guides/deploying.md`**: the `## Environments` section ends with two sentences pointing at the new guide section.
- **`skills/prisma-composer-core-concepts/SKILL.md`**: a subsection under "Two channels: dependencies and input" titled `### Values that differ per environment`, five lines: `environment.name`, `resolve([deps], ([values]) => …)`, accepted as an input leaf or a param, opaque in the body, `provision` inside fails. Written to the rules in `skills/README.md`.
- **`.drive/projects/public-urls/design/scenarios.md`**: the table row that says `ResolvedValue` says `Value`.

## 10. Scope

In: everything above, in `packages/0-framework/1-core/core`, `packages/0-framework/3-tooling/cli`, `examples/env-param`, `docs/`, `skills/`.

Out: module input references and `resolve()` over them (the `module-input` project); config and secret adapters; `envParam()` and `envSecret()` as values; `publicUrl()` (P1); a `Value` as a module `secrets` or `params` binding; async `fn`; a value that reads a deploy result; a second environment fact.

## 11. Tests

Each test below is one `test()` with the given title. Runtime tests use `bun test` in `packages/0-framework/1-core/core/src/__tests__/`; type tests use vitest `expectTypeOf` and `@ts-expect-error` in a `.test-d.ts` file. Fixtures follow `module.test.ts`: a `fake/compute` service with `input: anyInputSchema` from `helpers.ts`, and a string param where a param is needed.

### 11.1 `value.test.ts`

1. `resolve() returns a frozen computed value whose dependencies are a frozen copy` — mutate the array passed in afterwards; the value's `dependencies` are unchanged.
2. `resolve() rejects a non-array, a non-value dependency and a non-function` — the three construction errors by exact message.
3. `isValue() recognises environment.name and a resolve() result and nothing else` — a plain object, `null`, a secret source return false.

### 11.2 `evaluate.test.ts` (Load's second pass)

4. `a value over environment.name is substituted into a service input binding` — `Load(root, { environment: 'staging' })`; `graph.inputBindings[0].binding` equals `{ greeting: 'hello from staging' }`.
5. `a value over environment.name is substituted into a service param binding` — `graph.params[0].binding` is the computed string.
6. `a value nested inside objects and arrays in an input binding is substituted` — `{ hosts: [value], nested: { label: value } }`.
7. `a value bound in two places runs once` — a counter in `fn`; both bindings carry the result; counter is 1.
8. `a value's dependencies run before it, through two levels` — `shout` over `greeting` over `environment.name`; the result is `HELLO FROM STAGING`.
9. `a binding with no value is returned by reference` — `graph.inputBindings[0].binding === original`.
10. `Load without an environment loads a graph that binds no value` — as today.
11. `Load without an environment fails on a value over environment.name` — exact message.
12. `fn returning undefined fails naming the binding` — exact message with `input key "greeting" of service "shop.echo"`.
13. `fn returning a value fails naming the binding` — top-level and nested.
14. `fn returning a Promise fails naming the binding`.
15. `an error thrown by fn propagates unchanged` — a custom `Error` subclass instance is what `Load` throws.
16. `a cycle between values fails naming the binding` — build with `resolve([], …)`, then `blindCast` to a mutable origin and push the value into its own `dependencies` (test code is exempt from the cast rule).
17. `provision() inside fn fails with the structure error` — exact message; the graph has no extra node afterwards is not asserted because Load throws.
18. `provision() inside fn of a nested module fails the same way` — the nested module's name in the message.
19. `a value as provision() id fails`, 20. `a value in a service's deps fails` (an untyped slot, so the compiler lets it through; see § 4.5), 21. `a value as a module secrets binding fails`, 22. `a value as a module params binding fails` — exact messages.

### 11.3 `resource-slots.test.ts`

23. `a resource with a slot wired at construction loads with the slot node, the input edge and the dependency edge` — nodes include `shop.site.target` of kind `dependency`; edges include `{ from: 'shop.site.target', to: 'shop.site', input: 'target', kind: 'input' }` and `{ from: 'shop.web', to: 'shop.site', input: 'target', kind: 'dependency' }`; `shop.site` comes after `shop.web` in `graph.nodes`.
24. `the resource's slot is an in port and $out stays its out port` — `graph.ports` holds `{ node: 'shop.site', direction: 'in', name: 'target', contractKind: 'fake/http', style: undefined }` and the `$out` port.
25. `the authored edge runs from the producer's out port to the resource's in port`.
26. `a forwarded module input wired into a resource's slot counts as used and authors the edge from the module's in port`.
27. `resource() rejects a declared input with no wiring, an extra wiring, and a value in the wiring` — exact messages.
28. `provision(resource, { deps }) is still rejected`.
29. `a resource slot wired to a ref that does not satisfy the required contract fails` — through `validateWiring`, with the existing message.
30. `a resource that depends on a service that depends on it is a dependency cycle` — the existing cycle message names both.
31. `a value in a resource's options is substituted and the graph holds a copy with the prototype kept` — a class on `ResourceNodeBase` with a method; `graph.nodes` entry's `node.options.url` is the string, `node.describe()` still works, `isNode(node)` is true, and the authored node object is unchanged.
32. `a resource whose options hold no value appears in the graph as the authored object` — `toBe`.

### 11.4 `lowering.test.ts` (additions)

33. `lowering() passes opts.environment to Load, so a computed param reaches buildConfig resolved` — the fake descriptor's `serialize` sees `config.service.label === 'test'`.
34. `lowering() hands a resource descriptor its resolved options and its producer's outputs` — a `fake/url` resource descriptor with a slot on `fake/compute` reads `ctx.node.options.url` and `ctx.lowered.get(producer)`.

### 11.5 `value.test-d.ts`

The probe from § 3.2, as `expectTypeOf` assertions and `@ts-expect-error` lines:

- `fn` receives `readonly [string]` for `[environment.name]`; `readonly [string, number]` for two dependencies; destructuring a second member of a one-member tuple is an error.
- `resolve()` over `[]` returns `Value<T>` of `fn`'s return.
- `Value<number>` is not assignable to `Value<string>`; `Value<string>` is assignable to `Value<unknown>`.
- `{ greeting: Value<string> }` is an `InputBinding`; `{ when: Value<Date> }` is not.
- `Value<number>` is refused for a string param in `ParamBindings`; accepted for a number param.
- `Value<string>` is refused as `provision()`'s `id`.
- `resource({ inputs: { target: dep }, deps: { target: ref } })` compiles; `deps: {}` with a declared input is an error; `deps: { target: ref }` with no `inputs` is an error.
- `ModuleContext['environment']['name']` is `Value<string>`.

### 11.6 CLI (`packages/0-framework/3-tooling/cli`)

35. `generate-stack.test.ts`: the rendered file contains `environment: "staging"` and no `stage:` (replace the existing assertion's comment).
36. `generate-dev-stack.test.ts`: the rendered file contains `environment: "test"`.
37. `pipeline` tests: `runPipeline` passes the environment into Load; a fixture module binding a value over `environment.name` loads with the name in its binding.

### 11.7 Example

38. `examples/env-param/scripts/smoke.ts` asserts the `environment` field, as § 8 says. The integration suite that deploys the example, if any references `greeting` only, is extended the same way.

## 12. Done when

- Tests 1 to 38 pass; `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm test` are green at the root.
- `prisma dev` of `examples/env-param` as `dev` and as `test` serve `deployed to dev` and `deployed to test`; `prisma deploy` of it to `production` and to a second environment serve each name (QA, recorded in `qa.md`).
- A scratch copy of the example with `provision` inside `fn` fails `prisma deploy` with the § 5.3 message before any platform call; one whose `fn` returns `undefined` fails the same way.
- Every document in § 9 is updated, and a grep over `docs/`, `skills/`, `.drive/projects/public-urls/` for `ResolvedValue` finds nothing.

## 13. Decisions this spec records, for the review

1. One type, `Value<T>`, provided or computed, deploy-time or runtime (§ 2). Settled with Will.
2. `environment.name` is a value, not a computation with no dependencies (§ 3.3). Settled with Will.
3. Sources (`envParam()`, `envSecret()`) stay what they are in this slice (§ 2, § 10). Settled with Will.
4. The public URL node is a resource; a resource may declare slots wired at construction and carry options (§ 6). Settled with Will.
5. `Load`'s `environment` is optional and never defaulted; `LowerOptions.environment` is required and `stage` goes (§ 5.1, § 7.1). Orchestrator's decision: the commands always know the name, tests and programmatic callers that bind no value need none, and Load never guesses.
6. `fn` returning `undefined` is an error (§ 5.3). From ADR-0062: a function that returns nothing for some environment fails the deploy rather than silently picking a default.
7. A cycle is checked although a frozen dependency tuple makes one unconstructible without a cast (§ 5.2). Orchestrator's decision: the check costs one array and turns a stack overflow into a named error.
8. The resolved resource is a prototype-preserving copy (§ 6.4). Orchestrator's decision: a node is frozen, so substitution needs a new object, and a class-built node must keep its methods and brand.
9. The second pass lives in Load, not in `lowering()` (§ 5.2). From ADR-0062 ("Composer runs the module code and builds the graph … It then disables provision. It then runs each function") and because the CLI's preflight and coverage checks need the resolved graph.
