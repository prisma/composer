# C1 — Values, `resolve()` and the second pass of Load

Parent: [public-urls spec](../../spec.md). Decisions: ADR-0062 (`resolve()`), ADR-0060 (a node with its edge already set) and ADR-0013 (resources), each amended by this slice as recorded in § 9. Design settled with Will on 2026-10-29; see [design-notes.md](../../design-notes.md) entries 9 to 11. Reviewed on 2026-10-29 by the architect and principal-engineer passes in [reviews/design/](reviews/design/); every finding is folded in below, and § 14 lists the ones that are Will's to decide.

This spec leaves nothing to the implementer's judgement. Every type, signature, name, error message, file and test is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose.

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

- **A value** is an opaque stand-in, in a module body, for data that is known later: by the end of Load for a deploy-time value, or only on the platform for a runtime value. The body can pass a value wherever data of its type is accepted, and can do nothing else with it: it cannot read it, compare it or branch on it. This is what keeps the graph's structure the same whatever inputs Composer is given.
- **The real value** is the data a value stands for. "Real value" is the one term for it, in the glossary, in doc comments and in error texts. Elsewhere in the glossary "value" in lower case keeps its ordinary meaning, plain data such as a param's value.
- **A value is provided or computed.** A provided value is handed to the module body; `environment.name` is one, a deploy-time fact of the environment. A computed value is the result of `resolve(dependencies, fn)`: Load runs `fn` with its dependencies' real values after every module body has run. What the `resolve()` decision calls "a reference to a deploy-time fact" is a provided value.
- **A value is deploy-time or runtime.** A deploy-time value has its real value by the end of Load. A runtime value is known only to the platform the app is deployed to; at deploy time it is a pointer to it. Every value in this slice is deploy-time. The runtime axis is recorded so that `envSecret()` and `envParam()` can become values later without a redesign; they are not values in this slice.
- `resolve()` accepts values as dependencies, provided or computed, and returns a computed value. `resolve()` declares a computed value; Load resolves every value. Those are the two verbs, and "resolve" is the only one used for the act.

Why one type and not two (a computed value and a reference): the prior art, Gradle's `Provider<T>`, Pulumi's `Output<T>` and CDK's `Token`, uses one type for a stand-in whose real value comes later, whether supplied or derived, and nothing that consumes a value cares which it is. In code, `origin.kind` says where Load gets the real value: from a deploy-time fact of the environment, or by running a computation. Facts, and later module input references, are the provided values.

Why the word "value": "lazy" puts the emphasis on evaluation on demand, which is not the point; the point is that the thing depends on a calculation over its inputs, and the simplest word for a calculated or supplied quantity is value. The public barrel already has `Values<P>` (hydrated param data, `config.ts`) and `InputValueOf<I>` (validated input data). Those use the ordinary word for real data; this slice does not rename them. Renaming `Values<P>` to `ParamValues<P>` is recorded as debt for the next breaking release (§ 9, `.drive/deferred.md`).

## 3. Core: the value type and `resolve()`

### 3.1 File

New file `packages/0-framework/1-core/core/src/value.ts`. It imports only `blindCast` from `@internal/foundation/casts`; `node.ts` and `load-module.ts` import from it.

### 3.2 Types, verbatim

```ts
// Brands, Symbol.for so a check survives duplicated module instances (as NODE in node.ts).
const VALUE: unique symbol = blindCast<never, 'unique-symbol brand for a value'>(
  Symbol.for('prisma:value'),
);
// Core-only: where Load gets a value's real value. Symbol-keyed so a module body sees no member it could read.
const VALUE_ORIGIN: unique symbol = blindCast<never, 'unique-symbol key for a value origin'>(
  Symbol.for('prisma:value-origin'),
);
// Type-only, never assigned: carries T so Value<number> is not a Value<string>.
declare const VALUE_TYPE: unique symbol;

export type { VALUE, VALUE_ORIGIN, VALUE_TYPE };

/** Where Load gets a value's real value. Internal to core; not re-exported from the public barrel. */
export type ValueOrigin<T> =
  | {
      readonly kind: 'environment';
      /** Which deploy-time fact of the environment this is. Only the name exists today. */
      readonly fact: 'name';
    }
  | {
      readonly kind: 'computed';
      readonly dependencies: readonly Value<unknown>[];
      readonly compute: (values: readonly unknown[]) => T;
    };

/**
 * An opaque stand-in a module body can pass wherever a `T` is accepted; its
 * real value is known by the end of Load (ADR-0062). `environment.name` is one;
 * `resolve()` returns one computed from others.
 */
export interface Value<T> {
  readonly [VALUE]: true;
  readonly [VALUE_TYPE]?: T;
  readonly [VALUE_ORIGIN]: ValueOrigin<T>;
}

/** The tuple of real-value types a dependency tuple stands for: what `resolve()`'s `fn` receives. */
export type RealValuesOf<D extends readonly Value<unknown>[]> = {
  readonly [K in keyof D]: D[K] extends Value<infer T> ? T : never;
};

/** Plain data: what a `resolve()` function may return, and the only thing a value may stand for in a binding. */
export type PlainValue =
  | string
  | number
  | boolean
  | null
  | readonly PlainValue[]
  | { readonly [key: string]: PlainValue };
```

`VALUE_TYPE` is a phantom: `declare const` gives it no runtime existence, and the member is never assigned. It carries `T` on the interface itself, so `Value<number>` is not assignable to `Value<string>` and `Value<string>` is assignable to `Value<unknown>`. The repo's precedent for a phantom is `OrmCmp._contract?: C` in the Prisma Cloud extension. The three symbols are exported as types only, the way `NODE` is, so declaration emit works and nothing outside core can build or read a value by name. Checked on 2026-10-29 with a probe compiled under `tsconfig.base.json` with TypeScript 6.0.3: tuple inference, variance on both branches, the recursive `InputBinding` alias, and that `value.origin` is a type error; the probe is the type test in § 11.5.

### 3.3 Functions, verbatim

```ts
/**
 * A value computed from other values. `fn` receives the dependencies' real
 * values as one tuple, in order, and returns plain data. Load runs it after
 * every module body, with `provision` disabled (ADR-0062). `fn` must be a pure
 * function of its dependencies: a deploy runs it in two processes.
 */
export function resolve<const D extends readonly Value<unknown>[], T>(
  dependencies: D,
  fn: (values: RealValuesOf<D>) => T,
): Value<T>;
```

Implementation rules:

- Runtime checks, in this order, each throwing a plain `Error` (not a `LoadError`: construction is authoring, like `service()`), with exactly this text:
  - `dependencies` is not an array: `resolve() requires a tuple of values as its first argument.`
  - a member of `dependencies` is not a value (`isValue` false), naming its index: `resolve() dependency at index 1 is not a value — list environment.name or another resolve() result.`
  - `fn` is not a function: `resolve() requires a function as its second argument.`
- The dependency tuple is copied and frozen: `Object.freeze([...dependencies])`.
- The result is `Object.freeze({ [VALUE]: true as const, [VALUE_ORIGIN]: Object.freeze({ kind: 'computed' as const, dependencies, compute }) })` where `compute` is `fn` cast with `blindCast<(values: readonly unknown[]) => T, 'fn is typed against RealValuesOf<D>; Load supplies exactly that tuple'>`.

```ts
/** True if `value` is a `Value` (checks the brand only, never a prototype). */
export function isValue(value: unknown): value is Value<unknown>;
```

Same shape as `isSecretSource`: `typeof value === 'object' && value !== null && blindCast<Record<PropertyKey, unknown>, 'reading the value brand off an unknown object'>(value)[VALUE] === true`.

```ts
/** The deploy-time facts a module body receives, each as a value (ADR-0062). */
export interface EnvironmentFacts {
  /** The environment's name, as `--environment` gave it. */
  readonly name: Value<string>;
}

/** The one `environment` object every module body receives. */
export const environmentFacts: EnvironmentFacts = Object.freeze({
  name: Object.freeze({
    [VALUE]: true as const,
    [VALUE_ORIGIN]: Object.freeze({ kind: 'environment' as const, fact: 'name' as const }),
  }),
});
```

One frozen constant, shared by every Load and every module body. There is nothing per-body about it: it is a fact of the deploy, and identity does not matter to any check.

### 3.4 Exports

`packages/0-framework/1-core/core/src/exports/index.ts` adds, keeping the existing alphabetical grouping:

- types: `DepBindings`, `EnvironmentFacts`, `LoadOptions`, `PlainValue`, `RealValuesOf`, `ResourceProp`, `ResourceProps`, `Value`;
- values: `isValue`, `resolve`.

`value.ts` also exports `originOf(value)`, core's only way to read a value's origin at runtime, since the symbols are exported as types only. Not exported from the barrel: `ValueOrigin`, `originOf`, the three symbols, `environmentFacts` (the body reaches it through the module context). `@prisma/composer`'s index re-exports `@internal/core` wholesale, so nothing changes in `packages/9-public/composer`.

## 4. Core: where a value is accepted

### 4.1 The module context

`ModuleContext` in `node.ts` gains, after `params` and before `provision`:

```ts
  /** The deploy-time facts of the environment, each a value (ADR-0062). List `environment.name` as a `resolve()` dependency. Never environment variables: user code never reads those. */
  readonly environment: EnvironmentFacts;
```

`flatten` in `load-module.ts` sets `environment: environmentFacts` on the `ctx` object it builds.

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
  | Value<PlainValue>
  | readonly InputBinding[]
  | { readonly [key: string]: InputBinding };
```

A value may sit at the root of the binding or at any depth inside objects and arrays. Its type parameter must be `PlainValue`, so `Value<Date>` is refused by the compiler, and so is a value standing for a `SecretSource` or `ParamSource` (§ 5.3 refuses the same at runtime).

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

### 4.4 A resource's props and dependency slots

See § 6.

### 4.5 Nowhere else

The following never accept a value. The compiler refuses the first three outright; Load refuses all of them at runtime with the error in § 5.3, because an untyped dependency slot (`required: undefined`, so `DepBindings` gives `unknown`) accepts anything at the type level.

- `provision()`'s `id` (typed `string`).
- A node's `name` (typed `string`).
- A module's `secrets` binding (typed `SecretSource`).
- A module's `params` binding (typed `ParamSource`).
- A `deps` entry of a service, a module or a resource (§ 6).

## 5. Core: the second pass of Load

### 5.1 `Load`'s option

`graph.ts`:

```ts
export interface LoadOptions {
  /** The root's address: the app name. Defaults to the root's `name`. */
  readonly id?: NodeId;
  /** The facts of the environment being loaded. `name` is what `--environment` gave. Required by any value over `environment.name`. */
  readonly environment?: { readonly name: string };
}

export function Load(root: ServiceNode | ModuleNode, opts?: LoadOptions): Graph;
```

The option has the shape of `ctx.environment`: one key per fact, so a second fact is a second key, never a second option. `LoadOptions` is exported from `graph.ts` and from the barrel. `loadModule(root, opts)` receives the same object. `loadService` is unchanged: a service root takes no bindings, so it has no values to resolve.

`environment` is optional because a graph that binds no value needs none, and every test that loads a graph today passes none. It is not defaulted: Load never invents an environment name. The commands always pass it (§ 7); the error for its absence (§ 5.3) is reachable only from a direct `Load(root)` call, for example an author's own test, and its text is written for that caller.

`Load`'s doc comment in `graph.ts` changes "Executes nothing of the user's own code beyond module bodies" to "Executes nothing of the user's own code beyond module bodies and `resolve()` functions".

### 5.2 Where the pass runs

In `loadModule`, after `for (const entry of pending) validateWiring(entry, byId);` and `assertDependencyDag(edges);`, and before the `Graph` is assembled. The pass is one function in a new file `packages/0-framework/1-core/core/src/resolve-values.ts`:

```ts
export interface ValueBindingSite {
  /** The address of the node the binding belongs to. */
  readonly address: NodeId;
  /** `input` for a service input binding, `param` for a service param, `props` for a resource's props. */
  readonly channel: 'input' | 'param' | 'props';
  /** The param name for `param` (a value nested inside a param literal is reported under that name); the dotted path inside the document for `input` and `props` (`''` at the root). Array members by index: `hosts.0`. */
  readonly path: string;
}

/**
 * Resolves every value the graph binds, dependency-first, once each, and
 * returns each binding with its values replaced by their real values.
 */
export function resolveValues(input: {
  readonly environment: { readonly name: string } | undefined;
  readonly inputBindings: readonly ServiceInputBinding[];
  readonly params: readonly ParamBinding[];
  readonly resources: ReadonlyMap<NodeId, ResourceNode>;
}): {
  readonly inputBindings: readonly ServiceInputBinding[];
  readonly params: readonly ParamBinding[];
  readonly resourceProps: ReadonlyMap<NodeId, ResourceProps>;
};
```

D1 builds it with `inputBindings` and `params` only; D2 adds `resources` and `resourceProps` (plan).

**One predicate for plain data**, pinned here and used by the walk, the substitution and the result check: `isPlainObject(value)` is true when `typeof value === 'object'`, `value !== null`, and `Object.getPrototypeOf(value)` is `Object.prototype` or `null`. The walk descends into arrays and plain objects only. It stops at a `Value`, a `SecretSource` and a `ParamSource`, and does not descend into any other object. `deepValues` in `load-module.ts` is not reused: it descends into every object, and a value found inside a class instance could not be substituted.

The algorithm:

1. **Collect.** Walk every input binding (`channel: 'input'`), every param binding (`channel: 'param'`, path = the param name) and every resource's `props` (`channel: 'props'`) with the predicate above, guarding plain-data cycles with a `WeakSet` as `deepValues` does. Record each `Value` found with its binding site.
2. **Resolve**, with `const results = new Map<Value<unknown>, unknown>()` and `const visiting: Value<unknown>[] = []`:

   ```
   resolveOne(value, site):
     if results.has(value): return results.get(value)
     if visiting includes value: throw the cycle error (5.3)
     visiting.push(value)
     origin = value[VALUE_ORIGIN]
     switch origin.kind:
       'environment':
         if environment === undefined: throw the no-environment error (5.3)
         result = environment[origin.fact]
       'computed':
         args = origin.dependencies.map(d => resolveOne(d, site))
         try: result = origin.compute(args)
         catch (thrown): if thrown is a LoadError rethrow it; else throw the fn-threw error (5.3) with cause thrown
         check result (5.3): a Promise; then, walking it with the predicate, undefined, a Value, a SecretSource or ParamSource, or anything that is not plain data
     visiting.pop()
     results.set(value, result)
     return result
   ```

   `site` is the binding site the walk started from; a dependency reached through another value is reported under the same site, because the dependency has no site of its own. `visiting.length > 1` at the time of an error means a dependency's `fn` failed, and the message says so (§ 5.3), so the author opens the right function.
3. **Substitute.** Rebuild each binding with every `Value` replaced by `results.get(value)`. Plain objects are rebuilt as plain objects, arrays as arrays, everything else kept by reference. A binding that contained no value is returned by reference, unchanged. The substituted bindings replace `inputBindings`, `paramBindings` and each resource's props before the `Graph` is built (§ 6.4 says how a resource's props reach the graph).

`fn` runs synchronously. **`fn` is a pure function of its dependencies.** Load runs each `fn` once per Load, and a deploy Loads twice: in the CLI, whose graph the preflight, the coverage check and the topology submission read, and in the deploy engine's process, whose graph deploys. `destroy` Loads too, so every `fn` runs for the environment being removed; and every `prisma dev` rebuild Loads again. A `fn` that reads the clock, a random source, a file or an environment variable deploys a graph nobody checked. The guide says this (§ 9).

### 5.3 Errors, verbatim

Every error below is a `LoadError` (code `COMPOSE.GRAPH_INVALID`, the one code Load uses until a finer taxonomy is carved out, per ADR-0044). `LoadError` gains an optional cause: `constructor(message: string, options?: { readonly cause?: unknown })`, forwarded to `CliStructuredError`, so a user's thrown error is wrapped exactly once at the site that understands it, as ADR-0044 requires.

`<site>` is rendered by one function `describeSite(site)`:

- channel `input`, path `''`: `the input binding of service "shop.echo"`
- channel `input`, path `greeting`: `input key "greeting" of service "shop.echo"`
- channel `param`: `param "port" of service "shop.echo"`
- channel `props`, path `url`: `prop "url" of resource "shop.site"`
- channel `props`, path `''`: `the props of resource "shop.site"`

`<fn>` is `The resolve() function for <site>` when `visiting.length === 1` at the error, and `A resolve() function that <site> depends on` otherwise. `<at path>` is empty for a result's root and ` at "hosts.0"` inside it.

| Condition | Message |
| --- | --- |
| `provision()` called after the first pass finished | `provision() was called after module "shop" was loaded, from inside a resolve() function. resolve() computes values, never structure: the graph is the same whatever inputs Composer is given (ADR-0062). Provision the node in the module body and pass the value into it.` |
| A value over `environment.name` when `Load` got no `environment` | `<site> depends on environment.name, but Load was given no environment. Pass { environment: { name } } to Load; the deploy and dev commands do.` |
| A cycle | `<site> depends on itself: a computed value's dependencies lead back to it. Remove the cycle.` |
| `fn` threw | `<fn> threw: <thrown.message, or String(thrown) when it is not an Error>` with `cause` set to the thrown value. A `LoadError` thrown inside `fn` (the sealed `provision` error) propagates as it is. |
| `fn` returned a `Promise` (an object with a callable `then`) | `<fn> returned a Promise. resolve() runs synchronously at Load.` |
| `undefined` at the root or anywhere inside the result | `<fn> returned undefined<at path>. Return a result for every environment; Composer never picks a default.` |
| A `Value` anywhere inside the result | `<fn> returned a value<at path>, not a real value. List that value as a dependency; fn receives its real value.` |
| A `SecretSource` or `ParamSource` anywhere inside the result | `<fn> returned a secret or param source<at path>. Bind envSecret() or envParam() directly; resolve() returns plain data.` |
| Anything else that is not plain data (a function, a non-plain object, a symbol, a bigint, a non-finite number) | `<fn> returned <a function \| an object that is not plain data \| a symbol \| a bigint \| a non-finite number><at path>. resolve() returns plain data: strings, finite numbers, booleans, null, arrays and plain objects.` |
| A `Value` as `provision()`'s `id` | `provision() received a value as its id (module "shop"). A value can configure a node, never decide its address: the graph is the same whatever inputs Composer is given (ADR-0062).` |
| A `Value` in a `deps` entry | `The deps for "shop.web.db" are bound to a value. A value can configure a node, never decide its edges: the graph is the same whatever inputs Composer is given (ADR-0062).` |
| A `Value` in a module's `secrets` binding | `The secrets for "shop.auth" bind "signingKey" to a value. A value is not a secret source; bind envSecret('NAME') or a forwarded ctx.secrets ref.` |
| A `Value` in a module's `params` binding | `The params for "shop.auth" bind "region" to a value. A module param slot takes a param source; bind envParam('NAME') or a forwarded ctx.params ref.` |

Where the checks run:

- The `id` check runs directly after `id` is computed from `opts.id` and the node's name, before the existing `typeof id !== 'string'` check (which would otherwise report "requires a non-empty id" for an object).
- The `deps` check runs at the top of the `provision()` closure's handling of `opts.deps`, before `markUsed`.
- The `secrets` and `params` checks run inside `validateSecretBinding` and `validateParamNeedBinding`, before their existing "non-secret value" / "non-source value" checks. Both functions gain an `address` parameter (the child's full address) so the new messages name it; the existing messages keep the short provision id.

Why a computed value may not return a secret or param source in this slice: a forwarded `ctx.secrets` ref returned from `fn` would fail with "declares secret but never forwards it", because usage is marked at `provision()` time, before `fn` runs; and letting `fn` choose a platform variable's name per environment would fix a meaning for sources that the module-input project redesigns (design note 10). Pending Will's confirmation, § 14.

### 5.4 Sealing `provision`

`loadModule` creates `const loading = { sealed: false };` and passes it to `flatten` as a new last parameter, which every recursive `flatten` call forwards. The first statement of the `provision` closure is `if (loading.sealed) throw new LoadError(<the provision-after-load message, with this module's name>)`. `loadModule` sets `loading.sealed = true` after `assertDependencyDag(edges)` and before `resolveValues`. One flag, one write; `flatten`'s return type does not change; a `provision` a nested module leaked to the root through a closure is sealed by the same flag.

## 6. Core: a resource with its edge already set

### 6.1 Why

`publicUrl({ name, url, target })` (ADR-0060) is a resource: a RoutingUrl whose lifecycle Alchemy manages. It depends on the service it serves, and the dependency is known when the node is constructed, not at `provision()`. Today a resource declares no dependency slots and carries no configuration core can resolve, so core must let a resource declare slots, wire them at construction, and carry props that the second pass resolves. Nothing here is specific to public URLs.

A public URL is a resource by kind, because a provider manages its lifecycle, and a driver by role, because it depends on what it sends traffic to and nothing calls it. The scheduled-work decision (ADR-0020) contrasted a driver with a resource a consumer loads; it does not rule out a driver whose lifecycle is managed. The amendment notes (§ 9) say so.

### 6.2 The node

`ResourceNode` in `node.ts` becomes:

```ts
export interface ResourceNode<
  C extends AnyContract = AnyContract,
  D extends Deps = Deps,
  P extends ResourceProps = ResourceProps,
> {
  readonly [NODE]: true;
  readonly kind: 'resource';
  readonly name: string;
  readonly extension: string;
  readonly type: C['kind'];
  readonly provides: C;
  /** Dependency slots, as a service's `inputs`. Empty for a resource that depends on nothing. */
  readonly inputs: D;
  /** The producer wired into each slot, as a `provision()` call's `deps` supplies for a service. A resource is wired when it is constructed. (On a module node `deps` holds the declared slots; here it holds the producers.) */
  readonly deps: DepBindings<D>;
  /** Plain data the factory records, the resource's configuration. Load resolves any value inside it; nowhere else on a resource is a value resolved. Empty for a resource with none. */
  readonly props: P;
}

/** A resource's configuration: plain data and values, nested in objects and arrays. */
export type ResourceProps = { readonly [key: string]: ResourceProp };
export type ResourceProp =
  | string
  | number
  | boolean
  | null
  | Value<PlainValue>
  | readonly ResourceProp[]
  | { readonly [key: string]: ResourceProp };
```

Why `deps` for the producers: it is the meaning `deps` has at every `provision()` call, so a pack author reads the resource factory as a provision call with the node's own slots. The one collision is inside core, on `ModuleNode.deps`, which holds declared slots; the doc comment above says so. (Settled with Will on 2026-10-29; `wiring` was rejected.) Why `props`: the glossary's provisioning-plane entry uses "props" for the desired configuration passed at declare time, which is what a resource descriptor turns these into; "options" in this codebase means a function's options argument (`LoadOptions`, `LowerOptions`), and in Pulumi `ResourceOptions` means meta-settings such as `dependsOn`.

`DepBindings<D>` is the existing unexported type in `node.ts`; it is exported now, since it appears in a public interface. The existing generic parameter `C` keeps its position so every current `ResourceNode<C>` still compiles; `D` and `P` default to the widest shapes.

Every resource still provides a contract and gets the `$out` port. A public URL provides its HTTP ingress point as its own contract, which P1 names; nothing inside the graph wires to it, since no slot requires that contract kind, and `provision()`'s ref is inert for the same reason. Settled with Will on 2026-10-29: `provides` stays required.

### 6.3 The factory and the base class

```ts
export function resource<
  C extends AnyContract,
  D extends Deps = Record<never, never>,
  P extends ResourceProps = Record<never, never>,
>(def: {
  name: string;
  extension: string;
  provides: C;
  inputs?: D;
  deps?: DepBindings<D>;
  props?: P;
}): ResourceNode<C, D, P>;
```

Rules, in order after the existing name, extension and `provides` checks:

- `inputs` keys pass `requireConfigKeySegmentNames(…, 'input', 'resource')`, as a service's do.
- Every `inputs` entry must be a branded dependency end; otherwise `Error`: `resource() input "target" is not a branded dependency end (construct it with the dependency() factory).`
- `deps` must name exactly the keys of `inputs`: a missing one is `Error`: `resource() declares input "target" but its deps leave it unwired. A resource is wired when it is constructed.`; an extra one is `Error`: `resource() deps name "extra", which is not a declared input.`
- A `deps` entry that is a `Value` is `Error`: `resource() deps wire "target" to a value. A value can configure a node, never decide its edges (ADR-0062).`
- `props`, when given, must satisfy `isPlainObject` (§ 5.2); otherwise `Error`: `resource() props must be a plain object.` Its contents are not validated at construction: a function or a class instance inside is rejected by the deploy target that reads it, as an input binding's is today.
- The node is frozen with three pinned casts, because `frozenShallowCopy(def.inputs ?? {})` is `D | {}` and TypeScript refuses to assign it to `D`:
  - `inputs: blindCast<D, 'an omitted inputs map is the empty Deps; the deps-match check above guarantees the keys agree at runtime'>(frozenShallowCopy(def.inputs ?? {}))`
  - `deps: blindCast<DepBindings<D>, 'omitted deps are the empty bindings of the empty Deps; the deps-match check above guarantees the keys agree at runtime'>(frozenShallowCopy(def.deps ?? {}))`
  - `props: blindCast<P, 'omitted props are the empty props; the plain-object check above is the runtime guard'>(frozenShallowCopy(def.props ?? {}))`

`ResourceNodeBase<C, D, P>` (with `D` and `P` defaulting to `Record<never, never>`, as `resource()`'s do) takes the same three optional fields in its constructor `def`, runs the same checks, and assigns `inputs`, `deps`, `props` with the same casts; `resource()` runs them through the base class, so the casts appear once. `isPlainObject` lives in `value.ts` (which still imports only `blindCast`), since `node.ts` needs it and `resolve-values.ts` imports `node.ts`. Its doc comment adds: `A class built on this base must not use #private fields: Load copies a node whose props hold a value, and a copy carries own properties only.` `PostgresResourceNode` in the Prisma Cloud extension passes none of the three and compiles unchanged. Moving its `config` and `targetRef` into `props` is recorded as debt in `.drive/deferred.md`, not done here.

### 6.4 Load

In `flatten`'s `provision` closure, the `child.kind === 'resource'` branch changes as follows. The four existing rejections stay (deps, secrets, input, params supplied at `provision()` are still errors; the wiring is the node's own), and the `deps` one gets a true text: `provision("site") received deps for a resource — a resource's slots are wired when it is constructed, not at provision().` (D3 changes the text; test 33 asserts it.) A resource node built by another installed copy of core may lack `inputs`, `deps` or `props`; `dependencySlots` and this branch treat an absent one as empty, as the brand check's dual-package comment in `node.ts` intends (D3). Then:

```
const localWiring = { ...child.deps };
markUsed(Object.values(localWiring));
byId.set(fullAddress, child);
const slots = dependencySlots(child, fullAddress);
nodes.push(...slots.nodes, { id: fullAddress, parent: selfId, node: child });
edges.push(...slots.edges, ...wiringEdges(localWiring, fullAddress));
ports.push(...boundaryPortsOf(fullAddress, child));    // the in ports for the slots
ports.push({ node: fullAddress, direction: 'out', name: RESOURCE_OUT_PORT, contractKind: child.provides.kind, style: contractStyleOf(child.provides) });
recordAuthoredWiring(fullAddress, localWiring);
pending.push({ deps: child.inputs, wiring: localWiring, targetId: fullAddress, targetKind: 'resource', enclosingModuleName: moduleNode.name });
return refForResource(fullAddress, child);
```

- `serviceInputs(service, serviceId)` in `load-service.ts` is renamed `dependencySlots(node: ServiceNode | ResourceNode, serviceId: NodeId)`; its body is unchanged except that it reads `node.inputs` (absent on a resource from another core copy means empty) and its error texts keep saying `Input "x" of "id"` (they do not name the kind). `loadService` calls it under the new name.
- `boundaryPortsOf(id, node)` in `load-service.ts` accepts `ModuleNode | ServiceNode | ResourceNode`; for a resource it reads `node.inputs` for the `in` ports and emits no `out` ports (the `$out` port is pushed by `flatten`, as today, so the port order on the wire is unchanged for a resource with no slots).
- `PendingWiring.targetKind` gains `'resource'`; `validateWiring`'s messages already interpolate `targetKind`, so no text changes.
- `assertDependencyDag` is unchanged: it walks every `dependency` edge. Its doc comment, which says only service and module edges can cycle, is rewritten: `A resource with dependency slots can take part in a cycle too.`
- `topoSort` is unchanged.
- In `resolveValues` (§ 5.2), `resources` is every resource node in `byId` keyed by address. A resource whose `props` contain no value appears in the graph as the authored object. A resource whose `props` contain a value appears as a copy that keeps the prototype (so a class built on `ResourceNodeBase` keeps its methods) and the brand (an own property):

  ```ts
  const copy = Object.freeze(
    Object.create(Object.getPrototypeOf(node), {
      ...Object.getOwnPropertyDescriptors(node),
      props: { value: Object.freeze(resolvedProps), enumerable: true, writable: false, configurable: false },
    }),
  );
  ```

  The descriptor for `props` is given to `Object.create` because the authored node is frozen, so its own descriptor is non-writable and an assignment after the fact would throw. `loadModule` replaces the `GraphNode.node` for that address with the copy before building the `Graph`. `byId` is not touched: nothing reads it after `resolveValues`.

### 6.5 Lowering

`deploy.ts`:

- The lowering loop is unchanged for resources: a resource descriptor receives `ctx.node` (the resolved copy when there was a value), `ctx.graph` and `ctx.lowered`. Topological order places a resource after the service it depends on, and `lowered` holds that service's outputs by the time the resource lowers (the hoisted `provision()` loop touches services only and does not change this).
- The inputs half of `buildConfig` is split out as `export function connectionInputs(node: ServiceNode | ResourceNode, id: NodeId, graph: Graph, lowered: ReadonlyMap<NodeId, Outputs>, provisioned: ReadonlyMap<string, unknown>): Readonly<Record<string, Readonly<Record<string, unknown>>>>`, which `buildConfig` calls for the `inputs` part of its `Config`, and which a resource descriptor calls to read its slots' connection params with the same "did not supply it" check a service gets. `buildConfig` itself stays service-only.
- The ADR-0031 minting loop (`for (const edge of graph.edges)`) accepts a consumer of kind `'resource'` as well as `'service'`, reading `consumer.inputs[edge.input]` the same way, so a `provision` need on a resource slot is minted.

### 6.6 The application topology

`composeApplicationTopology` in `packages/1-prisma-cloud/0-lowering/lowering/src/builds/application-topology.ts` needs no change: it maps every `graph.ports` entry and every `graph.authoredEdges` entry. A resource with a slot submits an `in` port and an edge into it; the topology's content hash changes for such a graph, which the platform stores opaquely. The platform's `replaceApplicationTopology` interactor (pdp-control-plane, `packages/interactors/src/application-topology/replaceApplicationTopology.ts`, read 2026-10-29) checks only that ports are unique by node, direction and name, that every edge endpoint names a submitted port, and that a consuming endpoint has one incoming edge. It does not restrict which kinds carry `in` ports. The edge's `family` is `communication` when the producer is a service, which is what a public URL's edge is.

## 7. The environment name's path into Load

### 7.1 Lowering options

`LowerOptions` in `deploy.ts`: remove `readonly stage?: string;` (nothing reads it; the Alchemy stage rides on the `alchemy --stage` flag, and a state container may pin a different Alchemy stage from the environment name, so the two are not the same thing) and add, directly after `name`:

```ts
  /** The environment being deployed, as `--environment` gave it. Required by any value over `environment.name`; the generated stack files always pass it. */
  readonly environment?: string;
```

It is optional for the same reason `LoadOptions.environment` is: `lowering()` and `lower()` are public through `@prisma/composer/deploy`, a hand-composed stack whose graph binds no value needs none, and a required field would break those callers' typecheck for nothing. `lowering()` calls `Load(root, { id: opts.name, ...(opts.environment !== undefined ? { environment: { name: opts.environment } } : {}) })`. The `LowerOptions` block in `core-model.md` (which still lists `stage`) is updated (§ 9). Every `lowering()` and `lower()` call in tests that needs a value resolved passes `environment: 'test'`; the rest are untouched. The test file `packages/1-prisma-cloud/1-extensions/target/src/__tests__/control-lowering.test.ts` is checked by D1 for `stage:` and left as it is if it passes none.

### 7.2 The generated stack files

- `generate-stack.ts`: `StackFileInput` gains `readonly environment: string;` and `renderOptions` renders `  environment: ${quote(input.environment)},` directly after the `name` line. The comment block in `StackFileInput` that says there is no `stage` field is deleted. `execute-deploy-destroy.ts` passes `environment` where it calls `writeStackFile`.
- `dev/generate-dev-stack.ts`: `renderOptions` renders `  environment: ${quote(input.environment)},` directly after the `name` line (the input already carries `environment`).

### 7.3 The CLI's own Load

`runPipeline` in `pipeline.ts` gains a parameter `environment: string` directly after `overrideName`, and calls `Load(entryModule.root, { id: name, environment: { name: environment } })`. Its three callers pass the environment they already hold: in `execute-deploy-destroy.ts` the call `runPipeline(entry, name, cwd, composerConfig, pipelineDeps, onAssembleError)`, and in `execute-dev.ts` the two calls `runPipeline(input.entry, input.name, cwd, input.config, …)` (the first run and the rebuild on a watched change). `resolveAppIdentity` is unchanged: it does not Load. A missed caller fails to typecheck, because the parameter after `environment` is an object.

With this, the graph the deploy target's preflight receives is the resolved graph, and `validateRegistryCoverage` sees resolved resource props.

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
- `scripts/smoke.ts`: after the greeting matches (inside the existing `if (res.ok && body.greeting === expected)` branch, before the asset check), check `body.environment`; on a mismatch print `FAIL - ${environment} serves environment ${JSON.stringify(body.environment)}, expected "deployed to ${environment}"` and `process.exit(1)`. The `body` cast gains `environment?: string`.

No integration test deploys this example; the smoke script and § 12's QA are its proof.

## 9. Documentation

All in the same pull request, per `.agents/rules/user-facing-surface-changes.mdc`.

- **ADR-0062** amendment note (already written, 2026-10-29; D4 edits it): add that what the body calls "a reference to a deploy-time fact" is a provided value; replace "create a persisted resource for a value" with "store the value in a platform variable the deploy owns, as `generatedParam` does today"; add "`fn` must be a pure function of its dependencies: a deploy Loads in two processes". The index line in `docs/design/90-decisions/README.md` says `Value`.
- **ADR-0060** amendment note (already written; D4 edits it): the attribution "ADR-0013, which said a resource takes no wiring" becomes "the resource decision (ADR-0013), which modelled a resource as a producer only, with no dependency slots of its own"; add the kind-and-role sentence from § 6.1; name `deps` (the producers, as at `provision()`) and `props`. ADR-0020's Related line gains "a public URL is a resource by kind and a driver by role (ADR-0060, amended 2026-10-29)". Index lines for ADR-0013, ADR-0020 and ADR-0060 gain `*(Amended by ADR-0060, 2026-10-29: …)*` notes in the house form.
- **ADR-0013** amendment note (already written; D4 edits it): add "and may carry plain-data props that Load resolves", and "a resource's contract may be consumed outside the graph, as a public URL's ingress point is".
- **Glossary**: `### Value` (already written; D4 rewrites its lead paragraph to § 2's wording, adds the lower-case sentence and the `RealValuesOf` name). `### Resource` adds: "A resource may also declare Inputs, wired when it is constructed, so it can depend on the service it serves (a public URL). A resource node that is wired carries references from the module body that built it, so it can only be provisioned there. A resource's configuration that may hold a value goes in `props`; Load resolves values there and nowhere else on a resource." `### Ingress / Egress`: "a driver" becomes "a resource, a driver by role,". `### Load / Hydrate`: "with nothing executed" becomes "with nothing executed but module bodies and `resolve()` functions". `### Environment`: one sentence that `environment` in a module body holds the deploy's facts as values and never environment variables.
- **`core-model.md`**: the `resource()` factory signature in "Node factories" gains `inputs`, `deps`, `props`; the "Graph and Load" section describes the second pass (one paragraph: provision sealed, values resolved dependency-first, results substituted, the errors), replaces "resources take no wiring, so only service-to-service edges can cycle" with "a resource may declare slots wired at construction, so its edges take part in the cycle check like any other", and "Load executes nothing of the user's" with "Load executes nothing of the user's beyond module bodies and `resolve()` functions"; the `LowerOptions` block loses `stage` and gains `environment`.
- **`module-composition.md`**: `ModuleContext` in "The authoring surface" gains `environment`, with one sentence on `resolve()`.
- **`docs/guides/building-an-app.md`**: a new section `## Values that differ per environment` directly before `## Builds`, with the § 1 example, the rule that a value is opaque and `provision` inside `fn` fails, the purity rule and that `destroy` runs every `fn` for the environment it removes, and the error cases an author can hit (a thrown error, `undefined`, a value or a source returned, a cycle). `## Reusable Modules` lists `environment` beside `provision` in what the builder receives.
- **`docs/guides/deploying.md`**: the `## Environments` section ends with two sentences pointing at the new guide section.
- **`skills/prisma-composer-core-concepts/SKILL.md`**: a subsection under "Two channels: dependencies and input" titled `### Values that differ per environment`, six lines: `environment.name`, `resolve([deps], ([values]) => …)`, accepted as an input leaf or a param, opaque in the body, `provision` inside fails, `fn` is pure and returns plain data. Written to the rules in `skills/README.md`.
- **`.drive/projects/public-urls/design/scenarios.md`**: the table row says `Value` (done).
- **`.drive/deferred.md`**: two entries under a `# Values — deferred (2026-10-29)` heading: `Values<P>` → `ParamValues<P>` at the next breaking release; `PostgresResourceNode.config` and `targetRef` into `props`.

## 10. Scope

In: everything above, in `packages/0-framework/1-core/core`, `packages/0-framework/3-tooling/cli`, `examples/env-param`, `docs/`, `skills/`.

Out: module input references and `resolve()` over them (the `module-input` project); config and secret adapters; `envParam()` and `envSecret()` as values; `publicUrl()` (P1); a `Value` as a module `secrets` or `params` binding; async `fn`; a value that reads a deploy result; a second environment fact; a finer error code than `COMPOSE.GRAPH_INVALID` (needs an ADR-0044 registry amendment); an older CLI loading an app that uses `resolve()` (belongs with the extension-compatibility check, `DEPS.EXTENSION_INCOMPATIBLE`).

## 11. Tests

Each test below is one `test()` with the given title. Runtime tests use `bun test` in `packages/0-framework/1-core/core/src/__tests__/`; type tests use vitest `expectTypeOf` and `@ts-expect-error` in a `.test-d.ts` file. Fixtures follow `module.test.ts`: a `fake/compute` service with `input: anyInputSchema` from `helpers.ts`, and a string param where a param is needed. A test that needs a forged value builds one from the public brand: `const v = { [Symbol.for('prisma:value')]: true, [Symbol.for('prisma:value-origin')]: { kind: 'computed', dependencies: [] as unknown[], compute: () => 'x' } }`.

### 11.1 `value.test.ts`

1. `resolve() returns a frozen computed value whose dependencies are a frozen copy` — mutate the array passed in afterwards; the value's dependencies (read through the origin symbol) are unchanged.
2. `resolve() rejects a non-array, a non-value dependency and a non-function` — the three construction errors by exact message.
3. `isValue() recognises environment.name and a resolve() result and nothing else` — a plain object, `null`, a secret source return false.

### 11.2 `resolve-values.test.ts` (Load's second pass)

4. `a value over environment.name is substituted into a service input binding` — `Load(root, { environment: { name: 'staging' } })`; `graph.inputBindings[0].binding` equals `{ greeting: 'hello from staging' }`.
5. `a value over environment.name is substituted into a service param binding` — `graph.params[0].binding` is the computed string.
6. `a value nested inside objects and arrays in an input binding is substituted` — `{ hosts: [value], nested: { label: value } }`.
7. `a value inside a class instance in a binding is left where it is` — the instance is the same object after Load and still holds the value.
8. `a value bound in two places runs once` — a counter in `fn`; both bindings carry the result; counter is 1.
9. `a value's dependencies run before it, through two levels` — `shout` over `greeting` over `environment.name`; the result is `HELLO FROM STAGING`.
10. `a binding with no value is returned by reference` — `graph.inputBindings[0].binding === original`.
11. `Load without an environment loads a graph that binds no value` — as today.
12. `Load without an environment fails on a value over environment.name` — exact message.
13. `fn returning undefined fails naming the binding` — exact message with `input key "greeting" of service "shop.echo"`; and nested, `{ a: undefined }`, with ` at "a"`.
14. `fn returning a value fails naming the binding` — top-level and nested.
15. `fn returning a Promise fails naming the binding`.
16. `fn returning a secret source, a function, or a class instance fails naming the binding` — three cases, exact messages.
17. `an error thrown by fn is wrapped once with the thrown error as cause` — a custom `Error` subclass instance; the `LoadError`'s message is `The resolve() function for … threw: <message>` and `error.cause` is the instance.
18. `a failing dependency's fn is named as a dependency` — a two-level chain whose inner `fn` returns `undefined`; the message starts `A resolve() function that input key "greeting" of service "shop.echo" depends on returned undefined`.
19. `a cycle between values fails naming the binding` — a forged value pushed into its own dependencies (see the preamble).
20. `provision() inside fn fails with the structure error` — exact message.
21. `provision() inside fn of a nested module fails the same way` — the nested module's name in the message.
22. `a nested module's provision leaked to the root through a closure is sealed too` — the nested body stores `ctx.provision` in an outer variable; a root-level `fn` calls it; Load throws the sealed message naming the nested module.
23. `Loading the same root twice resolves values both times` — the seal does not leak across Loads.
24. `a value as provision() id fails`, 25. `a value in a service's deps fails` (an untyped slot, so the compiler lets it through; see § 4.5), 26. `a value as a module secrets binding fails`, 27. `a value as a module params binding fails` — exact messages.

### 11.3 `resource-slots.test.ts`

28. `a resource with a slot wired at construction loads with the slot node, the input edge and the dependency edge` — nodes include `shop.site.target` of kind `dependency`; edges include `{ from: 'shop.site.target', to: 'shop.site', input: 'target', kind: 'input' }` and `{ from: 'shop.web', to: 'shop.site', input: 'target', kind: 'dependency' }`; `shop.site` comes after `shop.web` in `graph.nodes`.
29. `the resource's slot is an in port and $out stays its out port` — `graph.ports` holds `{ node: 'shop.site', direction: 'in', name: 'target', contractKind: 'fake/http', style: undefined }` and the `$out` port.
30. `the authored edge runs from the producer's out port to the resource's in port`.
31. `a forwarded module input wired into a resource's slot counts as used and authors the edge from the module's in port`.
32. `resource() rejects a declared input with no deps entry, an extra deps entry, and a value in deps` — exact messages.
33. `provision(resource, { deps }) is still rejected` — with the text in § 6.4.
34. `a resource slot wired to a ref that does not satisfy the required contract fails` — through `validateWiring`, with the existing message.
35. `a resource that depends on a service that depends on it is a dependency cycle` — the service's untyped slot is wired to the forged ref `{ id: 'shop.site' }`, because a resource's wiring needs the producer's ref first; the existing cycle message names both.
36. `a value in a resource's props is substituted and the graph holds a copy with the prototype kept` — a class on `ResourceNodeBase` with a method, calling `freezeNode(this)` in its constructor; `graph.nodes` entry's `node.props.url` is the string, `node.describe()` still works, `isNode(node)` is true, and the authored node object is unchanged.
37. `a resource whose props hold no value appears in the graph as the authored object` — `toBe`.

### 11.4 `lowering.test.ts` (additions)

38. `lowering() passes opts.environment to Load, so a computed param reaches buildConfig resolved` — the fake descriptor's `serialize` sees `config.service.label === 'test'`.
39. `lowering() hands a resource descriptor its resolved props and its producer's outputs through connectionInputs` — a `fake/url` resource descriptor with a slot on `fake/compute` reads `ctx.node.props.url` and `connectionInputs(...)`.
40. `connectionInputs fails when a producer does not supply a param a resource slot declares` — the existing "did not supply it" message.

### 11.5 `value.test-d.ts`

- `fn` receives `readonly [string]` for `[environment.name]`; `readonly [string, number]` for two dependencies; destructuring a second member of a one-member tuple is an error.
- `resolve()` over `[]` returns `Value<T>` of `fn`'s return.
- `Value<number>` is not assignable to `Value<string>`; `Value<string>` is assignable to `Value<unknown>`.
- `value.origin` is a type error: the type exposes no readable member.
- `{ greeting: Value<string> }` is an `InputBinding`; `{ when: Value<Date> }` is not; a `Value<SecretSource>` is not.
- `Value<number>` is refused for a string param in `ParamBindings`; accepted for a number param.
- `Value<string>` is refused as `provision()`'s `id`.
- `resource({ inputs: { target: dep }, deps: { target: ref } })` compiles; `deps: {}` with a declared input is an error; a ref of the wrong contract on a declared slot is an error.
- `ModuleContext['environment']['name']` is `Value<string>`.

### 11.6 CLI (`packages/0-framework/3-tooling/cli`)

41. `generate-stack.test.ts`: the rendered file contains `environment: "staging"` and no `stage:` (replace the existing assertion's comment).
42. `generate-dev-stack.test.ts`: the rendered file contains `environment: "test"`.
43. `stack-file-import.test.ts`: the stub `lower` echoes `opts.environment`, and the evaluated stack file passes the environment given to the renderer.
44. New `cli/src/__tests__/pipeline.test.ts`: `runPipeline` passes the environment into Load. Fixture: a `prisma.config.ts` and a module under `cli/src/__tests__/fixtures/pipeline/` whose service input binds a value over `environment.name`; a stub `runAssembler` passed through `PipelineDeps` that returns an empty bundle; the returned `graph.inputBindings[0].binding` carries the name.
45. `execute-deploy-destroy` tests: `destroy` passes the environment into `runPipeline` (assert through the existing pipeline stubbing in that file's tests).

### 11.7 Example

46. `examples/env-param/scripts/smoke.ts` asserts the `environment` field, as § 8 says.

## 12. Done when

- Tests 1 to 46 pass; `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm test` are green at the root.
- With `ENV_PARAM_GREETING=hi` set, `prisma dev` of `examples/env-param` then `curl "$(prisma dev url env-param-example.echo)"` prints `"environment":"deployed to dev"`; after `prisma dev stop`, the same with `--environment test` on both commands prints `deployed to test`. `prisma deploy` of it to `production` and to a second environment, with the deploy credentials, serve each name through `pnpm smoke:deployed`. Recorded in `qa.md`.
- A scratch copy of the example with `provision` inside `fn` fails `prisma deploy` with the § 5.3 message before any platform call; one whose `fn` returns `undefined` fails the same way.
- Every document in § 9 is updated, and `grep -rn ResolvedValue docs/guides docs/design/03-domain-model docs/design/10-domains skills .drive/projects/public-urls/design` finds nothing (the `resolve()` decision keeps the old name in its amendment note, as amended records do).

## 13. Decisions this spec records, for the review

1. One type, `Value<T>`, provided or computed, deploy-time or runtime (§ 2). Settled with Will.
2. `environment.name` is a value, not a computation with no dependencies (§ 3.3). Settled with Will.
3. Sources (`envParam()`, `envSecret()`) stay what they are in this slice (§ 2, § 10). Settled with Will.
4. The public URL node is a resource that provides its ingress contract; a resource may declare slots wired at construction (`inputs` and `deps`) and carry `props` (§ 6). Settled with Will on 2026-10-29, after the design review.
5. `Load`'s `environment` and `LowerOptions.environment` are both optional and never defaulted (§ 5.1, § 7.1). Orchestrator's decision after review: the commands always pass it, programmatic callers that bind no value need none, and Load never guesses.
6. `fn` returning `undefined`, anywhere in its result, is an error (§ 5.3). From ADR-0062: a function that returns nothing for some environment fails the deploy rather than silently picking a default.
7. A cycle is checked although a frozen dependency tuple makes one unconstructible without forging (§ 5.2). The check costs one array and turns a stack overflow into a named error.
8. The resolved resource is a prototype-preserving copy built with `Object.create` and descriptors (§ 6.4). A node is frozen, so substitution needs a new object, and a class-built node must keep its methods and brand.
9. The second pass lives in Load, not in `lowering()` (§ 5.2). From ADR-0062 and because the CLI's preflight, coverage check and topology submission need the resolved graph.
10. `fn` is pure (§ 5.2). A deploy Loads in two processes; this is a documented constraint, which is the cheapest fix; passing the parent's results to the child was considered and rejected because values have no identity across processes.
11. An error thrown by `fn` is wrapped once in a `LoadError` with the thrown value as `cause` (§ 5.3). From ADR-0044: an unwrapped foreign error at the process boundary is reported as a Composer bug.

## 14. Settled after the review

D1 landed on 2026-10-29 (commits b3b4fe91, 8c168c2f, d666545f) with the spec's letter adapted in five places, each now written into the sections above: `originOf` in `value.ts`; a param's site path is the param name; the `id` check sits after `id` is computed; `validateSecretBinding` and `validateParamNeedBinding` take the full address; `resolve-values.ts` carries one extra pinned-reason cast typing the substituted binding back to `InputBinding`.

D2 landed on 2026-10-29 (commits 77b45ba6, 4b3cb003, a6244546, 45b79ca9) with: `isPlainObject` in `value.ts`; a second such cast for rebuilt props; the base class's type defaults; `dependencySlots` keeping its `serviceId` parameter name. D3 adds the true `provision(resource, { deps })` text and the tolerance for a resource from another core copy.

D3 landed on 2026-10-29 (commits 0b951e4a, 8320253d, 48a36fa4, f363f547, 5f7c14b4), with: `boundaryPortsOf` sharing the absent-`inputs` tolerance through a `slotsOf` helper in `load-service.ts`; `module.test.ts`'s older assertion on the `provision(resource, { deps })` text updated; test 45 proving the environment reaches `destroy`'s Load by recording the name a `resolve()` function receives, because the destroy tests run the real pipeline with a fake assembler and a fake `alchemy`; test 44's empty bundle as `{ dir: '', entry: '' }` and its fixture config using `as const` on descriptor kinds. The local proof in § 12 passed: `deployed to dev` and `deployed to test`.


Each of these was put to Will on 2026-10-29 after the architect and principal-engineer reviews.

1. **A resource keeps `provides`.** A public URL provides an HTTP ingress point as its own contract; nothing inside the graph wires to it. No change to the resource model beyond the slot wired at construction (§ 6.2).
2. **`deps`, not `wiring`, for a resource's bound producers** (§ 6.2). `wiring` was rejected; `deps` carries the meaning it has at `provision()`.
3. **`props` for a resource's configuration** (§ 6.2). Decided by the orchestrator so the build could start.
4. **A computed value may not return a secret or param source** (§ 5.3). Decided by the orchestrator so the build could start, for the two reasons given there.

**Open beside this slice, not in it:** the port vocabulary. Will, 2026-10-29: the glossary's Input and Output are inverted against the ports-and-adapters model. What a node is called through (today `expose`) is its input port; what it calls (today `deps`, stored as `inputs`) is its output port; a public URL is an ingress adapter wired to the service's input HTTP port. C1 keeps today's names in code; the rename is its own decision record, written beside this slice, and P1 uses the words it settles.
