# S6 — `field()` and the two kinds of pointer

Parent: [module-input spec](../../spec.md) and [plan](../../plan.md). Design: [design.md](../../design.md), which is authoritative; this slice builds the part of its section 3 that the plan's S6 paragraph names. Decisions: the service input decision ([ADR-0042](../../../../../docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md)) and the `resolve()` and config adapters decision ([ADR-0062](../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), each with its amendments. It builds on S5 (branch `claude/module-input-s5`), which builds on S4, S3 and S2.

This spec leaves nothing to the implementer's judgement. Every type, signature, name, error message, file, test and commit is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose. § 17 lists the decisions this spec takes, and § 18 the conflicts it found.

Read for this spec: `CLAUDE.md`; `docs/design/01-principles/`; the two decisions above with every amendment; the glossary entries Module, "Configuration — params and their sources" and Value; `module-composition.md` § Input; `core-model.md`'s entry table; the S3 spec (sources are values); `.agents/rules/exports-entrypoints.mdc`, `no-bare-casts.mdc`, `test-import-patterns.mdc`, `vitest-expect-typeof.mdc` and `user-facing-surface-changes.mdc`; `skills/README.md`; and the code each section names.

`<date>` below is the date the pull request is opened, as `YYYY-MM-DD`.

## 1. At a glance

```ts
import { module } from '@prisma/composer';
import { field, secretString } from '@prisma/composer/arktype';
import { type } from 'arktype';

const email = module(
  'email',
  {
    input: type({
      from: field(type('string')),
      port: field(type('string.integer.parse')),
      deliveryCredential: secretString(),
    }),
  },
  ({ input, provision }) => {
    // input.from is Value<string | Pointer<string>>; input.port is Value<number | Pointer<string>>
    provision(emailService, {
      id: 'service',
      input: { from: input.from, port: input.port, deliveryCredential: input.deliveryCredential },
    });
  },
);
```

```ts
// the same with Zod
import { field, secretString } from '@prisma/composer/zod';
import { z } from 'zod';

z.object({ from: field(z.string()), port: field(z.string().transform(Number)), deliveryCredential: secretString() });
```

A wrapped field reports the plain field's error for a value that is not a pointer:

```text
type({ from: field(type('string')) })({ from: 3 })    from must be a string (was a number)                same as type('string')
z.object({ from: field(z.string()) }), {}             Invalid input: expected string, received undefined  same as z.string()
type({ from: field(type('string')) })({})             from must be a string or an object (was missing)    type('string') says: from must be a string (was missing)
```

The third line is the one place the two differ (§ 18, conflict 1).

For any other Standard Schema library, `@prisma/composer` exports the checks the two helpers use:

```ts
import { isPlainPointer, isSecretPointer, type Pointer, type RuntimeValue } from '@prisma/composer';
```

Nothing in the deploy binds a pointer to a schema yet. A module's schema and a service's schema are still checked at deploy with the stand-ins S3 describes, which a wrapped field accepts as the plain field does. S7 replaces the stand-ins with pointers.

## 2. The model

- **A pointer is the real value at deploy of a runtime value.** S3 made it the source object itself: `envSecret()`, `generatedParam()` or `serviceOrigin()`. This slice records the pointer's **kind** in its data, under the registered symbol `Symbol.for('prisma:pointer')`: `'secret'` or `'plain'`.
- **Which source is which kind.** Every `secretSource()` is a secret pointer. A `paramSource()` with a pool key, such as `envParam()`, is no pointer: its real value is text. Any other `paramSource()` is a secret pointer when it is `redacted`, and a plain pointer otherwise. So `envSecret()` and a redacted `generatedParam()` are secret pointers, and `serviceOrigin()` and a plain `generatedParam()` are plain pointers.
- **A copy keeps the kind.** ArkType copies its input when a transform runs in the schema or when it deletes undeclared keys. Its copy keeps every own property, symbol keys included, and the prototype. So a copy of a source keeps the value brand, the source brand, the origin, the pointer kind and a copy of the payload, which keeps the target's payload brand and the variable name. Load, preflight and the serializer already recognise a source by these brands and its payload (§ 10); this slice proves it with tests.
- **`Pointer<T>`** is the public type of a pointer that stands for a `T`. It is typed by the variable's text, so every plain pointer is a `Pointer<string>`, and a secret pointer is a `Pointer<SecretString>`. **`RuntimeValue<T>`** is `Value<Pointer<T>>`.
- **`isPlainPointer()` and `isSecretPointer()`** read the kind. They live in `@internal/foundation`, beside `isSecretString()`, because `secretString()` lives there and foundation cannot import core.
- **`field(inner)`** wraps one leaf field's schema in a union that the schema library checks itself: a plain pointer, or a value `inner` accepts. Its input type is `In | Pointer<In>` and its output type `Out | Pointer<In>`. It ships for ArkType from `@prisma/composer/arktype` and for Zod from the new `@prisma/composer/zod`.
- **`secretString()`** accepts a secret box or a secret pointer, in both libraries. Its types do not change in this slice: it still reads as `SecretString` (§ 17, decision 5).
- **The source constructors' types do not change.** `envSecret()` is still `SecretSource<EnvSecretPayload> & Value<SecretString>` (§ 17, decision 4).
- **A service binding takes a forwarded wrapped field.** The loose `InputBindingData` gains `Pointer<unknown>`, so `input.from` of a wrapped field type-checks in a service's `input` binding (§ 17, decision 6).

## 3. Foundation: pointers

### 3.1 New file `packages/0-framework/0-foundation/foundation/src/pointer.ts`

Exactly:

```ts
/** A pointer: what a value known only at boot holds at deploy. It names the platform variable the service reads at boot, and records whether that variable holds a secret. */
import { blindCast } from './casts.ts';
import type { SecretString } from './secret.ts';

// Symbol.for, so a pointer built by a duplicated copy of this module carries the identical key.
const POINTER: unique symbol = blindCast<never, 'unique-symbol brand for a pointer'>(
  Symbol.for('prisma:pointer'),
);
// Type-only, never assigned: carries T so a Pointer<string> is not a Pointer<SecretString>.
declare const POINTER_TYPE: unique symbol;

export type { POINTER_TYPE };
export { POINTER };

/** Whether the variable a pointer names holds a secret. */
export type PointerKind = 'secret' | 'plain';

/** The real value at deploy of a value known only at boot: it names the platform variable that holds the text of a `T`. */
export interface Pointer<T> {
  readonly [POINTER]: PointerKind;
  readonly [POINTER_TYPE]?: T;
}

function kindOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return blindCast<Record<PropertyKey, unknown>, 'reading the pointer brand off an unknown object'>(
    value,
  )[POINTER];
}

/** True for a plain pointer: a value known only at boot whose variable holds plain text. */
export function isPlainPointer(value: unknown): value is Pointer<string> {
  return kindOf(value) === 'plain';
}

/** True for a secret pointer: a value known only at boot whose variable holds a secret. */
export function isSecretPointer(value: unknown): value is Pointer<SecretString> {
  return kindOf(value) === 'secret';
}
```

### 3.2 New file `packages/0-framework/0-foundation/foundation/src/exports/pointer.ts`

```ts
/** Public surface: the pointer a value known only at boot holds at deploy. Implementation lives in `../pointer.ts`. */

export type { Pointer, POINTER_TYPE, PointerKind } from '../pointer.ts';
export { isPlainPointer, isSecretPointer, POINTER } from '../pointer.ts';
```

## 4. Foundation: `secretString()` accepts a secret pointer

`packages/0-framework/0-foundation/foundation/src/arktype.ts`. The imports become:

```ts
import { type, type Type } from 'arktype';
import { blindCast } from './casts.ts';
import { describeKind } from './describe-kind.ts';
import { isPlainPointer, isSecretPointer, type Pointer } from './pointer.ts';
import { isSecretString, type SecretString } from './secret.ts';
```

The module doc comment does not change. `secretString` becomes, doc comment included:

```ts
/**
 * A schema leaf that accepts only a redacting `SecretString` box or a secret
 * pointer, so `input().<field>.expose()` type-checks and binding a plain
 * literal there fails the deploy (ADR-0042). Its error names the refused
 * value's kind, never the value.
 *
 * ```ts
 * input: type({ signingKey: secretString() })
 * ```
 */
export const secretString = () =>
  type('unknown').narrow(
    (value, ctx): value is SecretString =>
      isSecretString(value) ||
      isSecretPointer(value) ||
      ctx.reject({
        expected: 'a SecretString box — bind this field to a secret',
        actual: isPlainPointer(value)
          ? 'a value known only at boot that is not a secret'
          : describeKind(value),
      }),
  );
```

The predicate still says `value is SecretString` (§ 17, decision 5).

## 5. Foundation: `field()` for ArkType

Appended to `packages/0-framework/0-foundation/foundation/src/arktype.ts`, after `secretString`, exactly:

```ts
/** The error `inner` reports for `data`: what a wrapped field reports for a value that is not a pointer. */
function innerProblem(inner: Type<unknown, unknown>, data: unknown): string {
  const errors = inner(data);
  if (errors instanceof type.errors) return errors.map((error) => error.problem).join('; ');
  return `must be ${inner.description} (was ${describeKind(data)})`;
}

/**
 * Wraps the schema of one leaf field so the field also accepts a plain
 * pointer, which stands for a value known only at boot. The field's input type
 * is `In | Pointer<In>` and its output type `Out | Pointer<In>`, where `In` and
 * `Out` are `inner`'s. A value that is not a pointer gets `inner`'s error.
 * Wrap a leaf, never an object schema; put a default outside the wrapper.
 *
 * ```ts
 * input: type({ from: field(type('string')), port: field(type('string.integer.parse')) })
 * ```
 */
export function field<t, $>(inner: Type<t, $>): Type<t | Pointer<Type<t, $>['inferIn']>, $> {
  const checked = blindCast<
    Type<unknown, unknown>,
    "field() calls only or(), configure() and the type itself, none of which depends on inner's type parameters; on the generic Type<t, $> those calls do not type-check"
  >(inner);
  const pointer = type('object').narrow((value) => isPlainPointer(value));
  return blindCast<
    Type<t | Pointer<Type<t, $>['inferIn']>, $>,
    "ArkType infers the pointer branch as object; the branch admits only a plain pointer, which stands for the inner schema's input text"
  >(checked.or(pointer).configure({ problem: (error) => innerProblem(checked, error.data) }));
}
```

How it behaves, each checked against ArkType 2.2.7 (§ 18, conflict 1 has the evidence):

- **The pointer branch is `type('object').narrow(…)`**, never `type('unknown').narrow(…)`. A union of a transforming inner schema and a branch whose input overlaps it throws when the schema is defined. Limiting the branch to objects keeps `field(type('string.integer.parse'))` buildable.
- **`configure({ problem })`** replaces the union's error, and the errors of its branches, with `inner`'s own error for the same data. So a value of the wrong type, a non-pointer object, a secret pointer, a secret box and a value `inner` refuses all get the plain field's message. `configure()` returns a new type; `inner` is not changed.
- **A missing required key keeps ArkType's union wording**, `from must be a string or an object (was missing)`. ArkType builds that message from the key's node, which `field()` cannot reach (§ 18, conflict 1).
- **An object schema with a transform inside cannot be wrapped.** ArkType throws `An unordered union of a type including a morph and a type with overlapping input is indeterminate` when it is defined. `field()` adds no check of its own.
- **A default goes outside**: `field(type('string')).default('x')`. `type('string').default('x')` is a tuple, not a type.

`packages/0-framework/0-foundation/foundation/src/exports/arktype.ts`'s export line becomes `export { field, secretString } from '../arktype.ts';`. `@prisma/composer/arktype` re-exports `@internal/foundation/arktype` wholesale, so it gains `field` with no edit.

## 6. Foundation: the Zod entry

### 6.1 New file `packages/0-framework/0-foundation/foundation/src/zod.ts`

Exactly:

```ts
/**
 * Zod spellings of the framework's schema leaves. Opt-in: the framework
 * accepts any Standard Schema library (ADR-0042) and nothing outside this
 * module imports zod, so an app that uses ArkType never loads it.
 */
import { z } from 'zod';
import { blindCast } from './casts.ts';
import { describeKind } from './describe-kind.ts';
import { isPlainPointer, isSecretPointer, type Pointer } from './pointer.ts';
import { isSecretString, type SecretString } from './secret.ts';

/**
 * A schema leaf that accepts only a redacting `SecretString` box or a secret
 * pointer, so `input().<field>.expose()` type-checks and binding a plain
 * literal there fails the deploy (ADR-0042). Its error names the refused
 * value's kind, never the value.
 *
 * ```ts
 * input: z.object({ signingKey: secretString() })
 * ```
 */
export const secretString = () =>
  z.custom<SecretString>((value) => isSecretString(value) || isSecretPointer(value), {
    error: (issue) =>
      `must be a SecretString box — bind this field to a secret (was ${
        isPlainPointer(issue.input)
          ? 'a value known only at boot that is not a secret'
          : describeKind(issue.input)
      })`,
  });

/**
 * Wraps the schema of one leaf field so the field also accepts a plain
 * pointer, which stands for a value known only at boot. The field's input type
 * is `In | Pointer<In>` and its output type `Out | Pointer<In>`, where `In` and
 * `Out` are `inner`'s. A value that is not a pointer gets `inner`'s error.
 * Wrap a leaf, never an object schema.
 *
 * ```ts
 * input: z.object({ from: field(z.string()), port: field(z.string().transform(Number)) })
 * ```
 */
export function field<S extends z.ZodType>(
  inner: S,
): z.ZodType<z.output<S> | Pointer<z.input<S>>, z.input<S> | Pointer<z.input<S>>> {
  const pointer = z.custom((value) => isPlainPointer(value));
  return blindCast<
    z.ZodType<z.output<S> | Pointer<z.input<S>>, z.input<S> | Pointer<z.input<S>>>,
    "Zod infers the pointer branch as unknown; the branch admits only a plain pointer, which stands for the inner schema's input text"
  >(
    z.union([inner, pointer], {
      error: (issue) => (issue.code === 'invalid_union' ? issue.errors[0]?.[0]?.message : undefined),
    }),
  );
}
```

How it behaves, each checked against Zod 4.4.3:

- When `inner` fails with an issue that does not stop the parse, such as a URL check, Zod's union returns `inner`'s issues as they are.
- When both branches fail on the type, as for a missing key or a value of the wrong type, the union reports one `invalid_union` issue. The error function gives it `inner`'s first message, so the message is the plain field's. The issue's `code` is `invalid_union`, not the plain field's `invalid_type`; the tests compare messages, as the design asks.
- `inner` comes first in the union, so `issue.errors[0]` is `inner`'s issues.
- A pointer passes through as the same object: Zod does not copy it.
- `field(z.string()).optional()`, `field(z.string().optional())` and `field(z.string()).default('x')` all work.

### 6.2 New file `packages/0-framework/0-foundation/foundation/src/exports/zod.ts`

```ts
/** Public surface: the Zod spellings of the framework's schema leaves. Implementation lives in `../zod.ts`. */

export { field, secretString } from '../zod.ts';
```

## 7. Core

### 7.1 `node.ts`: a runtime source records its kind

The imports gain, after the `@internal/foundation/casts` import:

```ts
import { POINTER, type Pointer, type PointerKind } from '@internal/foundation/pointer';
```

`buildSource` gains a last parameter and sets the kind:

```ts
function buildSource(
  brand: typeof SECRET_SOURCE | typeof PARAM_SOURCE,
  payload: unknown,
  origin: Omit<SourceOrigin, 'source'>,
  kind: PointerKind | undefined,
): object {
  const source = {
    [VALUE]: true,
    [VALUE_ORIGIN]: origin,
    [brand]: true,
    ...(kind === undefined ? {} : { [POINTER]: kind }),
    payload,
  };
  Object.defineProperty(origin, 'source', { value: source });
  Object.defineProperties(source, coercions(origin));
  Object.freeze(origin);
  return Object.freeze(source);
}
```

The callers:

- `secretSource()`: `buildSource(SECRET_SOURCE, payload, { … unchanged … }, 'secret')`.
- `paramSource()`: `buildSource(PARAM_SOURCE, payload, { kind: 'source', label, poolKey, sentinel, redacted }, poolKey !== undefined ? undefined : redacted ? 'secret' : 'plain')`.

Nothing else in either function changes. `Object.keys(source)` is still `['payload']` and `JSON.stringify(source)` is unchanged, because the kind sits under a symbol key.

Doc comments, verbatim:

- `SecretSource`: `A secret's source: a target-defined payload core forwards but never inspects. It is a value too, known only at boot; its real value at deploy is the source itself, a secret pointer. A target (e.g. @prisma/composer-prisma-cloud's \`envSecret\`) builds one with \`secretSource()\`.`
- `ParamSource`: `A param's source: a target-defined payload core forwards but never inspects. It is a value too: known at deploy when it names a config pool key (\`envParam\`), otherwise known only at boot, with the source itself as its real value: a secret pointer when it is redacted, a plain pointer otherwise. A target builds one with \`paramSource()\`.`
- `ParamSourceOptions.redacted`: `For a source known only at boot whose value is redacted: a module's input schema checks an empty \`SecretString\` in its place, as for a secret, and the source is a secret pointer.`

### 7.2 `node.ts`: a service binding takes a forwarded wrapped field

`InputBindingData` becomes:

```ts
/** What a value in a service's input binding may stand for: plain data, a `SecretString` at any depth (a forwarded secret field), a pointer (a forwarded wrapped field), and `undefined` (an optional field the binding left out). */
export type InputBindingData =
  | string
  | number
  | boolean
  | null
  | undefined
  | SecretString
  | Pointer<unknown>
  | readonly InputBindingData[]
  | { readonly [key: string]: InputBindingData };
```

Without it, `provision(service, { input: { from: input.from } })` fails to compile when `from` is a wrapped field, because `Pointer` is an interface and has no string index signature (checked with `tsc` against the S5 code).

### 7.3 `value.ts`: `RuntimeValue<T>`

`value.ts` gains `import type { Pointer } from '@internal/foundation/pointer';` after its `blindCast` import, and, directly after the `Value<T>` interface:

```ts
/** A value known only at boot (ADR-0062): its real value at deploy is a `Pointer<T>`, which names the platform variable the service reads at boot. */
export type RuntimeValue<T> = Value<Pointer<T>>;
```

### 7.4 `exports/index.ts`

Directly before the two `@internal/foundation/secret` lines:

```ts
export type { Pointer } from '@internal/foundation/pointer';
export { isPlainPointer, isSecretPointer } from '@internal/foundation/pointer';
```

The last type export becomes `export type { EnvironmentFacts, PlainData, RealValuesOf, RuntimeValue, Value } from '../value.ts';`.

Not exported from core: `POINTER`, `POINTER_TYPE`, `PointerKind`. `@prisma/composer` re-exports `@internal/core` wholesale, so `Pointer`, `RuntimeValue`, `isPlainPointer` and `isSecretPointer` become public with no edit to `packages/9-public/composer/src/exports/index.ts`.

## 8. The public package: `@prisma/composer/zod`

New file `packages/9-public/composer/src/exports/zod.ts`, one line, the shape of `arktype.ts` beside it:

```ts
export * from '@internal/foundation/zod';
```

## 9. Packaging and repo configuration

The repo ships `@prisma/composer/arktype` this way: the implementation in `@internal/foundation`'s `src/arktype.ts`, a shim in its `src/exports/`, `arktype` a regular `dependencies` entry of both `@internal/foundation` and `@prisma/composer`, a hand-maintained export in `@prisma/composer`, and `paths` entries in `tsconfig.depcruise.json`. The Zod entry follows it exactly.

- **`packages/0-framework/0-foundation/foundation/tsdown.config.ts`**: the `entry` object gains `pointer: 'src/exports/pointer.ts',` after `secret`, and `zod: 'src/exports/zod.ts',` after `arktype`.
- **`packages/0-framework/0-foundation/foundation/package.json`**:
  - `description` becomes `Foundation utilities: the audited cast helpers, runtime assertions, the redacting secret box, pointers, and their opt-in ArkType and Zod spellings.`
  - `dependencies` gains `"zod": "^4.4.3"` after `arktype`.
  - `exports` is generated by the build (`.agents/rules/exports-entrypoints.mdc`; never hand-edited). After `pnpm build` it must hold exactly these keys in this order, and the implementer commits what the build wrote: `./arktype`, `./assertions`, `./casts`, `./errors`, `./pointer`, `./result`, `./secret`, `./zod`, `./package.json`. If the build writes anything else, stop and report.
- **`packages/9-public/composer/tsdown.config.ts`**: `entry` gains `zod: 'src/exports/zod.ts',` directly after `arktype: 'src/exports/arktype.ts',`.
- **`packages/9-public/composer/package.json`**: `exports` gains `"./zod": "./dist/zod.mjs",` directly after `"./arktype": "./dist/arktype.mjs",` (this map is hand-maintained); `dependencies` gains `"zod": "^4.4.3"` as its last entry, after `"@prisma/management-api-sdk"`.
- **`packages/0-framework/1-core/core/package.json`**: `devDependencies` gains `"zod": "^4.4.3"` after `vitest`, for the type tests in § 13.4.
- **`architecture.config.json`**: directly after the block whose glob is `packages/9-public/composer/src/exports/arktype.ts`, a new block:

  ```json
      {
        "glob": "packages/9-public/composer/src/exports/zod.ts",
        "domain": "public",
        "layer": "public",
        "plane": "shared"
      },
  ```

  The foundation's new files are covered by its existing `packages/0-framework/0-foundation/**` glob.
- **`tsconfig.depcruise.json`**: directly after the `@internal/foundation/arktype` entry,

  ```json
      "@internal/foundation/pointer": [
        "./packages/0-framework/0-foundation/foundation/src/exports/pointer.ts"
      ],
      "@internal/foundation/zod": [
        "./packages/0-framework/0-foundation/foundation/src/exports/zod.ts"
      ],
  ```

  and directly after the `@prisma/composer/arktype` entry, `"@prisma/composer/zod": ["./packages/9-public/composer/src/exports/zod.ts"],`.
- **`pnpm-lock.yaml`**: run `pnpm install`. The lockfile gains `zod` in the three importers above. It must resolve `zod@4.4.3`, the version already in the lockfile and the one this spec's messages were checked against. If it resolves another version, stop and report.

## 10. Recognition by brand: what changes and what is proved

The design says Load, preflight and the serializer recognise a pointer by its brand and the variable it names, never by object identity, so a copy made by ArkType still counts. Every site was read against the S5 code:

| Where | How it recognises a source today | A copy |
| --- | --- | --- |
| `collect`, `substitute`, `readPath`, `refusePointersInProps`, `withSentinels` (`resolve-values.ts`) | `isSecretSource` / `isParamSource`: the source brand | kept: own symbol keys are copied |
| `resolveOne`'s `'source'` case | the origin under `VALUE_ORIGIN`; a pointer's real value is `origin.source` | the copy shares the origin object, whose `source` is the original |
| `canonicalSecret` and the `secretUses` map | `origin.source`, the original | a copy and its original are one entry |
| `restore`'s `SecretBox` tag | a non-enumerable symbol on the stand-in box | kept: ArkType copies non-enumerable symbol properties too |
| the serializer's binding walk and `preflight-names.ts` | the source brand, then the payload's target brand and `payload.name` | kept: the payload is copied with its symbol brand and name |
| `checkResult`'s `received` set | the objects a `resolve()` function received | not recognition: a function can only return an object it holds, so a copy it returns is in the set; S8 removes this check |

So no code in Load, preflight or the serializer changes for this. The kind is new data the same way: an own property under a registered symbol. The tests in § 13.5 to § 13.7 bind ArkType copies in each place and fail if a copy stops being recognised. Core never reads a target's payload, so it cannot read "the variable it names"; § 18, conflict 2 says how this spec reads the design there.

## 11. Error messages, verbatim

| Where | Condition | Message |
| --- | --- | --- |
| ArkType `secretString()` | a plain pointer | `<path> must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)` |
| ArkType `secretString()` | anything else refused | unchanged: `<path> must be a SecretString box — bind this field to a secret (was <describeKind(value)>)` |
| Zod `secretString()` | a plain pointer | `must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)` |
| Zod `secretString()` | anything else refused | `must be a SecretString box — bind this field to a secret (was <describeKind(value)>)`; for a missing key `<describeKind(undefined)>` is `nothing` |
| ArkType `field()` | a present value that is not a plain pointer and that `inner` refuses | `inner`'s message for the same value |
| ArkType `field()` | a missing required key | ArkType's own: `<path> must be <inner's branch description> or an object (was missing)`, in the order ArkType chooses, e.g. `from must be a string or an object (was missing)` |
| ArkType `field()` | `inner` accepts data the union refused (cannot happen for a deterministic `inner`) | `<path> must be <inner.description> (was <describeKind(data)>)` |
| Zod `field()` | any value that is not a plain pointer and that `inner` refuses, a missing key included | `inner`'s message for the same value |

No message names a Composer class. Every other message is unchanged.

## 12. Documentation

All in the same pull request (`.agents/rules/user-facing-surface-changes.mdc`).

### 12.1 Glossary, `docs/design/03-domain-model/glossary.md`

1. **Core nouns introduction.** `Anything without a lifecycle — an API key, an external URL — is **Configuration**, not a node.` becomes `Anything without a lifecycle — an API key, an external URL — is part of a node's **[Input](#input)**, not a node.`
2. **Module**, the `Input` bullet. `A Module declares its configuration as one \`input\` Standard Schema, as a Service does,` becomes `A Module declares its [Input](#input) as one \`input\` Standard Schema, as a Service does,`. The rest of the bullet is unchanged.
3. **Resource**, last paragraph. `a service you call but don't provision is **Configuration**, not a Resource.` becomes `a service you call but don't provision is part of the caller's **Input**, not a Resource.`
4. **The entry `### Configuration — params and their sources`** is renamed `### Input`, and its text up to and including the line `Each source constructor, and \`serviceOrigin()\`, returns a [value](#value) that is the source too.` is replaced by:

   ```markdown
   ### Input

   What a Service or a Module needs, per environment, from whoever provisions
   it, other than its dependencies: values that are **not themselves nodes**.
   The node declares its input as one Standard Schema, `input`
   ([ADR-0042](../90-decisions/ADR-0042-service-input-is-one-standard-schema.md),
   [ADR-0061](../90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)),
   and whoever provisions it binds that input with
   `provision(node, { input: { … } })`, an object that mirrors the schema. The
   framework checks the binding with the schema and injects the result; user
   code never reads the environment (no-globals). Each key of a binding takes:

   - a **literal**: the author writes the data, and it travels in the
     service's input document;
   - a [value](#value): `environment.name`, a `resolve()` result, or a field of
     the provisioning module's own input;
   - a **source**: target-provided logic that turns what the author supplies
     into data. A source is a value too. Prisma Cloud's:
     - **`envParam(NAME)`** — the author supplies an environment-variable name.
       Where the value goes depends on where it is bound. In a service's input,
       the deploy reads `NAME` from its [config pool](#config-pool) and writes
       the value into the service's input document, so every deploy reads it
       again. In a service's per-key params, the deploy writes a pointer row to
       a platform variable, and the service reads that variable at boot. Either
       way it varies by environment, not by deployment logic.
     - **`envSecret(NAME)`** — the author supplies a name; the target reads the
       platform's secret store. The value **never enters deploy state**, and it
       is **redacted**. **This is the only thing the framework calls a
       secret.**
     - **`generatedParam(...)`** — the author supplies generation parameters;
       the **target generates the value at deploy** and **persists it in deploy
       state**, stable across redeploys. A generated value can act as
       asymmetric knowledge (an rpc service key, an instance signing key) but
       it is **not a secret** — it is config the system produces and owns.
     - **`serviceOrigin(address)`** — the public origin of another service in
       the environment being deployed, which exists only once the deploy has
       created that service.

   A field typed `secretString()` takes only a secret. A
   [wrapped field](#field) also takes a value known only at boot.

   The older form of input is a service's per-key `params`, each bound to a
   literal or a source
   ([ADR-0032](../90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)).
   ```

   The paragraphs from `Two properties fall out of the source, and neither is its own category:` to the end of the entry stay as they are.
5. **The entry `### Value`** is replaced, heading included, by:

   ```markdown
   ### Value

   An opaque stand-in, in a module body, for data that is known later: by the
   end of Load for a deploy-time value, or only on the platform for a
   [runtime value](#runtimevalue). The body can pass a value wherever data of
   its type is accepted. It cannot read the data: turning a value into text or
   a number, serializing it or listing its keys fails the deploy. It can branch
   on a value with a truthiness check or `typeof`, but a value is always an
   object, so the branch always goes the same way, in every environment, and
   cannot vary the graph. That is what keeps the graph's structure the same
   whatever inputs Composer is given
   ([ADR-0062](../90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)).
   The data a value stands for is its **real value**.

   - **Provided or computed.** A provided value is handed to the module body:
     `environment.name` is one, a deploy-time fact of the environment, and each
     field of a module's `input` is another, whose real value is read from the
     module's input after its schema has validated it. A root's input is the
     config pool. A computed
     value is what `resolve(dependencies, fn)` returns; Load runs `fn` with its
     dependencies' real values after every module body has run, with `provision`
     disabled. `resolve()` declares a computed value; Load resolves every value.
   - **Deploy-time or runtime.** A deploy-time value has its real value by the
     end of Load: `environment.name`, a `resolve()` result, `envParam()`, whose
     real value is the variable's value at deploy, and a module input field
     bound to one of these. `envSecret()`, `generatedParam()` and
     `serviceOrigin()` give [runtime values](#runtimevalue): the platform holds
     the data, or the deploy creates it later, so Load holds a pointer in its
     place. A `resolve()` function that lists a runtime value receives the
     pointer and may return it unchanged; `isRuntimeValue(x)` is true for it.
   - **Sources are values.** `envParam()`, `envSecret()`, `generatedParam()` and
     `serviceOrigin()` each return one object that is a value and the deploy
     target's source. Where a service's binding takes a source, the target
     receives that object.

   In code the type is `Value<T>`, and `RealValuesOf<D>` is the tuple of
   real-value types `fn` receives for a dependency tuple `D`. A source's type is
   the source and a value at once, such as `SecretSource & Value<SecretString>`.
   A value is not a node: it has no lifecycle and no address. Elsewhere
   in this glossary "value" in lower case keeps its ordinary meaning, plain data
   such as a param's value.

   ### RuntimeValue

   A [value](#value) whose data exists only on the platform the app is
   deployed to: the service reads it at boot. `envSecret()`, `generatedParam()`
   and `serviceOrigin()` give one. In code a runtime value is
   `RuntimeValue<T>`, which is `Value<Pointer<T>>`.

   At deploy its real value is a **pointer**: an object that names the
   platform variable holding the data. The deploy writes the pointer into the
   service's input document, and the service reads the variable at boot. A
   pointer has one of two kinds, which it records in its data:

   - a **secret pointer**, typed `Pointer<SecretString>`, from `envSecret()`
     and a redacted `generatedParam()`;
   - a **plain pointer**, typed `Pointer<string>`, from `serviceOrigin()` and
     a plain `generatedParam()`.

   A pointer is typed by the variable's text, so every plain pointer is a
   `Pointer<string>`. `isSecretPointer(x)` and `isPlainPointer(x)` from
   `@prisma/composer` tell the kinds apart. A schema may return a copy of a
   pointer: ArkType copies its input when a transform runs in it or when it
   deletes undeclared keys. The copy keeps the pointer's kind and the variable
   it names, and Composer treats it as the same pointer. A pointer throws when
   code turns it into text or a number.

   ### `field()`

   `field(inner)`, from `@prisma/composer/arktype` or `@prisma/composer/zod`,
   wraps the schema of one leaf field of an input schema. A **wrapped field**
   accepts what `inner` accepts and a plain pointer, so it also takes a runtime
   value with a plain pointer. Its input type is `In | Pointer<In>` and its
   output type `Out | Pointer<In>`, where `In` and `Out` are `inner`'s. A
   **plain field** is written without `field()`: the author's request for
   deploy-time data, and the kind of field a `resolve()` computes with, since a
   wrapped field's real value may be a pointer. A secret field is
   `secretString()`, which accepts a secret box or a secret pointer and needs no
   `field()`. `field()` wraps leaves only: an object field stays a plain object
   schema whose leaves are wrapped. For another Standard Schema library,
   `@prisma/composer` exports `Pointer`, `isPlainPointer()` and
   `isSecretPointer()`, with which an author writes the same two helpers.
   ```

6. **Topology.** The sentence `Anything without a lifecycle is Configuration, not a node.` (wrapped across two lines in the file) becomes `Anything without a lifecycle is part of a node's [Input](#input), not a node.`
7. **Ingress / Egress.** `the Configuration (URL + credentials) it carries` becomes `the Input (URL + credentials) it carries`.
8. **Alchemy — definition language**, the `Props` bullet: its last words, `a node's **dependencies** + **Configuration**.`, become `a node's **dependencies** + **Input**.`
9. **Effect substrate.** In the `Config` bullet, `**Configuration**; the host shim` becomes `**Input**; the host shim`. In the `Redacted` bullet, `secret **Configuration** (e.g. \`DATABASE_URL\`)` becomes `a secret field of a node's **Input** (e.g. \`DATABASE_URL\`)`.
10. **Superseded terms**, the `Input and Output` bullet gains, at its end: ` **Input** now names what a node's \`input\` schema declares ([Input](#input)).`

After these edits `grep -n "Configuration" docs/design/03-domain-model/glossary.md` finds no line that uses it as a glossary noun.

### 12.2 Decision records

- **The service input decision**, `docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md`: a new amendment note directly after the existing fifth-slice note, verbatim:

  > Amended `<date>` (module-input project, sixth slice): `@prisma/composer/zod` ships beside `@prisma/composer/arktype`. Each exports `secretString()` and `field()`. Zod's `secretString()` is the `z.custom` described below. In both libraries `secretString()` also accepts a secret pointer, the real value at deploy of a secret known only at boot ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). `field(inner)` wraps the schema of one leaf field: the wrapped field accepts what `inner` accepts and a plain pointer, the real value at deploy of a plain value known only at boot, such as `serviceOrigin()`. Its input type is `In | Pointer<In>` and its output type `Out | Pointer<In>`. For a value that is not a pointer, a wrapped field reports `inner`'s error, except ArkType's message for a missing key, which names both branches (`from must be a string or an object (was missing)`). For any other Standard Schema library, `@prisma/composer` exports `Pointer`, `isPlainPointer()` and `isSecretPointer()`, beside `isSecretString()`, so an author can write the same two helpers. The deploy still checks a service's binding with the stand-ins described below, so neither change alters what a deploy accepts.

  Its index line in `docs/design/90-decisions/README.md` gains, at its end: ``*(Amended `<date>`, sixth slice: `field()` and `secretString()` ship from `@prisma/composer/arktype` and `@prisma/composer/zod`; `secretString()` accepts a secret pointer.)*``
- **The `resolve()` and config adapters decision**, `ADR-0062-environment-values-come-from-resolve-and-config-adapters.md`: a new amendment note directly after the existing fourth-slice note, verbatim:

  > Amended `<date>` (module-input project, sixth slice): a pointer records its kind in its data. A secret pointer is the real value of `envSecret()` and of a redacted `generatedParam()`; a plain pointer is the real value of `serviceOrigin()` and of a plain `generatedParam()`. `@prisma/composer` exports `isSecretPointer()` and `isPlainPointer()`, which read the kind, and the types `Pointer<T>` and `RuntimeValue<T>`, which is `Value<Pointer<T>>`: the type of a value whose real value at deploy is a pointer standing for a `T`. A schema may return a copy of a pointer: ArkType copies its input when a transform runs in it or when it deletes undeclared keys. The copy keeps the pointer's brands, its kind and the variable it names, so Composer still recognises it, because it recognises a pointer by its brands, never by object identity. A copy counts as the same source as its original, so a secret used through both is one secret, because the copy shares its original's origin object. The constructors' types do not change yet: `envSecret()` is still typed `SecretSource & Value<SecretString>`.

  Its index line gains, at its end: ``*(Amended `<date>`, sixth slice: a pointer records its kind, secret or plain; `Pointer`, `RuntimeValue`, `isPlainPointer()` and `isSecretPointer()` ship.)*``

### 12.3 Domain docs

- **`docs/design/10-domains/core-model.md`**, the entry table:
  - The `@prisma/composer` row's Exports cell becomes: `node factories (\`service\`, \`resource\`, \`dependency\`, \`module\`), \`Load\`, \`configOf\`, \`hydrate\`, \`BuildAdapter\` type, model types (incl. \`Config\`), and the pointer checks \`isPlainPointer()\` and \`isSecretPointer()\` with the \`Pointer\` and \`RuntimeValue\` types`.
  - The `@prisma/composer/arktype` row's Exports cell becomes: `\`secretString()\` and \`field()\` — the arktype spellings of a \`SecretString\` input leaf and of a wrapped leaf field (ADR-0042). Opt-in: no other entry imports it, so a Zod app never loads arktype`.
  - A new row directly after it: `| \`@prisma/composer/zod\` | \`secretString()\` and \`field()\` — the Zod spellings of the same two (ADR-0042). Opt-in: no other entry imports it, so an ArkType app never loads Zod | \`zod\` |`
  - The link `the [config/secret glossary](../03-domain-model/glossary.md#configuration--config-and-secrets)` becomes `the [input glossary entry](../03-domain-model/glossary.md#input)`.
- **`docs/design/10-domains/module-composition.md`**, § Input: a new paragraph directly after the paragraph that ends `although its type is the schema's output type.`, verbatim:

  ```markdown
  A leaf field can be **wrapped**: its schema is `field(inner)`, from
  `@prisma/composer/arktype` or `@prisma/composer/zod`
  ([glossary](../03-domain-model/glossary.md#field)). A wrapped field's schema
  accepts what `inner` accepts and a plain pointer, so its value in the body is
  typed `Value<Out | Pointer<In>>`: for `from: field(type('string'))`,
  `input.from` is `Value<string | Pointer<string>>`. Its binding takes a
  literal, a value of `inner`'s input type, or a `RuntimeValue<string>`; a
  `RuntimeValue<SecretString>` there fails to compile, and so does a
  `RuntimeValue<string>` in a plain field. At deploy a module's schema still
  checks the stand-ins described below, so a wrapped and a plain field check
  the same data.
  ```

### 12.4 The guide, `docs/guides/building-an-app.md`

- **§ Service input**, directly after the code block that defines `schedulerInput`, a new paragraph:

  ```markdown
  With Zod, import `secretString` from `@prisma/composer/zod` instead:
  `z.object({ apiKey: secretString() })`. With another Standard Schema
  library, accept a value for which `isSecretString()` or `isSecretPointer()`
  from `@prisma/composer` is true.
  ```

- **§ A module's input**, a new bullet directly after the bullet that begins `- A module's \`input\` takes every source a service's does.`:

  ```markdown
  - `field()`, from `@prisma/composer/arktype` or `@prisma/composer/zod`,
    wraps one leaf field's schema: `type({ from: field(type('string')) })` or
    `z.object({ from: field(z.string()) })`. A wrapped field also accepts a
    plain pointer, which stands for a value known only at boot such as
    `serviceOrigin()`, so in the body `input.from` is typed
    `Value<string | Pointer<string>>`. Pass it on into another wrapped field or
    a service's input; a plain `string` field refuses it at compile time. For a
    value that is not a pointer, a wrapped field reports the plain field's
    error, except that ArkType reports a missing key as
    `from must be a string or an object (was missing)`. Wrap leaves, never an
    object schema, and with ArkType put a default outside the wrapper:
    `field(type('string')).default('x')`. With another Standard Schema library,
    `Pointer`, `isPlainPointer()` and `isSecretPointer()` from
    `@prisma/composer` are what `field()` and `secretString()` check.
  ```

### 12.5 The agent skill, `skills/prisma-composer-core-concepts/SKILL.md`

Written to `skills/README.md`.

- § Two channels: dependencies and input. `A credential is a field typed as\n\`secretString()\` from \`@prisma/composer/arktype\`;` becomes `A credential is a field typed as\n\`secretString()\` from \`@prisma/composer/arktype\` (or \`@prisma/composer/zod\` for a Zod schema);`.
- § Values that differ per environment, a new bullet directly after the bullet that begins `- A module declares \`input\` (one Standard Schema)`:

  ```markdown
  - `field(inner)` from `@prisma/composer/arktype` or `@prisma/composer/zod` wraps one leaf field's schema (`field(type('string'))`, `field(z.string())`) so it also accepts a plain pointer, the stand-in for a value known only at boot such as `serviceOrigin()`. In the body the field is `Value<string | Pointer<string>>`: pass it into another wrapped field or a service's input, never a plain `string` field (compile error). Wrap leaves, not object schemas; an ArkType default goes outside: `field(type('string')).default('x')`. Other schema libraries: `Pointer`, `isPlainPointer()` and `isSecretPointer()` from `@prisma/composer`.
  ```

### 12.6 `.drive/deferred.md`

Two entries appended under `# Module input — deferred (2026-10-29)`:

- `**ArkType reports a missing wrapped field with both branches.** \`type({ from: field(type('string')) })({})\` says \`from must be a string or an object (was missing)\`, where the plain field says \`from must be a string (was missing)\`. ArkType words a missing key from its value's branch descriptions (\`RequiredNode\` reads \`value.defaultShortDescription\`), which ignore \`describe()\` and \`configure()\` on a union. Only a morph branch carries its own description there, and a morph makes ArkType copy the whole input whenever a pointer is present, which loses a \`SecretBox\`'s value. A root's fields stay plain, and a missing key in a typed module binding fails to compile. Origin: module-input S6 spec.`
- `**A Zod schema's refusal does not name the field in Composer's errors.** Load joins each issue's \`message\`, and Zod's messages carry no path (\`Invalid input: expected string, received undefined\`), where ArkType's start with it. Load could prefix each issue's \`path\`. Origin: module-input S6 spec.`

## 13. Tests

Runtime tests use `bun test`; type tests use vitest `expectTypeOf` and `@ts-expect-error`. A test that passes a value its types refuse casts with `as never`, as `source-load.test.ts` does. The foundation tests define two pointers at the top of each file that uses them, with `POINTER` from `./pointer.ts`:

```ts
const plain = Object.freeze({ [POINTER]: 'plain' as const });
const secret = Object.freeze({ [POINTER]: 'secret' as const });
```

The core and target tests that copy a source define, at the top of the file, with `type` from `arktype`:

```ts
/** An ArkType copy of `value`: a transform elsewhere in the schema makes ArkType copy its whole input. */
const copyOf = <T>(value: T): T => {
  const out = type({ value: 'object', n: 'string.integer.parse' })({ value, n: '1' });
  if (out instanceof type.errors) throw new Error(out.summary);
  return out.value as T;
};
```

### 13.1 Foundation: new file `packages/0-framework/0-foundation/foundation/src/pointer.test.ts`

1. `isPlainPointer() and isSecretPointer() read the kind from the pointer brand` — for `plain`, `[isPlainPointer, isSecretPointer]` gives `[true, false]`; for `secret`, `[false, true]`.
2. `anything without a plain or secret brand is no pointer` — `undefined`, `null`, `'plain'`, `3`, `{}`, `{ [POINTER]: true }`, `{ [POINTER]: 'other' }` and `new SecretBox('x')`: both `false`.
3. `the brand is the registered symbol prisma:pointer, so another copy of this module agrees` — `POINTER` is `Symbol.for('prisma:pointer')`.

### 13.2 Foundation: `packages/0-framework/0-foundation/foundation/src/arktype.test.ts`

Imports gain `field` from `./arktype.ts`, `isPlainPointer` and `POINTER` from `./pointer.ts`. A helper: `const messages = (schema: (value: unknown) => unknown, value: unknown): string[] => { const out = schema(value); return out instanceof type.errors ? out.map((error) => error.message) : []; };`. Inner schemas: `const inners = { string: () => type('string'), url: () => type('string.url'), integer: () => type('string.integer.parse'), mode: () => type("'resend' | 'smtp' | 'none'"), number: () => type('number') };`.

`describe('secretString', …)` gains:

4. `accepts a secret pointer` — `schema({ signingKey: secret })` is not `type.errors`, and its `signingKey` is `toBe(secret)`.
5. `refuses a plain pointer, saying it is not a secret` — `String(schema({ signingKey: plain }))` is exactly `signingKey must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)`.

A new `describe('field', …)`:

6. `a wrapped field accepts a plain pointer and returns it as itself` — `type({ from: field(type('string')) })({ from: plain })`'s `from` is `toBe(plain)`.
7. `a wrapped field passes text through the inner schema, transforms included` — `type({ port: field(type('string.integer.parse')) })({ port: '4' })` equals `{ port: 4 }`.
8. `a value of the wrong type gets the plain field's error` — for every inner in `inners` and every value in `[3, true, { a: 1 }, new SecretBox('x'), secret]`, `messages(type({ u: field(inner()) }), { u: value })` equals `messages(type({ u: inner() }), { u: value })`.
9. `a value the inner schema refuses gets the plain field's error` — the same comparison for `url` with `'no'`, `integer` with `'no'` and `mode` with `'smpt'`; and for `url` with `'no'` the messages are exactly `['u must be a URL string (was "no")']`.
10. `a wrong type names the inner type, not a Composer class` — `messages(type({ from: field(type('string')) }), { from: 3 })` is exactly `['from must be a string (was a number)']`.
11. `a missing key names both branches, and no Composer class` — `messages(type({ from: field(type('string')) }), {})` is exactly `['from must be a string or an object (was missing)']`; and for every inner in `inners`, `messages(type({ u: field(inner()) }), {})` has one message, which contains `(was missing)` and contains none of `Pointer`, `Source` and `instance of`.
12. `a transforming leaf can be wrapped` — `field(type('string.integer.parse'))` and `field(type('string.trim'))` do not throw.
13. `a default goes outside the wrapper` — `type({ from: field(type('string')).default('d') })({})` equals `{ from: 'd' }`.
14. `an optional key can be left out` — `type({ 'from?': field(type('string')) })({})` equals `{}`.
15. `a copy ArkType makes of a pointer keeps its kind` — `type({ from: field(type('string')), n: 'string.integer.parse' })({ from: plain, n: '1' })`'s `from` is not `toBe(plain)`, and `isPlainPointer` is true for it.
16. `an object schema with a transform inside cannot be wrapped` — `field(type({ port: 'string.integer.parse' }))` throws an error whose message contains `An unordered union of a type including a morph and a type with overlapping input is indeterminate`.

### 13.3 Foundation: new file `packages/0-framework/0-foundation/foundation/src/zod.test.ts`

Imports `z` from `zod`; `field`, `secretString` from `./zod.ts`; `POINTER` from `./pointer.ts`; `SecretBox` from `./secret.ts`. A helper: `const messages = (schema: z.ZodType, value: unknown): string[] => { const out = schema.safeParse(value); return out.success ? [] : out.error.issues.map((issue) => issue.message); };`. Inner schemas: `const inners = { string: () => z.string(), url: () => z.string().url(), transform: () => z.string().transform(Number), mode: () => z.enum(['resend', 'smtp', 'none']), number: () => z.number(), min: () => z.string().min(3) };`.

`describe('secretString', …)`:

17. `accepts a secret box, and the validated field reads back as a SecretString` — `z.object({ k: secretString() }).parse({ k: new SecretBox('v') }).k.expose()` is `'v'`.
18. `accepts a secret pointer` — the parsed `k` is `toBe(secret)`.
19. `refuses a plain string, naming its kind and never its value` — `messages(z.object({ k: secretString() }), { k: 'sk_live_SENTINEL' })` is exactly `['must be a SecretString box — bind this field to a secret (was a string)']`, and `JSON.stringify` of the `safeParse` error's `issues` does not contain `sk_live_SENTINEL`.
20. `refuses a plain pointer, saying it is not a secret` — exactly `['must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)']`.

`describe('field', …)`:

21. `a wrapped field accepts a plain pointer and returns it as itself` — `z.object({ from: field(z.string()) }).parse({ from: plain }).from` is `toBe(plain)`.
22. `a wrapped field passes text through the inner schema, transforms included` — `z.object({ port: field(z.string().transform(Number)) }).parse({ port: '4' })` equals `{ port: 4 }`.
23. `a value of the wrong type gets the plain field's error` — for every inner and every value in `[3, true, { a: 1 }, new SecretBox('x'), secret]`, the messages of `z.object({ u: field(inner()) })` equal those of `z.object({ u: inner() })`.
24. `a value the inner schema refuses gets the plain field's error` — the same comparison for `url` with `'no'`, `mode` with `'smpt'` and `min` with `'no'`; for `url` with `'no'` the messages are exactly `['Invalid URL']`.
25. `a missing key gets the plain field's error` — for every inner, the messages for `{}` are equal; for `string` they are exactly `['Invalid input: expected string, received undefined']`.
26. `a wrong type names the inner type` — `messages(z.object({ from: field(z.string()) }), { from: 3 })` is exactly `['Invalid input: expected string, received number']`.
27. `no message names a Composer class` — every message produced in tests 23 to 25 contains neither `Pointer` nor `Source`.
28. `optional works inside and outside the wrapper` — `z.object({ from: field(z.string()).optional() })` and `z.object({ from: field(z.string().optional()) })` each parse `{}` to `{}`.
29. `a default works outside the wrapper` — `z.object({ from: field(z.string()).default('d') }).parse({})` equals `{ from: 'd' }`.

### 13.4 Core: new file `packages/0-framework/1-core/core/src/__tests__/field.test-d.ts`

Imports `StandardSchemaV1` from `@standard-schema/spec`; `expectTypeOf`, `test` from `vitest`; `field as arkField`, `secretString as arkSecretString` from `@internal/foundation/arktype`; `field as zodField`, `secretString as zodSecretString` from `@internal/foundation/zod`; `type` from `arktype`; `z` from `zod`; types `ModuleInputField`, `Pointer`, `RuntimeValue`, `SecretString`, `Value` and values `isPlainPointer`, `isSecretPointer`, `module`, `service` from `../exports/index.ts`. Declared fixtures: `plainRuntime: RuntimeValue<string>`, `secretRuntime: RuntimeValue<SecretString>`, `text: Value<string>`, `secretValue: Value<SecretString>`. The ArkType schema `arkSchema = type({ from: arkField(type('string')), port: arkField(type('string.integer.parse')), host: 'string', key: arkSecretString() })` and the Zod schema `zodSchema = z.object({ from: zodField(z.string()), port: zodField(z.string().transform(Number)), host: z.string(), key: zodSecretString() })`; modules `arkChild` and `zodChild` declaring them as `input` with empty bodies.

30. `ArkType: a wrapped field's input is In | Pointer<In> and its output Out | Pointer<In>` — on `StandardSchemaV1.InferInput<typeof arkSchema>`, `from` and `port` are `string | Pointer<string>`; on `InferOutput`, `from` is `string | Pointer<string>` and `port` is `number | Pointer<string>`; `host` is `string` in both.
31. `Zod: a wrapped field's input is In | Pointer<In> and its output Out | Pointer<In>` — the same for `zodSchema`.
32. `a plain field takes no pointer` — `@ts-expect-error` on assigning `{} as Pointer<string>` to `InferInput<typeof arkSchema>['host']`, and to the Zod one.
33. `a wrapped field of another type takes no pointer to text` — `@ts-expect-error` on assigning `{} as Pointer<string>` to `InferInput` of `arkField(type('number'))`, and of `zodField(z.number())`.
34. `a wrapped text field takes no secret pointer` — `@ts-expect-error` on assigning `{} as Pointer<SecretString>` to `InferInput<typeof arkSchema>['from']`, and to the Zod one.
35. `secretString() still reads as SecretString in both libraries` — `InferInput` and `InferOutput` of `arkSecretString()` and of `zodSecretString()` are each `SecretString`.
36. `ArkType: a default outside the wrapper keeps the wrapped output` — `InferOutput<typeof type({ from: arkField(type('string')).default('d') })>['from']` is `string | Pointer<string>`.
37. `in a module body a wrapped field is a value of Out | Pointer<In>` — in `module('m', { input: arkSchema }, ({ input }) => …)`, `input.from` is `ModuleInputField<string | Pointer<string>>`, `input.port` is `ModuleInputField<number | Pointer<string>>`, `input.host` is `ModuleInputField<string>`; the same for `zodSchema`.
38. `a wrapped field's binding takes a literal, a deploy-time value and a plain runtime value` — in a root body, `provision(arkChild, { input: { from: 'x', port: '1', host: 'h', key: secretValue } })`, the same with `from: text, port: text`, and with `from: plainRuntime, port: plainRuntime` all compile; the same three for `zodChild`.
39. `a wrapped field's binding refuses a secret runtime value` — `@ts-expect-error` on `from: secretRuntime`, for `arkChild` and `zodChild`.
40. `a plain field's binding refuses a runtime value` — `@ts-expect-error` on `host: plainRuntime`, for both.
41. `a secretString() field's binding refuses a plain runtime value` — `@ts-expect-error` on `key: plainRuntime` for `arkChild`.
42. `a wrapped module field passes on into a service's input binding` — a `service({ name: 'sink', extension: 'test/pack', type: 'fake/compute', inputs: {}, params: {}, input: type({ from: arkField(type('string')) }), build })` (with `build` as in `source-load.test.ts`), and `module('m', { input: type({ from: arkField(type('string')) }) }, ({ input, provision }) => { provision(sink, { input: { from: input.from } }); })` compiles.
43. `RuntimeValue<T> is Value<Pointer<T>>` — `expectTypeOf<RuntimeValue<string>>().toEqualTypeOf<Value<Pointer<string>>>()`.
44. `isPlainPointer() narrows to Pointer<string>, isSecretPointer() to Pointer<SecretString>` — for `x: unknown`, inside `if (isPlainPointer(x))` `x` is `Pointer<string>`, inside `if (isSecretPointer(x))` it is `Pointer<SecretString>`.
45. `the two kinds of pointer do not fit each other` — `@ts-expect-error` on `const a: Pointer<string> = {} as Pointer<SecretString>` and on the reverse.

### 13.5 Core: new file `packages/0-framework/1-core/core/src/__tests__/pointer.test.ts`

Imports `field` from `@internal/foundation/arktype`; `isPlainPointer`, `isSecretPointer` from `@internal/foundation/pointer`; `type` from `arktype`; `Load`, `LoadError` and `type Graph` from `../graph.ts`; `type ModuleNode`, `module`, `paramSource`, `secretSource`, `isSecretSource`, `service` from `../node.ts`; `environmentFacts`, `isValue`, `resolve` from `../value.ts`; `string` from `../config.ts`; `anyInputSchema` from `./helpers.ts`. Fixtures copied from `source-load.test.ts`: `build`, `echoService`, `loadError`, `shopWith`, `bindingOf`, `pointer`, `origin`; plus `copyOf`, and:

```ts
/** A module `relay` whose `input` schema is `schema` and whose body passes `base` to `echo`. */
const relay = (schema: StandardSchemaV1<{ base: unknown }, { base: unknown }>): ModuleNode =>
  module('relay', { input: schema }, ({ input, provision }) => {
    provision(echoService(), { input: { base: input.base as never } });
  });
```

(`StandardSchemaV1` imported as a type from `@standard-schema/spec`.) In commit 2 (§ 15) the file holds tests 46 to 53 and only the imports and fixtures they use; commit 7 adds the `field` import and tests 54 to 56.

46. `secretSource() is a secret pointer` — `[isSecretPointer, isPlainPointer]` of `pointer('K')` is `[true, false]`.
47. `paramSource() without a pool key is a plain pointer, or a secret pointer when redacted` — `paramSource({}, { sentinel: 'x' })` and `paramSource({})` are plain pointers; `paramSource({}, { redacted: true })` is a secret pointer.
48. `paramSource() with a pool key is no pointer` — `paramSource({}, { poolKey: 'X' })`: both `false`.
49. `the kind is data on the source, under the registered symbol prisma:pointer` — `Reflect.get(pointer('K'), Symbol.for('prisma:pointer'))` is `'secret'`, and for `origin()` it is `'plain'`; `Object.keys(pointer('K'))` is `['payload']`; `JSON.stringify(secretSource({ name: 'X' }))` is `'{"payload":{"name":"X"}}'`.
50. `environment.name, a resolve() result and plain data are no pointer` — `environmentFacts.name`, `resolve([environmentFacts.name], ([n]) => n)`, `'x'` and `{}`: both `false`.
51. `an ArkType copy of a source is a different object with the same brands, kind and payload` — `copyOf(pointer('K'))` is not `toBe` the source; `isValue`, `isSecretSource` and `isSecretPointer` are each `true` for it; its `payload` equals the source's.
52. `a copy of a secret source in a service's binding is listed once, as its original` — `const key = pointer('K'); const copy = copyOf(key);` a root `shop` provisions `echoService()` with `input: { a: key, b: copy }`; `bindingOf(graph)['b']` is `toBe(copy)`; `graph.secretSources` equals `[{ source: key, address: 'shop.echo', nodeKind: 'service' }]`, and its `[0].source` is `toBe(key)`.
53. `a copy of a runtime param source in a module's input reaches the service as the original` — `const source = origin();` `Load(shopWith(relay(type({ base: 'string' })), { base: copyOf(source) }))`; `bindingOf(graph)['base']` is `toBe(source)`. (`shopWith` provisions with id `email`, so the service is `shop.email.echo`.)
54. `a wrapped field reports the plain field's error at Load` — the messages of `loadError(() => Load(shopWith(module('email', { input: type({ from: 'string' }) }, () => {}), { from: 3 })))` and of the same with `from: field(type('string'))` are equal, and the wrapped one is exactly `The input binding of module "shop.email" does not match the module's input schema: from must be a string (was a number)`.
55. `a wrapped field takes a runtime param source's stand-in at Load, and the service receives the source` — `Load(shopWith(relay(type({ base: field(type('string')) })), { base: source }))` with `source = origin()`; `bindingOf(graph)['base']` is `toBe(source)`.
56. `a secret source bound to a wrapped text field fails at Load with the plain field's error` — `relay(type({ base: field(type('string')) }))` bound `{ base: pointer('K') }`; the message equals the one with `type({ base: 'string' })` and is exactly `The input binding of module "shop.email" does not match the module's input schema: base must be a string (was an object)`.

### 13.6 Prisma Cloud target, `packages/1-prisma-cloud/1-extensions/target/src/__tests__/`

Each file imports `isPlainPointer` and `isSecretPointer` from `@internal/core` where it uses them, and `copyOf` is defined at its top with `type` from `arktype`.

57. `secret.test.ts`, `describe('envSecret() as a value', …)`: `envSecret() is a secret pointer` — `isSecretPointer(envSecret('X'))` is `true` and `isPlainPointer` is `false`.
58. `param.test.ts`, new `describe('the kind of pointer each source is', …)`: `serviceOrigin() and a plain generatedParam() are plain pointers, a redacted generatedParam() is a secret pointer, and envParam() is no pointer` — `isPlainPointer(serviceOrigin('shop.web'))`, `isPlainPointer(generatedParam({ redacted: false }))` and `isSecretPointer(generatedParam())` are `true`; both are `false` for `envParam('X')`.
59. `input-serializer.test.ts`, new `describe('an ArkType copy of a source', …)`: `a copy of envSecret() serializes to its $secret pointer` — `JSON.parse(serializeInput(svc(type({ key: secretString() })), 'web', { key: copyOf(envSecret('STRIPE_SECRET_KEY')) }, { env: {} })?.value ?? '')` equals `{ key: { $secret: 'STRIPE_SECRET_KEY' } }`.
60. Same `describe`: `a copy of serviceOrigin() serializes to its $generated pointer` — `svc(type({ base: 'string' }))`, `{ base: copyOf(serviceOrigin('shop.web')) }`; the document equals `{ base: { $generated: 'COMPOSER_WEB_BASE_GENERATED', redacted: false } }` and `row?.generated[0]?.origin` is `'shop.web'`.
61. Same `describe`: `a copy of a redacted generatedParam() serializes to its $generated pointer` — `svc(type({ secret: secretString() }))`, `{ secret: copyOf(generatedParam()) }`; the document equals `{ secret: { $generated: 'COMPOSER_WEB_SECRET_GENERATED', redacted: true } }`.
62. `preflight.test.ts`, new `describe('preflight names', …)`: `an envSecret() and its ArkType copy are one name to check` — `inputSecretNames({ a: key, b: copyOf(key) }, 'app.web')` with `key = envSecret('STRIPE_SECRET_KEY')` equals `['STRIPE_SECRET_KEY']` (`inputSecretNames` imported from `../preflight-names.ts`).

### 13.7 Existing tests

No existing test changes. If one fails, the implementer stops and reports. In particular `source-value.test.ts`'s `Object.keys` and `JSON.stringify` tests, and every `toEqual` over `graph.secretSources`, must pass unchanged.

## 14. Scope

In: `packages/0-framework/0-foundation/foundation` (§ 3 to § 6), `packages/0-framework/1-core/core` (§ 7, tests), `packages/9-public/composer` (§ 8, § 9), `packages/1-prisma-cloud/1-extensions/target` (tests only), `architecture.config.json`, `tsconfig.depcruise.json`, `pnpm-lock.yaml`, `docs/`, `skills/`, `.drive/deferred.md`.

Out, as the plan assigns: binding pointers to schemas at deploy, removing the stand-ins and `paramSource()`'s `sentinel` option, the second check of ArkType service schemas with stand-in boxes, `service.input()` without pointers, and wrapping the auth service's schema and the examples (S7); `resolve()` refusing runtime values and wrapped fields, and removing `isRuntimeValue()` (S8); the dictionary brand on `input` (S9); typing a service's binding from its schema and treating `SecretString` and `Pointer` as leaves (S10); `secret(schema)` (S17). Also out: changing the source constructors' types (§ 17, decision 4).

## 15. Commits, in order

Each commit is signed off as the repo's git instructions say and ends with the attribution lines the session gives. Each leaves `pnpm build`, `pnpm typecheck` and the touched packages' tests green.

1. `feat(foundation): a pointer records whether it is secret` — § 3.1, § 3.2, the `pointer` tsdown entry, the regenerated foundation `exports`, the `@internal/foundation/pointer` entry in `tsconfig.depcruise.json`, tests 1 to 3.
2. `feat(core): a runtime source is a secret or a plain pointer` — § 7.1, § 7.3, § 7.4, tests 46 to 53.
3. `feat(foundation): secretString() accepts a secret pointer` — § 4, tests 4 and 5.
4. `feat(foundation): field() wraps an ArkType leaf field` — § 5, tests 6 to 16.
5. `feat(foundation): field() and secretString() for Zod` — § 6, the `zod` tsdown entry, the foundation `description`, `dependencies` and regenerated `exports`, the `@internal/foundation/zod` entry in `tsconfig.depcruise.json`, the lockfile, tests 17 to 29.
6. `feat: @prisma/composer/zod` — § 8 and the rest of § 9 for `@prisma/composer` and `architecture.config.json`, the lockfile.
7. `feat(core): a service binding takes a forwarded wrapped field` — § 7.2, core's `zod` devDependency, the lockfile, tests 30 to 45, tests 54 to 56.
8. `test(prisma-cloud): sources are pointers of a kind, and a copy still counts` — tests 57 to 62.
9. `docs(design): the glossary's Input, Value, RuntimeValue and field() entries` — § 12.1.
10. `docs(design): record field(), the Zod entry and the two kinds of pointer` — § 12.2, § 12.3.
11. `docs: teach field() and @prisma/composer/zod in the guide and the agent skill` — § 12.4, § 12.5.
12. `docs(drive): defer ArkType's missing-key wording and Zod's pathless messages` — § 12.6.
13. `docs(drive): module-input S6 manual QA` — `qa.md` (§ 16).

## 16. Done when

- Tests 1 to 62 pass. At the root: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm lint:deps`, `pnpm test`, `pnpm turbo run test:types`, `pnpm check:floor-imports`, `pnpm check:publish-deps` and `pnpm check:skill-packaging` are green. `pnpm lint:casts` reports no new bare cast: the four casts this slice adds are `blindCast` calls with reasons.
- Every document in § 12 is updated.
- Manual QA, recorded in `qa.md` in this slice's folder, after `pnpm build`:
  1. **The published package, outside the workspace.** `QA=$(mktemp -d)`; `(cd packages/9-public/composer && pnpm pack --pack-destination "$QA")`; in `$QA`, `npm init -y` and `npm install ./prisma-composer-*.tgz arktype@2.2.7 zod@4.4.3`. `npm ls zod` lists `zod@4.4.3` under `@prisma/composer`. A file `check.mjs`:

     ```js
     import { isPlainPointer, isSecretPointer } from '@prisma/composer';
     import { field as arkField } from '@prisma/composer/arktype';
     import { field as zodField, secretString as zodSecretString } from '@prisma/composer/zod';
     import { type } from 'arktype';
     import { z } from 'zod';
     console.log(String(type({ from: arkField(type('string')) })({ from: 3 })));
     console.log(z.object({ from: zodField(z.string()) }).safeParse({}).error.issues[0].message);
     console.log(z.object({ k: zodSecretString() }).safeParse({ k: 'x' }).error.issues[0].message);
     console.log(isPlainPointer({}), isSecretPointer({}));
     ```

     `node check.mjs` prints exactly:

     ```text
     from must be a string (was a number)
     Invalid input: expected string, received undefined
     must be a SecretString box — bind this field to a secret (was a string)
     false false
     ```

  2. **Sources still reach a running service.** In `examples/email`, with `EMAIL_DELIVERY_MODE`, `EMAIL_FROM` and `EMAIL_DELIVERY_CREDENTIAL` unset in the shell, create `.env.dev` holding `EMAIL_DELIVERY_MODE=none`, `EMAIL_FROM=s6-qa-dev@example.com` and `EMAIL_DELIVERY_CREDENTIAL=local-dev-unused`. `prisma dev --detach`; with `URL=$(prisma dev url email-example.mailer)`, `curl -sS -X POST "$URL/signup" -H 'content-type: application/json' -d '{"email":"s6-qa@example.com","name":"S6 QA"}'` returns an `id`, and `curl -sS "$URL/emails/$ID"` shows `"from":"s6-qa-dev@example.com"`. `prisma dev stop`, then remove `.env.dev`; `git status` shows only this slice's changes.

## 17. Decisions this spec records, for the review

1. **`Pointer` and its two checks live in `@internal/foundation`**, in a new `./pointer` subpath (§ 3). `secretString()` must accept a secret pointer and lives in foundation, which is below core and cannot import it. `isSecretString()` sits there for the same reason. Core re-exports the public names.
2. **The kind is the value of one registered symbol, `Symbol.for('prisma:pointer')`** (§ 3.1, § 7.1): `'secret'` or `'plain'`, set only on a source whose real value is a pointer. A registered symbol survives an ArkType copy and a duplicated copy of the module, and stays out of `Object.keys` and `JSON.stringify`, so S3's tests and the wire format do not change. A separate pointer brand plus a kind field would be two properties to keep in step.
3. **`paramSource()`'s `redacted` option decides the kind now** (§ 7.1). A param source with a pool key is no pointer. The design gives `redacted` this job in S7; the kind has to come from somewhere in S6, and `redacted` already says what S7 will say.
4. **The source constructors keep their types** (§ 2, § 14). Typing `envSecret()` as `RuntimeValue<SecretString>` and `serviceOrigin()` as `RuntimeValue<string>` makes `auth()`'s plain `baseUrl` field refuse `serviceOrigin()` and makes a forwarded secret stop fitting `secretString()`. Fixing those wraps the auth module's schema and changes `secretString()`'s types, which S7 does. The plan does not say which slice changes the constructors; § 18, conflict 3.
5. **`secretString()` accepts a secret pointer at run time, and its types stay `SecretString`** (§ 4, § 6.1). Its output type is what `service.input()` returns. Adding `Pointer<SecretString>` to it would break `.expose()` in every service until S7 removes pointers from `service.input()`'s type. Zod's new `secretString()` is typed the same way so the two libraries change together in S7.
6. **`InputBindingData` gains `Pointer<unknown>`** (§ 7.2). Without it a wrapped module field cannot be passed into any service's `input` binding, which is how a module uses its input. The loose type stays loose until S10 replaces it. `Pointer<unknown>` admits a pointer of any type, as the loose type admits any source.
7. **ArkType's `field()` is the union plus `configure({ problem })`** (§ 5). The design suggests a description on the pointer branch. Probes show a description changes neither the wrong-type nor the missing-key message (§ 18, conflict 1). `configure({ problem })` is ArkType's documented way to set an error's text, and delegating to `inner` reproduces the plain field's message exactly for every present value.
8. **Zod's `field()` is `z.union` with an `error` function** (§ 6.1), as the design says. It returns `inner`'s first message for the union's own issue.
9. **The Zod refusal text for `secretString()` mirrors ArkType's**, without the path, which Zod messages never carry (§ 11). The plain-pointer wording is the same in both.
10. **`zod` is a regular dependency, `^4.4.3`**, of `@internal/foundation` and `@prisma/composer` (§ 9), because that is how `arktype` ships for `@prisma/composer/arktype`. An optional peer dependency would let an app keep its own Zod, but would make the two entries differ in how they are installed.
11. **Zod's `field()` takes a classic `z.ZodType`** (§ 6.1), the type `z.string()` returns. `zod/mini` schemas are not covered.
12. **`field()` has no run-time check of its argument** (§ 5, § 6.1), as `secretString()` and the rest of the foundation helpers have none. TypeScript refuses a wrong argument.
13. **Load, preflight and the serializer keep their code** (§ 10). Each already recognises a source by its brands and payload, and a copy keeps both. The tests in § 13.5 and § 13.6 prove it for each.
14. **Type tests live in core, run-time tests of the helpers in foundation** (§ 13). Foundation has no vitest set-up; core does, and its tests already import `@internal/foundation/arktype`. Core gains `zod` as a devDependency for this.
15. **The guide and the skill describe `field()` in this slice** (§ 12.4, § 12.5). The plan has S7 teach `field()` as the way to write a reusable module. The repo's `user-facing-surface-changes` instruction requires the guide and the skill to change with any new public export, so this slice describes what ships, and S7 makes it the idiom.
16. **The glossary's Superseded terms bullet for Input gains a sentence** (§ 12.1, item 10). The design renames the input entry "Input", and that bullet says "Input" was retired as a name for a connection's end. The sentence says which meaning the word has now.
17. **Two decision records are amended: service input and `resolve()`** (§ 12.2). They are the two this slice changes: the service input decision describes `secretString()` and the arktype entry, and the `resolve()` decision defines runtime values and pointers. The module input decision's text does not depend on `field()`, and S7 amends the service input decision again for pointers at deploy.

## 18. Conflicts

1. **ArkType cannot report the plain field's message for a missing key, and a description on the pointer branch does not help.** The plan asks to prove whether ArkType can. Evidence, with probes in `wip/s6-field-probe/` of the composer worktree (git-ignored), run against the repo's `arktype` 2.2.7:
   - `ark-a.ts`: with the pointer branch described (`.describe('a value known only at boot')`), `3` for `field(type('string'))` still gives `u must be a string or an object (was a number)`, and a missing key `u must be a string or an object (was missing)`. `describe()` and `configure({ expected })` on the union change only the non-pointer-object case.
   - `ark-b.ts` and `run.ts`: `configure({ problem })` on the union gives the plain message for every present value, for `string`, `string.url`, `string.integer.parse`, `'resend' | 'smtp' | 'none'`, `number` and `string.trim`. Only the missing-key case differs, in all six.
   - The reason, in `@ark/schema` 0.56.6: `structure/required.js` builds the missing-key error with `missingValueDescription: this.value.defaultShortDescription` and the required node's own meta; `roots/union.js`'s `defaultShortDescription` joins its branches' default descriptions and ignores `meta`; only `roots/morph.js`'s reads `rawIn.meta.description`.
   - `ark-morph.ts`: a morph pointer branch does give `u must be a string (was missing)`. But `shared/traversal.js`'s `finalize` deep-copies the whole input whenever a morph is queued, so with a pointer present a `SecretBox` elsewhere in the input loses its value (`expose THROWS`). S7's second check of ArkType service schemas, with stand-in boxes and plain pointers side by side, would then refuse every such service. This spec does not use it.
   
   So S6 ships ArkType's own wording for a missing wrapped key, `from must be a string or an object (was missing)`: it names no Composer class, but it is not the plain field's message. A root's fields stay plain (design section 7), so the root's missing-variable message is unchanged, and a missing key in a typed module binding fails to compile. **This needs Will's acceptance**, or a change to the design's sentence "A missing required field and a value of the wrong type keep the inner schema's message".
2. **"Recognise a pointer by its brand and the variable it names."** Core never reads a target's payload (`node.ts`: "Core never reads this"), and for `generatedParam()` and `serviceOrigin()` the variable's name does not exist until the target serializes. So core recognises a pointer by its brands and kind, and treats a copy as the same pointer through the origin object every copy shares (§ 10). The target recognises a source by its payload's brand and reads the variable's name, as it does today. No identity check decides whether something is a pointer.
3. **The plan does not say which slice types the constructors as `RuntimeValue`.** The design says a runtime value is a `RuntimeValue<T>` and `envSecret()` gives a `Pointer<SecretString>`. S8's compile error for listing a runtime value in `resolve()` needs that type. This spec leaves it to S7, which wraps the fields that the new types would otherwise break (§ 17, decision 4). The orchestrator should put it in S7's spec.
4. **Between S6 and S7, a service schema that uses `field()` reads `string | Pointer<string>` from `service.input()`.** S7 removes pointers from that type. Nothing in the repo wraps a service field in S6, and the guide does not tell anyone to.
5. **The plan has S7 teach `field()`; the repo requires the guide and skill to describe each new public export in the same pull request** (§ 17, decision 15).
6. **Renaming the glossary entry "Input" reuses a word the glossary lists as superseded** for a connection's end (§ 17, decision 16). The design chose the name; this spec only adds the sentence that tells the two apart.
7. **`core-model.md` links to a glossary anchor that does not exist**, `#configuration--config-and-secrets`. This spec points it at `#input` (§ 12.3).
8. **Composer's Load error for a Zod schema does not name the field**, because Zod messages carry no path and Load joins only `message`. Found while writing the message tests; recorded as deferred (§ 12.6), not fixed here.
9. **`design.md` and the current `plan.md` are not on this branch.** They are on `claude/module-input` (`.drive/projects/module-input/` in the composer worktree), which the stacked branches do not yet contain. This branch's `plan.md` and `design-notes.md` are the older versions. The links in this spec's header resolve once the stack carries them; until then the implementer reads them from `claude/module-input`.
