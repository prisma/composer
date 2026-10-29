# S3 — `envParam()` and `envSecret()` are values

Parent: [module-input spec](../../spec.md) and [plan](../../plan.md). Decisions: the secrets decision ([ADR-0029](../../../../../docs/design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md)), the provision-time params decision ([ADR-0032](../../../../../docs/design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)), the service input decision ([ADR-0042](../../../../../docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md)), the module input decision ([ADR-0061](../../../../../docs/design/90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)) and the `resolve()` decision ([ADR-0062](../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), each with its amendments. This slice implements sections 2 and 4 of [design-notes.md](../../design-notes.md). It builds on S2 ([S2 spec](../s2-module-input/spec.md), prisma/composer#401) after S2's review fixes have landed, including the `readPath` change in `resolve-values.ts`.

This spec leaves nothing to the implementer's judgement. Every type, signature, name, error message, file and test is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose. § 14 lists the decisions this spec takes, and § 15 the conflicts it found.

## 1. At a glance

```ts
import { module, resolve } from '@prisma/composer';
import { secretString } from '@prisma/composer/arktype';
import { envParam, envSecret, serviceOrigin } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

const billing = module(
  'billing',
  { input: type({ greeting: 'string', stripeKey: secretString(), returnUrl: 'string' }) },
  ({ input, provision }) => {
    provision(billingService, {
      id: 'service',
      input: { greeting: input.greeting, stripeKey: input.stripeKey, returnUrl: input.returnUrl },
    });
  },
);

export default module('shop', ({ environment, provision }) => {
  const stripeKey = resolve(
    [envSecret('STRIPE_LIVE_KEY'), envSecret('STRIPE_TEST_KEY'), environment.name],
    ([live, test, name]) => (name === 'production' ? live : test),
  );
  provision(billing, {
    input: {
      greeting: resolve([envParam('GREETING')], ([greeting]) => greeting.toUpperCase()),
      stripeKey,
      returnUrl: serviceOrigin('shop.web'),
    },
  });
  // … shop.web
});
```

`GREETING=hi prisma deploy --environment staging` gives `shop.billing.service` the input binding `{ greeting: 'HI', stripeKey: envSecret('STRIPE_TEST_KEY'), returnUrl: serviceOrigin('shop.web') }`. The target serializes it exactly as if the root had bound those sources on the service directly. Deploy preflight checks both `STRIPE_LIVE_KEY` and `STRIPE_TEST_KEY`, although the function returned only one.

```ts
// a pointer cannot be read
resolve([envSecret('STRIPE_TEST_KEY')], ([key]) => `Bearer ${key}`);
// LoadError: The resolve() function for input key "stripeKey" of module "shop.billing" threw:
// envSecret('STRIPE_TEST_KEY') is known only at boot: the deploy holds a pointer to it, never
// its value, and it was turned into text (a template literal or String()). …
```

## 2. The model

The glossary already defines value, real value, deploy-time and runtime ([Value](../../../../../docs/design/03-domain-model/glossary.md#value)). This slice applies them to sources. The glossary entry changes in § 9.

- **A source is a value.** A source is what a deploy target builds to say where a value comes from: `envParam('NAME')`, `envSecret('NAME')`, `generatedParam()` and `serviceOrigin(address)` on Prisma Cloud. Each one returns a single object that is both a value and the target's `ParamSource` or `SecretSource`. `isValue()` is true for it, and so is `isParamSource()` or `isSecretSource()`.
- **Where a binding took a source before, the target receives the same object.** A service's `input` binding, a service's `params`, and a module's `secrets` and `params` slots keep every source in place. So the serializer, the param pointer rows, preflight and boot see exactly what they see today.
- **Where core needs a real value, it uses the source's real value.** That is a module's `input` binding (its schema checks the real values), a `resolve()` dependency (its function receives them), and a resource's `props`.
- **`envParam('NAME')` is deploy-time.** Its real value is the value of the variable `NAME` at deploy. Load reads it from the **config pool**, a map of names to values given to Load. In this slice the deploy and dev commands pass the process environment, so the variable comes from the shell that runs the command, as it does today. An unset or empty variable gives no real value.
- **`envSecret('NAME')` is runtime.** The deploy never holds the secret. Its real value at deploy is a **pointer**: the source itself, which names the platform variable. The service dereferences it at boot, as today.
- **`generatedParam()` and `serviceOrigin()` are runtime too.** The deploy creates their values after Load: it generates the first and reads the second from the platform once the service exists. Their real value at deploy is the pointer, the source itself.
- **A pointer cannot be read.** Turning one into text or a number (`toString`, `valueOf`, `Symbol.toPrimitive`) throws an error that names the source and says it is known only at boot. A `resolve()` function may return a pointer it received, at any depth of its result, and the target then receives it as if the source had been bound directly. `isRuntimeValue(x)` is true for a pointer.
- **Every secret source in the graph is checked.** Load records every `envSecret()` it meets in any binding or `resolve()` dependency, including one that no service's final binding holds. Deploy preflight checks each of them. So the platform variables an app needs do not depend on which pointer a function returns.

| Where the source is bound | What Load does with it |
| --- | --- |
| A service's `input` binding, at any depth | Keeps the source in place. The target reads it at serialize, as today. |
| A service's `params` | Keeps the source in place. An `envParam()` param keeps its pointer row, read at boot. |
| A module's `secrets` or `params` slot | Accepts the source and forwards it, as today. |
| A module's `input` binding | Uses its real value: the variable's value for `envParam()`; the pointer for the others, which the module's schema checks in a stand-in form (§ 4.7). |
| A `resolve()` dependency | The function receives the real value. |
| A resource's `props` | Uses the real value. A runtime value fails Load (§ 4.9). |

## 3. Core: sources are values

### 3.1 `value.ts`

`value.ts` gains one type-only import: `import type { ParamSource, SecretSource } from './node.ts';`. It still imports only `blindCast` at runtime.

`ValueOrigin<T>` gains a fourth member, after `'input'`:

```ts
  | {
      readonly kind: 'source';
      /** How an error names the source, e.g. `envSecret('STRIPE_KEY')`. */
      readonly label: string;
      /** The config pool key whose value at deploy is the real value, as for `envParam()`. `undefined` for a value known only at boot, whose real value is `source`, a pointer. */
      readonly poolKey: string | undefined;
      /** For a param source known only at boot: the string a module's input schema checks in its place. */
      readonly sentinel: string | undefined;
      /** A module's input schema checks an empty `SecretString` in its place: always for a secret source, and for a redacted param source. */
      readonly redacted: boolean;
      /** The source itself. Not enumerable, so a copy's origin compares equal and the origin holds no cycle. */
      readonly source: ParamSource | SecretSource;
    };
```

New export, directly after `InputOrigin`:

```ts
/** The origin of a deploy target's source. Internal to core. */
export type SourceOrigin = Extract<ValueOrigin<unknown>, { readonly kind: 'source' }>;
```

Doc comment changes, verbatim:

- `Value<T>`: `An opaque stand-in a module body can pass wherever a \`T\` is accepted (ADR-0062). \`environment.name\` is one; each field of a module's \`input\` is one; \`resolve()\` returns one computed from others; a deploy target's source, such as \`envParam()\` or \`envSecret()\`, is one too. A deploy-time value's real value is known by the end of Load; a runtime value's real value at deploy is a pointer.`
- `isValue`: `True if \`value\` is a \`Value\`, a source included (checks the brand only, never a prototype).`

### 3.2 `node.ts`: the source types

`SecretSource` and `ParamSource` extend `Value<unknown>`:

```ts
export interface SecretSource<T = unknown> extends Value<unknown> {
  readonly [SECRET_SOURCE]: true;
  /** Target-defined. Core never reads this; the target that authored the source reads it back. */
  readonly payload: T;
}

export interface ParamSource<T = unknown> extends Value<unknown> {
  readonly [PARAM_SOURCE]: true;
  /** Target-defined. Core never reads this; the target that authored the source reads it back. */
  readonly payload: T;
}
```

Their doc comments become:

- `SecretSource`: `A secret's source: a target-defined payload core forwards but never inspects. It is a value too, known only at boot; its real value at deploy is the source itself, a pointer. A target (e.g. @prisma/composer-prisma-cloud's \`envSecret\`) builds one with \`secretSource()\`.`
- `ParamSource`: `A param's source: a target-defined payload core forwards but never inspects. It is a value too: known at deploy when it names a config pool key (\`envParam\`), otherwise known only at boot, with the source itself, a pointer, as its real value. A target builds one with \`paramSource()\`.`

New exported option types, directly before `secretSource`:

```ts
/** What a deploy target says about a source it builds. */
export interface SourceOptions {
  /** How errors name the source, e.g. `envSecret('STRIPE_KEY')`. Defaults to `a secret source` or `a param source`. */
  readonly label?: string;
}

/** What a deploy target says about a param source it builds. */
export interface ParamSourceOptions extends SourceOptions {
  /** The config pool key whose value at deploy is the source's real value, as for `envParam()`. Without one the source is known only at boot, and its real value is the source itself, a pointer. */
  readonly poolKey?: string;
  /** For a source known only at boot: the string a module's input schema checks in its place, because the deploy has no value for it. */
  readonly sentinel?: string;
  /** For a source known only at boot whose value is redacted: a module's input schema checks an empty `SecretString` in its place, as for a secret. */
  readonly redacted?: boolean;
}
```

### 3.3 `node.ts`: building a source

```ts
/** Builds a secret source from a target-defined payload: the SPI a deploy target's own constructor (e.g. `envSecret`) calls. The source is a value whose real value at deploy is itself, a pointer. Core forwards it and never inspects the payload. */
export function secretSource<P, T = unknown>(payload: P, options?: SourceOptions): SecretSource<P> & Value<T>;

/** Builds a param source from a target-defined payload: the SPI a deploy target's own constructor (e.g. `envParam`) calls. Core forwards it and never inspects the payload. */
export function paramSource<P, T = unknown>(payload: P, options?: ParamSourceOptions): ParamSource<P> & Value<T>;
```

The first type parameter keeps its position, so every existing `secretSource<EnvSecretPayload>(…)` and `paramSource<EnvParamPayload>(…)` call compiles unchanged.

Checks, in order, each a plain `Error` with exactly this text:

- `options.label` given but not a non-empty string: `secretSource() label must be a non-empty string.` (or `paramSource() …`).
- `options.poolKey` given but not a non-empty string: `paramSource() poolKey must be a non-empty string.`
- `poolKey` beside `sentinel` or `redacted: true`: `paramSource() takes poolKey, for a value known at deploy, or sentinel or redacted, for one known only at boot, not both.`
- `sentinel` beside `redacted: true`: `paramSource() takes sentinel or redacted, not both.`

Both build the source through one module-private function, `buildSource(brand, payload, origin)`:

1. The origin is a plain object `{ kind: 'source', label, poolKey, sentinel, redacted }`, with `label` defaulted (`'a secret source'` or `'a param source'`), `poolKey` and `sentinel` `undefined` when not given, and `redacted` `true` for a secret source and `options.redacted === true` for a param source.
2. The source is `{ [VALUE]: true, [VALUE_ORIGIN]: origin, [brand]: true, payload }`. `VALUE` and `VALUE_ORIGIN` are imported from `./value.ts`.
3. `Object.defineProperty(origin, 'source', { value: source })`: not enumerable, not writable.
4. `Object.defineProperties(source, coercions(origin))` adds three non-enumerable, non-writable properties: `toString`, `valueOf` and `[Symbol.toPrimitive]`, each a function that throws the misuse error in § 3.4.
5. `Object.freeze(origin)`, then `return Object.freeze(source)`.

If the compiler refuses the return type, cast with `blindCast<SecretSource<P> & Value<T>, 'the frozen object carries the value brand, a source origin whose source is itself, the source brand and the payload, which is the SecretSource and Value shape'>` (and the `ParamSource` sibling). No other cast.

`Object.keys(source)` is still `['payload']`, and `JSON.stringify(source)` gives exactly what it gives today. A spread copy (`{ ...source, [MODULE_SECRET_KEY]: key }`, as `flatten` makes for `ctx.secrets` and `ctx.params`) copies the brands, the payload and the origin by reference, so it is still a value and a source. It does not copy the three coercion properties; Load reads the real value of a copy through `origin.source`, which is the original (§ 4.4).

### 3.4 `node.ts`: reading a source throws

`node.ts` gains a runtime import of `LoadError` from `./graph-types.ts` (which imports only types from `node.ts`, so there is no runtime cycle) and of `primitiveMisuse` from `./module-input.ts`, which is exported for this (it stays out of the barrel).

The coercion functions throw a `LoadError` built by one module-private function, `sourceMisuse(origin, what)`. `<what>` is `primitiveMisuse(hint)` for `Symbol.toPrimitive`, `its toString() was called` for `toString`, and `its valueOf() was called` for `valueOf`, exactly S2's texts. The message, verbatim:

- For a value known only at boot (`origin.poolKey === undefined`):

  ```
  <label> is known only at boot: the deploy holds a pointer to it, never its value, and <what>. A resolve() function may return the pointer, or put it in its result, unchanged; to compute with the value, do it in the service that reads it.
  ```

- For a value known at deploy (`envParam()`):

  ```
  <label> is a value, not its real value, and <what>. A module body can only pass it on: into a provision() binding or as a resolve() dependency. To compute with it, list it: resolve([<label>], ([v]) => …).
  ```

Every error `sourceMisuse` builds is added to a module-private `WeakSet<LoadError>`. New internal export:

```ts
/** True for the error a source throws when code turns it into text or a number. Internal to core. */
export function isSourceMisuse(error: unknown): boolean;
```

### 3.5 `node.ts`: reading a source's origin, and `isRuntimeValue()`

```ts
/** A source's origin; `undefined` for a source another installed copy of core built without one. Internal to core. */
export function sourceOriginOf(source: ParamSource | SecretSource): SourceOrigin | undefined;
```

It returns `undefined` unless `isValue(source)` and `originOf(source).kind === 'source'`.

```ts
/**
 * True when `value` is a pointer: the real value at deploy of a value known
 * only at boot, such as `envSecret()`, `generatedParam()` or `serviceOrigin()`.
 * A resolve() function receives one in place of such a value; it may return it
 * unchanged, but cannot read it (ADR-0062). `envParam()` is not one: it is known
 * at deploy. A module input field is never one in the body, because Load reads
 * its binding only after the body has run.
 */
export function isRuntimeValue(value: unknown): value is ParamSource | SecretSource;
```

It is true when `isSecretSource(value) || isParamSource(value)`, and the source has no origin or its origin's `poolKey` is `undefined`.

### 3.6 `node.ts`: the module slot checks

`validateSecretBinding` in `load-module.ts`: the condition `if (isValue(bound))` becomes `if (isValue(bound) && !isSecretSource(bound))`. `validateParamNeedBinding`: `if (isValue(bound))` becomes `if (isValue(bound) && !isParamSource(bound))`. The messages do not change. A source is a value, but it is the value these slots take.

### 3.7 Exports

`exports/index.ts` adds, in its alphabetical groups:

- from `../node.ts`, types: `ParamSourceOptions`, `SourceOptions`; values: `isRuntimeValue`;
- from `../graph-types.ts`, type: `SecretSourceUse` (§ 4.10);
- from `../config.ts`, value: `secretSourceManifest` (§ 4.10).

Not exported: `isSourceMisuse`, `sourceOriginOf`, `SourceOrigin`, `primitiveMisuse`. `@prisma/composer` re-exports `@internal/core` wholesale, so nothing changes in `packages/9-public/composer`.

## 4. Core: Load

All in `resolve-values.ts` unless stated.

### 4.1 `LoadOptions`

`graph-types.ts`:

```ts
export interface LoadOptions {
  /** The root's address: the app name. Defaults to the root's `name`. */
  readonly id?: NodeId;
  /** The facts of the environment being loaded. `name` is what `--environment` gave. Required by any value over `environment.name`. */
  readonly environment?: EnvironmentRealValues;
  /** The config pool: the values a source with a pool key, such as `envParam('NAME')`, reads by name at deploy. Required by any such source whose real value Load needs. The deploy and dev commands pass the process environment. */
  readonly configPool?: Readonly<Record<string, unknown>>;
}
```

It is optional for the reason `environment` is: a graph that needs no such real value needs none, and every existing test passes none. Load never defaults it. `loadModule` passes `configPool: opts?.configPool` to `resolveValues`.

### 4.2 `resolveValues`'s signature

Its input gains `readonly configPool: Readonly<Record<string, unknown>> | undefined;` after `environment`. Its output gains `readonly secretSources: readonly SecretSourceUse[];`. `loadModule` puts it on the graph (§ 4.10).

### 4.3 Collecting

`collect` gains a last parameter `recordSecret: (source: SecretSource, site: ValueBindingSite) => void`, and its first lines become:

```ts
if (isSecretSource(value) || isParamSource(value)) {
  if (isSecretSource(value) && site.kind !== 'props') recordSecret(value, site);
  if (site.kind === 'serviceInput' || site.kind === 'param' || !isValue(value)) return;
  found.push({ value, site });
  return;
}
if (isValue(value)) {
  found.push({ value, site });
  return;
}
```

So a source in a service's input binding or params is a leaf Load leaves alone, and its real value is never computed. A source in a module's input binding or a resource's props is collected as a value. A source from another installed copy of core, which is not a value, is a leaf everywhere, as today.

`recordSecret` is defined in `resolveValues`. It takes the source's canonical object, `sourceOriginOf(source)?.source ?? source`, so a `ctx.secrets` copy and its original count as one. It skips one it has already recorded. Otherwise it pushes `{ source: canonical, address: site.address, nodeKind: site.kind === 'moduleInput' ? 'module' : 'service' }`. The list keeps the order of first recording.

### 4.4 Resolving a source

`resolveOne` gains a case:

```
case 'source':
  if isSecretSource(origin.source): recordSecret(origin.source, site)
  if origin.poolKey === undefined: result = origin.source           // the pointer
  else if configPool === undefined: throw the no-config-pool error (§ 4.12)
  else:
    raw = configPool[origin.poolKey]
    result = raw === undefined || raw === '' ? undefined : raw
```

A source's real value is not passed through `checkResult`. `undefined` means no real value, as for an optional input field the binding left out: in an object, the key is left out (S2's substitution rule).

In the `'computed'` case, each dependency's real value is checked as it is resolved:

```ts
const args = origin.dependencies.map((dependency) => {
  const real = resolveOne(dependency, site);
  const source = originOf(dependency);
  if (real === undefined && source.kind === 'source') {
    throw <the unset-config error (§ 4.12)>;
  }
  return real;
});
```

A function's type says it receives a string for `envParam()`, so Load does not hand it `undefined`.

The `catch` around `origin.compute(args)` becomes:

```ts
} catch (thrown) {
  if (thrown instanceof LoadError && !isSourceMisuse(thrown)) throw thrown;
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  throw new LoadError(`${fnLabelFor(site)} threw: ${message}`, { cause: thrown });
}
```

So a pointer read inside a function is reported with the binding the function's value sits in. Every other `LoadError` thrown inside a function, such as the sealed `provision` error, still propagates as it is.

### 4.5 A function may return a pointer it received

`checkResult(result, fnLabel)` gains a third parameter, `received: ReadonlySet<object>`, the pointers the function received. The `'computed'` case builds it with a module-private `pointersIn(args)`: a walk over arrays and plain objects that adds every value for which `isSecretSource || isParamSource` is true and does not descend into it.

In `checkResult`'s walk, the line that refuses a source moves before the value check and becomes:

```ts
if (isSecretSource(value) || isParamSource(value)) {
  if (received.has(value)) return;
  throw new LoadError(
    `${fnLabel} returned a source${atPath} it did not receive, such as envSecret() or envParam() called inside the function. A resolve() function may return a pointer it received from a dependency, unchanged; bind any other source directly.`,
  );
}
if (isValue(value)) { /* the existing "returned a value" error */ }
```

An `envParam()` source is never received, since a function receives its string, so returning one fails. A pointer may sit at the root of the result or at any depth. `isThenable` is unchanged: a source is a value, so it is not a Promise.

### 4.6 Substitution

`substitute` gains a last parameter `sources: 'keep' | 'resolve'`, passed down every recursive call. Its first lines become:

```ts
if (isSecretSource(value) || isParamSource(value)) {
  return sources === 'keep' || !isValue(value) ? value : results.get(value);
}
if (isValue(value)) return results.get(value);
```

The callers:

- service input bindings and service params: `'keep'`;
- a module's input binding (in `validatedInputOf`) and a resource's props: `'resolve'`.

In the plain-object branch, a source member whose real value is `undefined` is left out, by the existing `real === undefined && isValue(member)` rule.

The two `blindCast` reasons in `resolveValues`'s return (whatever S2's review fix left) become, verbatim:

- props: `'substitution rebuilds the plain props object, replacing each Value<PlainData> with its real value: an environment or computed value is plain data or a pointer it received, which checkResult checked, an input field is its module schema output, and the pointer check above refused any pointer left'`
- service input: `'substitution replaces each value with its real value and keeps every source in place: an environment or computed value is plain data or a pointer it received, which checkResult checked, and an input field is its module schema output with each pointer put back; the service schema validates the whole binding again when the target serializes it'`

### 4.7 A module's input: what its schema checks

`validateModuleInput`'s first walk (`withSentinels`) gains a map, `const textPointers = new Map<string, ParamSource>()`, keyed by path. Its param source line becomes:

```
if isParamSource(value):
  origin = sourceOriginOf(value)
  if origin?.redacted: return a tagged SecretBox, as for a secret source, with the tag pointing at value
  if origin?.sentinel !== undefined: textPointers.set(path, value); return origin.sentinel
  throw the raw-param-source error (§ 4.12)
```

By this point every source that is a value has been replaced by its real value, so an `envParam()` is its string, and the sources left are pointers or sources from another copy of core.

The second walk (`restore`) changes in two places:

- **First**, at a path in `textPointers`: if the schema's output there is `===` the source's sentinel, it becomes the source. Otherwise the walk throws the changed-sentinel error (§ 4.12). A path the schema's output does not have is not visited, and the source is dropped, as a secret's sentinel is when a schema strips its key.
- A `SecretString` whose tag `isSecretSource(tag) || isParamSource(tag)` becomes the tag. Otherwise the existing minted-secret error.

The sentinels the Prisma Cloud target names are in § 6.

### 4.8 Reading a path through a pointer

S2's review fix made `readPath` refuse a path through a secret source. That check becomes `if (!isPlainObject(current) || isSecretSource(current) || isParamSource(current))`, and `describeData` gains `if (isParamSource(value)) return 'a value known only at boot';` after its secret line. So `input.returnUrl.x`, with `returnUrl` bound to `serviceOrigin()`, reports `input.returnUrl.x of module "shop.billing" does not exist: input.returnUrl is a value known only at boot, not a plain object, so it has no fields. …`.

### 4.9 A resource's props take no pointer

After the props are substituted, `resolveValues` walks each resource's substituted props (arrays and plain objects, the same path format as `collect`). A value for which `isSecretSource || isParamSource` is true throws the props-pointer error (§ 4.12). This refuses a runtime source bound directly, a pointer a function returned, and a source from another copy of core. A props member is read by the target at deploy, when a pointer has no value.

### 4.10 The graph records every secret source

`graph-types.ts`:

```ts
/** A secret source the graph names, in a binding or as a resolve() dependency, wherever it sits (ADR-0029). Deploy preflight checks every one, so the platform variables an app needs do not depend on which pointer a resolve() function returns. */
export interface SecretSourceUse {
  /** The source, as its target built it. Core never reads its payload. */
  readonly source: SecretSource;
  /** The node whose binding names it, directly or through a resolve() dependency: the first place Load met it. */
  readonly address: NodeId;
  /** That node's kind. */
  readonly nodeKind: 'service' | 'module';
}
```

`Graph` gains, after `params`:

```ts
  /** Every secret source a binding or a resolve() dependency names, once each, in the order Load met them (ADR-0029). */
  readonly secretSources: readonly SecretSourceUse[];
```

`loadModule` sets it from `resolveValues`. `loadService`'s graph sets `secretSources: []`. The test graph literal in `packages/1-prisma-cloud/1-extensions/target/src/__tests__/control-lowering.test.ts` gains `secretSources: []`.

`config.ts`, beside `paramManifest`:

```ts
/**
 * Every secret source the graph names, in a binding or as a resolve()
 * dependency, wherever it sits: what a deploy target's preflight checks.
 * Pure graph introspection, TARGET-AGNOSTIC.
 */
export function secretSourceManifest(graph: Graph): readonly SecretSourceUse[] {
  return graph.secretSources;
}
```

### 4.11 A forwarded slot listed in `resolve()` counts as forwarded

`deepValues` in `load-module.ts`: the line `if (isValue(value) || isSecretSource(value) || isParamSource(value)) return;` becomes:

```ts
if (isValue(value)) {
  const origin = originOf(value);
  if (origin.kind === 'computed') {
    for (const dependency of origin.dependencies) deepValues(dependency, out, seen);
  }
  return;
}
if (isSecretSource(value) || isParamSource(value)) return;
```

`seen.add(value)` moves before this block so a value reached twice is walked once. With this, `provision(svc, { input: { key: resolve([secrets.key], ([key]) => key) } })` marks the module's `key` slot as forwarded. Without it, Load would report that the module declares a secret it never forwards. `load-module.ts` imports `originOf` from `./value.ts`.

### 4.12 Errors, verbatim

Every error is a `LoadError` (code `COMPOSE.GRAPH_INVALID`) except the construction errors in § 3.3, which are plain `Error`s like every factory's. `<site>` is `describeSite(site)`. `<fn>` is `fnLabelFor(site)`. `<label>` is the source origin's label. `<at path>` is empty at the root and ` at "a.b"` inside.

| Condition | Message |
| --- | --- |
| A pointer turned into text or a number | § 3.4, the first form. Inside a `resolve()` function it is wrapped: `<fn> threw: <that message>`. |
| An `envParam()` turned into text or a number | § 3.4, the second form. |
| A source with a pool key, when Load has no config pool | `<site> depends on <label>, but Load was given no config pool to read "<key>" from. Pass { configPool } to Load; the deploy and dev commands pass the process environment.` |
| A function lists a source with a pool key whose variable is unset or empty | `<fn> lists <label>, but "<key>" is unset or empty, so it has no real value. Set "<key>", or bind <label> directly into an input binding, where an absent value leaves the key out and the schema decides.` |
| A function returns a source it did not receive | § 4.5. Replaces C1's `returned a secret or param source` error. |
| A module's input binding holds a param source with no sentinel and no redaction | `<site> is bound to a param source a module's input cannot take: it names no sentinel for the module's schema to check in its place, as a raw paramSource() does. Bind envParam(), generatedParam() or serviceOrigin(), or a value.` with `<site>` of kind `moduleInput` at the source's path. Replaces S2's param-source error. |
| A module's schema changes a field bound to a pointer with a sentinel | `The input schema of module "<module>" changed input key "<path>", which is bound to <label>. Its value is known only at boot, so a module's schema may check the field but never transform it.` |
| A pointer in a resource's props | `<site> is bound to <label>, which is known only at boot. A resource's props are read at deploy; bind a value known at deploy.` with `<site>` of kind `props` at the pointer's path, and `<label>` `a secret source` or `a param source` for a source with no origin. |

Unchanged texts: S2's misuse error, minted-secret error, issues error and async error; C1's other `checkResult` errors; the slot errors in § 3.6.

## 5. Where each source is accepted

| Where | `envParam()` | `envSecret()` | `generatedParam()` | `serviceOrigin()` |
| --- | --- | --- | --- | --- |
| A service's `input` binding | kept; read at serialize from the deploy shell, as today | kept | kept | kept |
| A service's `params` | kept; pointer row, as today | kept (fails at deploy, as today) | kept (fails at deploy, as today) | kept (fails at deploy, as today) |
| A module's `secrets` slot | refused, as today | accepted and forwarded | refused, as today | refused, as today |
| A module's `params` slot | accepted and forwarded | refused | accepted and forwarded | accepted and forwarded |
| A module's `input` binding | its string; unset or empty leaves the key out | its pointer; the schema checks an empty `SecretString` | its pointer; the schema checks an empty `SecretString` when redacted, else `''` | its pointer; the schema checks `https://origin.invalid` |
| A `resolve()` dependency | its string; unset or empty fails | its pointer | its pointer | its pointer |
| A resource's `props` | its string; unset or empty leaves the key out | refused by the type | refused by the type | refused at Load |

The type of each constructor (§ 6) makes the compiler agree with this table, except where a schema's input type is `unknown` (ArkType's `secretString()`), as S2 notes.

## 6. The Prisma Cloud target

### 6.1 The constructors

`secret.ts`:

```ts
export function envSecret(name: string): SecretSource<EnvSecretPayload> & Value<SecretString>;
```

The checks are unchanged. The return is `secretSource<EnvSecretPayload, SecretString>({ [PRISMA_CLOUD_SECRET_SOURCE]: true, name }, { label: \`envSecret('${name}')\` })`. Its doc comment gains: `It returns a value known only at boot: a resolve() function that lists it receives a pointer, which throws when turned into text.`

`param.ts`:

```ts
export function envParam(name: string): ParamSource<EnvParamPayload> & Value<string>;
```

Returns `paramSource<EnvParamPayload, string>({ [PRISMA_CLOUD_PARAM_SOURCE]: true, name }, { label: \`envParam('${name}')\`, poolKey: name })`. Doc comment gains: `It returns a value known at deploy: where a module's input or a resolve() function needs its real value, that is the variable's value in the config pool, the process environment of the deploying shell.`

```ts
export function generatedParam(
  opts?: GeneratedParamOptions & { readonly redacted?: true },
): ParamSource<GeneratedParamPayload> & Value<SecretString>;
export function generatedParam(
  opts: GeneratedParamOptions & { readonly redacted: false },
): ParamSource<GeneratedParamPayload> & Value<string>;
export function generatedParam(
  opts: GeneratedParamOptions,
): ParamSource<GeneratedParamPayload> & Value<SecretString | string>;
```

The implementation returns `paramSource<GeneratedParamPayload, SecretString | string>(payload, redacted ? { label: 'generatedParam()', redacted: true } : { label: 'generatedParam()', sentinel: '' })`. The sentinels are the ones the serializer already uses for a service.

```ts
/** What a schema checks at deploy in place of a serviceOrigin() leaf, whose value exists only once the deploy has created the service; boot checks the real one. */
export const ORIGIN_SENTINEL = 'https://origin.invalid';

export function serviceOrigin(address: string): ParamSource<OriginParamPayload> & Value<string>;
```

`ORIGIN_SENTINEL` moves here from `serializer.ts`, which imports it. `serviceOrigin` returns `paramSource<OriginParamPayload, string>(payload, { label: \`serviceOrigin('${address}')\`, sentinel: ORIGIN_SENTINEL })`.

`param.ts` and `secret.ts` import `type Value` from `@internal/core` and `type SecretString` from `@internal/foundation/secret`. The serializer, `paramName`, `secretName` and the `is…Source` guards do not change: every source is still the object they read.

### 6.2 Deploy preflight

`preflight-names.ts`:

```ts
export interface PreflightName {
  readonly name: string;
  /** The node that uses the name: a service, or a module whose input holds a secret no service receives. */
  readonly address: string;
  readonly nodeKind: 'service' | 'module';
}
```

`serviceAddress` is renamed `address` wherever `PreflightName` is read: `preflight.ts` and `local-target/preflight.ts`'s `missingEnvParamsSection`. Every existing entry has `nodeKind: 'service'`.

`collectPreflightNames`: after the existing walk over `inputManifest(graph)`, before `dedupedNames`, it appends one entry per `secretSourceManifest(graph)` use: `{ name: secretName(use.source, \`a secret source of ${use.nodeKind} "${use.address}"\`), address: use.address, nodeKind: use.nodeKind }`. `dedupedNames` keeps the first entry per name, so a name a service's binding holds is still reported under that service, as today. The file's header comment gains: `Secrets also include every secret source the graph names elsewhere (secretSourceManifest): one a resolve() lists but does not return, and one in a module's input that no service receives.`

`preflight.ts`, `missingError`: the line becomes `` `  - ${m.name}  (used by ${m.nodeKind} "${m.address}")` ``. For a service the text is what it is today. `runPreflight`'s doc comment gains, after its first sentence: `Every secret source the graph names is checked, including one only a resolve() dependency lists.`

### 6.3 Dev preflight

`runDevPreflight` keeps its per-service rule: a missing secret is an error only when a service's schema rejects its absence. A secret that only a `resolve()` lists, or that sits in a module's input no service receives, is in no service's input, so no schema needs it, and `prisma dev` does not require it (§ 14, decision 10). The only change is the rename in § 6.2.

### 6.4 The process environment count is unchanged

The target's invariant test counts `process.env` per file. This slice adds none.

## 7. The commands give Load the config pool

Core's invariant test allows `process.env` only in `control/deploy.ts`, twice, to read back the container transport. So core never reads the environment itself; the command that runs Load passes it.

- `packages/0-framework/3-tooling/cli/src/pipeline.ts`: `Load(entryModule.root, { id: name, environment: { name: environment }, configPool: process.env })`.
- `LowerOptions` in `control/deploy.ts` gains, after `environment`:

  ```ts
  /** The config pool Load reads a source's pool key from, such as envParam()'s variable. The generated stack files pass the process environment. */
  readonly configPool?: Readonly<Record<string, unknown>>;
  ```

  `lowering()` calls `Load(root, { id: opts.name, ...(opts.environment !== undefined ? { environment: { name: opts.environment } } : {}), ...(opts.configPool !== undefined ? { configPool: opts.configPool } : {}) })`.
- `generate-stack.ts` and `dev/generate-dev-stack.ts`: `renderOptions` renders `  configPool: process.env,` directly after the `environment` line.

The CLI starts the deploy engine's process with the same environment (`run-alchemy.ts`), so both Loads read the same values. A deploy where they differ deploys a graph the CLI did not check, as a `resolve()` function that reads the clock does.

## 8. Every existing app keeps working

Nothing an app writes today changes meaning. This is how the slice proves it:

1. **The graph a target receives is the same.** A service's input binding and params keep every source in place (§ 4.3, § 4.6), so `graph.inputBindings` and `graph.params` hold the same objects, with the same payloads, as before. These existing tests read those leaves after `Load` and must pass unchanged: `examples/storefront-auth/module.test.ts`; the `module.test.ts` of `auth`, `email` and `streams` under `packages/1-prisma-cloud/2-shared-modules/`; core's `secrets.test.ts`, `params.test.ts` and `module-composition.test.ts`.
2. **The target reads sources directly, without Load, and they are still sources.** `input-serializer.test.ts`, `serializer.test.ts`, `generated-param.test.ts`, `param.test.ts`, `secret.test.ts`, `preflight.test.ts` and `local-target-preflight.test.ts` build bindings with `envParam()`, `envSecret()` and `generatedParam()` and must pass unchanged. In particular `isParamSource(generatedParam())` stays true and `isGeneratedParamSource(envSecret('…'))` stays false.
3. **Graphs that bind `envParam()` on services Load without a config pool**, as every existing test does, because Load never computes the real value of a source kept in place.
4. **Every type test passes unchanged**, because each constructor's type is still its source type (§ 6.1).
5. **The examples deploy and serve as before** (§ 12, QA 1 and 2).

The only existing tests this slice changes are the ones whose subject changed, in § 11.6. If any other existing test fails, the implementer stops and reports.

## 9. Documentation

All in the same pull request, per `.agents/rules/user-facing-surface-changes.mdc`.

- **The `resolve()` decision**, `docs/design/90-decisions/ADR-0062-…md`:
  - In its existing 2026-10-29 amendment note, the sentence that begins "`envParam()` and `envSecret()` are not values yet" is replaced, verbatim, by: `` `envParam()` and `envSecret()` were not values then; the `module-input` project makes them values (see the next amendment). Neither stores a value in a platform variable the deploy owns: an earlier version of this note said they would, and was wrong. ``
  - A second amendment note, directly after the first, verbatim:

    > Amended 2026-10-29 (module-input project, third slice): `envParam()`, `envSecret()`, `generatedParam()` and `serviceOrigin()` return values, each the deploy target's source as well. Wherever a service's binding, a service's params or a module's `secrets` and `params` slots took a source, the target receives the same object, so the wire format does not change. `envParam()` is deploy-time: its real value is the variable's value at deploy, read from the config pool, which is the process environment until config adapters exist. `envSecret()` is runtime: the deploy never holds the secret, and its real value at deploy is a pointer the service dereferences at boot. `generatedParam()` and `serviceOrigin()` are runtime too, because the deploy creates their values after Load; so the table's plain runtime cell holds them. Two statements below are corrected. A `resolve()` function receives a secret input as that pointer, not as an opaque `SecretString` box; a pointer throws when code turns it into text or a number, and `isRuntimeValue(x)` is true for one. And `fn` returns plain data or a pointer it received, which the target then receives as if the source had been bound directly. Deploy preflight checks every `envSecret()` the graph names, including one a function lists but does not return.
  - The index line in `docs/design/90-decisions/README.md` gains, after the existing note: ``*(Amended 2026-10-29, third slice: the sources are values; `envParam()` is deploy-time, `envSecret()` a runtime pointer; neither stores a value in a platform variable the deploy owns.)*``
- **The secrets decision**, `ADR-0029-…md`, an amendment note after the existing one, verbatim:

  > Amended 2026-10-29 (module-input project, third slice): `envSecret('NAME')` returns a value, `SecretSource & Value<SecretString>`, that is also the source. Wherever a binding took the source, the target receives the same object, so the pointer, preflight and boot are unchanged. Its real value at deploy is a pointer: a `resolve()` function that lists it receives the source itself, which throws when turned into text or a number, and may return it. Deploy preflight checks every `envSecret()` the graph names, including one a function lists but does not return and one in a module's input that no service receives. `secretSource()` takes an optional `label`, the name errors use.

  Index line gains: ``*(Amended 2026-10-29: `envSecret()` returns a value whose real value is a pointer; preflight checks every `envSecret()` the graph names.)*``
- **The provision-time params decision**, `ADR-0032-…md`, an amendment note after the existing one, verbatim:

  > Amended 2026-10-29 (module-input project, third slice): `envParam('NAME')` returns a value, `ParamSource & Value<string>`, that is also the source. In a service's input binding and a service's params the target receives the source, so both work as before: an input leaf is read from the deploying shell when the target serializes it, and a param keeps its pointer row, read at boot. In a module's input and as a `resolve()` dependency, its real value is the variable's value at deploy, read from the process environment; an unset or empty variable has none. `paramSource()` takes an optional `label`, `poolKey`, `sentinel` and `redacted`.

  Index line gains: ``*(Amended 2026-10-29: `envParam()` returns a value; a module's input and `resolve()` read its variable at deploy.)*``
- **Glossary**, `docs/design/03-domain-model/glossary.md`:
  - `### Value`, the "Deploy-time or runtime" bullet becomes, verbatim: `- **Deploy-time or runtime.** A deploy-time value has its real value by the end of Load: \`environment.name\`, a \`resolve()\` result, and \`envParam()\`, whose real value is the variable's value at deploy. A runtime value has no real value when Load runs: the platform holds it (\`envSecret()\`), or the deploy creates it later (\`generatedParam()\`, \`serviceOrigin()\`). Load holds a **pointer** in its place, and uses the pointer as its real value: a \`resolve()\` function that lists one receives the pointer, and a module input field bound to one holds it. A pointer throws when code turns it into text or a number, and \`isRuntimeValue(x)\` is true for one. A function may return a pointer it received.`
  - A new bullet after it: `- **Sources are values.** \`envParam()\`, \`envSecret()\`, \`generatedParam()\` and \`serviceOrigin()\` each return one object that is a value and the deploy target's source. Where a service's binding takes a source, the target receives that object.`
  - The paragraph after the bullets: the sentence "`envParam()` and `envSecret()` are not values yet; they become values, with config and secret adapters, in the module-input project." is replaced by `A source's type is the source and a value at once, such as \`SecretSource & Value<SecretString>\`.`
  - `### Configuration — params and their sources`, after the four-source list: `Each source constructor, and \`serviceOrigin()\`, returns a [value](#value) that is the source too.`
- **`docs/design/10-domains/config-params.md`**:
  - The header note gains a second line: `> Amended by the module-input project (2026-10-29): every source constructor returns a value; see § Sources are values.`
  - A new section `## Sources are values`, after "Binding a param at provision": the table in § 5 of this spec; one paragraph saying a service's input binding, its params and a module's `secrets` and `params` slots receive the source, so the rest of this document holds unchanged; one paragraph on the real value of each source and the pointer (§ 2's bullets as prose); one sentence on preflight checking every `envSecret()` the graph names.
- **`docs/design/10-domains/module-composition.md`**, section "Input":
  - "A field bound to `envSecret()` has the `SecretSource` as its real value, the pointer and never the secret, although its type says `SecretString`, because that is the schema's output type." becomes `A field bound to \`envSecret()\`, \`generatedParam()\` or \`serviceOrigin()\` has a pointer as its real value, never a value, although its type is the schema's output type.`
  - The `resolve()` bullet's second sentence becomes `For a field bound to a runtime value, that is a pointer, which the function may return unchanged.`
  - "How Load validates" gains, after the secret-source sentence: `A param source known only at boot reaches the schema as the sentinel its target names, an empty \`SecretString\` box when it is redacted, and is put back at its path; a schema that changes such a field fails the Load.`
  - "Not supported yet": the sentence about `envParam()` is removed.
- **`docs/design/10-domains/core-model.md`**:
  - The `LoadOptions` block gains `  readonly configPool?: Readonly<Record<string, unknown>>  // what a source's pool key reads; the commands pass the process environment`.
  - The `LowerOptions` block gains `  readonly configPool?: Readonly<Record<string, unknown>>       // passed to Load; the generated stack files pass process.env`.
  - The second-pass paragraph: "or `fn` returned a Promise, `undefined`, a value, a secret or param source, or anything else that is not plain data" becomes "or `fn` returned a Promise, `undefined`, a value, a source it did not receive, or anything else that is neither plain data nor a pointer it received". "A value as a `provision()` id, in a `deps` entry, or as a module's `secrets` or `params` binding is a LoadError too." becomes "A value as a `provision()` id or in a `deps` entry, or a value that is not a source as a module's `secrets` or `params` binding, is a LoadError too." It gains, at its end: `A source is a value too. Load leaves one in place in a service's input binding and params, and computes its real value only where a module's input, a resolve() function or a resource's props needs it. The graph lists every secret source it names in \`secretSources\`.`
- **`docs/guides/building-an-app.md`**:
  - "A module's input": the bullet "A root module cannot declare `input` yet, and a module's `input` does not take `envParam()` yet. …" becomes two bullets: `- A root module cannot declare \`input\` yet.` and `- A module's \`input\` takes every source a service's does. Its schema checks \`envParam()\`'s value. It checks a stand-in for the three whose value exists only at boot: an empty \`SecretString\` for \`envSecret()\` and a redacted \`generatedParam()\`, \`''\` for a plain \`generatedParam()\`, and \`https://origin.invalid\` for \`serviceOrigin()\`. A schema that transforms such a field fails the deploy.`
  - "Service input", the `envParam('NAME')` paragraph is replaced, verbatim: `**\`envParam('NAME')\`** is for plain values the code *can't* know. An app origin is the canonical case: it's different on production and on every preview environment. The deploy reads the variable from the environment of the shell that runs \`prisma deploy\` or \`prisma dev\`, and writes its value into the service's input. So set it in that shell for every deploy; in CI, export it per environment. An unset or empty variable leaves the key out, and the schema decides ([below](#absence-is-the-schemas-call)). The value is a string, so bind \`envParam\` to string fields. To change it, deploy again with the new value. [\`examples/env-param\`](../../examples/env-param/) is the minimal working version, including a smoke script that proves the per-environment split.`
  - The `envSecret('NAME')` paragraph's second sentence becomes: `Each environment keeps its own copy of the platform variable, and that copy is the store: at deploy, preflight checks that the environment has the variable, and copies a missing one up from the deploying shell, so CI (or you) exports \`STRIPE_SECRET_KEY\` for a first deploy.`
  - "Values that differ per environment": "a module's `secrets` and `params` bindings take sources, not values" becomes "a module's `secrets` and `params` bindings take only sources, which are values too". The error bullet "`fn` returns `envParam()` or `envSecret()`. Bind those directly, not through `resolve()`." becomes "`fn` returns a source it did not receive, such as `envSecret()` called inside `fn`. It may return a pointer it received ([below](#sources-in-resolve))." A new bullet: "`fn` lists `envParam('NAME')` and the variable is unset or empty."
  - A new subsection `### Sources in resolve()` at the end of that section: `envParam()`, `envSecret()`, `generatedParam()` and `serviceOrigin()` are values, so `resolve()` can list them; for `envParam()` the function receives the variable's value at deploy; for the other three it receives a pointer, although the type says `SecretString` or `string`, because their value exists only at boot; a pointer throws when turned into text or a number; the function may return it, or put it in its result, unchanged, and the service receives the source as if it had been bound directly; `isRuntimeValue(x)` from `@prisma/composer` is true for a pointer; the § 1 example; deploy preflight checks every `envSecret()` listed, in every environment, whichever one the function returns, and one variable name with a different value per environment is simpler; turning `envParam()` into text in a module body fails the deploy, as reading an input field does.
- **`docs/guides/deploying.md`**, "CI": the paragraph "One extra: if your app binds input fields with `envSecret` or `envParam` …" is replaced, verbatim: `One extra: if your app binds \`envSecret\` (see [Building an app § Service input](building-an-app.md#service-input)), each environment keeps its own copy of those platform variables, and the platform copy is the store; the deploying shell only seeds it. A fresh environment (a new \`pr-42\`) has none of them yet, so CI must export the values (e.g. \`AUTH_SIGNING_SECRET\`) alongside the two credentials; preflight copies missing ones up on that first deploy. A name absent from both the platform and the shell fails the deploy early, naming the missing variable. An \`envParam\` input is different: the deploy reads it from the shell on every deploy, so CI exports it every time.`
- **`skills/prisma-composer-core-concepts/SKILL.md`**, written to the rules in `skills/README.md`:
  - Rule 2 of "Rules that bite" becomes: `2. **\`envParam\` values arrive as raw strings**; bind them to string fields. In \`input\`, the deploy reads the variable from the deploying shell on every deploy. Only \`envSecret\` lives on the platform: each environment keeps its own copy, and the deploying shell only seeds a missing name (the deploy fails early, naming the variable, when both lack it).`
  - Under "Values that differ per environment": in the first bullet, "and a module's `input` takes no `envParam()` yet" becomes "and a module's `input` takes every source a service's does"; the bullet "A value is accepted …" ends "Never as a provision id or a `deps` entry; a module's `secrets` and `params` bindings take only sources."; the last bullet's parenthesis becomes "(no `undefined`, Promise or value, and no source it did not receive)"; and a new bullet: `- Sources are values. \`resolve([envParam('X')], ([x]) => …)\` receives the string, and an unset \`X\` fails the deploy. For \`envSecret()\`, \`generatedParam()\` and \`serviceOrigin()\` the function receives a pointer that throws when used as text; it may return the pointer unchanged. \`isRuntimeValue(x)\` is true for one. Preflight checks every \`envSecret()\` listed, even one the function does not return.`
- **`.drive/deferred.md`**, two entries under a `# Module input — deferred (2026-10-29)` heading, added to it if S2 created it:
  - `An envParam() in a module's input that resolves absent is not in the deploy report's list of absent keys, which ADR-0042 promises for a service's input. Load would record it and the compute descriptor would print it.`
  - `A spread copy of a source (the ctx.secrets and ctx.params refs) does not throw when turned into text, because the coercion properties are not enumerable. Load reads its real value through the original, so only code holding the copy itself sees "[object Object]". Removed with the module slots in S5.`

## 10. Scope

In: everything above, in `packages/0-framework/1-core/core`, `packages/0-framework/3-tooling/cli` (§ 7), `packages/1-prisma-cloud/1-extensions/target` (§ 6), `docs/`, `skills/`, `.drive/deferred.md`.

Out: config and secrets adapters, `dotenv()`, a root's `input` and reading `envParam()` from the adapters' pool (S4); removing the module `params` and `secrets` slots and migrating `auth()`, `email()` and the examples (S5); the absent-key report for a module's `envParam()`; a throwing copy of a source; any change to the serializer's handling of a service's own sources; any change to boot.

## 11. Tests

Runtime tests use `bun test`; type tests use vitest `expectTypeOf` and `@ts-expect-error`. Core fixtures follow `module-input.test.ts`: `echoService()`, `shopWith(child, binding)`, `staging`, `loadError()`, `recording(seen)`, `refusing(message)`. Two more core fixtures:

- `const pointer = (name: string) => secretSource({ name }, { label: \`envSecret('${name}')\` })`
- `const variable = (name: string) => paramSource({ name }, { label: \`envParam('${name}')\`, poolKey: name })`

### 11.1 New file `packages/0-framework/1-core/core/src/__tests__/source-value.test.ts`

**Building a source**

1. `secretSource() and paramSource() return values that are also sources` — `isValue`, `isSecretSource` (or `isParamSource`) true; `payload` reads back; `Object.keys(source)` is `['payload']`; `Object.isFrozen(source)` is true.
2. `a source's JSON is what it was before sources were values` — `JSON.stringify(secretSource({ name: 'X' }))` is `'{"payload":{"name":"X"}}'`.
3. `a spread copy of a source is still a value and a source` — `{ ...pointer('X'), extra: 1 }`.
4. `paramSource() refuses a pool key beside a sentinel or redacted, a sentinel beside redacted, and an empty label or pool key` — the § 3.3 messages.
5. `isRuntimeValue() is true for a secret source and a param source without a pool key, and false otherwise` — false for `variable('X')`, `environment.name`, a `resolve()` result, a string, `null` and a plain object.

**Reading a source**

6. `turning a pointer into text or a number fails naming it and saying it is known only at boot` — over `String(s)`, `` `${s}` ``, `s * 2`, `s + 1`, `s.toString()`, `s.valueOf()`; each a `LoadError` with the § 3.4 first form for `envSecret('X')`.
7. `turning envParam() into text in a module body fails as a value` — `` provision(echoService(), { input: { greeting: `${variable('G')}` as never } }) ``; the § 3.4 second form.

### 11.2 New file `packages/0-framework/1-core/core/src/__tests__/source-load.test.ts`

**Sources a service takes stay in place**

8. `a source in a service's input binding reaches the graph as the same object` — `toBe` for `pointer('K')` and `variable('G')`, with no config pool.
9. `a source in a service's params reaches the graph as the same object, with no config pool` — `variable('G')` on the `label` param.
10. `a source bound to a module's secrets slot and forwarded reaches the service with the same payload` — `isSecretSource(leaf)`, `leaf.payload` equal.
11. `a param source with a pool key bound to a module's params slot and forwarded reaches the service param unchanged`.

**Real values**

12. `envParam() in a module's input is its config pool value` — `configPool: { G: 'hi' }`; the service binding is `{ greeting: 'hi' }`.
13. `an unset or empty variable in a module's input leaves the key out` — `{}` and `{ G: '' }`; `'greeting' in binding` is false.
14. `a variable in a module's input fails when Load has no config pool` — the exact message.
15. `resolve() over envParam() receives the string` — `resolve([variable('G')], ([g]) => g.toUpperCase())`; `'HI'`.
16. `resolve() over an unset variable fails naming it` — the exact message, `<fn>` `The resolve() function for input key "greeting" of service "shop.echo"`.
17. `resolve() over a secret source receives the source and may return it` — the service binding's `key` is `toBe` the source.
18. `resolve() may return a pointer inside its result` — `([k]) => ({ inner: k })`.
19. `resolve() may choose between two pointers it received` — `staging` picks the second; the binding holds it.
20. `a resolve() function that returns a source it did not receive fails` — `paramSource({ name: 'X' })` made inside `fn`, at path `a`; the exact message with ` at "a"`.
21. `a pointer turned into text inside resolve() fails naming the binding and the pointer` — `` ([k]) => `Bearer ${k}` ``; the message is `The resolve() function for input key "key" of service "shop.echo" threw: ` followed by the § 3.4 first form, and `cause` is a `LoadError`.

**A module's input and runtime param sources**

22. `a param source with a string sentinel in a module's input reaches the service as the same source` — `paramSource({}, { label: "serviceOrigin('shop.web')", sentinel: 'https://origin.invalid' })` into a `recording` schema forwarded on; the schema saw `'https://origin.invalid'`; the service binding holds the source by identity.
23. `a redacted param source is checked as a SecretString and reaches the service as the same source` — ArkType `type({ key: secretString(), n: 'string.integer.parse' })`, so the morph copies the input; `toBe`.
24. `a module schema that changes a field bound to a sentinel fails` — a schema returning `{ base: 'x' }`; the exact message.
25. `a param source with no sentinel in a module's input fails` — `paramSource({ name: 'X' })` at `from`; the exact message.
26. `a path through a runtime param source fails naming the path` — `input.base.x`; the § 4.8 text.

**Props**

27. `envParam() in a resource's props is its config pool value`.
28. `a runtime source in a resource's props fails` — `pointer` cast into a props member, at `url`; the exact message with `prop "url" of resource "shop.site"`.

**The secret list and forwarded slots**

29. `graph.secretSources lists every secret source a binding or a resolve() dependency names` — test 19's graph holds both, each with `address: 'shop.echo'`, `nodeKind: 'service'`.
30. `a secret source in a module's input that no service receives is listed under the module` — `nodeKind: 'module'`, `address: 'shop.email'`.
31. `graph.secretSources lists a source once, where Load first met it` — one source in two services' bindings.
32. `a forwarded secrets slot listed only in a resolve() dependency counts as forwarded` — the § 4.11 example; Load passes; the binding's `key` is the root's source.

### 11.3 New file `packages/0-framework/1-core/core/src/__tests__/source-value.test-d.ts`

- `secretSource<{ name: string }, SecretString>(…)` is assignable to `SecretSource` and to `Value<SecretString>`; in `resolve([s], ([v]) => …)`, `v` is `SecretString`.
- `paramSource<{ name: string }, string>(…)` is accepted by `ModuleInputBinding<{ from: string }>` and refused by `ModuleInputBinding<{ n: number }>`; a bare `ParamSource` is refused by `ModuleInputBinding<{ from: string }>`.
- A `Value<SecretString>` that is not a source is not a `SecretSource`, so a module's `secrets` slot refuses an input field.
- `ResourcePropsMember` accepts `paramSource<P, string>(…)` and refuses `secretSource<P, SecretString>(…)`.
- `isRuntimeValue(x)` narrows `x` to `ParamSource | SecretSource`.

### 11.4 Prisma Cloud target

33. `param.test.ts`: `envParam() in a module's input is the variable's value in the config pool` — `Load` a root whose module forwards `envParam('APP_ORIGIN')` to a service, with `configPool: { APP_ORIGIN: 'https://shop.example' }`.
34. `secret.test.ts`: `envSecret() turned into text fails naming it and saying it is known only at boot` — `String(envSecret('STRIPE_KEY'))`; the exact § 3.4 text with `envSecret('STRIPE_KEY')`.
35. `input-serializer.test.ts`, `describe('a source forwarded through a module input', …)`: `serviceOrigin() forwarded through a module's input serializes to its origin pointer` — `Load`, then `serializeInput`; the document has `{ $generated: <var>, redacted: false }` at the key and `row.generated[0].origin` is `'shop.web'`.
36. Same `describe`: `a redacted generatedParam() forwarded through a module's secretString() field serializes to its generated pointer`.
37. `preflight.test.ts`: `a secret only a resolve() dependency lists is checked, and fails when missing` — a graph whose function picks `envSecret('A')` in `production`; the platform has `A` only; the shell has neither; the failure names `B` and `used by service "app.ingest"`.
38. `preflight.test.ts`: `a secret in a module's input that no service receives is checked, named as used by the module` — `used by module "app.mail"`.
39. `local-target-preflight.test.ts`: `prisma dev does not require a secret only a resolve() dependency lists` — `runDevPreflight` passes with `B` unset.
40. New file `sources.test-d.ts`: `envParam()` is `ParamSource<EnvParamPayload> & Value<string>`; `envSecret()` is `SecretSource<EnvSecretPayload> & Value<SecretString>`; `generatedParam()` stands for `SecretString`, `generatedParam({ redacted: false })` for `string`; `serviceOrigin()` for `string`; each still compiles in a module's `params` or `secrets` slot as today, and `envParam()` in a service param typed `number`.

### 11.5 CLI and lowering

41. `pipeline.test.ts`: `runPipeline passes the process environment to Load as the config pool` — new fixture `cli/src/__tests__/fixtures/pipeline-config-pool/` (a copy of `fixtures/pipeline/prisma.config.ts`, and a `module.ts` whose root binds `paramSource({ name: 'S3_PIPELINE_PROBE' }, { poolKey: 'S3_PIPELINE_PROBE' })` into a child module's input, forwarded to the `echo` service's `greeting`); with `S3_PIPELINE_PROBE=probe` set for the test, `graph.inputBindings[0].binding` equals `{ greeting: 'probe' }`.
42. `generate-stack.test.ts` and `generate-dev-stack.test.ts`: the rendered file contains `  configPool: process.env,` directly after the `environment` line.
43. `stack-file-import.test.ts`: the stub `lower` records `opts.configPool === process.env`, and the evaluated stack file makes it `true`.
44. `lowering.test.ts`: `lowering() passes opts.configPool to Load` — a module forwarding a pool-key source into the service's `label` param through its input; the fake descriptor's `serialize` sees `config.service.label === 'probe'`.

### 11.6 Existing tests whose subject changed

- `value.test.ts`: `isValue() recognises environment.name and a resolve() result and nothing else` is renamed `isValue() recognises environment.name, a resolve() result and a source, and nothing else`, and its last line expects `true`.
- `resolve-values.test.ts`: in `fn returning a secret source, a function, or a class instance fails naming the binding`, the first expectation is the § 4.5 message (no path).
- `module-input.test.ts`: `a param source in a module's input binding fails naming the key` expects the § 4.12 raw-param-source message.
- `control-lowering.test.ts`: its graph literal gains `secretSources: []`.

## 12. Done when

- Tests 1 to 44 and the type tests pass; `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm test` are green at the root.
- Manual QA, recorded in `qa.md` in this slice's folder:
  1. **Unchanged, deployed.** `examples/env-param` with `ENV_PARAM_GREETING=hi`: `pnpm deploy` to `production`, then `pnpm smoke:deployed` passes. `examples/auth`: `pnpm deploy`, then `pnpm smoke:deployed` passes. Together these cover `envParam()` in a service's input, `envParam()` and `envSecret()` in module slots, `serviceOrigin()` through a module's `params` slot, and `generatedParam()`.
  2. **Unchanged, local.** `ENV_PARAM_GREETING=hi prisma dev --detach` in `examples/env-param`, then `curl "$(prisma dev url env-param-example.echo)"` prints `{"greeting":"hi","environment":"deployed to dev"}`; then `prisma dev stop`.
  3. **A source in a module's input.** A working-tree edit of `examples/env-param/module.ts` moves `echoService` into a module `greeter` with `input: type({ greeting: 'string', environment: 'string' })`, forwarding both fields. The root binds `greeting: envParam('ENV_PARAM_GREETING')` and `environment: resolve([envParam('ENV_PARAM_GREETING'), environment.name], ([g, name]) => \`${g} from ${name}\`)`. `prisma dev` serves `{"greeting":"hi","environment":"hi from dev"}`.
  4. **A source cannot be read.** The same edit with `` greeting: `${envParam('ENV_PARAM_GREETING')}` `` fails `prisma dev` with the § 3.4 second form before anything starts.
  5. **Preflight checks a secret no service receives.** The edit's `greeter` schema gains `'key?': secretString()`, its body does not forward it, and the root binds `key: envSecret('S3_QA_UNSET_SECRET')`. With that variable set nowhere, `prisma deploy` to `production` fails in preflight, naming `S3_QA_UNSET_SECRET  (used by module "env-param-example.greeter")`, before the deploy engine runs.
  6. The edit is reverted with `git checkout examples/env-param/module.ts`.
- Every document in § 9 is updated.

## 13. How a reviewer checks the decisions

Each decision in § 14 has a test that fails when the behavior breaks: decision 1 by tests 1, 3 and § 8's unchanged suites; 2 by tests 8 to 11; 3 by tests 12 to 14 and 41 to 44; 4 by tests 13 and 16; 5 by tests 22 to 26, 35 and 36; 6 by tests 6 and 21; 7 by test 7; 8 by tests 17 to 20; 9 by test 5; 10 by tests 29 to 31, 37 to 39; 11 by test 32.

## 14. Decisions this spec records, for the review

1. **A source and its value are one object** (§ 3.2, § 3.3). `envSecret('X')` is a `SecretSource` and a value at once. Every place that reads a source today, in core, in the target and in tests that call the serializer without Load, keeps reading the same object. The design notes say the source becomes "the payload inside a value"; § 15, conflict 1.
2. **Where a binding took a source before, Load keeps the source in place** (§ 4.3, § 4.6). A service's input binding, its params and the module slots receive the object as today. This keeps the deploy report's absent keys for a service's input (the service input decision), the pointer rows for an `envParam()` param (the provision-time params decision), and the dev preflight's per-service checks, all unchanged. Load computes a real value only where core consumes one.
3. **`envParam()`'s real value comes from a config pool Load is given** (§ 4.1, § 7). The deploy and dev commands, and the generated stack files, pass the process environment. Core does not read `process.env`, because its invariant test allows only the container transport to. S4 fills the pool from the config adapters through the same option.
4. **An unset or empty variable gives no real value** (§ 4.4). In a binding the key is left out and the schema decides, as for a service's input today. Listed in `resolve()`, it fails Load, because the function's type promises a string.
5. **`generatedParam()` and `serviceOrigin()` are runtime values in a module's input** (§ 4.7, § 6.1). Their real value is the pointer. The module's schema checks the sentinel the target names, the same ones the serializer uses for a service, and Load puts the source back at its path. A schema that transforms such a field fails, because the transform would be lost. A schema that copies the sentinel to another key is not caught; it would deploy the sentinel as data. This settles the orchestrator's note that S3 must accept these sources, because S5 moves `auth()` onto `input`.
6. **The pointer is the source itself, and reading it throws a `LoadError`** (§ 3.4). Inside a `resolve()` function the error is wrapped once with the binding's name (§ 4.4), so the author finds both the function and the source.
7. **`envParam()` turned into text in a module body throws too** (§ 3.4). Today it silently gives `[object Object]`. This is a behavior change an app could hit, and the guide says so (§ 9).
8. **A function may return only a pointer it received** (§ 4.5), at any depth, matched by identity. Choosing between received pointers per environment is allowed, as the design notes settle. Making a new source inside the function is not.
9. **`isRuntimeValue()` answers about pointers** (§ 3.5): true for a secret source and a param source without a pool key, which is what a function receives. It is false for `envParam()` and for every other value. In a module body an input field is never one, because its binding is read after the body runs; the doc comment says so.
10. **The graph lists every secret source; deploy preflight checks them; dev preflight does not** (§ 4.10, § 6.2, § 6.3). Deploy preflight checks platform state, which must not depend on which pointer a function returns. Dev has no platform state, and its rule is that a secret is required only when a service's schema needs it.
11. **A forwarded `secrets` or `params` slot listed in `resolve()` counts as forwarded** (§ 4.11). C1 refused sources from functions partly because this was reported as never forwarded.
12. **`secretSource()` and `paramSource()` take options, in a second parameter** (§ 3.2). `label` names a source in errors without core reading the payload. `poolKey`, `sentinel` and `redacted` tell core what it needs about a param source's real value, again without the payload.
13. **`generatedParam()` gets overloads** (§ 6.1), so a redacted one stands for `SecretString` and a plain one for `string`, and each fits the module schema field it belongs in.

## 15. Conflicts

Where the code, the design notes, the decision records or the docs disagree, and what this spec does.

1. **Design note 5 says `ParamSource` and `SecretSource` "become the target's payload inside a value".** This spec makes the value and the source one object (§ 14, decision 1). Under either reading `isValue()` is true for `envParam()` and `envSecret()`. Wrapping the source inside a separate value would break every target path that reads a source without going through Load, including the serializer tests.
2. **Design note 2's table says there is no runtime config in `input` today, and the `resolve()` decision's table leaves that cell empty.** `generatedParam()` and `serviceOrigin()` in a service's input are runtime config already: the deploy writes their value to a platform variable and the service reads it at boot. This spec treats them as runtime values, and the `resolve()` decision's amendment says the cell holds them (§ 9).
3. **Design note 2 says `envParam()` stays deploy-time "as it is in a service's input today".** In a service's `params`, `envParam()` is a runtime pointer: the deploy writes a pointer row, and boot reads the platform variable (the provision-time params decision). This spec keeps both behaviors by handing the target the source (§ 14, decision 2).
4. **The guides and the skill say `envParam()`'s platform variable is the store and the shell only seeds it.** For an `envParam()` in a service's input, the serializer reads the deploying shell on every deploy, and preflight does not check the name (`preflight.ts`'s own doc comment; `examples/env-param/module.ts`'s comment). That description is true only for an `envParam()` param. This spec corrects the guide, the deploying guide and the skill (§ 9).
5. **The glossary's Value entry, written in S2, says a module input field bound to `envSecret()` is deploy-time.** The design notes put `envSecret()` in the runtime row. This spec follows the design notes and rewrites the entry (§ 9).
6. **The `resolve()` decision says "Secret inputs arrive as opaque `SecretString` boxes"** in a function. Design note 4 says the function receives the pointer. This spec follows the design note, and the amendment corrects the statement (§ 9).
7. **The task says to keep reading the deploy shell, and core's invariant test forbids core to read `process.env`** except for the container transport. This spec has the commands and the generated stack files pass the process environment into Load (§ 7).
8. **The service input decision promises a deploy report that lists every key that resolved absent.** An `envParam()` in a module's input that resolves absent leaves its key out silently. This spec records it as deferred (§ 9) rather than adding a graph field and a report change to this slice.
9. **S2's review fix of `readPath` is uncommitted on the branch** at the time of writing. § 4.8 builds on it. If it has not landed, or landed in a different form, the implementer stops and reports.
10. **C1 refused a source returned from a function, for two reasons.** A forwarded slot ref used only in a function was reported as never forwarded; decision 11 fixes that. A function choosing a platform variable per environment would fix a meaning for sources before this project; design note 4 now settles that a function may return a pointer it received.
