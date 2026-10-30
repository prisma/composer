# S7 — Schemas see pointers at deploy

Parent: [module-input spec](../../spec.md) and [plan](../../plan.md). Design: [design.md](../../design.md), which is authoritative; this slice builds the part of its sections 3, 5 and 10 that the plan's S7 paragraph names. Decisions: the service input decision ([ADR-0042](../../../../../docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md)), the module input decision ([ADR-0061](../../../../../docs/design/90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)) and the `resolve()` and config adapters decision ([ADR-0062](../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), each with its amendments. It builds on S6 (branch `claude/module-input-s6`), which builds on S5, S4, S3 and S2. The branch is `claude/module-input-s7`.

This spec leaves nothing to the implementer's judgement. Every type, signature, name, error message, file, test, document edit and commit is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose. § 18 lists the decisions this spec takes, and § 19 the conflicts it found.

Every code change and every test in § 3 to § 8 and § 13 was applied and run in a scratch copy of this branch, against the repo's installed `arktype` 2.2.7 and `zod` 4.4.3, as a whole and commit by commit in the order of § 15; § 17 lists what ran and what passed.

Read for this spec: `CLAUDE.md`; `docs/design/01-principles/`; the three decisions above with every amendment; the glossary entries Input, Value, RuntimeValue and `field()`; `module-composition.md` § Input; `config-params.md` § Sources are values; the S6 spec and its reviews; `.agents/rules/no-bare-casts.mdc`, `test-import-patterns.mdc`, `vitest-expect-typeof.mdc` and `user-facing-surface-changes.mdc`; `skills/README.md`; and the code each section names.

`<date>` below is the date the pull request is opened, as `YYYY-MM-DD`.

## 1. At a glance

```ts
// a service whose input takes another service's origin
import { field, secretString } from '@prisma/composer/arktype';
import { type } from 'arktype';

const billing = compute({
  name: 'billing',
  input: type({ returnUrl: field(type('string')), stripeKey: secretString() }),
  /* … */
});

provision(billing, {
  input: { returnUrl: serviceOrigin('shop.web'), stripeKey: envSecret('STRIPE_KEY') },
});

// in the service: no pointer in the type
const { returnUrl, stripeKey } = billing.input(); // returnUrl: string, stripeKey: SecretString
```

At deploy, the schema now checks `serviceOrigin('shop.web')` and `envSecret('STRIPE_KEY')` as their pointers, the source objects themselves. S3 to S6 checked stand-in values instead. So a plain field refuses a value known only at boot:

```text
type({ returnUrl: 'string' }), bound to serviceOrigin('shop.web')
  compile:  Type 'ParamSource<OriginParamPayload> & RuntimeValue<string>' is not assignable …   (in a module's binding)
  deploy:   invalid input for service "shop.billing": config param validation failed: returnUrl must be a string (was an object)
```

An ArkType service schema that copies its input loses a secret box's value at boot. The deploy now finds this with a second check and refuses the service, for `envSecret()` and for a redacted `generatedParam()`:

```text
type({ key: secretString(), port: field(type('string.integer.parse')) })
  input key "key" of service "web" validated to a copy of its secret, and the copy has lost the secret's value: …
```

## 2. The model

- **A schema sees each runtime value as its pointer.** A pointer is the source object of `envSecret()`, `generatedParam()` or `serviceOrigin()` (S3), which records its kind (S6). Load passes it to a module's schema, and the serializer to a service's schema, as it is. `secretString()` accepts a secret pointer, a field wrapped with `field()` accepts a plain pointer, and a plain field accepts neither.
- **The stand-ins go.** Load no longer builds an empty `SecretBox` for a secret or a sentinel string for a plain runtime value. The serializer no longer builds an empty `SecretBox` for `envSecret()` or a redacted `generatedParam()`, `''` for a plain `generatedParam()`, or `https://origin.invalid` (`ORIGIN_SENTINEL`) for `serviceOrigin()`. `paramSource()` loses its `sentinel` option. Its `redacted` option alone decides the pointer's kind.
- **A copy counts as the same pointer.** A schema may return a copy of a pointer (S6). Load replaces each pointer in a module schema's output with its original, `origin.source`, so a child receives the source the binding named. The serializer writes each pointer in a service schema's output by its brands: `isSecretSource()` gives `$secret` with the payload's name, and `isParamSource()` gives `$generated` with the leaf recorded at that path.
- **The second check.** For a service whose resolved binding holds a secret pointer, the serializer runs the schema a second time, with `new SecretBox('composer-stand-in-not-a-secret')` in place of each secret pointer. If any `SecretBox` in that output does not give back that text from `expose()`, the deploy refuses the service, naming the field. A box that throws from `expose()` counts as not giving it back: ArkType's copy of a `SecretBox` has no private `#value`.
- **The source constructors are runtime values.** `envSecret()` is `SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>`, `serviceOrigin()` is `ParamSource<OriginParamPayload> & RuntimeValue<string>`, and `generatedParam()` is `ParamSource<GeneratedParamPayload> & RuntimeValue<SecretString>`, or `& RuntimeValue<string>` for `{ redacted: false }`. This is S6's conflict 3, resolved here.
- **`secretString()` admits its pointer in its types.** Both libraries' `secretString()` is typed `SecretString | Pointer<SecretString>`, input and output, because at deploy its output is the pointer.
- **`service.input()` has no pointers.** `InputValueOf<I>` is the schema's output with every pointer removed, at any depth: a wrapped field reads as `Out`, and a `secretString()` field as `SecretString`. `mockService()`'s input double has the same type. This resolves S6's conflict 4.
- **The shared modules wrap.** `auth()`'s and its service's `baseUrl`, and `email()`'s and its service's `deliveryMode` and `from`, become wrapped fields. The examples need no code change: the only runtime value an example binds into a schema field is the auth example's `serviceOrigin()`, into `auth()`'s now-wrapped `baseUrl`.

## 3. Foundation: `secretString()` admits its pointer

### 3.1 `packages/0-framework/0-foundation/foundation/src/arktype.ts`

In `secretString`, the predicate's return type `value is SecretString` becomes `value is SecretString | Pointer<SecretString>`. Nothing else in the file changes. The function is then exactly:

```ts
export const secretString = () =>
  type('unknown').narrow(
    (value, ctx): value is SecretString | Pointer<SecretString> =>
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

### 3.2 `packages/0-framework/0-foundation/foundation/src/zod.ts`

`secretString` becomes exactly (Biome's formatting):

```ts
export const secretString = () =>
  z.custom<SecretString | Pointer<SecretString>>(
    (value) => isSecretString(value) || isSecretPointer(value),
    {
      error: (issue) =>
        `must be a SecretString box — bind this field to a secret (was ${
          isPlainPointer(issue.input)
            ? 'a value known only at boot that is not a secret'
            : describeKind(issue.input)
        })`,
    },
  );
```

The doc comments of both functions do not change. Their messages do not change.

## 4. Core: service input without pointers

### 4.1 `packages/0-framework/1-core/core/src/node.ts`

`InputValueOf` and its doc comment are replaced by:

```ts
/**
 * `T` with every pointer removed, at any depth: what a service reads at boot,
 * when each pointer has been replaced by the text of the variable it names.
 */
type WithoutPointers<T> =
  T extends Pointer<unknown>
    ? never
    : T extends SecretString
      ? T
      : T extends object
        ? { [K in keyof T]: WithoutPointers<T[K]> }
        : T;

/** What `input()` returns: the schema's validated output type with every pointer removed; `never` on a service that declares no input schema. */
export type InputValueOf<I> = I extends StandardSchemaV1
  ? WithoutPointers<StandardSchemaV1.InferOutput<I>>
  : never;
```

`WithoutPointers` is not exported. The mapped type is homomorphic, so it keeps optional and `readonly` modifiers and maps an array to an array; a schema without type information still reads as `unknown` (tests 1 to 4).

### 4.2 `packages/0-framework/1-core/core/src/testing.ts`

`LoadOverrides` becomes (one line, Biome's formatting):

```ts
export type LoadOverrides<
  D extends Deps,
  I extends StandardSchemaV1 | undefined,
> = HydratedDeps<D> & (I extends StandardSchemaV1 ? { input: InputValueOf<I> } : { input?: never });
```

Its doc comment does not change. `mockService`'s body does not change: it already casts to `InputValueOf<I>`.

`packages/1-prisma-cloud/1-extensions/target/src/compute.ts` does not change: `ComputeService.input()` already returns `InputValueOf<I>`.

## 5. Core: a module's schema checks each runtime value as its pointer

### 5.1 `packages/0-framework/1-core/core/src/value.ts`

In `ValueOrigin`'s `'source'` member, the two fields `sentinel` and `redacted`, with their doc comments, are removed. The member is then:

```ts
  | {
      readonly kind: 'source';
      /** How an error names the source, e.g. `envSecret('STRIPE_KEY')`. */
      readonly label: string;
      /** The config pool key whose value at deploy is the real value, as for `envParam()`. `undefined` for a value known only at boot, whose real value is `source`, a pointer. */
      readonly poolKey: string | undefined;
      /** The source itself. Not enumerable, so a copy's origin compares equal and the origin holds no cycle. */
      readonly source: ParamSource | SecretSource;
    };
```

### 5.2 `packages/0-framework/1-core/core/src/node.ts`

- `ParamSourceOptions`: the `sentinel` field and its doc comment are removed. The `redacted` field's doc comment becomes `/** For a source known only at boot: \`true\` makes the source a secret pointer, whose variable holds a secret; otherwise it is a plain pointer. */`.
- `secretSource()`: the origin object passed to `buildSource` loses `sentinel: undefined,` and `redacted: true,`, leaving `{ kind: 'source', label, poolKey: undefined, }` laid out one key per line as today.
- `paramSource()`: the lines from `const sentinel = options?.sentinel;` to the closing brace of the `if (sentinel !== undefined && redacted)` block are replaced by:

  ```ts
  const redacted = options?.redacted === true;
  if (poolKey !== undefined && redacted) {
    throw new Error(
      'paramSource() takes poolKey, for a value known at deploy, or redacted, for a secret known only at boot, not both.',
    );
  }
  ```

  and the origin passed to `buildSource` becomes `{ kind: 'source', label, poolKey }`. The pointer-kind argument does not change: `poolKey !== undefined ? undefined : redacted ? 'secret' : 'plain'`.

A third-party target that still passes `sentinel` gets a compile error, and at run time the key is ignored: the source is a plain pointer (§ 18, decision 5).

### 5.3 `packages/0-framework/1-core/core/src/resolve-values.ts`

- Imports: `import { isSecretString, SecretBox } from '@internal/foundation/secret';` becomes `import { isSecretString } from '@internal/foundation/secret';`, and `type ParamSource,` is removed from the `./node.ts` import.
- The line `const SENTINEL_SOURCE = Symbol('prisma:module-input-sentinel');` and the blank line after it are removed.
- Directly before `function validateModuleInput(`, a new function:

  ```ts
  function refuseSecretBoxes(address: NodeId, value: unknown, path: string): void {
    if (isSecretSource(value) || isParamSource(value)) return;
    if (isSecretString(value)) {
      throw new LoadError(
        `${describeSite({ address, kind: 'moduleInput', path })} is bound to a SecretString. A secret's value never appears in the code; bind envSecret('NAME'), or pass on an input field typed secretString().`,
      );
    }
    if (Array.isArray(value)) {
      for (const [index, member] of value.entries()) {
        refuseSecretBoxes(address, member, joinPath(path, index));
      }
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, member] of Object.entries(value)) {
        refuseSecretBoxes(address, member, joinPath(path, key));
      }
    }
  }
  ```

  The source check comes first because a source is a frozen object whose prototype is `Object.prototype`, so `isPlainObject()` is true for it.
- In `validateModuleInput`, everything from `const textPointers = new Map<string, ParamSource>();` up to and including `const result = entry.schema['~standard'].validate(withSentinels(resolved, ''));` is replaced by:

  ```ts
  refuseSecretBoxes(address, resolved, '');
  const result = entry.schema['~standard'].validate(resolved);
  ```

  The two issue branches after it do not change.
- In `restore`, the opening block from `const pointer = textPointers.get(path);` to its closing brace is replaced by:

  ```ts
  if (isSecretSource(value) || isParamSource(value)) {
    return sourceOriginOf(value)?.source ?? value;
  }
  ```

  and in the `isSecretString(value)` branch the five lines from `const tag = blindCast<` to `if (isSecretSource(tag) || isParamSource(tag)) return tag;` are removed, so the branch throws its existing error at once. `blindCast` stays imported; other code in the file uses it.

What this changes at Load:

- A module's schema receives the binding with every source in place. `withSentinels` threw for a raw `paramSource()` with neither `sentinel` nor `redacted`; such a source is now a plain pointer, checked like `serviceOrigin()`.
- `restore` puts the original source back wherever the output holds a source or a copy of one, by its brands. A copy shares its original's origin object (S6), so `origin.source` is the original.
- The check that a module's schema left a runtime value's field unchanged stays, rewritten for pointers (§ 18, decision 7): Load records the source the binding put at each path, and `restore` fails when the output holds another value at such a path, or holds a source at a path the binding did not put it at. Its old message (`The input schema of module … changed input key …`) becomes the two Load messages in § 10. *(Corrected after the code review: the first version of this spec removed the check.)*

## 6. Prisma Cloud target: the source constructors

### 6.1 `packages/1-prisma-cloud/1-extensions/target/src/secret.ts`

- The first import becomes `import { type Pointer, type RuntimeValue, type SecretSource, secretSource } from '@internal/core';`.
- `envSecret`'s signature becomes:

  ```ts
  export function envSecret(
    name: string,
  ): SecretSource<EnvSecretPayload> & RuntimeValue<SecretString> {
  ```

- Its return statement's type arguments become `secretSource<EnvSecretPayload, Pointer<SecretString>>(`.

### 6.2 `packages/1-prisma-cloud/1-extensions/target/src/param.ts`

- The `@internal/core` import gains `type Pointer,` after `type ParamSource,` and `type RuntimeValue,` after `paramSource,`.
- `generatedParam`'s four signatures change their return types: `& Value<SecretString>` becomes `& RuntimeValue<SecretString>`, `& Value<string>` becomes `& RuntimeValue<string>`, and `& Value<SecretString | string>` (twice) becomes `& RuntimeValue<SecretString | string>`.
- `generatedParam`'s return statement becomes:

  ```ts
  return paramSource<GeneratedParamPayload, Pointer<SecretString | string>>(
    { [PRISMA_CLOUD_GENERATED_PARAM_SOURCE]: true, bytes, redacted },
    { label: 'generatedParam()', redacted },
  );
  ```

- `ORIGIN_SENTINEL` and its doc comment are removed (in commit 4, § 15; commit 3 leaves them).
- `serviceOrigin`'s signature becomes:

  ```ts
  export function serviceOrigin(
    address: string,
  ): ParamSource<OriginParamPayload> & RuntimeValue<string> {
  ```

  and its return statement:

  ```ts
  return paramSource<OriginParamPayload, Pointer<string>>(
    { [PRISMA_CLOUD_ORIGIN_PARAM_SOURCE]: true, address },
    { label: `serviceOrigin('${address}')` },
  );
  ```

The option changes (`{ label, redacted }` and `{ label }`) land in commit 3; the type changes in commit 5 (§ 15).

## 7. Prisma Cloud target: the serializer

All in `packages/1-prisma-cloud/1-extensions/target/src/serializer.ts`.

### 7.1 Imports

```ts
import type { Config, ConfigParam, Params, ServiceNode } from '@internal/core';
import {
  isParamSource,
  isSecretPointer as isSecretPointerValue,
  isSecretSource,
} from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import { SecretBox } from '@internal/foundation/secret';
```

and the `./param.ts` import becomes `import { isEnvParamSource, isGeneratedParamSource, isOriginParamSource } from './param.ts';`. Core's `isSecretPointer` is imported under the alias `isSecretPointerValue` because the file already has its own `isSecretPointer`, which recognises the document's `{ "$secret": … }` marker.

### 7.2 Comments

- In the "Input channel" comment block, `// (secrets as empty sentinel boxes — never values), and writes the` becomes `// (each value known only at boot as its pointer — never a value), and writes the`.

### 7.3 `ResolvedInputBinding`

Becomes:

```ts
/** What `resolveInputBinding` hands back: the schema-ready object, with each pointer in place, plus the generated leaves and every key path that resolved absent. */
export interface ResolvedInputBinding {
  readonly resolved: unknown;
  /** Every generated leaf — provisioned by the descriptor, substituted to a `$generated` pointer by path. */
  readonly generated: readonly GeneratedLeaf[];
  /** Dot-joined binding paths whose env-bound leaf resolved absent (unset/empty deploy-shell var, or a secret `prisma dev` found unset) — deploy-report fodder. */
  readonly absent: readonly string[];
}
```

### 7.4 `resolveInputBinding`

- Its doc comment becomes:

  ```ts
  /**
   * Deploy: recursive descent over the provision-time binding (plain data).
   * `envSecret`, `generatedParam` and `serviceOrigin` leaves stay in place as
   * their pointers (the value never enters the deploy); `envParam` leaves read
   * the config pool — unset or empty means the enclosing object key is
   * OMITTED, and the schema arbitrates whether that absence is legal
   * (ADR-0042). An `envSecret` leaf named in `absentSecrets` is omitted the
   * same way; only `prisma dev` passes any. Everything non-plain (a class
   * instance, a function, a raw SecretBox holding a value) is rejected loudly.
   */
  ```

- The two lines `const sentinels = new Map<SecretString, string>();` and `const secretPaths = new Set<string>();` are removed.
- The comment above `if (isOriginParamSource(value))` becomes:

  ```ts
      // A generated leaf is a ParamSource too, so it MUST be recognized before
      // the param branch. It stays in place as its pointer, which the schema
      // checks; serializing swaps it for a `{ "$generated": VAR, "redacted": <bool> }`
      // pointer by path. The walk itself provisions nothing.
  ```

- `return ORIGIN_SENTINEL;` becomes `return value;`. `return redacted ? new SecretBox('') : '';` becomes `return value;`. In the `isSecretSource(value)` branch, the four lines from `const sentinel = new SecretBox('');` to `return sentinel;` become `return value;`.
- The returned object loses `sentinels,` and `secretPaths,`.

### 7.5 `serializeInput` and the second check

Directly before `serializeInput`'s doc comment, a constant:

```ts
/** The text a stand-in box holds: known, and not a secret. */
const STAND_IN_TEXT = 'composer-stand-in-not-a-secret';
```

`serializeInput`, doc comment included, becomes:

```ts
/**
 * Deploy: resolve the binding, judge it with the service's own schema (each
 * value known only at boot as its pointer), and serialize the
 * defaults-applied VALIDATED output, each pointer written as a `$secret` or
 * `$generated` marker, into one JSON row. Returns `undefined` for a service
 * with no input schema. A service whose binding holds a secret pointer is
 * judged a second time, with a stand-in box in place of each secret pointer,
 * and refused if a box loses its text: the schema copies its input, and at
 * boot the copy would lose the secret's value.
 */
export function serializeInput(
  node: ServiceNode,
  address: string,
  binding: unknown,
  options: SerializeInputOptions = {},
): InputDocumentRow | undefined {
  const judged = judgeInput(node, address, binding, options);
  if (judged === undefined) return undefined;
  if (!judged.ok) {
    throw new Error(
      `invalid input for service "${address}": ${judged.thrown ? '' : 'config param validation failed: '}${judged.message}\n` +
        '(Deploy-time validation sees each value known only at boot, envSecret() included, as a pointer ' +
        'to its platform variable, never its value. ' +
        'A failure naming a secret field means the binding and schema disagree about its ' +
        'secretness, or the schema refines on secret content — which ADR-0042 forbids.)',
    );
  }
  const { validated, generated, absent, resolved } = judged;
  refuseLostSecrets(node, address, resolved);
  const emittedSecrets = new Set<string>();
  const document = substitutePointers(validated, generated, address, emittedSecrets);
  return {
    key: inputKey(address),
    value: JSON.stringify(document),
    absent,
    generated,
    // The names the DOCUMENT actually carries (a schema transform can drop a
    // bound leaf), sorted and unique: the fingerprint depends only on the set
    // of referenced variables, so a binding refactor that reorders or
    // duplicates leaves cannot move it.
    secrets: [...emittedSecrets].sort(),
  };
}
```

Directly after `serializeInput`, a new function:

```ts
/**
 * Judges `resolved` a second time with a stand-in box in place of each secret
 * pointer, and fails naming the first field whose box no longer gives back
 * the stand-in's text. A schema that copies its input (an ArkType transform,
 * or deleting undeclared keys) copies a box without its value, so at boot the
 * service could not read the secret. Does nothing when `resolved` holds no
 * secret pointer.
 */
function refuseLostSecrets(node: ServiceNode, address: string, resolved: unknown): void {
  let found = false;
  const withStandIns = (value: unknown): unknown => {
    if (isSecretPointerValue(value)) {
      found = true;
      return new SecretBox(STAND_IN_TEXT);
    }
    if (isSecretSource(value) || isParamSource(value)) return value;
    if (Array.isArray(value)) return value.map(withStandIns);
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, member]) => [key, withStandIns(member)]),
      );
    }
    return value;
  };
  const standIns = withStandIns(resolved);
  if (!found || node.inputSchema === undefined) return;
  const result = standardValidate(node.inputSchema, standIns);
  if ('issues' in result) {
    throw new Error(
      `invalid input for service "${address}": the schema accepts each secret's pointer but refuses a secret box in its place: ${result.issues}`,
    );
  }
  const walk = (value: unknown, path: string): void => {
    if (value instanceof SecretBox) {
      let text: unknown;
      try {
        text = value.expose();
      } catch {
        text = undefined;
      }
      if (text !== STAND_IN_TEXT) {
        throw new Error(
          `input key "${path}" of service "${address}" validated to a copy of its secret, and the copy ` +
            "has lost the secret's value: the schema copies its input (for example an ArkType morph " +
            'elsewhere in the schema), so the service would fail to read the secret at boot. Move the ' +
            'transform into the service code, or keep the schema free of transforms.',
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, member] of value.entries()) {
        walk(member, path === '' ? String(index) : `${path}.${index}`);
      }
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, member] of Object.entries(value)) {
        walk(member, path === '' ? key : `${path}.${key}`);
      }
    }
  };
  walk(result.value, '');
}
```

How it behaves, each checked against ArkType 2.2.7 and Zod 4.4.3:

- The secret-pointer check (`isSecretPointerValue`, the pointer kind) comes before the source check, so a redacted `generatedParam()`, a `ParamSource` whose kind is `'secret'`, gets a stand-in too. A plain pointer stays in place.
- The second check runs only after the first passed, and only when the binding holds a secret pointer. `judgeInput` and `inputValidationFailure` do not run it: `prisma dev`'s preflight asks only whether the schema accepts the binding.
- ArkType returns a copy of a `SecretBox` whose `expose()` throws `Cannot access invalid private field`, for: a morph anywhere in the schema (`'string.trim'`, `'string.integer.parse'`, `.pipe()`), a wrapped transforming field such as `field(type('string.integer.parse'))`, and `'+': 'delete'`, even with no undeclared key in the input. A schema with none of these returns the same box.
- Zod returns the same box for `z.object`, `z.strictObject`, a `.transform()` beside the secret and a wrapped transforming field.
- The error names the field by its path in the second check's output, in the format `resolveInputBinding` uses.
- The stand-in never reaches the document: the document is built from the first check's output.

### 7.6 `substitutePointers`

The function, doc comment included, becomes:

```ts
/**
 * Walks the VALIDATED output and writes each pointer as its document marker:
 * an `envSecret` pointer as `{ "$secret": name }`, and a `generatedParam` or
 * `serviceOrigin` pointer as `{ "$generated": VAR, "redacted": <bool> }`, found
 * by the input path its binding put it at. A pointer is recognised by its
 * brands, never by identity, so a copy the schema made still counts. Escapes
 * any user key that matches a reserved marker. A `SecretString` in the output
 * came from the schema itself (a default or transform minting a box): no
 * platform var stands behind it, so it is rejected rather than serialized.
 */
function substitutePointers(
  value: unknown,
  generated: readonly GeneratedLeaf[],
  address: string,
  emittedSecrets: Set<string>,
): unknown {
  const generatedByPath = new Map(generated.map((leaf) => [leaf.path, leaf]));
  const walk = (v: unknown, path: string): unknown => {
    const leaf = generatedByPath.get(path);
    if (isSecretSource(v)) {
      const name = secretName(v, path === '' ? 'the input binding root' : `input key "${path}"`);
      emittedSecrets.add(name);
      return { [SECRET_MARKER]: name };
    }
    if (isParamSource(v)) {
      if (leaf === undefined) {
        throw new Error(
          `input key "${path}" of service "${address}" validated to a value known only at boot that its ` +
            'binding did not put there: the schema moved it. A schema may check such a field, never move or transform it.',
        );
      }
      return { [GENERATED_MARKER]: leaf.varName, redacted: leaf.redacted };
    }
    if (leaf !== undefined && v !== undefined) {
      throw new Error(
        `input key "${path}" of service "${address}" is bound to a value known only at boot, but the ` +
          'schema replaced it. A schema may check such a field, never move or transform it.',
      );
    }
    if (v instanceof SecretBox) {
      throw new Error(
        `input key "${path}" of service "${address}" validated to a SecretString the binding did ` +
          'not supply — a schema must not mint secret boxes (a default/transform cannot name a ' +
          "platform variable); bind the field with envSecret('NAME') instead.",
      );
    }
    if (Array.isArray(v)) return v.map((m, i) => walk(m, path === '' ? String(i) : `${path}.${i}`));
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(v)) {
        if (member === undefined) continue;
        const written = ESCAPABLE_KEY.test(key) ? `$${key}` : key;
        out[written] = walk(member, path === '' ? key : `${path}.${key}`);
      }
      return out;
    }
    if (
      v === null ||
      v === undefined ||
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      return v;
    }
    throw new Error(
      `input key "${path}" of service "${address}" validated to a value that cannot be serialized ` +
        `(a ${typeof v === 'object' ? 'non-plain object' : typeof v}) — the input document is plain JSON (ADR-0042).`,
    );
  };
  return walk(value, '');
}
```

The last two branches are today's, unchanged. The source checks come before `isPlainObject` for the reason § 5.3 gives. A generated leaf whose output value is `undefined`, because the schema dropped the field, writes nothing, as today.

### 7.7 `packages/1-prisma-cloud/1-extensions/target/src/testing.ts`

In `BootstrapConfig`'s doc comment, the two lines

```text
 * deploy-side path a real deploy takes (`serializeInput`: resolve, validate
 * with sentinel boxes, one `$secret`-pointer document row), so `input()` in
```

become

```text
 * deploy-side path a real deploy takes (`serializeInput`: resolve, validate
 * with pointers in place, one document row of markers), so `input()` in
```

Nothing else in the target changes. `preflight-names.ts`, `env-key-clash.ts`, `local-target/preflight.ts`, `descriptors/compute.ts` and `compute.ts` read `serializeInput`, `inputValidationFailure` and the sources as before.

## 8. The shared modules wrap their fields

### 8.1 `packages/1-prisma-cloud/2-shared-modules/auth/src/auth-module.ts`

- After `import { emailSender } from '@internal/email';`, a new line `import { field } from '@internal/foundation/arktype';`.
- `const authModuleInput = type({ baseUrl: 'string' });` becomes `const authModuleInput = type({ baseUrl: field(type('string')) });`.

### 8.2 `packages/1-prisma-cloud/2-shared-modules/auth/src/auth-service.ts`

- `import { secretString } from '@internal/foundation/arktype';` becomes `import { field, secretString } from '@internal/foundation/arktype';`.
- The `input:` line becomes:

  ```ts
      input: type({
        baseUrl: field(type('string')),
        secret: secretString(),
        signUp: "'open' | 'closed'",
      }),
  ```

The auth service's document is unchanged: for `{ baseUrl: serviceOrigin('shop.api'), secret: generatedParam(), signUp: 'open' }` at `shop.auth.service` it is `{"baseUrl":{"$generated":"COMPOSER_SHOP_AUTH_SERVICE_BASEURL_GENERATED","redacted":false},"secret":{"$generated":"COMPOSER_SHOP_AUTH_SERVICE_SECRET_GENERATED","redacted":true},"signUp":"open"}`, with and without this slice. The schema has no transform, so the second check passes.

### 8.3 `packages/1-prisma-cloud/2-shared-modules/email/src/email-module.ts`

- `import { secretString } from '@internal/foundation/arktype';` becomes `import { field, secretString } from '@internal/foundation/arktype';`.
- In `emailModuleInput`, `deliveryMode: 'string',` becomes `deliveryMode: field(type('string')),` and `from: 'string',` becomes `from: field(type('string')),`.

### 8.4 `packages/1-prisma-cloud/2-shared-modules/email/src/email-service.ts`

- The same import change as § 8.3.
- In `emailInputSchema`, `deliveryMode: "'resend'|'smtp'|'none'",` becomes `deliveryMode: field(type("'resend'|'smtp'|'none'")),` and `from: 'string',` becomes `from: field(type('string')),`. `deliveryUrl: 'string',` stays plain: only `email()`'s factory option binds it, with a literal.

The entrypoints `auth-entrypoint.ts` and `email-entrypoint.ts` do not change: `service.input()` reads `baseUrl`, `deliveryMode` and `from` as their inner types (`deliveryMode` as `'resend' | 'smtp' | 'none'`), and `secret.expose()` and `deliveryCredential` type-check as `SecretString`.

### 8.5 The examples

No example's code changes. Every example was checked: `examples/auth/module.ts` binds `serviceOrigin('auth-example.api')` into `auth()`'s `baseUrl`, now wrapped; no other example binds `generatedParam()` or `serviceOrigin()`; the roots' fields stay plain (design section 7); and `examples/storefront-auth`'s module and service declare only a `secretString()` field.

## 9. What breaks, and what does not

Breaks:

1. A module or service schema field bound to `serviceOrigin()` or a plain `generatedParam()` that is not wrapped: a compile error in a module's binding (§ 6), and at deploy the plain field's message (§ 10).
2. Code that reads a `secretString()` field from a schema's own output, outside `service.input()`, such as `schema(value).key.expose()`: the field is now typed `SecretString | Pointer<SecretString>`, so it narrows with `isSecretString()` first.
3. A `paramSource()` call with `sentinel`: a compile error.
4. An ArkType service schema that copies its input beside a redacted `generatedParam()`: refused at deploy, naming the field. Before, it deployed, and the service failed to read the secret at boot. The same schema beside an `envSecret()` was already refused, with the same message.
5. `email()`'s message for a missing `from` or `deliveryMode` is ArkType's union wording, `from must be a string or an object (was missing)` (S6, conflict 1).

Unchanged:

1. **The wire format.** Every service's input document holds the same values and markers, under the same variable names (§ 8.2; the existing serializer tests).
2. **Boot.** `readInput` and `hydrateInputDocument` do not change.
3. **Preflight.** `inputSecretNames` and `prisma dev`'s preflight read the same sources.
4. **`service.input()` at run time**, and every existing service's and entrypoint's types.
5. **A schema without a runtime value.** A binding of literals, `envParam()` and `resolve()` results is checked exactly as before, once.

The only existing tests this slice changes are listed in § 13.1. If any other existing test fails, the implementer stops and reports.

## 10. Error messages, verbatim

New messages:

| Where | Condition | Message |
| --- | --- | --- |
| `serializeInput` | the second check reports issues | `invalid input for service "<address>": the schema accepts each secret's pointer but refuses a secret box in its place: <issues joined with "; ">` |
| `substitutePointers` | a param source in the output at a path with no generated leaf | `input key "<path>" of service "<address>" validated to a value known only at boot that its binding did not put there: the schema moved it. A schema may check such a field, never move or transform it.` |
| `substitutePointers` | a path with a generated leaf whose output is defined and not a param source | `input key "<path>" of service "<address>" is bound to a value known only at boot, but the schema replaced it. A schema may check such a field, never move or transform it.` |
| `paramSource()` | `poolKey` with `redacted: true` | `paramSource() takes poolKey, for a value known at deploy, or redacted, for a secret known only at boot, not both.` |
| Load's `restore` | a defined value that is not a source at a path the binding bound to a source | `The input schema of module "<address>" replaced input key "<path>", which is bound to <label>. Its value is known only at boot, so a module's schema may check the field but never replace or move it.` |
| Load's `restore` | a source at a path where the binding put no source, or another source | `The input schema of module "<address>" moved <label> to input key "<path>". Its value is known only at boot, so a module's schema may check the field but never replace or move it.` |

Changed messages:

| Where | Before | After |
| --- | --- | --- |
| `serializeInput`, the note after a schema failure | `(Deploy-time validation sees each envSecret leaf as an opaque, empty SecretString box. A failure naming …` | `(Deploy-time validation sees each value known only at boot, envSecret() included, as a pointer to its platform variable, never its value. A failure naming …` (the rest unchanged) |
| the copied-secret refusal | raised by `substitutePointers`, for `envSecret()` only | the same text, raised by `refuseLostSecrets`, for `envSecret()` and a redacted `generatedParam()` |

Removed messages: `paramSource() takes poolKey, for a value known at deploy, or sentinel or redacted, for one known only at boot, not both.`; `paramSource() takes sentinel or redacted, not both.`; Load's `… is bound to a param source a module's input cannot take: it names no sentinel …`; Load's `The input schema of module "<address>" changed input key "<path>", which is bound to <label>. …`, replaced by the two `restore` messages above.

What a user sees now for a runtime value in the wrong field, each the schema library's own message (tests 7, 8, 10 to 12 and 22):

| Field | Bound to | Message after `does not match the module's input schema: ` or `config param validation failed: ` |
| --- | --- | --- |
| `type('string')` | `serviceOrigin()`, `envSecret()` | `<key> must be a string (was an object)` |
| `field(type('string'))` | `envSecret()` | `<key> must be a string (was an object)` |
| `secretString()` | `serviceOrigin()`, a plain `generatedParam()` | `<key> must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)` |

## 11. Documentation

All in the same pull request (`.agents/rules/user-facing-surface-changes.mdc`).

### 11.1 Glossary, `docs/design/03-domain-model/glossary.md`

1. **Input**, the paragraph `A field typed \`secretString()\` takes only a secret. A\n[wrapped field](#field) also takes a value known only at boot.` is replaced by:

   ```markdown
   A field typed `secretString()` takes only a secret: a secret box, or the
   secret pointer of `envSecret()` or a redacted `generatedParam()`. A
   [wrapped field](#field) also takes a plain pointer, from `serviceOrigin()`
   or a plain `generatedParam()`. A plain field takes neither: at deploy a
   schema checks each value known only at boot as its pointer, so a plain
   field bound to one fails the deploy.
   ```

2. **Value**, the sentence `A source's type is\nthe source and a value at once, such as \`SecretSource & Value<SecretString>\`.` becomes `A source's type is\nthe source and a value at once, such as \`SecretSource & RuntimeValue<SecretString>\`\nfor \`envSecret()\`.`
3. **`field()`**, a sentence appended to the entry's paragraph: ` A service reads a wrapped field as \`Out\`: \`service.input()\` returns the schema's output with every pointer removed, because at boot each pointer has been replaced by the text of the variable it names.`

### 11.2 Decision records

The repo writes an amendment note as a plain paragraph, directly after the decision's last amendment note (S6 code review, the implementer's adaptations).

- **The service input decision**, `ADR-0042-service-input-is-one-standard-schema.md`, after the sixth-slice note:

  > Amended `<date>` (module-input project, seventh slice): the deploy checks a service's binding with each value known only at boot in place as its pointer, not as a stand-in, so the sentinels described below are gone. An `envSecret()` or a redacted `generatedParam()` reaches the schema as a secret pointer, which `secretString()` accepts. A `serviceOrigin()` or a plain `generatedParam()` reaches it as a plain pointer, which only a field wrapped with `field()` accepts. So a field bound to `serviceOrigin()` or a plain `generatedParam()` must be wrapped: a plain `type('string')` field refuses it at deploy, and in a module's binding it fails to compile, because the three constructors are typed as runtime values ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). The serializer writes each pointer in the schema's output by its brands, so a copy the schema made still counts. ArkType copies its input when a transform runs anywhere in it, a wrapped field's included, or when it deletes undeclared keys, and a copied secret box loses its value. So the deploy checks a service whose binding holds a secret pointer a second time, with a stand-in box holding a known text in place of each secret pointer, and refuses the service, naming the field, if a box in the output no longer gives back that text. This covers a redacted `generatedParam()` as well as `envSecret()`. `secretString()` is typed `SecretString | Pointer<SecretString>`. `service.input()` returns the schema's output with every pointer removed, at any depth, because at boot each pointer has been replaced by the variable's text, and `mockService()`'s input double has the same type.

  Its index line in `docs/design/90-decisions/README.md` gains, at its end: ``*(Amended `<date>`, seventh slice: the deploy checks a service's schema with pointers in place; a field bound to `serviceOrigin()` or a plain `generatedParam()` is wrapped with `field()`; `service.input()` has no pointers.)*``
- **The module input decision**, `ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md`, after the fifth-slice note:

  > Amended `<date>` (module-input project, seventh slice): Load checks a module's binding with each value known only at boot in place as its pointer, so one statement below is corrected: the deploy does not resolve a secret to an opaque box. The schema sees the secret pointer, which `secretString()` accepts. A plain pointer, from `serviceOrigin()` or a plain `generatedParam()`, passes only a field wrapped with `field()`; a plain field refuses it. `paramSource()` loses its `sentinel` option, and its `redacted` option says whether the source is a secret pointer or a plain one; a `paramSource()` with neither a pool key nor `redacted` is a plain pointer, which a module's input now takes. Wherever the schema's output holds a pointer, Load passes on the original source, so a copy the schema made reaches the child as the source the binding named.

  Its index line gains, at its end: ``*(Amended `<date>`, seventh slice: a module's schema checks each runtime value as its pointer; `paramSource()` loses `sentinel`.)*``
- **The `resolve()` and config adapters decision**, `ADR-0062-environment-values-come-from-resolve-and-config-adapters.md`, after the sixth-slice note:

  > Amended `<date>` (module-input project, seventh slice): the constructors are typed as runtime values, which reverses the sixth-slice note's last sentence. `envSecret()` is `SecretSource & RuntimeValue<SecretString>`, `serviceOrigin()` is `ParamSource & RuntimeValue<string>`, and `generatedParam()` is `ParamSource & RuntimeValue<SecretString>`, or `ParamSource & RuntimeValue<string>` when it is not redacted. So a `resolve()` function that lists one receives a value typed `Pointer<SecretString>` or `Pointer<string>`, which is what it receives at run time. Schemas see these pointers at deploy ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md), [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).

  Its index line gains, at its end: ``*(Amended `<date>`, seventh slice: `envSecret()`, `generatedParam()` and `serviceOrigin()` are typed `RuntimeValue`.)*``

### 11.3 Domain docs

- **`docs/design/10-domains/config-params.md`**, § Sources are values:
  - The table row that begins `| A module's \`input\` binding |` becomes:

    ```markdown
    | A module's `input` binding | its string; unset or empty leaves the key out | its pointer, which a `secretString()` field accepts | its pointer: a `secretString()` field accepts it when redacted, a wrapped field otherwise | its pointer, which a wrapped field accepts |
    ```

  - Directly after the table, a new paragraph:

    ```markdown
    In a service's and a module's input, the schema checks each of the three
    runtime sources as its pointer. A plain field refuses a pointer, so a field
    bound to `generatedParam()` or `serviceOrigin()` is wrapped with `field()`,
    or is a `secretString()` field for a redacted `generatedParam()`
    ([glossary](../03-domain-model/glossary.md#field)).
    ```

- **`docs/design/10-domains/module-composition.md`**, § Input:
  - The sentence `A field bound to \`envSecret()\`, \`generatedParam()\` or\n\`serviceOrigin()\` has a pointer as its real value, never a value, although its\ntype is the schema's output type.` becomes `A field bound to \`envSecret()\`, \`generatedParam()\` or\n\`serviceOrigin()\` has a pointer as its real value, and its type says so: a\nwrapped field's type includes \`Pointer<In>\`, and a \`secretString()\` field's\nincludes \`Pointer<SecretString>\`.`
  - The sentence `At deploy a module's schema still\nchecks the stand-ins described below, so a wrapped and a plain field check\nthe same data.` becomes `At deploy a module's schema checks\neach runtime value as its pointer, so a plain field bound to one fails the\ndeploy, as below.`
  - In **How Load validates**, the three sentences from `A secret source reaches the schema as` to `a schema that changes\nsuch a field fails the Load.` are replaced by:

    ```markdown
    A value known only at boot reaches the schema as its pointer, the source
    itself: `secretString()` accepts a secret pointer, a wrapped field a plain
    one, and a plain field neither. Wherever the schema's output holds a
    pointer, Load passes on the original source, so a copy the schema made, as
    ArkType does when a transform runs, reaches the child as the source the
    binding named.
    ```

### 11.4 The guide, `docs/guides/building-an-app.md`

1. **§ A module's input**, the example: `import { secretString } from '@prisma/composer/arktype';` becomes `import { field, secretString } from '@prisma/composer/arktype';`, and `{ input: type({ from: 'string', deliveryCredential: secretString(), 'replyTo?': 'string' }) },` becomes `{ input: type({ from: 'string', deliveryCredential: secretString(), 'replyTo?': field(type('string')) }) },`.
2. **§ A module's input**, the bullet that begins `- A module's \`input\` takes every source a service's does.` is replaced by:

   ```markdown
   - A module's `input` takes every source a service's does. Its schema checks
     `envParam()`'s value, and checks each of the other three as its
     **pointer**: the object that names the platform variable the service
     reads at boot. A `secretString()` field accepts the pointer of
     `envSecret()` and of a redacted `generatedParam()`. A plain field accepts
     no pointer, so a field bound to `serviceOrigin()` or a plain
     `generatedParam()` is wrapped with `field()`, below.
   ```

3. **§ A module's input**, the bullet that begins `- \`field()\`, from` gains, at its end: ` Wrap every leaf field of a reusable module's schema, unless a \`resolve()\` lists it: the module then takes a literal, a deploy-time value or a value known only at boot, whichever its caller has. In the example above, \`from\` stays plain because a \`resolve()\` computes with it, and \`replyTo\` is wrapped. A root's fields stay plain too, because the config pool never holds a pointer.`
4. **§ Binding the input at provision**, the paragraph that begins `A schema with a \`SecretString\` field cannot also transform its input.` is replaced by:

   ```markdown
   An ArkType schema with a `SecretString` field cannot also transform its
   input. A morph anywhere in the schema, such as `'string.trim'`,
   `.pipe()` or a wrapped transforming field like
   `field(type('string.integer.parse'))`, and deleting undeclared keys with
   `'+': 'delete'`, make ArkType copy the whole input, and a copied
   `SecretString` loses its value, so the service could not read the secret at
   boot. The deploy checks for this and refuses such a schema, naming the
   secret field. Do the transform in the service code instead. A Zod schema
   keeps the secret box when it transforms, so it can do both.
   ```

5. **§ Binding the input at provision**, directly after the paragraph that ends `Neither side can silently\nmisclassify a credential.`, a new paragraph:

   ```markdown
   **A field bound to `serviceOrigin()` or `generatedParam({ redacted: false })`
   is wrapped.** Their value exists only at boot, so at deploy the schema sees
   a pointer to the platform variable, and only a field wrapped with `field()`
   accepts it: `type({ returnUrl: field(type('string')) })`. A plain `'string'`
   field fails the deploy, and in a module's binding it fails to compile. A
   redacted `generatedParam()` is a secret, so its field is `secretString()`.
   In the service a wrapped field reads as its inner type:
   `service.input().returnUrl` is a `string`, because at boot the pointer has
   been replaced by the variable's text. `mockService()` takes the input
   double in the same shape.
   ```

6. **§ Sources in resolve()**: `the other three, \`fn\` receives a **pointer**, although the type says\n\`SecretString\` or \`string\`, because their value exists only at boot:` becomes `the other three, \`fn\` receives a **pointer**, typed \`Pointer<SecretString>\`\nor \`Pointer<string>\`, because their value exists only at boot:`. In that section's example, `import { secretString } from '@prisma/composer/arktype';` becomes `import { field, secretString } from '@prisma/composer/arktype';` and `returnUrl: 'string'` becomes `returnUrl: field(type('string'))`. The rest of the section is S8's.

### 11.5 The testing guide, `docs/guides/testing.md`

In § Unit tests, directly after `doesn't compile.`, a new sentence in the same paragraph: ` The input double has the type \`service.input()\` returns: a wrapped field is its inner type and a \`secretString()\` field a \`SecretString\`, never a pointer.`

### 11.6 The agent skill, `skills/prisma-composer-core-concepts/SKILL.md`

Written to `skills/README.md`.

1. **Rules that bite**, item 1: `A schema with a \`SecretString\` field\n   cannot also transform its input: an ArkType morph anywhere in it\n   (\`'string.trim'\`, \`.pipe()\`) copies the input, the copied secret loses its\n   value, and the deploy refuses it. Transform in the service code instead.` becomes `An ArkType schema with a \`SecretString\`\n   field cannot also transform its input: a morph anywhere in it\n   (\`'string.trim'\`, \`.pipe()\`, \`field(type('string.integer.parse'))\`) or\n   \`'+': 'delete'\` copies the input, the copied secret loses its value, and\n   the deploy refuses it. Transform in the service code instead; a Zod schema\n   keeps the box.`
2. **Rules that bite**, a new last item after item 6:

   ```markdown
   7. **A field bound to `serviceOrigin()` or a plain `generatedParam()` is
      wrapped**: `field(type('string'))`. At deploy the schema sees a pointer,
      and a plain `'string'` field refuses it (a deploy error, and a compile
      error in a module's binding). `service.input()` and `mockService`'s input
      double read the field as its inner type.
   ```

3. **Values that differ per environment**, the `field(inner)` bullet: `so it also accepts a plain pointer, the stand-in for a value known only at boot such as \`serviceOrigin()\`.` becomes `so it also accepts a plain pointer, which is what a value known only at boot such as \`serviceOrigin()\` is at deploy.`, and the bullet gains, at its end: ` Wrap every leaf of a reusable module's schema unless a \`resolve()\` lists it; keep a root's fields plain.`
4. **Values that differ per environment**, the `Sources are values.` bullet: `the function receives a pointer that throws when used as text` becomes `the function receives a pointer (typed \`Pointer<…>\`) that throws when used as text`.
5. The `mockService` paragraph: `(required exactly when the\nservice declares an input schema; handed over as-is, not validated)` becomes `(required exactly when the\nservice declares an input schema, typed as \`service.input()\` returns, with no pointers; handed over as-is, not validated)`.

### 11.7 The email module's README, `packages/1-prisma-cloud/2-shared-modules/email/README.md`

In the paragraph that begins `` `deliveryMode`, `from` and `deliveryCredential` are the module's `input`. ``, the sentence `The module's schema checks only that \`deliveryMode\` is a string; the service checks that it is \`resend\`, \`smtp\` or \`none\` before anything is created.` becomes `\`deliveryMode\` and \`from\` are wrapped fields (\`field()\`), so a module that passes its own wrapped field on can bind them too. The module's schema checks only that \`deliveryMode\` is a string; the service checks that it is \`resend\`, \`smtp\` or \`none\`, before anything is created for a literal or an \`envParam()\`, and at boot for a value known only at boot.`

## 12. The release note

The repo has no changesets; GitHub Release notes are generated from pull request titles (S5 spec § 7). So the pull request carries the release note:

- **Title**: `feat!: schemas check runtime values as pointers, so a field bound to serviceOrigin() is wrapped`.
- **Description**, a section `## Breaking change` holding, in this order:

  1. The before and after:

     ```ts
     // before: deployed, with the schema checking a stand-in URL
     compute({ name: 'billing', input: type({ returnUrl: 'string', stripeKey: secretString() }), /* … */ });

     // after: a field bound to serviceOrigin() or generatedParam({ redacted: false }) is wrapped
     import { field, secretString } from '@prisma/composer/arktype';
     compute({ name: 'billing', input: type({ returnUrl: field(type('string')), stripeKey: secretString() }), /* … */ });

     provision(billing, { input: { returnUrl: serviceOrigin('shop.web'), stripeKey: envSecret('STRIPE_KEY') } });
     ```

     and the sentence: `Without field(), the deploy now fails with "returnUrl must be a string (was an object)", and in a module's binding the code fails to compile. In the service, billing.input().returnUrl is still a string. With another Standard Schema library, such as Valibot or a hand-written schema, accept the pointer with isPlainPointer() or isSecretPointer() from @prisma/composer, as field() and secretString() do.` *(The last sentence was added after the code review.)*
  2. `envSecret(), generatedParam() and serviceOrigin() are typed as RuntimeValue: SecretSource & RuntimeValue<SecretString>, ParamSource & RuntimeValue<SecretString> (or RuntimeValue<string> for { redacted: false }) and ParamSource & RuntimeValue<string>. A resolve() function that lists one now sees the Pointer type it receives.`
  3. `secretString() from @prisma/composer/arktype and @prisma/composer/zod is typed SecretString | Pointer<SecretString>. service.input() and mockService() still give a SecretString; code that reads a schema's own output directly narrows with isSecretString().`
  4. `An ArkType service schema that copies its input loses a secret's value at boot. The deploy already refused it beside an envSecret(); it now refuses it beside a redacted generatedParam() too, naming the field. ArkType copies the input for a morph anywhere in the schema, a wrapped transforming field such as field(type('string.integer.parse')) included, and for '+': 'delete'.`
  5. `paramSource() loses its sentinel option (for deploy targets). redacted: true makes the source a secret pointer; without it the source is a plain pointer.`
  6. `email() and auth() wrap the fields a value known only at boot may bind. email()'s message for a missing from now reads "from must be a string or an object (was missing)".`

## 13. Tests

Runtime tests use `bun test`; type tests use vitest `expectTypeOf` and `@ts-expect-error`. Test files are exempt from the no-bare-casts instruction; the casts below are the ones the existing tests use.

### 13.1 Existing tests this slice changes

Each change is the whole change to that test; its title is kept unless a new one is given.

**Foundation**

- `packages/0-framework/0-foundation/foundation/src/arktype.test.ts`: the import `import { SecretBox } from './secret.ts';` becomes `import { isSecretString, SecretBox } from './secret.ts';`. The test `accepts a secret box, and the validated field reads back as a SecretString` becomes:

  ```ts
  test('accepts a secret box, and the validated field is a box that exposes its value', () => {
    const out = schema({ signingKey: new SecretBox('sk_live_abc') });
    if (out instanceof type.errors) throw new Error(out.summary);
    const { signingKey } = out;
    if (!isSecretString(signingKey)) throw new Error('expected a SecretString box');
    expect(signingKey.expose()).toBe('sk_live_abc');
  });
  ```

- `packages/0-framework/0-foundation/foundation/src/zod.test.ts`: the same import change. The test `accepts a secret box, and the validated field reads back as a SecretString` becomes:

  ```ts
  test('accepts a secret box, and the validated field is a box that exposes its value', () => {
    const { k } = schema.parse({ k: new SecretBox('v') });
    if (!isSecretString(k)) throw new Error('expected a SecretString box');
    expect(k.expose()).toBe('v');
  });
  ```

**Core**

- `packages/0-framework/1-core/core/src/__tests__/field.test-d.ts`: the test `secretString() still reads as SecretString in both libraries` becomes `secretString() reads as a SecretString or a secret pointer in both libraries`, and each of its four `toEqualTypeOf<SecretString>()` becomes `toEqualTypeOf<SecretString | Pointer<SecretString>>()`.
- `packages/0-framework/1-core/core/src/__tests__/pointer.test.ts`:
  - The fixture `origin` becomes `const origin = () => paramSource({}, { label: "serviceOrigin('shop.web')" });`.
  - In `paramSource() without a pool key is a plain pointer, or a secret pointer when redacted`, the line `expect(kinds(paramSource({}, { sentinel: 'x' }))).toEqual([false, true]);` is removed.
  - In `a copy of a runtime param source in a module's input reaches the service as the original`, `relay(type({ base: 'string' }))` becomes `relay(type({ base: field(type('string')) }))`.
  - `a wrapped field takes a runtime param source's stand-in at Load, and the service receives the source` is retitled `a wrapped field takes a runtime param source's pointer at Load, and the service receives the source`.
- `packages/0-framework/1-core/core/src/__tests__/source-load.test.ts`:
  - The fixture `origin` becomes as in `pointer.test.ts`.
  - `a param source with a string sentinel in a module's input reaches the service as the same source` becomes:

    ```ts
    test("a runtime param source in a module's input is checked as its pointer and reaches the service as the same source", () => {
      const seen: unknown[] = [];
      const base = origin();

      const graph = Load(shopWith(forwarding(recording(seen)), { base }));

      expect((seen[0] as Record<string, unknown>)['base']).toBe(base);
      expect(bindingOf(graph)['base']).toBe(base);
    });
    ```

  - `a redacted param source is checked as a SecretString and reaches the service as the same source` is retitled `a redacted param source is checked as a secret pointer and reaches the service as the same source`.
  - `a module schema that changes a field bound to a sentinel fails` is removed; two tests at the end of `pointer.test.ts`, `a module schema that replaces a field bound to a runtime value fails at Load` and `a module schema that moves a runtime value to another key fails at Load`, take its place (§ 18, decision 7).
  - `a param source with no sentinel in a module's input fails` becomes:

    ```ts
    test("a raw param source in a module's input is a plain pointer and reaches the service as the same source", () => {
      const from = paramSource({ name: 'X' });

      const graph = Load(shopWith(forwarding(anyInputSchema), { from }));

      expect(bindingOf(graph)['from']).toBe(from);
    });
    ```

- `packages/0-framework/1-core/core/src/__tests__/source-value.test.ts`:
  - `paramSource() refuses a pool key beside a sentinel or redacted, a sentinel beside redacted, and an empty label or pool key` is retitled `paramSource() refuses a pool key beside redacted, and an empty label or pool key`, and its first five statements (from `const both =` to the `toThrow('paramSource() takes sentinel or redacted, not both.')` call) are replaced by:

    ```ts
    expect(() => paramSource({}, { poolKey: 'X', redacted: true })).toThrow(
      'paramSource() takes poolKey, for a value known at deploy, or redacted, for a secret known only at boot, not both.',
    );
    ```

  - In `isRuntimeValue() is true for …`, `isRuntimeValue(paramSource({}, { sentinel: '' }))` becomes `isRuntimeValue(paramSource({}, { redacted: true }))`.
- `packages/0-framework/1-core/core/src/__tests__/module-input.test.ts`: `a param source in a module's input binding fails naming the key` is removed, and the `../node.ts` import becomes `import { dependency, type ModuleNode, module, secretSource, service } from '../node.ts';`.

**Prisma Cloud target**

- `packages/1-prisma-cloud/1-extensions/target/src/__tests__/input-serializer.test.ts`:
  - The header line ` * escaping, sentinel validation, and the round trip.` becomes ` * escaping, validation with pointers in place, and the round trip.`
  - The `@internal/core` import becomes `import {\n  isSecretPointer,\n  isSecretString,\n  Load,\n  module,\n  SecretBox,\n  type ServiceNode,\n  service,\n} from '@internal/core';` and `import { secretString } from '@internal/foundation/arktype';` becomes `import { field, secretString } from '@internal/foundation/arktype';`.
  - `classifies literals, envParam, and envSecret leaves, nested objects and arrays included`: a first line `const secretly = envSecret('STRIPE_SECRET_KEY');`; the destructuring becomes `const { resolved, absent } = resolveInputBinding(`; the binding's `secretly: envSecret('STRIPE_SECRET_KEY'),` becomes `secretly,`; and the comment and two assertions from `// The secret leaf resolves to an empty sentinel box` to `.toBe('STRIPE_SECRET_KEY');` become `// The secret leaf stays in place as its pointer.` and `expect(nested['secretly']).toBe(secretly);`.
  - The describe `serializeInput — validate with sentinels, serialize the validated output` is retitled `serializeInput — validate with pointers in place, serialize the validated output`, and its test `discriminated-union conditionality passes with the satisfied arm (sentinel boxes as secrets)` is retitled `discriminated-union conditionality passes with the satisfied arm (secret pointers in place)`.
  - `a redacted generated leaf resolves to a box sentinel and records the generated list` becomes `a redacted generated leaf stays in place as its pointer and records the generated list`, with its first two statements `const secret = generatedParam();` and `const { resolved, generated } = resolveInputBinding({ secret }, 'web', { env: {} });`, and `toBeInstanceOf(SecretBox)` becomes `toBe(secret)`.
  - `a non-redacted generated leaf resolves to an empty-string sentinel` becomes `a non-redacted generated leaf stays in place as its pointer`, with its first two statements `const token = generatedParam({ redacted: false, bytes: 16 });` and `const { resolved, generated } = resolveInputBinding({ token }, 'web', { env: {} });`, and `.toBe('')` becomes `.toBe(token)`.
  - `a non-redacted leaf (plain string schema) also serializes to a $generated pointer` becomes `a non-redacted leaf (wrapped string field) also serializes to a $generated pointer`, and its `type({ token: 'string' })` becomes `type({ token: field(type('string')) })`.
  - `deploy → boot round trip: a non-redacted generated leaf hydrates to a PLAIN STRING, not a box`: `type({ token: 'string' })` becomes `type({ token: field(type('string')) })`, and in its comment `a box here would fail the plain` becomes `a box here would fail the wrapped`.
  - `a secret leaf and a generated leaf with distinct names do NOT collide` becomes:

    ```ts
    test('a secret leaf and a generated leaf with distinct names do NOT collide', () => {
      const sec = envSecret('MY_SECRET');
      const { resolved, generated } = resolveInputBinding(
        { sec, gen: generatedParam() },
        'web',
        { env: {} },
      );
      expect(generated).toHaveLength(1);
      expect((resolved as Record<string, unknown>)['sec']).toBe(sec);
    });
    ```

  - `serviceOrigin() forwarded through a module's input serializes to its origin pointer`: `forwarded(type({ baseUrl: 'string' }), { baseUrl: serviceOrigin('shop.web') })` becomes `forwarded(type({ baseUrl: field(type('string')) }), { baseUrl: serviceOrigin('shop.web') })`.
  - `a copy of serviceOrigin() serializes to its $generated pointer`: `svc(type({ base: 'string' }))` becomes `svc(type({ base: field(type('string')) }))`.
  - Unchanged and still passing: `a secret field beside an ArkType morph is refused at deploy, naming the copied secret` (the second check now raises the same message) and `a schema that mints its own SecretBox (a default) is rejected — no platform var stands behind it`.
- `packages/1-prisma-cloud/1-extensions/target/src/__tests__/control-lowering.test.ts`: `import { secretString } from '@internal/foundation/arktype';` becomes `import { field, secretString } from '@internal/foundation/arktype';`, and both `input: type({ baseUrl: 'string' }),` (in `serialize writes a serviceOrigin() leaf as the target's endpoint domain` and `serialize fails loudly for serviceOrigin() naming no compute service`) become `input: type({ baseUrl: field(type('string')) }),`.
- `packages/1-prisma-cloud/1-extensions/target/src/__tests__/local-target-preflight.test.ts`: the import `import { Load, module, resolve, type ServiceNode } from '@internal/core';` becomes `import { isSecretPointer, Load, module, resolve, type ServiceNode } from '@internal/core';`, `import { SecretBox } from '@internal/foundation/secret';` becomes `import { isSecretString } from '@internal/foundation/secret';`, and the fixture `requiresSecrets` becomes:

  ```ts
  /** Passes when every field named in `required` holds a secret: a secret box or a secret pointer. */
  const requiresSecrets = (...required: string[]): StandardSchemaV1<unknown, unknown> => ({
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => {
        const record = typeof value === 'object' && value !== null ? value : {};
        const missing = required.filter((key) => {
          const field = Object.getOwnPropertyDescriptor(record, key)?.value;
          return !(isSecretString(field) || isSecretPointer(field));
        });
        return missing.length === 0
          ? { value }
          : { issues: missing.map((key) => ({ message: `${key} is required` })) };
      },
    },
  });
  ```

- `packages/1-prisma-cloud/1-extensions/target/src/__tests__/sources.test-d.ts`: the `@internal/core` import gains `type RuntimeValue,` after `type ParamSource,`; `import { secretString } from '@internal/foundation/arktype';` becomes `import { field, secretString } from '@internal/foundation/arktype';`. In `each source constructor returns its source and a value of the type it stands for`, the four `toEqualTypeOf` arguments become `SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>`, `ParamSource<GeneratedParamPayload> & RuntimeValue<SecretString>`, `ParamSource<GeneratedParamPayload> & RuntimeValue<string>` and `ParamSource<OriginParamPayload> & RuntimeValue<string>` (`envParam`'s does not change). In `each source fits a module's input field of its type, and envParam() a service param`, the schema becomes `type({ origin: 'string', token: secretString(), base: field(type('string')), plainToken: field(type('string')), key: secretString() })` and the binding gains `plainToken: generatedParam({ redacted: false }),` after `base: serviceOrigin('shop.web'),`.

**Shared modules**

- `packages/1-prisma-cloud/2-shared-modules/auth/src/__tests__/contract.test-d.ts`: the import `import type { DependencyEnd, ModuleNode, RefPort } from '@internal/core';` gains `Pointer` (`DependencyEnd, ModuleNode, Pointer, RefPort`). `auth()'s input is baseUrl, a string` becomes `auth()'s input is baseUrl, a wrapped string field`, with `toEqualTypeOf<{ baseUrl: string | Pointer<string> }>()`.
- `packages/1-prisma-cloud/2-shared-modules/auth/src/__tests__/module.test.ts`: the import `import { Load, module, type Value } from '@internal/core';` becomes `import { Load, module, type Pointer, type Value } from '@internal/core';`, and `rootWithAuth`'s parameter becomes `baseUrl: Value<string | Pointer<string>> | string = serviceOrigin('root.app'),`.
- `packages/1-prisma-cloud/2-shared-modules/email/src/__tests__/module.test-d.ts`: the import gains `Pointer` (`ModuleNode, Pointer, RefPort, SecretString, Value`). `email()'s input is deliveryMode, from and a secret deliveryCredential` becomes `email()'s input is the wrapped fields deliveryMode and from, and a secret deliveryCredential`, with `toEqualTypeOf<{ deliveryMode: string | Pointer<string>; from: string | Pointer<string>; deliveryCredential: SecretString | Pointer<SecretString> }>()`. In commit 1 (§ 15) the expected type is `{ deliveryMode: string; from: string; deliveryCredential: SecretString | Pointer<SecretString> }` and the title does not change; commit 2 gives the final form.
- `packages/1-prisma-cloud/2-shared-modules/email/src/__tests__/module.test.ts`: in `the module's schema refuses a missing from before the service's does`, the expected message becomes `'The input binding of module "root.email" does not match the module\'s input schema: from must be a string or an object (was missing)'`.

### 13.2 New core type tests, appended to `packages/0-framework/1-core/core/src/__tests__/field.test-d.ts`

The `../exports/index.ts` type import gains `InputValueOf` (first, alphabetically), and a new line after the value import: `import type { LoadOverrides } from '../exports/testing.ts';`. Two new schemas after the existing fixtures:

```ts
const arkNested = type({
  smtp: { user: arkField(type('string')), password: arkSecretString() },
  'replyTo?': arkField(type('string')),
  tags: arkField(type('string')).array(),
});
const zodNested = z.object({
  smtp: z.object({ user: zodField(z.string()), password: zodSecretString() }),
  replyTo: zodField(z.string()).optional(),
  tags: z.array(zodField(z.string())),
});
```

1. `ArkType: service.input() is the schema's output with every pointer removed` — `InputValueOf<typeof arkSchema>` is exactly `{ from: string; port: number; host: string; key: SecretString }`, and `InputValueOf<typeof arkNested>` is exactly `{ smtp: { user: string; password: SecretString }; replyTo?: string; tags: string[] }`.
2. `Zod: service.input() is the schema's output with every pointer removed` — `InputValueOf<typeof zodSchema>` is exactly `{ from: string; port: number; host: string; key: SecretString }`, and `InputValueOf<typeof zodNested>` is exactly `{ smtp: { user: string; password: SecretString }; replyTo?: string | undefined; tags: string[] }`.
3. `a schema without type information still reads as unknown` — `InputValueOf<StandardSchemaV1>` is `unknown`.
4. `mockService()'s input double takes the shape service.input() returns, with no pointer` — `LoadOverrides<Record<never, never>, typeof arkSchema>['input']` equals `InputValueOf<typeof arkSchema>`; and, under `// @ts-expect-error a test double holds the text the service reads, never a pointer`, `const double: LoadOverrides<Record<never, never>, typeof arkSchema>['input']['from'] = {} as Pointer<string>;` then `void double;`.
5. `a secretString() field of a module takes a secret runtime value, and the body sees it as a value of SecretString | Pointer<SecretString>` — in a root body, `provision(arkChild, { id: 'a', input: { from: 'x', port: '1', host: 'h', key: secretRuntime } })` and the same for `zodChild` with id `b` compile; in `module('m', { input: arkSchema }, ({ input }) => …)`, `input.key` is `ModuleInputField<SecretString | Pointer<SecretString>>`.

### 13.3 New core runtime tests, a new `describe("a module's schema sees pointers at Load", …)` at the end of `packages/0-framework/1-core/core/src/__tests__/pointer.test.ts`

The `@internal/foundation/arktype` import becomes `import { field, secretString } from '@internal/foundation/arktype';`.

6. `a module's schema receives each runtime value's pointer itself, not a stand-in` — a Standard Schema `recording` typed `StandardSchemaV1<{ base: unknown }, { base: unknown }>` whose `validate` pushes the value into `seen` and returns `{ value: value as { base: unknown } }`; `Load(shopWith(relay(recording), { base, key }))` with `base = origin()` and `key = pointer('K')`; `(seen[0] as Record<string, unknown>)['base']` is `toBe(base)` and `['key']` is `toBe(key)`.
7. `a plain field bound to a runtime value fails at Load with the plain field's message` — `Load(shopWith(relay(type({ base: 'string' })), { base: origin() }))` fails with exactly `The input binding of module "shop.email" does not match the module's input schema: base must be a string (was an object)`.
8. `a plain pointer bound to a secretString() field fails at Load, saying it is not a secret` — `module('email', { input: type({ key: secretString() }) }, () => {})` bound `{ key: origin() }` fails with exactly `The input binding of module "shop.email" does not match the module's input schema: key must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)`.
9. `an ArkType module schema that copies its input passes the original pointers on` — a module `email` with `input: type({ base: field(type('string')), key: secretString(), port: field(type('string.integer.parse')) })` whose body provisions `echoService()` with `input: { base: input.base, key: input.key, port: input.port }`; bound `{ base, key, port: '4' }` with `base = origin()` and `key = pointer('K')`; `bindingOf(graph)['base']` is `toBe(base)`, `['key']` is `toBe(key)`, and `['port']` is `4`.

### 13.4 New target tests, a new `describe('schemas see pointers at deploy', …)` at the end of `packages/1-prisma-cloud/1-extensions/target/src/__tests__/input-serializer.test.ts`

Two fixtures inside the describe:

```ts
const recording = (seen: unknown[]): StandardSchemaV1<unknown, unknown> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      seen.push(value);
      return { value };
    },
  },
});
const returning = (output: (value: Record<string, unknown>) => unknown): StandardSchemaV1 => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => ({ value: output(value as Record<string, unknown>) }),
  },
});
```

Each test calls `serializeInput(…, { env: {} })`.

10. `a plain field bound to serviceOrigin() fails at deploy with the plain field's message` — `svc(type({ base: 'string' }))`, `{ base: serviceOrigin('shop.web') }` throws `invalid input for service "web": config param validation failed: base must be a string (was an object)`.
11. `envSecret() bound to a wrapped text field fails at deploy` — `svc(type({ from: field(type('string')) }))`, `{ from: envSecret('KEY') }` throws `invalid input for service "web": config param validation failed: from must be a string (was an object)`.
12. `a plain generatedParam() bound to a secretString() field fails, saying it is not a secret` — `svc(type({ secret: secretString() }))`, `{ secret: generatedParam({ redacted: false }) }` throws `invalid input for service "web": config param validation failed: secret must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)`.
13. `a pointer the schema copies is still written as its marker` — `svc(type({ base: field(type('string')), n: 'string.integer.parse' }))`, `{ base: serviceOrigin('shop.web'), n: '1' }`; the document equals `{ base: { $generated: 'COMPOSER_WEB_BASE_GENERATED', redacted: false }, n: 1 }`.
14. `a service whose binding holds no secret pointer is checked once` — `svc(recording(seen))`, `{ greeting: 'hi', base: serviceOrigin('shop.web') }`; `seen` has length 1.
15. `a service whose binding holds a secret pointer is checked again with a stand-in box, which never reaches the document` — `svc(recording(seen))`, `{ key, token: generatedParam() }` with `key = envSecret('KEY')`; `seen` has length 2; in `seen[0]`, `key` is `toBe(key)` and `isSecretPointer(token)` is `true`; in `seen[1]`, `isSecretString` is `true` for `key` and for `token`; `row?.value` does not contain `composer-stand-in-not-a-secret`; the document equals `{ key: { $secret: 'KEY' }, token: { $generated: 'COMPOSER_WEB_TOKEN_GENERATED', redacted: true } }`.
16. `an ArkType schema that deletes undeclared keys loses a secret box, and the deploy refuses it naming the field` — `svc(type({ '+': 'delete', key: secretString() }))`, `{ key: envSecret('KEY') }` throws a message containing `input key "key" of service "web" validated to a copy of its secret`.
17. `a wrapped transforming field beside a secret makes ArkType copy the input, and the deploy refuses it` — `svc(type({ key: secretString(), port: field(type('string.integer.parse')) }))`, `{ key: envSecret('KEY'), port: '4' }` throws a message containing `input key "key" of service "web" validated to a copy of its secret`.
18. `a redacted generatedParam() copied with the input is refused the same way` — `svc(type({ secret: secretString(), name: 'string.trim' }))`, `{ secret: generatedParam(), name: ' shop ' }` throws a message containing `input key "secret" of service "web" validated to a copy of its secret`.
19. `a schema that accepts a secret's pointer but refuses a box in its place is refused` — a Standard Schema whose `validate` returns `{ value }` when `isSecretPointer((value as Record<string, unknown>)['key'])` and otherwise `{ issues: [{ message: 'key must be a pointer' }] }`; `{ key: envSecret('KEY') }` throws exactly `invalid input for service "web": the schema accepts each secret's pointer but refuses a secret box in its place: key must be a pointer`.
20. `a schema that replaces a field bound to a value known only at boot is refused` — `svc(returning(() => ({ base: 'x' })))`, `{ base: serviceOrigin('shop.web') }` throws exactly `input key "base" of service "web" is bound to a value known only at boot, but the schema replaced it. A schema may check such a field, never move or transform it.`
21. `a schema that moves a pointer to another key is refused` — `svc(returning((value) => ({ other: value['base'] })))`, `{ base: serviceOrigin('shop.web') }` throws exactly `input key "other" of service "web" validated to a value known only at boot that its binding did not put there: the schema moved it. A schema may check such a field, never move or transform it.`

### 13.5 New target type test, appended to `packages/1-prisma-cloud/1-extensions/target/src/__tests__/sources.test-d.ts`

22. `a runtime value does not fit a plain field, and a secret one does not fit a wrapped text field` — `relay = module('relay', { input: type({ host: 'string', from: field(type('string')) }) }, () => {})`; in a root body, each of these has its own `@ts-expect-error` line with the reason in a trailing comment:
    - `provision(relay, { input: { host: serviceOrigin('shop.web'), from: 'x' } });` — `serviceOrigin() is a runtime value; a plain field takes deploy-time data only`;
    - `provision(relay, { input: { host: generatedParam({ redacted: false }), from: 'x' } });` — `a plain generatedParam() is a runtime value; a plain field takes deploy-time data only`;
    - `provision(relay, { input: { host: 'h', from: envSecret('KEY') } });` — `envSecret() is a secret runtime value; a wrapped text field takes a plain pointer only`.


## 14. Scope

In: `packages/0-framework/0-foundation/foundation` (§ 3, tests); `packages/0-framework/1-core/core` (§ 4, § 5, tests); `packages/1-prisma-cloud/1-extensions/target` (§ 6, § 7, tests); `packages/1-prisma-cloud/2-shared-modules/{auth,email}` (§ 8, tests, the email README); `docs/`; `skills/`.

Out, as the plan assigns: `resolve()` refusing runtime values and wrapped fields, removing `isRuntimeValue()` and Load's acceptance of a returned pointer, and the rest of the guide's § Sources in resolve() (S8); the dictionary brand on `input` and refusing the whole `input` (S9); typing a service's binding from its schema, `SecretString` and `Pointer` as leaves, and removing `InputBindingData` and `InputBinding` (S10); `dotenv-flow` (S11); the configuration file and the "pool" names (S12); redaction (S13); `secret(schema)` (S17). Also out: a secret box that survives an ArkType copy (design section 11).

## 15. Commits, in order

Each commit is made with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"` and has no `Co-Authored-By` line. Before each commit, run `pnpm lint:fix` and keep the formatting it writes. Each commit leaves `pnpm build`, `pnpm turbo run typecheck`, `pnpm turbo run test:types`, `pnpm lint` and the touched packages' `bun test` green, apart from the four tests § 16 names. If a commit cannot be made green as pinned, stop and report.

1. `feat(core): service.input() reads every field without its pointer` — § 3, § 4; the foundation test changes (§ 13.1); the retitled `secretString()` type test in `field.test-d.ts` and tests 1 to 5; the commit-1 form of `email/src/__tests__/module.test-d.ts`.
2. `feat(prisma-cloud): auth() and email() wrap the fields a runtime value may bind` — § 8; the auth `contract.test-d.ts` change; the final `email/src/__tests__/module.test-d.ts`; the `email/src/__tests__/module.test.ts` change. At this commit the stand-ins of S6 are still in place, and a wrapped field accepts them as the plain field did.
3. `feat(core): a module's schema checks each runtime value as its pointer` — § 5; in `param.ts`, only the two `paramSource()` option objects (`{ label: 'generatedParam()', redacted }` and `` { label: `serviceOrigin('${address}')` } ``); the core test changes in § 13.1; tests 6 to 9; and in `input-serializer.test.ts` only the `serviceOrigin() forwarded through a module's input …` change and the `field` import.
4. `feat(prisma-cloud): a service's schema checks each runtime value as its pointer` — § 7; `ORIGIN_SENTINEL` removed from `param.ts`; the rest of the `input-serializer.test.ts` changes; the `control-lowering.test.ts` and `local-target-preflight.test.ts` changes; tests 10 to 21.
5. `feat(prisma-cloud)!: envSecret(), generatedParam() and serviceOrigin() are runtime values` — the type changes of § 6; the `sources.test-d.ts` changes and test 22; the auth `module.test.ts` change.
6. `docs(design): schemas see pointers at deploy` — § 11.1, § 11.2, § 11.3.
7. `docs: wrap fields bound to runtime values, in the guides, the agent skill and the email README` — § 11.4, § 11.5, § 11.6, § 11.7.
8. `docs(drive): module-input S7 manual QA` — `qa.md` in this slice's folder (§ 16).

## 16. Done when

- Tests 1 to 22 pass, and every test changed in § 13.1 passes. At the root: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm lint:deps`, `pnpm test`, `pnpm turbo run test:types`, `pnpm check:floor-imports`, `pnpm check:publish-deps` and `pnpm check:skill-packaging` are green. `pnpm lint:casts` reports `delta=0`: this slice adds no bare cast, and removes one `blindCast` from `resolve-values.ts`.
- The one exception: the four tests under `a hostname public URL under the Alchemy apply engine` in the Prisma Cloud target fail when `bun test` runs alone in `packages/1-prisma-cloud/1-extensions/target`, on the unchanged S6 branch as well, and pass under `pnpm test`. If any other test fails, stop and report.
- Every document in § 11 is updated.
- Manual QA, recorded in `qa.md` in this slice's folder, after `pnpm build`, against Prisma Cloud. Credentials come from `$HOME/.config/prisma-compose/deploy.env`, which sets `PRISMA_SERVICE_TOKEN`, `PRISMA_WORKSPACE_ID` and `ALCHEMY_PASSWORD`; print only variable names, never values. It does not set the region, so every command below that reaches Prisma Cloud is prefixed with `PRISMA_REGION=us-east-1`. Run deploys from the example folder as `pnpm run deploy`, because `pnpm deploy` is pnpm's own command.
  1. **Nothing to collide with.** List the workspace's Project names, and record them:

     ```sh
     ( set -a; . "$HOME/.config/prisma-compose/deploy.env"; set +a
       curl -sS -H "Authorization: Bearer $PRISMA_SERVICE_TOKEN" 'https://api.prisma.io/v1/projects?limit=100' \
         | jq -r '.pagination.hasMore, (.data[].name)' )
     ```

     The first line is `false`; if it is `true`, stop and report. If a Project named `auth-example` is listed, stop and report: this run creates that Project and removes it, and must not touch one it did not create.
  2. **The auth example, deployed.** In `examples/auth`, with `EMAIL_DELIVERY_MODE`, `EMAIL_FROM` and `EMAIL_DELIVERY_CREDENTIAL` unset in the shell: `cp .env.example .env`, then `PRISMA_DEPLOY_ENV="$HOME/.config/prisma-compose/deploy.env" PRISMA_REGION=us-east-1 pnpm run deploy`. It ends with `Deployed auth-example to production`. Record the step lines.
  3. **It serves.** `PRISMA_DEPLOY_ENV="$HOME/.config/prisma-compose/deploy.env" PRISMA_REGION=us-east-1 pnpm run smoke:deployed` passes every check (15 at S5). The checks include following the verification email's link, which starts with the api service's deployed origin: that is `serviceOrigin('auth-example.api')` reaching the auth service through `auth()`'s wrapped `baseUrl`, and the instance secret, a redacted `generatedParam()`, read at boot through a `secretString()` field the second check passed.
  4. **`prisma dev` of the auth example.** Remove `.env`. Create `.env.dev` holding `EMAIL_DELIVERY_MODE=none`, `EMAIL_FROM=s7-qa-auth-dev@example.com` and `EMAIL_DELIVERY_CREDENTIAL=local-dev-unused`. `prisma dev --detach` prints `dev: ready`. With the URLs from `prisma dev url auth-example.api` and `prisma dev url auth-example.ops`, sign up `s7-qa-dev-user@example.com` through `POST /api/auth/sign-up/email` on the api URL, then read it back through `POST /admin/find-sent-email` on the ops URL: the email's `from` is `s7-qa-auth-dev@example.com`, and its link starts with the api service's dev URL. `prisma dev stop`, then remove `.env.dev`.
  5. **Tear down.** `cp .env.example .env`, then `PRISMA_DEPLOY_ENV="$HOME/.config/prisma-compose/deploy.env" PRISMA_REGION=us-east-1 pnpm run destroy` prints `Destroyed.` and that it removed the Project. Remove `.env`. The Project list is the one step 1 recorded. `git status` shows only this slice's changes.

## 17. Checks the spec author ran

Two scratch worktrees of this branch, detached, under its git-ignored `wip/`, removed afterwards. The whole change, as one patch against this branch, is kept at `wip/s7-spec-probe/final.patch` (git-ignored) for the review to compare with; the spec, not the patch, is what the implementer follows.

- **The whole change.** With every change in § 3 to § 8 and § 13 applied: `pnpm build`; `pnpm turbo run typecheck --continue`, 80 of 80 tasks green; `pnpm turbo run test:types --continue`, 43 of 43 green; `pnpm test`, 69 of 69 tasks green (foundation 93 pass, core 401, the Prisma Cloud target 616, auth 132, email 99, the auth example 3, every other package unchanged); `pnpm lint`, 40 warnings and 20 infos, the same as the unchanged S6 branch; `pnpm lint:casts`, `current=18 merge-base=18 delta=0`; `pnpm lint:deps`, `pnpm check:floor-imports`, `pnpm check:publish-deps` and `pnpm check:skill-packaging` green.
- **The commit order.** Commits 1 to 5 of § 15 applied one at a time, each followed by `pnpm build`, `pnpm turbo run typecheck`, `pnpm turbo run test:types`, `pnpm lint` and `bun test` in foundation, core, the target, auth, email and the auth example. Each was green, apart from the four tests § 16 names, which fail the same way under a lone `bun test` on the unchanged S6 branch. After commit 5 the tree was byte for byte the whole change above.
- **Probes against ArkType 2.2.7**, each with `new SecretBox('stand')` beside other fields: `type({ '+': 'delete', key: secretString() })` with and without an undeclared key, `type({ key: secretString(), name: 'string.trim' })`, a nested morph, and `type({ key: secretString(), port: field(type('string.integer.parse')) })` each return a different box whose `expose()` throws `Cannot access invalid private field (evaluating 'this.#value')`; `type({ key: secretString(), name: 'string' })` returns the same box. **Against Zod 4.4.3**, `z.object` with a `.transform()` and a wrapped transforming field beside `secretString()`, and `z.strictObject`, return the same box.
- `serializeInput(authService(), 'shop.auth.service', { baseUrl: serviceOrigin('shop.api'), secret: generatedParam(), signUp: 'open' }, { env: {} })` gives the document § 8.2 quotes.

## 18. Decisions this spec records, for the review

1. **The constructors' types change in this slice** (§ 6), as S6's conflict 3 asked. They need the wrapped `auth()` field and the new `secretString()` types first, which this slice adds, and S8's compile error needs them.
2. **`secretString()` is typed `SecretString | Pointer<SecretString>`** (§ 3). At deploy its output is a pointer, and a module's body and S10's binding types read that type. `service.input()` strips the pointer, so services keep `.expose()`. S6's decision 5 deferred this to here.
3. **`InputValueOf` strips pointers with an unexported `WithoutPointers<T>`** (§ 4.1). The design names no type. `InputValueOf` is already public and is what `service.input()` and `mockService()` use, so one change covers both, and nothing new becomes public.
4. **`auth()` and `email()` wrap their fields** (§ 8). The design shows `email()`'s `from` wrapped (section 1) and asks for every leaf of a reusable module's schema to be wrapped unless a `resolve()` needs it (section 3). A wrapped module field forwarded to a plain service field would fail at deploy, so each service field the module forwards is wrapped too. `email()`'s `deliveryUrl` and `auth()`'s `signUp` stay plain: only a factory option binds them, with a literal. The cost is ArkType's union wording for a missing wrapped key (§ 9, item 5), which S6 recorded.
5. **`paramSource()` has no run-time check for a leftover `sentinel`** (§ 5.2). TypeScript refuses it, and the foundation and core helpers check no unknown options anywhere. A source built with it is a plain pointer, which is what a param source with a sentinel was.
6. **Load puts back the original source by its origin** (§ 5.3), as the S6 tests require (`a copy … reaches the service as the original`). That keeps one object per source downstream, so `graph.secretSources` and the identity tests hold.
7. **Load keeps refusing a module schema that replaces or moves a runtime value's field** (§ 5.3). *(Corrected after the code review. The first version of this spec removed the check, arguing that the service's own deploy check would then see no pointer where it expected one. That is wrong: the service's binding is built from the module schema's output, so a replaced pointer reaches the service's binding as the replacement, and the serializer has no generated leaf at that path to compare against. The replacement would pass on silently.)* With pointers in place, the check is: "is the output at this path the source the binding put there", which a wrapped field always passes, and only a hand-written schema can fail. The serializer keeps the same check for a service's schema (§ 7.6).
8. **The second check uses one fixed stand-in text, `'composer-stand-in-not-a-secret'`** (§ 7.5). The design asks for a known text that is not a secret. One constant makes the test that the stand-in never reaches the document exact.
9. **The second check names the field by its path in the output** (§ 7.5). The copied box is found in the output; the binding path is the same unless the schema renames keys, which the design does not cover.
10. **The second check runs only in `serializeInput`** (§ 7.5), the path of every deploy and every `prisma dev` stack. `inputValidationFailure` answers a different question for dev preflight, whether the schema accepts a binding with some secrets left out.
11. **A schema that refuses a stand-in box it accepted as a pointer fails the deploy** (§ 7.5). Neither helper does this; a hand-written schema could. The deploy cannot tell what the schema would do at boot, so it refuses.
12. **The serializer refuses a moved or replaced runtime value** (§ 7.6). The old serializer wrote a `$generated` marker at a generated path whatever the schema returned there. With pointers in place, writing a marker over a value the schema chose would hide the schema's choice; the two refusals say what happened.
13. **The examples change no code** (§ 8.5). The plan asks the examples to wrap every field bound to `generatedParam()` or `serviceOrigin()`; none of them binds one to a field of its own schema.
14. **The guide's module example wraps `replyTo` and keeps `from` plain** (§ 11.4), to show both kinds of field in one place: `from` is listed in a `resolve()`.
15. **Three decision records are amended: service input, module input and `resolve()`** (§ 11.2). Design section 12 lists the service input reversal; the module input decision's body says a secret reaches the schema as an opaque box, which is now false; the `resolve()` decision's sixth-slice note said the constructors' types would not change yet. The params-bind-at-provision decision (`ADR-0032`) is amended too, after the code review: its third-slice note lists `paramSource()`'s `sentinel` option, and a seventh-slice note says it is gone and `redacted` sets the pointer's kind. No other recorded decision mentions stand-ins.
16. **The release note's title marks the whole change breaking with `feat!:`** (§ 12), as S5 did with `feat(core)!:`, because it spans core and the Prisma Cloud target.
17. **No `.drive/deferred.md` entry.** The one limit this slice exposes, that an ArkType service schema cannot transform beside a secret, is design section 11's "A secret box that survives an ArkType copy".

## 19. Conflicts

1. **The brief asks for throwaway names in the Prisma Cloud QA; the auth example cannot be deployed under another name.** `examples/auth/module.ts` binds `serviceOrigin('auth-example.api')`, and `docs/design/10-domains/deploy-cli.md` says an app that uses `serviceOrigin()` cannot be deployed under `--name`, because the addresses in its bindings start with the app name. So § 16 creates the `auth-example` Project and removes it, as S5's QA did, and stops if a Project of that name already exists.
2. **The brief lists `reviews/design/*.md`; there is no such folder.** The project's reviews are per slice (`slices/*/reviews/`). This spec read S6's two reviews.
3. **A wrapped transforming field makes ArkType copy the whole input** (§ 17). So an ArkType service schema with a `secretString()` field cannot use `field(type('string.integer.parse'))`, the design's own example of a wrapped field (section 3, "Wrapped fields and plain fields"). The design's section 3 "Limits" says any ArkType transform copies the input; the second check refuses such a service at deploy, as S6's check already did beside an `envSecret()`. A module's schema is not affected: Load's restore keeps the original pointers, and no box crosses a module schema at deploy. The guide and the skill say so (§ 11.4, § 11.6). Will may want the design's example pair, `port: field(type('string.integer.parse'))` beside `deliveryCredential: secretString()`, marked as a module schema, not a service schema.
4. **`email()`'s missing-field message regresses to ArkType's union wording** (§ 9, item 5). Design section 3 accepts this for every wrapped ArkType field; the email module's test now asserts it.
5. **`config-params.md` § Sources are values says the service row's `generatedParam()` and `serviceOrigin()` are "kept"**, which stays true: the source reaches the target. Only the module row described stand-ins, and § 11.3 rewrites it.
