# S2 — `module()` takes `input`

Parent: [module-input spec](../../spec.md) and [plan](../../plan.md). Decisions: the module input decision ([ADR-0061](../../../../../docs/design/90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)), the `resolve()` decision ([ADR-0062](../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md), with its 2026-10-29 amendment), the module boundary decision ([ADR-0016](../../../../../docs/design/90-decisions/ADR-0016-a-module-has-the-same-boundary-as-a-service.md)) and the service input decision ([ADR-0042](../../../../../docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md)). What the discussion with Will settled beyond them is in [design-notes.md](../../design-notes.md). The mechanism is the one the [S1 spike](../s1-spike/report.md) proved; its probe is in [`../s1-spike/probe/`](../s1-spike/probe/).

This spec leaves nothing to the implementer's judgement. Every type, signature, name, error message, file and test is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose. § 13 lists where this spec departs from the plan, the spike or the decision records, and why.

## 1. At a glance

```ts
import { module, resolve } from '@prisma/composer';
import { secretString } from '@prisma/composer/arktype';
import { envSecret } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

const email = module(
  'email',
  { input: type({ from: 'string', deliveryCredential: secretString(), 'replyTo?': 'string' }) },
  ({ input, environment, provision }) => {
    const sender = resolve([input.from, environment.name], ([from, name]) =>
      name === 'production' ? from : `${name}+${from}`);
    provision(emailService, {
      id: 'service',
      input: { from: sender, replyTo: input.replyTo, deliveryCredential: input.deliveryCredential },
    });
  },
);

export default module('shop', ({ provision }) => {
  provision(email, {
    input: { from: 'shop@example.com', deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') },
  });
});
```

`prisma deploy --environment staging` gives `shop.email.service` the input binding `{ from: 'staging+shop@example.com', deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') }`. The binding has no `replyTo` key, because the root left that optional field out.

```ts
// the structure rule, enforced
module('email', { input: type({ domain: 'string' }) }, ({ input, provision }) => {
  provision(emailService, { input: { from: `noreply@${input.domain}` } });
  // LoadError: input.domain of module "shop.email" is a value, not its real value,
  // and it was turned into text (a template literal or String()). …
});
```

## 2. The model

These are the terms the glossary already defines ([Value](../../../../../docs/design/03-domain-model/glossary.md#value)), applied to module input. The glossary gains the input case (§ 8).

- **An input field** is what a module body holds for one key of its `input` schema: `input.from`, `input.smtp.host`, or `input` itself for the whole input. Every input field is a **value**, the same kind as `environment.name` and a `resolve()` result. It is a **provided** value: the body is handed it.
- **The real value of an input field** is the data at that key path in the module's **validated input**: the module's input binding, with its values replaced by their real values, passed through the module's schema. A real value is the schema's output, so a field typed `number` from a `string.integer.parse` schema receives `4`, not `'4'`.
- **An input field is deploy-time.** Its real value is known by the end of Load. A field bound to `envSecret()` has a `SecretSource` as its real value: the pointer, never the secret. Its type says `SecretString`, because that is the schema's output type.
- **The body can only pass an input field on**: into a `provision()` binding, or as a `resolve()` dependency. Turning one into text or a number, serializing it, listing its keys, iterating it, testing it with `in`, assigning to it or freezing it throws a `LoadError` naming the field. `===`, `!==` and `switch` against a literal fail to compile, because the types do not overlap. A truthiness check (`if`, `!`, `&&`, `||`, `? :`, `??`) and `typeof` cannot be caught at all: the body sees an object, so such a branch always goes the same way, and the graph's structure still cannot vary.
- **A module's input binding is validated during Load's second pass, synchronously**, by the module's schema. A child's real value is read from its parent's validated output, so the parent's schema must run first. An async schema fails the Load. Each module's binding is validated once per Load, whether or not the body uses any field.
- **Load cannot list a schema's keys.** Standard Schema exposes only `validate`. So a declared input field the body never uses is not an error, unlike an unused `deps` entry.

## 3. Core: the input field

### 3.1 `value.ts`

`ValueOrigin<T>` gains a third member, after `'computed'`:

```ts
  | {
      readonly kind: 'input';
      /** The address of the module whose input this field is. */
      readonly module: string;
      /** The key path inside that module's input; `[]` is the whole input. */
      readonly path: readonly string[];
    };
```

New export, directly after `ValueOrigin`:

```ts
/** The origin of a module input field. Internal to core. */
export type InputOrigin = Extract<ValueOrigin<unknown>, { readonly kind: 'input' }>;
```

The line `export type { VALUE, VALUE_ORIGIN, VALUE_TYPE };` becomes two lines:

```ts
export { VALUE, VALUE_ORIGIN };
export type { VALUE_TYPE };
```

`module-input.ts` (§ 3.2) needs the two symbols at runtime to answer the brand in a Proxy. The public barrel still does not re-export them (§ 4.6), so nothing outside core can build a value by name.

Doc comment changes, verbatim:

- `Value<T>`: `An opaque stand-in a module body can pass wherever a \`T\` is accepted; its real value is known by the end of Load (ADR-0062). \`environment.name\` is one; each field of a module's \`input\` is one; \`resolve()\` returns one computed from others.`
- `PlainData`: `Plain data: what a \`resolve()\` function may return.`

`value.ts` still imports only `blindCast`.

### 3.2 New file `packages/0-framework/1-core/core/src/module-input.ts`

It imports `StandardSchemaV1` (type) from `@standard-schema/spec`, `blindCast` from `@internal/foundation/casts`, `LoadError` and `NodeId` from `./graph-types.ts`, and `VALUE`, `VALUE_ORIGIN`, `InputOrigin` and `Value` from `./value.ts`. The types are the spike's, renamed (§ 12, decision 3).

```ts
type PlainObject = { readonly [key: string]: unknown };

/**
 * What a module body holds for an input field whose real value has type `T`:
 * a value, plus one `InputField` per key when `T` is a plain object.
 */
export type InputField<T> = Value<T> & FieldsOf<T>;

type FieldsOf<T> = [NonNullable<T>] extends [never]
  ? unknown
  : [NonNullable<T>] extends [readonly unknown[]]
    ? unknown
    : [NonNullable<T>] extends [PlainObject]
      ? Fields<NonNullable<T>, undefined extends T ? undefined : never>
      : unknown;

// `Absent` carries a parent's optionality down: if `a` may be absent, so may `a.b`.
type Fields<O, Absent> = {
  readonly [K in keyof O & string]-?: InputField<FieldType<O, K> | Absent>;
};

// An optional key's real value may be undefined even under exactOptionalPropertyTypes.
type FieldType<O, K extends keyof O> = {} extends Pick<O, K> ? O[K] | undefined : O[K];

/** The `input` a module body receives for its input schema `S`: one value per field, typed from the schema's output (ADR-0061). */
export type ModuleInput<S extends StandardSchemaV1> = InputField<StandardSchemaV1.InferOutput<S>>;
```

The two comments above are the spike's and stay: each says something the code cannot.

```ts
/** `input` or `input.a.b`: how an error names an input field. */
export function inputFieldLabel(origin: InputOrigin): string;
```

Returns `'input'` when `origin.path.length === 0`, else `` `input.${origin.path.join('.')}` ``.

```ts
/**
 * Builds the `input` a module body receives. Every property access returns a
 * value recording its key path, and the same path always returns the same
 * object, so Load's identity-keyed maps see one value per field. Any way of
 * reading the real value throws a LoadError naming the field.
 */
export function buildModuleInput(moduleAddress: NodeId): ModuleInput<StandardSchemaV1>;
```

The implementation is the spike's `inputValues()` ([`input-value.ts`](../s1-spike/probe/input-value.ts), lines 79 to 154), with these changes and nothing else:

- It throws `LoadError` where the spike throws `InputValueMisuse`. There is no `InputValueMisuse` class.
- The origin is typed `InputOrigin` and built as `Object.freeze({ kind: 'input' as const, module: moduleAddress, path: Object.freeze([...path]) })`.
- The `get` trap answers `VALUE` (imported) with `true` and `VALUE_ORIGIN` (imported) with the origin; the `has` trap answers `true` for both.
- The inspect key is `Symbol.for('nodejs.util.inspect.custom')`, defined as a module-level `const INSPECT`, as `foundation/secret.ts` does.
- The return is `blindCast<ModuleInput<StandardSchemaV1>, 'the proxy answers the value brand and origin, and returns a further proxy for every string key, which is the shape ModuleInput describes'>(valueAt([]))`.

The misuse message, built by one function `misuse(origin, what)`, verbatim:

```
<field> of module "<module>" is a value, not its real value, and <what>. A module body can only pass an input field on: into a provision() binding or as a resolve() dependency. To compute with it, list it: resolve([<field>], ([v]) => …).
```

`<field>` is `inputFieldLabel(origin)`. `<what>` per trap, verbatim:

| Trap or key | `<what>` |
| --- | --- |
| `Symbol.toPrimitive`, hint `string` | `it was turned into text (a template literal or String())` |
| `Symbol.toPrimitive`, hint `number` | `it was turned into a number (arithmetic, or a comparison such as <)` |
| `Symbol.toPrimitive`, hint `default` | `it was combined with + or compared with ==` |
| `get` of `toString` (called) | `its toString() was called` |
| `get` of `valueOf` (called) | `its valueOf() was called` |
| `get` of `toJSON` (called) | `it was serialized with JSON.stringify` |
| `get` of `Symbol.iterator` or `Symbol.asyncIterator` (called) | `it was iterated (array spread, for…of or array destructuring)` |
| `has` of a string key | `it was checked with the in operator ("<key>" in …)` |
| `ownKeys` | `its keys were listed (Object.keys, object spread, for…in or Object.entries)` |
| `getOwnPropertyDescriptor` | `its properties were inspected` |
| `set`, `defineProperty` | `its field "<key>" was assigned to` |
| `deleteProperty` | `a property was deleted from it` |
| `setPrototypeOf` | `its prototype was changed` |
| `preventExtensions` | `it was frozen or sealed` |

Any other symbol key reads `undefined`, so `isSecretSource`, `isParamSource`, `isNode` and `isSecretString` return `false` for an input field. Any other string key, `then` included, returns the field one level down; that field is an object, not a function, so `await` and `Promise.resolve` treat an input field as a plain object.

## 4. Core: the module node, `module()` and `provision()`

All in `node.ts` unless stated.

### 4.1 `InputBinding` (the spike's finding d)

New exported type, directly before `InputBinding`:

```ts
/** What a value in a service's input binding may stand for: plain data, a `SecretString` at any depth (a forwarded secret field), and `undefined` (an optional field the binding left out). */
export type InputBindingData =
  | string
  | number
  | boolean
  | null
  | undefined
  | SecretString
  | readonly InputBindingData[]
  | { readonly [key: string]: InputBindingData };
```

`InputBinding`'s value member changes from `Value<PlainData>` to `Value<InputBindingData>`. Nothing else in `InputBinding` changes. `node.ts` gains `import type { SecretString } from '@internal/foundation/secret';`.

This lets a module body bind `input.deliveryCredential` (`Value<SecretString>`), `input.replyTo` (`Value<string | undefined>`) and a nested object holding a secret into a service's input. `Value<Date>` and `Value<SecretSource>` are still refused. Checked on 2026-10-29 with a probe compiled under `tsconfig.base.json` with TypeScript 6.0.3 (`wip/s2-type-probe/`, not committed; its checks are carried into § 10.2's type tests). The probe covered §§ 4.1 to 4.5 in isolation, not against `node.ts`'s full overload set.

`ParamBindings<P>` and `ResourcePropsMember` are unchanged: they keep `Value<PlainData>`. An optional input field is not accepted as a service param or a resource prop at the type level.

### 4.2 `ModuleInputBinding<T>`

New exported type, directly after `InputBinding`:

```ts
/**
 * What `provision(module, { input })` accepts where the module's input schema
 * expects `T` (its Standard Schema input type): the data, a value standing for
 * it, or, for a `SecretString` field, a secret source. An optional key also
 * takes a value that may stand for `undefined`.
 */
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
                | ({} extends Pick<T, K> ? Value<T[K] | undefined> : never);
            }
          : T);

/** A module input schema's Standard Schema input type. */
type ModuleInputOf<I extends StandardSchemaV1 | undefined> = StandardSchemaV1.InferInput<NonNullable<I>>;
```

This is the spike's `Bindable<T>` with one change: a `SecretString` field does not take a literal `SecretString`. A secret's value never sits in the code, and Load refuses one at runtime too (§ 5.4). Note that ArkType's `secretString()` has the input type `unknown`, so for an ArkType schema the compiler accepts anything in a secret field and only validation checks it. A schema whose input type is `SecretString` (Zod's `z.custom<SecretString>(isSecretString)`) is checked by the compiler too.

### 4.3 `ModuleNode` and `ModuleContext`

`ModuleNode` gains a fifth type parameter and a field:

```ts
export interface ModuleNode<
  D extends Deps = Deps,
  E extends Expose = Expose,
  S extends Secrets = Secrets,
  PN extends ParamNeeds = ParamNeeds,
  I extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  // … existing members, in their order, then after paramSlots:
  /** The module's whole incoming configuration as one Standard Schema (authored as `input`, ADR-0061), or `undefined` when it takes none. Load only calls its `~standard.validate`. */
  readonly inputSchema: I;
  // … expose, body
  body(ctx: ModuleContext<D, S, PN, I>): ModuleOutputs<E> | void;
}
```

`ModuleContext` gains a fourth type parameter and a member, after `params` and before `environment`:

```ts
export interface ModuleContext<
  D extends Deps,
  S extends Secrets = Secrets,
  PN extends ParamNeeds = ParamNeeds,
  I extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  // …
  /** The module's input: one value per field, typed from its input schema's output (ADR-0061); `undefined` when it declares none. Pass a field into a provision() binding or list it as a resolve() dependency. */
  readonly input: I extends StandardSchemaV1 ? ModuleInput<I> : undefined;
  // …
}
```

The conditional is distributive on purpose. With the wide default `StandardSchemaV1 | undefined`, `input` is `ModuleInput<StandardSchemaV1> | undefined`, and that is what lets `ModuleNode<D, E, S, PN, typeof schema>` assign to the wide `ModuleNode`. The non-distributive form `[I] extends [StandardSchemaV1]` was probed and fails that assignment.

`node.ts` imports `type ModuleInput` from `./module-input.ts`.

### 4.4 `module()`

The closed-root overload's context becomes `ModuleContext<Record<never, never>, Record<never, never>, Record<never, never>, undefined>` and its return `ModuleNode<Record<never, never>, Record<never, never>, Record<never, never>, Record<never, never>, undefined>`.

The boundary overload:

```ts
export function module<
  D extends Deps = Record<never, never>,
  E extends Expose = Record<never, never>,
  S extends Secrets = Record<never, never>,
  PN extends ParamNeeds = Record<never, never>,
  I extends StandardSchemaV1 | undefined = undefined,
>(
  name: string,
  boundary: { deps?: D; secrets?: S; params?: PN; input?: I; expose?: E },
  body: (ctx: ModuleContext<D, S, PN, I>) => ModuleOutputs<E> | void,
): ModuleNode<D, E, S, PN, I>;
```

The implementation signature's boundary type gains `input?: StandardSchemaV1`. After the `requireNotReservedPortNames` calls:

```ts
if (boundary.input !== undefined && typeof boundary.input['~standard']?.validate !== 'function') {
  throw new Error(
    'module() `input` must be a Standard Schema (an object with a "~standard".validate ' +
      'function) — see https://standardschema.dev (ADR-0061).',
  );
}
```

The node gains `inputSchema: boundary.input` between `paramSlots` and `expose`. The schema is stored by reference, as `service()` stores it.

A module may declare `input` beside `secrets` and `params`. The old slots keep working in this slice.

### 4.5 `provision()` of a module

`ModuleProvisionArgs` is replaced by:

```ts
/**
 * A child-MODULE provision's trailing options: `deps`, `secrets` and `input`
 * each required exactly when the module declares them; a declared
 * param-forwarding slot may be bound to a `ParamSource`.
 */
type ModuleProvisionOptions<
  D extends Deps,
  S extends Secrets,
  I extends StandardSchemaV1 | undefined,
  PB,
> = { id?: string; params?: PB } & ([keyof D] extends [never] ? unknown : { deps: DepBindings<D> }) &
  ([keyof S] extends [never] ? unknown : { secrets: SecretBindings<S> }) &
  ([I] extends [StandardSchemaV1] ? { input: ModuleInputBinding<ModuleInputOf<I>> } : unknown);

/** The options are optional exactly when nothing is required. */
type ModuleProvisionArgs<
  D extends Deps,
  S extends Secrets,
  I extends StandardSchemaV1 | undefined,
  PB,
> = [keyof D] extends [never]
  ? [keyof S] extends [never]
    ? [I] extends [StandardSchemaV1]
      ? [opts: ModuleProvisionOptions<D, S, I, PB>]
      : [opts?: ModuleProvisionOptions<D, S, I, PB>]
    : [opts: ModuleProvisionOptions<D, S, I, PB>]
  : [opts: ModuleProvisionOptions<D, S, I, PB>];
```

The two module overloads of `ModuleBuilder['provision']` become:

```ts
  /** Registers an owned child module; its id defaults to the node's `name`; `deps`, `secrets` and `input` are required iff it declares them; a declared param-forwarding slot may be bound to a `ParamSource`. */
  provision<
    D extends Deps,
    E extends Expose,
    S extends Secrets,
    PN extends ParamNeeds,
    I extends StandardSchemaV1 | undefined,
  >(
    child: ModuleNode<D, E, S, PN, I>,
    ...args: ModuleProvisionArgs<D, S, I, ParamNeedBindings<PN>>
  ): ProvisionedRef<E>;
  /** The child-module call with `deps` spelled out — the same generic-wrapper escape as the service overload above. */
  provision<
    D extends Deps,
    E extends Expose,
    S extends Secrets,
    PN extends ParamNeeds,
    I extends StandardSchemaV1 | undefined,
  >(
    child: ModuleNode<D, E, S, PN, I>,
    opts: {
      id?: string;
      deps: DepBindings<D>;
      secrets?: SecretBindings<S>;
      params?: ParamNeedBindings<PN>;
      input?: ModuleInputBinding<ModuleInputOf<I>>;
    },
  ): ProvisionedRef<E>;
```

The first overload was probed with the existing secret slot, the new input, and both together (§ 10.2). The existing type tests in `module-composition.test-d.ts`, `module-wiring.test-d.ts`, `params.test-d.ts` and `value.test-d.ts` must pass unchanged, except the one title change in § 10.2. If one fails, stop and report.

### 4.6 Exports

`exports/index.ts` adds, in its alphabetical groups:

- from `../module-input.ts`, types: `InputField`, `ModuleInput`;
- from `../node.ts`, types: `InputBindingData`, `ModuleInputBinding`.

Not exported: `buildModuleInput`, `inputFieldLabel`, `InputOrigin`, `ModuleInputOf`, `ProvisionedModuleInput` (§ 5.2), `VALUE`, `VALUE_ORIGIN`. `@prisma/composer` re-exports `@internal/core` wholesale, so nothing changes in `packages/9-public/composer`.

### 4.7 Dependencies

`packages/0-framework/1-core/core/package.json` gains `"arktype": "^2.2.3"` in `devDependencies`, the range `@internal/foundation` uses. Only tests import it (§ 10.1, tests 9 and 10, where an ArkType morph is the thing under test). Run `pnpm install` so the lockfile records it.

## 5. Core: Load

All in `load-module.ts` unless stated.

### 5.1 The first pass

**`flatten`** gains a parameter `moduleInputs: ProvisionedModuleInput[]` directly after `paramBindings`. Every recursive call and the call in `loadModule` pass it. `loadModule` creates `const moduleInputs: ProvisionedModuleInput[] = [];` beside `paramBindings`.

**The context.** `ctx` gains `input: moduleNode.inputSchema === undefined ? undefined : buildModuleInput(selfId)`, between `params` and `environment`. A module node from another installed copy of core may have no `inputSchema`; `undefined` covers it. The `blindCast` reason on `ctx` becomes, verbatim: `ctxInputs/ctxSecrets/ctxParams hold one resolved ref per moduleNode.deps/secrets/paramSlots key (the same shapes a producer port, an envSecret source, and an envParam source carry), input is buildModuleInput(selfId) exactly when the node declares an input schema, and provision is exactly ModuleBuilder['provision'] — together they satisfy ModuleContext<D, S, PN, I> structurally for whatever D/S/PN/I this moduleNode declares`.

**A module child's input binding.** In the `provision` closure's module branch, the existing block

```ts
if (provisionInput !== undefined) {
  throw new LoadError(`provision("${id}") received an input binding for a module — …`);
}
```

is replaced by:

```ts
const childInputSchema: StandardSchemaV1 | undefined = child.inputSchema;
if (childInputSchema === undefined && provisionInput !== undefined) {
  throw new LoadError(
    `provision("${id}") received an input binding, but the module declares no input schema ` +
      `(module "${moduleNode.name}").`,
  );
}
if (childInputSchema !== undefined && provisionInput === undefined) {
  throw new LoadError(
    `Input of provisioned module "${id}" is not bound (module "${moduleNode.name}") — the ` +
      'module declares an input schema; bind it with `input: { … }` on its provision() call.',
  );
}
if (childInputSchema !== undefined) {
  const leaves: unknown[] = [];
  deepValues(provisionInput, leaves);
  markSecretsUsed(leaves);
  markParamsUsed(leaves);
  moduleInputs.push({ moduleAddress: fullAddress, schema: childInputSchema, binding: provisionInput });
}
```

The texts mirror the service branch's two messages. The binding is recorded before `flatten` recurses into the child, so `moduleInputs` lists a parent before its children. A forwarded `ctx.secrets` ref inside a module's input binding counts as used, as it does inside a service's.

**`deepValues`** stops at a value. Its line `if (isSecretSource(value) || isParamSource(value)) return;` becomes `if (isValue(value) || isSecretSource(value) || isParamSource(value)) return;`. Today it lists an input field's keys and the Proxy throws. Its doc comment's second sentence becomes: `A value or a secret/param source is an opaque leaf: it is pushed (a forwarded ref IS such a source, so identity-matching still needs it) but never descended into, so a ref buried in an unrelated source's payload is not falsely seen as used.`

**A value returned as an exposed interface.** In `flatten`'s expose loop, directly after the `port === undefined` check and before `satisfiesRequired`:

```ts
if (isValue(port)) {
  throw new LoadError(
    `Module "${moduleNode.name}" returned a value for expose "${key}". A value can configure a ` +
      'node, never decide its edges: return a port of a node the body provisions.',
  );
}
```

Without it, `satisfiesRequired` reaches the Proxy's `has` trap and the author gets an error about the `in` operator.

**The root.** `loadModule`, after the root params check:

```ts
if (root.inputSchema !== undefined) {
  throw new LoadError(
    `Module "${root.name}" declares input but is being deployed as the root. Composer cannot ` +
      `fill a root's input yet; provision "${root.name}" from another module and bind its input there.`,
  );
}
```

S4 removes this check when the config adapters fill the root's input.

**The second pass call.** `resolveValues({ environment: opts?.environment, inputBindings, params: paramBindings, moduleInputs, resources })`.

### 5.2 The second pass: `resolve-values.ts`

New imports: `type StandardSchemaV1` from `@standard-schema/spec`; `isSecretString` and `SecretBox` from `@internal/foundation/secret`; `inputFieldLabel` from `./module-input.ts`.

New exported type:

```ts
/** A provisioned module's input binding, recorded at its provision() call. Load validates it in the second pass; the graph does not carry it. */
export interface ProvisionedModuleInput {
  /** The module's address. */
  readonly moduleAddress: NodeId;
  /** The module's input schema. */
  readonly schema: StandardSchemaV1;
  /** The binding the provision() call supplied, values in place. */
  readonly binding: unknown;
}
```

`ValueBindingSite.kind` becomes `'input' | 'moduleInput' | 'param' | 'props'`. Its doc comment becomes: `` `input` for a service input binding, `moduleInput` for a module's input binding, `param` for a service param, `props` for a resource's props. `` The `path` doc comment says `input`, `moduleInput` and `props`.

`describeSite` gains, verbatim:

- kind `moduleInput`, path `''`: `the input binding of module "shop.email"`
- kind `moduleInput`, path `from`: `input key "from" of module "shop.email"`

`resolveValues`'s input gains `readonly moduleInputs: readonly ProvisionedModuleInput[];` after `params`. Its output does not change.

The algorithm, with what is new marked:

1. **Collect** from service input bindings, params and resource props, as today. Module input bindings are not collected here.
2. **(new)** `const moduleInputByAddress = new Map(input.moduleInputs.map((entry) => [entry.moduleAddress, entry]));`, `const validatedInputs = new Map<NodeId, unknown>();`, `const validating = new Set<NodeId>();`.
3. **(new)** `resolveOne` gains a case:

   ```
   case 'input':
     entry = moduleInputByAddress.get(origin.module)
     if entry is undefined: throw the missing-module error (5.4)
     result = readPath(validatedInputOf(entry), origin.path)
   ```

   An input field's real value is not passed through `checkResult`: it is the schema's output, and `undefined` is a legitimate real value for an optional field.
4. **(new)** `validatedInputOf(entry)`:

   ```
   if validatedInputs.has(entry.moduleAddress): return it
   if validating.has(entry.moduleAddress): throw the cycle error (5.4)
   validating.add(entry.moduleAddress)
   site = { address: entry.moduleAddress, kind: 'moduleInput', path: '' }
   values = []; collect(entry.binding, site, values, new WeakSet())
   for each { value, site } of values: resolveOne(value, site)
   resolved = substitute(entry.binding, results, new WeakSet())
   validated = validateModuleInput(entry, resolved)
   validating.delete(entry.moduleAddress)
   validatedInputs.set(entry.moduleAddress, validated)
   return validated
   ```

   It is a `const` arrow declared after `resolveOne`. The two call each other; both are defined before either runs.
5. **(new)** `for (const entry of input.moduleInputs) validatedInputOf(entry);` runs before step 6. So every module's binding is validated, used or not, parents first, and a module's errors come before a service's.
6. `for (const { value, site } of found) resolveOne(value, site);` as today. The early return when `found.length === 0` stays where it is, after step 6.
7. **Substitute**, as today, with the two changes in § 5.3.

`readPath`, a module-private function:

```ts
/** The data at `path` inside a validated input; `undefined` where a key is absent or the data there is not a plain object. */
function readPath(data: unknown, path: readonly string[]): unknown {
  let current = data;
  for (const key of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}
```

`validateModuleInput(entry: ProvisionedModuleInput, resolved: unknown): unknown`, module-private. It is the spike's `validateModuleInput` ([`probe-load.ts`](../s1-spike/probe/probe-load.ts), lines 181 to 239), with these rules:

- `const SENTINEL_SOURCE = Symbol('prisma:module-input-sentinel');` at module level, not `Symbol.for`: a sentinel is made and consumed inside one call.
- **Before validation**, walk `resolved` with its path (`joinPath`), rebuilding arrays and plain objects:
  - a `SecretSource` becomes `new SecretBox('')` with `Object.defineProperty(sentinel, SENTINEL_SOURCE, { value: source })`. The tag is an own property because an ArkType schema with a morph copies its input, and the copy is a different object: an identity map from sentinel to source would miss it (the spike's finding c). A non-enumerable own symbol property survives the copy.
  - a `ParamSource` throws the param-source error (5.4);
  - a value for which `isSecretString` is true throws the literal-secret error (5.4);
  - anything else is kept as it is.
- **Validate** with `entry.schema['~standard'].validate(withSentinels)`. A result that is `instanceof Promise` throws the async error; a result with `issues` throws the issues error, the messages joined with `'; '` as the Prisma Cloud serializer joins them.
- **After validation**, walk `result.value`, rebuilding arrays and plain objects. A value for which `isSecretString` is true is read with `blindCast<Record<PropertyKey, unknown>, 'reading the sentinel tag a module input validation put on its own SecretString box'>(box)[SENTINEL_SOURCE]`. If that is a `SecretSource`, it replaces the box. If not, the schema made the box itself, and the walk throws the minted-secret error. Anything else is kept by reference.
- The validated input is neither copied nor frozen; two consumers of the same field get the same object.

`checkResult` change: `isThenable`'s first line is `if (isValue(value)) return false;`. Today `checkResult` asks `'then' in result` first, and for a `resolve()` function that returns an input field the Proxy's `has` trap throws the wrong error. With the change, the walk reports `returned a value`, as for any other value.

### 5.3 Substitution

In `substitute`'s plain-object branch, a member that is a value whose real value is `undefined` is left out of the rebuilt object:

```ts
for (const [key, member] of Object.entries(value)) {
  const real = substitute(member, results, inProgress);
  if (real === undefined && isValue(member)) {
    changed = true;
    continue;
  }
  rebuilt[key] = real;
  if (real !== member) changed = true;
}
```

An authored `undefined` member is kept, as today. An array member whose real value is `undefined` is kept as `undefined`; the Prisma Cloud serializer already refuses it with its own message. A binding whose root is an input field with no real value becomes `undefined`, and the service's schema decides, as it does for an unset `envParam()`.

In `resolveValues`'s return, a service param binding that was a value and whose real value is `undefined` is dropped from `params`, so the param falls back to its `default` as an unbound param does:

```ts
params: input.params.flatMap((entry) => {
  const binding = substitute(entry.binding, results, inProgress);
  if (binding === undefined && isValue(entry.binding)) return [];
  return [binding === entry.binding ? entry : { ...entry, binding }];
}),
```

(The type refuses `Value<string | undefined>` as a param, § 4.1; this path is reached by a value whose type the compiler could not see, such as a field of a schema whose output is `unknown`.)

### 5.4 Errors, verbatim

Every error is a `LoadError` (code `COMPOSE.GRAPH_INVALID`), except the `module()` construction error, which is a plain `Error` like every factory's. `<site>` is `describeSite(site)`. `<field>` is `inputFieldLabel(origin)`. `<at path>` is empty at the root and ` at "smtp.key"` inside.

| Condition | Message |
| --- | --- |
| Reading an input field in the body | the misuse message in § 3.2 |
| `module()` given an `input` that is not a Standard Schema | ``module() `input` must be a Standard Schema (an object with a "~standard".validate function) — see https://standardschema.dev (ADR-0061).`` |
| A root declares `input` | `Module "shop" declares input but is being deployed as the root. Composer cannot fill a root's input yet; provision "shop" from another module and bind its input there.` |
| A module declares `input`; its `provision()` has none | ``Input of provisioned module "email" is not bound (module "shop") — the module declares an input schema; bind it with `input: { … }` on its provision() call.`` |
| A module declares no `input`; its `provision()` has one | `provision("email") received an input binding, but the module declares no input schema (module "shop").` |
| A value returned for an `expose` key | `Module "email" returned a value for expose "send". A value can configure a node, never decide its edges: return a port of a node the body provisions.` |
| A param source in a module's input binding | `<site> is bound to a param source, such as envParam(). A module's input does not take a param source yet; bind it on the service's input inside the module, or forward it through the module's params slot.` with `<site>` of kind `moduleInput` at the source's path |
| A `SecretString` in a module's input binding | `<site> is bound to a SecretString. A secret's value never appears in the code; bind envSecret('NAME'), or pass on an input field typed secretString().` |
| The module's schema reports issues | `The input binding of module "shop.email" does not match the module's input schema: <messages joined with "; ">` |
| The module's schema validates asynchronously | `The input schema of module "shop.email" returned a Promise from validate(). A module's input is validated synchronously at Load; use a schema with no asynchronous checks.` |
| The schema's output holds a `SecretString` it made itself | `The input schema of module "shop.email" produced a SecretString<at path> that its binding did not supply. A module's schema may check a secret field, never create one.` |
| An input field of a module this Load does not provision | `<site> depends on <field> of module "shop.gone", which this Load does not provision. An input field can be passed on only inside the body of the module that received it.` |
| A module's binding depends on its own input | `The input binding of module "shop.email" depends on that module's own input. Remove the cycle.` |

The last two are reachable only through a value leaked out of a module body or forged, for example an input field kept from an earlier Load of the same root. The checks turn a wrong answer or a stack overflow into a named error.

Existing checks that now also cover an input field, with their existing messages: a value as `provision()`'s `id`; a value in a `deps` entry (service, module or resource); a value in a module's `secrets` or `params` binding.

## 6. Where an input field is accepted

- **A service's `input` binding**, at any depth, including the root (`provision(svc, { input })`). Typed by `InputBinding` (§ 4.1).
- **A module's `input` binding**, at any depth, including the root (`provision(child, { input })`). Typed by `ModuleInputBinding` (§ 4.2).
- **A `resolve()` dependency.** `fn` receives the real value. For a field bound to `envSecret()`, that is the `SecretSource`; returning it fails with the existing `returned a secret or param source` message. S3 relaxes this.
- **A service param** and **a resource prop**, when its real-value type is `PlainData` (not optional, no secret), through the existing `Value<PlainData>` members.

Nowhere else: not as a `provision()` id or a node's `name`, not in `deps`, not in a module's `secrets` or `params` binding, not as an `expose` return. Each is refused by § 5.4 or an existing check.

## 7. The Prisma Cloud target: one serializer fix

Load hands the target the same `Graph` as before: service input bindings with every value replaced by its real value. A secret forwarded through a module's input arrives as the original `envSecret()` source, so the serializer and preflight treat it exactly as a directly bound one. § 10.3 proves it with one test.

The serializer's ArkType morph problem (the spike's finding c) is fixed here, in its own commit, because module input makes such schemas more likely and the fix is the same tagging § 5.2 uses. In `packages/1-prisma-cloud/1-extensions/target/src/serializer.ts`, each secret sentinel `SecretBox` the deploy walk creates carries a symbol-keyed property naming its pointer (`Symbol.for('prisma:secret-sentinel')`, value the platform variable's name). The substitution that maps validated output back to pointers reads that property instead of matching the box by identity. A box in the validated output without the property is still refused with the existing "validated to a SecretString the binding did not supply" error.

## 8. Documentation

All in the same pull request. The repo rule `.agents/rules/user-facing-surface-changes.mdc` requires the guides and the skill to change with a user-facing export, so this slice updates them too (§ 13, conflict 1).

- **ADR-0061**, an amendment note directly under the title, verbatim:

  > Amended 2026-10-29 (module-input project, second slice): each input field the body receives is a **value**, `Value<T>` typed from the schema's output, the same kind of value as `environment.name` and a `resolve()` result ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). Three statements below are corrected. First, the body cannot be stopped from reading or branching on a value in every case: turning one into text or a number, serializing it, listing its keys or iterating it fails with an error naming the field, and `===` or `switch` against a literal fails to compile, but a truthiness check sees an object and always passes. The structure rule holds, because such a branch always goes the same way. Second, a module's binding is validated during Load's second pass, synchronously, not after it, because a child's real value is read from its parent's validated output; an async schema fails the Load. A real value is the schema's output, so a field typed `number` by a parsing schema receives `4`, not `'4'`. Third, a body reaches only the keys every member of a union schema has, and an array field has no element access: to narrow, forward the whole `input` or narrow inside a `resolve()` function. An input field the body never uses is not an error, because Load cannot list a schema's keys.

  The index line in `docs/design/90-decisions/README.md` gains `*(Amended 2026-10-29: an input field is a \`Value\`; the module's schema validates its binding during Load's second pass; a truthiness check on a field is not caught, but always goes the same way.)*`.
- **ADR-0016**: its existing "Amended by ADR-0061" paragraph gains a third sentence, verbatim: `Load validates a module's input binding with its schema; a declared input field the body never uses is not an error, unlike an unused dependency, because Load cannot list a schema's keys.`
- **Glossary**, `docs/design/03-domain-model/glossary.md`:
  - `### Module` gains a bullet after "Nesting": `- **Input.** A Module declares its configuration as one \`input\` Standard Schema, as a Service does, and whoever provisions it binds it. Its body receives one [value](#value) per input field and can only pass it on: into a \`provision()\` binding or as a \`resolve()\` dependency.`
  - `### Value`, the "Provided or computed" bullet's first sentence becomes: `A provided value is handed to the module body: \`environment.name\` is one, a deploy-time fact of the environment, and each field of a module's \`input\` is another, whose real value is read from the module's input after its schema has validated it.` The bullet "Deploy-time or runtime" ends with: `A module input field bound to \`envSecret()\` is deploy-time: its real value is the pointer, never the secret.`
  - `### Load / Hydrate`: "with nothing executed but module bodies and `resolve()` functions" becomes "with nothing executed but module bodies, `resolve()` functions and module input schemas".
- **`docs/design/10-domains/module-composition.md`**:
  - The header note keeps its first sentence and replaces "This settles the "Module-level params" extension point listed below." with `A module's input fields are values (Value<T>), and its binding is validated during Load's second pass; see § Input.`
  - "The authoring surface": the signature becomes `module<D extends Deps, E extends Expose, I extends StandardSchemaV1 | undefined>(name, boundary: { deps?: D; input?: I; expose?: E }, body: (ctx: ModuleContext<D, I>) => ModuleOutputs<E>)`, and `ModuleContext` lists `input` with the § 4.3 doc comment. (The doc's signatures already omit the `secrets` and `params` slots; keep omitting them.)
  - A new section `## Input`, after "## Forwarding", in this order: the § 1 example; the § 2 model bullets, reworded as prose; the four places an input field is accepted (§ 6); how Load validates (parents first, once each, synchronously, the schema's output is the real value, an optional field left out is a key left out); what is not supported yet (a root's `input` until the config adapters; a param source in a module's binding until `envParam()` becomes a value); and that an unused input field is not detected.
  - "`provision()` accepts modules": the overload gains `input`, required when the module declares an input schema.
  - "Load: flattening, addresses, validation": the boundary-validation list gains a fifth item, `a module's input binding the module's schema refuses — validated in the second pass, after every module body has run`.
  - "Extension points": the "Module-level params" bullet is removed.
- **`docs/design/10-domains/core-model.md`**, the second-pass paragraph ("Load then runs a second pass over values…") gains, after its third sentence: `An input field of a module takes its real value from that module's input binding, resolved and then validated by the module's schema; every module's binding is validated once, parents first, before any service binding is resolved.` The `module` factory line becomes `function module(name: string, boundary: { deps?, input?, expose? }, body: (ctx: ModuleContext) => ModuleOutputs): ModuleNode   // body runs at Load, not here`.
- **`docs/guides/building-an-app.md`**:
  - `## Reusable Modules`: after the paragraph ending "…([below](#service-input))." and before "The root then treats it like any other node", a new subsection `### A module's input`. It shows the § 1 example and says, one sentence each: a module declares its configuration as one `input` schema, as a service does; whoever provisions it binds `input`; the body receives each field as a value and can pass it into a `provision()` binding or list it in `resolve()`; reading a field (a template literal, `String()`, arithmetic, `JSON.stringify`, `Object.keys`) fails the deploy with a message naming the field; an optional field the binding leaves out is a key left out; the module's schema checks the binding when the deploy loads the graph, so a mistake fails before anything reaches the platform; a root cannot declare `input` yet, and a module's `input` does not take `envParam()` yet (bind it on the service, or use the module's `params` slot); a body reaches only the keys every member of a union schema has, and has no element access into an array field.
  - The `provision(node, opts?)` list's `input` item becomes: `` `input` — the service's or module's input binding; required exactly when the node declares an input schema. ``
  - `## Values that differ per environment`: the sentence "A value cannot be a provision id or a `deps` entry, and a module's `secrets` and `params` bindings take sources, not values." gains, before it: `A field of a module's \`input\` is a value too ([A module's input](#a-modules-input)).`
- **`skills/prisma-composer-core-concepts/SKILL.md`**: under "### Values that differ per environment", a new first bullet: `- A module declares \`input\` (one Standard Schema) as a service does; \`provision(module, { input })\` binds it, and the body receives each field as a value it can pass into a binding or list in \`resolve()\`. A root cannot declare \`input\` yet, and a module's \`input\` takes no \`envParam()\` yet.` Rule 5 of "Rules that bite" ends with: `A module can instead declare \`input\` with a \`secretString()\` field and pass that field on.` Written to the rules in `skills/README.md`.

## 9. Scope

In: everything above, in `packages/0-framework/1-core/core`, the serializer fix and two tests in `packages/1-prisma-cloud/1-extensions/target`, `docs/`, `skills/`.

Out: a root's `input` and the config adapters (S4); `envParam()` and `envSecret()` as values, a pointer that throws when used as text, and `resolve()` returning a pointer (S3); removing `params`, `paramNeed()`, `secrets` and the module form of `secret()`, and migrating `auth()`, `email()` and the examples (S5); the serializer's morph problem (§ 7); widening `ParamBindings` or `ResourcePropsMember` to optional or secret values; carrying validated module inputs on the `Graph`.

## 10. Tests

Runtime tests use `bun test` in `packages/0-framework/1-core/core/src/__tests__/`. Type tests use vitest `expectTypeOf` and `@ts-expect-error`. Fixtures follow `resolve-values.test.ts`: `echoService()` (an `anyInputSchema` service with a `label` string param), the `build` constant, `staging`, `loadError()`. Two more fixtures in the new file:

- `const recording = (seen: unknown[]): StandardSchemaV1 => ({ '~standard': { version: 1, vendor: 'test', validate: (value) => { seen.push(value); return { value }; } } })` — a schema that records what it validated and passes it through.
- `const refusing = (message: string): StandardSchemaV1 => ({ '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [{ message }] }) } })`.

A forged input field: `{ [Symbol.for('prisma:value')]: true, [Symbol.for('prisma:value-origin')]: { kind: 'input', module: 'shop.gone', path: ['from'] } }`.

### 10.1 New file `module-input.test.ts`

**The body's `input`**

1. `a module body receives one value per input field, and the same path gives the same value` — inside the body, `isValue(input.from)`, `isValue(input)` and `input.smtp.host === input.smtp.host` are all true.
2. `a module that declares no input receives undefined`.
3. `turning an input field into text fails naming the field` — `` `noreply@${input.domain}` `` in a child body; the exact message for `input.domain of module "shop.email"` with `<what>` `it was turned into text (a template literal or String())`.
4. `each way of reading an input field fails naming the field and what was done` — one test over a table: `String(f)`, `` `${f}` ``, `f * 2`, `f + 1`, `f.toString()`, `f.valueOf()`, `JSON.stringify(f)`, `Object.keys(f)`, `({ ...f })`, `for (const k in f)`, `[...f]`, `'x' in f`, `f.x = 1`, `delete f.x`, `Object.freeze(f)`, `Object.setPrototypeOf(f, null)`. Each throws a `LoadError` whose message contains the `<what>` from § 3.2's table.
5. `a truthiness check on an input field always takes the branch` — `if (input.enabled) provision(extra)` with the binding `{ enabled: false }`; the graph contains `shop.child.extra`. (It documents why the structure rule still holds.)

**Forwarding and the second pass**

6. `a field forwarded into a service's input reaches it as the bound literal` — `graph.inputBindings[0].binding` equals `{ from: 'shop@example.com' }`.
7. `the whole input forwarded into a service reaches it as the module's validated input` — `provision(echoService(), { input })`.
8. `a field forwarded through two modules reaches the service` — root → `relay` → `email` → service.
9. `a secret source forwarded through two module schemas with an ArkType morph reaches the service by identity` — both modules' schemas are ArkType `type({ key: secretString(), n: 'string.integer.parse' })`, `secretString` from `@internal/foundation/arktype`; the root binds `key: secretSource({ name: 'EMAIL_KEY' })`; the service binding's `key` is `toBe` that source.
10. `a real value is the schema's output` — `n: 'string.integer.parse'` bound to `'4'`; the service binding's `n` is `4`.
11. `an optional field the binding leaves out is a key left out of the service binding` — `'replyTo' in binding` is false.
12. `environment.name and a resolve() result in a module's binding are resolved before the module's schema runs` — a `recording` schema sees `{ label: 'hi staging' }`.
13. `resolve() over input fields receives their real values` — `resolve([input.host, environment.name], ([host, name]) => \`${name}.${host}\`)`; the service binding holds `'staging.shop.com'`.
14. `resolve() over a secret field receives the secret source` — `fn` stores its argument; it is `toBe` the bound source.
15. `a resolve() function that returns an input field fails as returning a value` — the exact existing message, `The resolve() function for input key "host" of service "shop.child.echo" returned a value, not a real value. List that value as a dependency; fn receives its real value.`
16. `a module's schema runs once per Load, however many fields are read` — three fields forwarded; the `recording` schema's array has length 1.
17. `every provisioned module's binding is validated, even when the body uses no field` — a `refusing('nope')` schema and a body that provisions nothing; the issues message.
18. `a forwarded secrets slot inside a module's input binding counts as used` — a module declaring `secrets: { key: secret() }` and `input` forwards `secrets.key` into a child module's input; Load passes; the service receives the root's source.

**Errors** (exact messages from § 5.4)

19. `a binding the module's schema refuses fails naming the module` — `refusing('from is required')`.
20. `an async module schema fails the Load`.
21. `a plain string where an ArkType secretString() field is expected fails with the schema's message` — the message starts `The input binding of module "shop.email" does not match the module's input schema: `.
22. `a param source in a module's input binding fails naming the key` — `paramSource({ name: 'X' })` at `from`; `<site>` is `input key "from" of module "shop.email"`.
23. `a SecretString in a module's input binding fails naming the key` — `new SecretBox('x')` at `key`.
24. `a schema that produces a SecretString its binding did not supply fails` — a schema returning `{ key: new SecretBox('x') }`; ` at "key"`.
25. `a module that declares input but is provisioned without one fails` — the call is cast in the test, since the type refuses it.
26. `an input binding for a module that declares no input fails`.
27. `a root that declares input fails`.
28. `module() refuses an input that is not a Standard Schema`.
29. `an input field of a module this Load does not provision fails` — the forged field at `from` in a service binding; `<site>` is `input key "from" of service "shop.echo"`.
30. `a module's binding that holds its own input field is a cycle` — a forged field with `module: 'shop.email'` in `shop.email`'s own binding.
31. `an input field returned as an exposed interface fails`.
32. `an input field in a service's deps fails with the existing deps message` — an untyped slot, so the compiler lets it through.
33. `an input field bound to a module's secrets slot fails with the existing message`.

### 10.2 New file `module-input.test-d.ts`

Schemas are declared, not built: `declare const shopSchema: StandardSchemaV1<ShopIn, ShopOut>`, where `ShopOut` is `{ EMAIL_FROM: string; SITE_HOSTNAME?: string; smtp: { host: string; port: number; tls?: { ca: string } }; tags: string[]; signingKey: SecretString; count: number }` and `ShopIn` is the same with `count: string` and `signingKey: unknown`. A second, `emailSchema: StandardSchemaV1<{ from: string; key: SecretString; replyTo?: string }, …same>`, has a secret field whose input type is `SecretString`.

- Field types: `input.EMAIL_FROM` is `InputField<string>`; `input.SITE_HOSTNAME`'s real value is `string | undefined`; `input.smtp.tls.ca`'s is `string | undefined`; `input.tags` is `Value<string[]>` and `input.tags[0]` is an error; `input.signingKey`'s real value is `SecretString` and `input.signingKey.expose` is an error; `input.count`'s real value is `number`; `input` itself stands for `ShopOut`; `input.nope` is an error; assigning `input.EMAIL_FROM` is an error.
- A union schema `StandardSchemaV1<…, { on: false } | { on: true; key: SecretString }>`: `input.on`'s real value is `boolean`, `input.key` is an error.
- `ModuleContext` of a module declaring no input: `input` is `undefined`.
- `if (input.flag === true)` against a `boolean` field and `switch (input.kind) { case 'a': }` against a `'a' | 'b'` field are errors.
- `provision(email, { input: { from: input.EMAIL_FROM, key: input.signingKey } })` compiles; so does `key: secretSource(…)`; `key: new SecretBox('x')` is an error; `key: 'plain'` is an error.
- An optional value into an optional field compiles; into a required field is an error; a `number` field into a `string` field is an error.
- `provision(email)` and `provision(email, {})` are errors; `provision(plainModule, { input: {} })` is an error when `plainModule` declares no input.
- A module declaring `secrets` and `input` needs both: omitting `secrets` is an error.
- Forwarding the whole `input` into a child whose input type it satisfies compiles; into one it does not satisfy is an error.
- `InputBinding` accepts `{ k: Value<SecretString> }`, `{ k: Value<string | undefined> }` and `{ smtp: Value<{ host: string; key: SecretString }> }`.
- `ModuleNode<…, typeof emailSchema>` (from `module()`) is assignable to `ModuleNode`.
- `InputField<string>` is assignable to `Value<string>`.

`value.test-d.ts`: the test `a value standing for plain data is an input binding leaf; any other value is not` is renamed `a value standing for input data is an input binding leaf; a Date or a source is not`. Its body does not change.

### 10.3 Prisma Cloud target

34. In `packages/1-prisma-cloud/1-extensions/target/src/__tests__/input-serializer.test.ts`, a new `describe('a secret forwarded through a module input', …)` with `a secret forwarded through a module's input serializes to its $secret pointer`: `Load` (from `@internal/core`) a root that provisions an `email` module with ArkType input `type({ from: 'string', key: secretString() })`, bound `{ from: 'shop@example.com', key: envSecret('EMAIL_KEY') }`; the module provisions `svc(type({ from: 'string', key: secretString() }))` with `input: { from: input.from, key: input.key }`. `serializeInput(node, address, graph.inputBindings[0].binding, { env: {} })`, with `node` the graph node at that address; `JSON.parse(row.value)` equals `{ from: 'shop@example.com', key: { $secret: 'EMAIL_KEY' } }`.

35. In the same file, `describe('an ArkType schema with a morph', …)` with `a secret field survives an ArkType morph elsewhere in the schema`: a service with ArkType input `type({ key: secretString(), count: 'string.integer.parse' })`, bound `{ key: envSecret('KEY'), count: '4' }`; `serializeInput` succeeds and `JSON.parse(row.value)` equals `{ key: { $secret: 'KEY' }, count: 4 }`. It fails on main with the "validated to a SecretString the binding did not supply" error.

## 11. Done when

- Tests 1 to 34 and the § 10.2 type tests pass; `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm test` are green at the root.
- With `ENV_PARAM_GREETING=hi` set, a working-tree edit of `examples/env-param/module.ts` that moves `echoService` into a module `greeter` declaring `input: type({ environment: 'string' })`, whose body provisions `echoService` with `input: { greeting: envParam('ENV_PARAM_GREETING'), environment: input.environment }`, and which the root provisions with `input: { environment: label }`, serves `"environment":"deployed to dev"` from `curl "$(prisma dev url env-param-example.greeter.echo)"` under `prisma dev`. The same edit with `` `${input.environment}` `` in `greeter`'s body fails `prisma dev` with the § 3.2 message before anything starts. The edit is reverted with `git checkout examples/env-param/module.ts`. Recorded in `qa.md` in this slice's folder.
- Every document in § 8 is updated.

## 12. Decisions this spec records, for the review

1. **Validation runs during the second pass, synchronously** (§ 5.2). The spike's correction b: a child's real value is read from its parent's validated output. The plan said "after".
2. **A module's binding is validated even when no field is used** (§ 5.2, step 5). The decision says the binding is validated at deploy, as a service's is; skipping an unused module would let a wrong binding through silently.
3. **Names: `InputField<T>`, `ModuleInput<S>`, `ModuleInputBinding<T>`, `InputBindingData`, `buildModuleInput`.** The spike's `InputValue`/`InputValues` would sit beside the existing `InputValueOf<I>`, which means validated service input data, the real value. Two names one letter apart for the value and its real value would mislead. `Bindable` named nothing specific to modules.
4. **The misuse error is a `LoadError`** (§ 3.2). It is thrown from a module body during Load, and the error decision ([ADR-0044](../../../../../docs/design/90-decisions/ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md)) reports an unstructured error at the process boundary as a Composer bug.
5. **A literal `SecretString` is refused in a module binding**, by the type and at runtime (§ 4.2, § 5.4). The spike's `Bindable` accepted one. The Prisma Cloud serializer already refuses one in a service binding.
6. **A root that declares `input` is refused** (§ 5.1). Nothing can fill it until S4; accepting it and leaving the body's fields with no real value would fail later and less clearly.
7. **A param source in a module binding is refused** (§ 5.4). Core cannot read a param source: its payload belongs to the target, and `generatedParam()` and `serviceOrigin()` are param sources too. S3 makes `envParam()` a value with a real value, which lifts this for it. Until then the old `params` slot forwards one.
8. **An input field's real value skips `checkResult`** (§ 5.2, step 3). It is the schema's output, which may legitimately be `undefined`, a number, or a `SecretSource`.
9. **An optional value is dropped from an object and from `params`, kept in an array** (§ 5.3). Design note 5 settled "the key is omitted". An array position cannot be omitted; the serializer's existing error covers it.
10. **ArkType becomes a test dependency of core** (§ 4.7). Tests 9 and 10 test an ArkType morph's copy of its input; a hand-written schema would not reproduce it.

## 13. Conflicts

Where the code, the spike, the plan or a decision record disagree, and what this spec does.

1. **The plan lists the guides for S5 only**; the repo rule `user-facing-surface-changes.mdc` requires the guides and the skill to change in the same PR as a user-facing export. This spec updates them in S2 (§ 8).
2. **The module input decision binds `envParam()` into a module's input** (its first example). In S2, a module's binding refuses a param source (§ 12, decision 7). The example works after S3.
3. **The module input decision says "Load accepts `input` on a root"** (its consequences). In S2, Load refuses it (§ 12, decision 6). S4 does what the decision says.
4. **The plan says the binding is validated "after Load's second pass"**; the spike's correction b says during. This spec follows the spike (§ 12, decision 1). The decision record's amendment in § 8 says so.
5. **The spike's `Bindable<T>` takes a literal `SecretString`**; this spec does not (§ 12, decision 5).
6. **The spike's report says a child's binding "takes … a source for a secret"** at the type level. For ArkType's `secretString()`, whose input type is `unknown`, the compiler accepts anything in that field; only validation checks it (§ 4.2). This is the service input decision's rule ("secretness is enforced by validation"), but the spike's table reads as if the compiler checked it.
7. **Design note 4 says a `resolve()` listing a secret field receives a pointer that throws when used as text.** In S2 it receives the plain `SecretSource`, which does not throw (`${source}` gives `[object Object]`), and returning it fails. The throwing pointer is S3's.
8. **The C1 spec's type test says `Value<SecretSource>` is not an `InputBinding`.** That still holds. But a `Value<SecretString>` now is, and its real value at runtime is a `SecretSource`, not a `SecretString`. The type is the schema's output type; the runtime object is the pointer the deploy carries. Design note 4 accepts this ("although the type says `SecretString`").
9. **The `ModuleContext` doc comment and `module-composition.md` signatures already differ from the code**: the doc omits `secrets` and `params`. This spec keeps that difference rather than documenting slots S5 removes.

## 14. Settled by the orchestrator

1. **The serializer's morph problem is fixed in this slice** (§ 7, test 35), in its own commit.
2. **The interim errors are acceptable.** Nothing that works today stops working, so a release between S2 and S4 only shows a not-yet-supported error to someone trying a new feature, with what to do instead. S2 does not wait for S3 and S4.
3. **For S3:** a module's binding must accept every param source a service binding accepts, `envParam()`, `generatedParam()` and `serviceOrigin()`, because S5 moves `auth()`, whose `baseUrl` the auth example binds with `serviceOrigin()`, onto `input`.
