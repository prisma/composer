# S8 — `resolve()` takes deploy-time values only

Parent: [module-input spec](../../spec.md) and [plan](../../plan.md). Design: [design.md](../../design.md), which is authoritative; this slice builds its section 6 and the two `resolve()` items of section 10. Decisions: the `resolve()` and config adapters decision ([ADR-0062](../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), the secrets decision ([ADR-0029](../../../../../docs/design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md)) and the module input decision ([ADR-0061](../../../../../docs/design/90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)), each with its amendments. It builds on S7 (branch `claude/module-input-s7`), which builds on S6 to S2. The branch is `claude/module-input-s8`.

This spec leaves nothing to the implementer's judgement. Every type, signature, name, error message, file, test, document edit and commit is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose. § 16 lists the decisions this spec takes, and § 17 the conflicts it found.

Every code change, test and document edit in § 3 to § 9 and § 11 was applied in a scratch copy of this branch, commit by commit in the order of § 13, with TypeScript 6.0.3, ArkType 2.2.7 and Zod 4.4.3; § 15 lists what ran and what passed.

Read for this spec: `CLAUDE.md`; `docs/design/01-principles/`; the three decisions above with every amendment note; the glossary entries Value, RuntimeValue and `field()`; `module-composition.md` § Input; `config-params.md` § Sources are values; `core-model.md` on Load's second pass; `design.md` sections 3, 4, 6, 10 and 12; `plan.md` S8 to S13; the S6 and S7 slice folders (spec, both reviews, `qa.md`); `.agents/rules/no-bare-casts.mdc`, `test-import-patterns.mdc`, `vitest-expect-typeof.mdc` and `user-facing-surface-changes.mdc`; `skills/README.md`; and the code each section names.

`<date>` below is the date the pull request is opened, as `YYYY-MM-DD`.

## 1. At a glance

```ts
// a plain field: the author asks for deploy-time data, so resolve() can compute with it
const email = module('email', { input: type({ from: 'string', replyTo: field(type('string')) }) },
  ({ input, environment, provision }) => {
    const sender = resolve([input.from, environment.name], ([from, name]) => `${name}+${from}`); // compiles
    resolve([input.replyTo], ([replyTo]) => replyTo);  // fails to compile: a wrapped field may hold a pointer
    resolve([envSecret('STRIPE_KEY')], ([key]) => key); // fails to compile: known only at boot
  });
```

What the author sees for the last line:

```text
error TS2322: Type 'SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>' is not assignable to type '"a resolve() dependency must be a deploy-time value, never a value known only at boot or a field wrapped with field(); to compute with an input field, declare it plain"'.
```

Where the compiler cannot see it, such as a field typed `unknown` or a cast, Load refuses the dependency before `fn` runs:

```text
The resolve() function for input key "url" of service "shop.email.echo" lists input.from of module "shop.email", whose real value is serviceOrigin('shop.web'), a value known only at boot. A resolve() dependency must be a deploy-time value. To compute with input.from, declare it plain, without field(), and bind it to deploy-time data.
```

`isRuntimeValue()` is removed from `@prisma/composer`, and a `resolve()` function that returns a source always fails.

## 2. The model

- **A dependency must be a deploy-time value.** That is `environment.name`, another `resolve()` result, `envParam()`, or a plain field of a module's input (design section 6). A runtime value (`envSecret()`, `generatedParam()`, `serviceOrigin()`), a field wrapped with `field()`, and a `secretString()` field cannot be listed.
- **The compiler checks the type.** `resolve()`'s first parameter is typed `DeployTimeDependencies<D>`, which maps each dependency whose real-value type is or holds a `Pointer`, at any depth through arrays and plain object types, to a string literal type: the message. So TypeScript reports that the value is not assignable to the message. `any` and `unknown` pass, because the type says nothing.
- **Load checks the real value.** Before it runs `fn`, Load looks through each dependency's real value, through arrays and plain objects, for a source known only at boot. If it finds one, it fails, naming the dependency and, for an input field, the field that holds the pointer. The advice differs for a secret pointer, which no field can make deploy-time.
- **`fn` never receives a pointer, so it can never return one.** `checkResult` refuses every source in a result. `isRuntimeValue()`, which existed to tell a received pointer apart, is removed.
- **So every secret preflight checks is one a binding names.** Load fails before it records a secret only a `resolve()` lists. The preflight code does not change; only its doc comments and the tests that relied on a secret only a `resolve()` lists change.
- **Deploy output does not change.** No example and no shared module lists a source or a wrapped field in `resolve()`: `examples/env-param/module.ts` lists `environment.name`, and that is the only `resolve()` in `examples/` and `packages/*/2-shared-modules/`.

## 3. Core: the compile-time check

All in `packages/0-framework/1-core/core/src/value.ts`.

### 3.1 New types

Directly after `RealValuesOf` (and before the `PlainData` doc comment), four types, none exported:

```ts
/** `true` when `T` is a `Pointer` or holds one, through arrays and plain object types. */
type HoldsPointer<T> =
  T extends Pointer<unknown>
    ? true
    : T extends readonly (infer E)[]
      ? HoldsPointer<E>
      : T extends Record<PropertyKey, unknown>
        ? HoldsPointer<T[keyof T]>
        : false;

/** `true` for a real-value type a `resolve()` function can compute with: one that holds no pointer. `any` and `unknown` pass; Load checks those. */
type IsDeployTime<T> = 0 extends 1 & T ? true : true extends HoldsPointer<T> ? false : true;

/** The type error an author sees for a dependency that is not a deploy-time value. */
type NotDeployTime =
  'a resolve() dependency must be a deploy-time value, never a value known only at boot or a field wrapped with field(); to compute with an input field, declare it plain';

/** `D` with each dependency that is not a deploy-time value replaced by the message saying so. */
type DeployTimeDependencies<D extends readonly Value<unknown>[]> = {
  readonly [K in keyof D]: D[K] extends Value<infer T>
    ? IsDeployTime<T> extends true
      ? D[K]
      : NotDeployTime
    : D[K];
};
```

How they behave, each checked with `tsc`:

- `HoldsPointer` is distributive, so a union such as `string | Pointer<string>` gives `boolean`, and `true extends boolean` refuses it.
- `Record<PropertyKey, unknown>` matches object literal types, which is what ArkType and Zod output. It does not match an interface or a class, so `Date`, `Map` and `SecretString` stop the walk, as in S7's `WithoutPointers`. So `Value<SecretString>` with no pointer in its type compiles; § 16, decision 4.
- `0 extends 1 & T` is true only for `any`. Without it, `HoldsPointer<any>` is `boolean` and a field typed `z.any()` would be refused.
- `unknown` matches no branch, so `HoldsPointer<unknown>` is `false`.

### 3.2 `resolve()`

The doc comment, the first parameter and the dependency check change. The function from its doc comment to the `frozenDependencies` line becomes exactly:

```ts
/**
 * A value computed from other values. `fn` receives the dependencies' real
 * values as one tuple, in order, and returns plain data. Each dependency must
 * be a deploy-time value: listing a runtime value or a field wrapped with
 * `field()` fails to compile, and Load refuses a dependency whose real value
 * holds a pointer. Load runs `fn` after every module body, with `provision`
 * disabled (ADR-0062). `fn` must be a pure function of its dependencies: a
 * deploy runs it in two processes.
 */
export function resolve<const D extends readonly Value<unknown>[], T>(
  dependencies: DeployTimeDependencies<D>,
  fn: (values: RealValuesOf<D>) => T,
): Value<T> {
  if (!Array.isArray(dependencies)) {
    throw new Error('resolve() requires a tuple of values as its first argument.');
  }
  const checked = dependencies.map((dependency: unknown, index): Value<unknown> => {
    if (!isValue(dependency)) {
      throw new Error(
        `resolve() dependency at index ${index} is not a value — list environment.name or another resolve() result.`,
      );
    }
    return dependency;
  });
  if (typeof fn !== 'function') {
    throw new Error('resolve() requires a function as its second argument.');
  }
  const frozenDependencies: readonly Value<unknown>[] = Object.freeze(checked);
```

The rest of the function does not change. The `map` replaces `forEach` and `[...dependencies]`, because a `DeployTimeDependencies<D>` element is typed as a value or the message, and `isValue()` narrows each one to `Value<unknown>` with no cast. TypeScript still infers `D` through the mapped type, so `fn`'s tuple keeps its exact types (test 8).

When the check fails, TypeScript types the call's result `Value<unknown>`, so a second error can follow where the result is used, such as `No overload matches this call` on the `provision()` that binds it. Three other signatures were tried and each gives `Value<unknown>` too (§ 15). The first error is always the message, at the dependency.

## 4. Core: Load refuses a pointer dependency

All in `packages/0-framework/1-core/core/src/resolve-values.ts`.

### 4.1 Import

After `import { describeKind } from '@internal/foundation/errors';`, a new line:

```ts
import { isSecretPointer } from '@internal/foundation/pointer';
```

### 4.2 `checkResult`

- Its signature becomes `function checkResult(result: unknown, fnLabel: string): void {`.
- In its walk, the branch for a source becomes:

  ```ts
      if (isSecretSource(value) || isParamSource(value)) {
        throw new LoadError(
          `${fnLabel} returned a source${atPath}, such as envSecret() or envParam() called inside the function. resolve() returns plain data; bind a source directly.`,
        );
      }
  ```

  The line `if (received.has(value)) return;` is gone. Nothing else in `checkResult` changes.
- Its call in `resolveOne`, `checkResult(result, fnLabelFor(site), pointersIn(args));`, becomes `checkResult(result, fnLabelFor(site));`. `pointersIn` stays: `secretSourcesReceivedBy` uses it.

### 4.3 Two new functions

Directly before `function substitute(`:

```ts
/** The first pointer in `value`, at any depth through arrays and plain objects, with its key path; `undefined` when there is none. */
function firstPointer(
  value: unknown,
  path: readonly string[] = [],
  seen = new WeakSet<object>(),
): { readonly pointer: ParamSource | SecretSource; readonly path: readonly string[] } | undefined {
  if (isSecretSource(value) || isParamSource(value)) return { pointer: value, path };
  if (!Array.isArray(value) && !isPlainObject(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((member, index) => [String(index), member])
    : Object.entries(value);
  for (const [key, member] of entries) {
    const found = firstPointer(member, [...path, key], seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Refuses a resolve() dependency whose real value is a pointer or holds one at any depth: `fn` computes with deploy-time data only. */
function refusePointerDependency(fnLabel: string, dependency: Value<unknown>, real: unknown): void {
  const found = firstPointer(real);
  if (found === undefined) return;
  const label = sourceOriginOf(found.pointer)?.label ?? 'a value known only at boot';
  const origin = originOf(dependency);
  if (origin.kind !== 'input') {
    throw new LoadError(
      `${fnLabel} lists ${label}, which is known only at boot. A resolve() dependency must be a deploy-time value. Bind ${label} directly into the input of the service that reads it.`,
    );
  }
  const listed = `${inputFieldLabel(origin)} of module "${origin.module}"`;
  const field = inputFieldLabel({ ...origin, path: [...origin.path, ...found.path] });
  const holds =
    found.path.length === 0 ? `whose real value is ${label}` : `which holds ${label} at ${field}`;
  const advice = isSecretPointer(found.pointer)
    ? `A secret has no deploy-time value: pass ${field} on into a binding, and read it in the service.`
    : `To compute with ${field}, declare it plain, without field(), and bind it to deploy-time data.`;
  throw new LoadError(
    `${fnLabel} lists ${listed}, ${holds}, a value known only at boot. A resolve() dependency must be a deploy-time value. ${advice}`,
  );
}
```

- The source check comes before `isPlainObject()`, because a source is a frozen object whose prototype is `Object.prototype` (S7 spec § 5.3).
- A source found in a real value is always one known only at boot: Load replaces an `envParam()` with its text before any real value holds it.
- A source is recognised by its brands, as everywhere in Load, so a copy an ArkType schema made counts. Load's `restore` has already put the original back, so the label is the original's.
- The `origin.kind !== 'input'` branch covers a source listed directly. An environment value has no pointer, and a computed value's result has none either, because `checkResult` refuses a source.

### 4.4 The call

In `resolveOne`, case `'computed'`, the dependency map becomes:

```ts
        const args = origin.dependencies.map((dependency) => {
          const real = resolveOne(dependency, site);
          const source = originOf(dependency);
          if (real === undefined && source.kind === 'source') {
            throw new LoadError(
              `${fnLabelFor(site)} lists ${source.label}, but "${source.poolKey}" is unset or empty, so it has no real value. Set "${source.poolKey}", or bind ${source.label} directly into an input binding, where an absent value leaves the key out and the schema decides.`,
            );
          }
          refusePointerDependency(fnLabelFor(site), dependency, real);
          return real;
        });
```

The only new line is `refusePointerDependency(fnLabelFor(site), dependency, real);`. So the check runs once per dependency, after its real value is known and before `fn` runs.

### 4.5 Two cast reasons

The reasons of the two `blindCast` calls at the end of `resolveValues` lose ` or a pointer it received`:

- `'substitution rebuilds the plain props object, replacing each Value<PlainData> with its real value: an environment or computed value is plain data, which checkResult checked, an input field is its module schema output, and the pointer check above refused any pointer left'`
- `'substitution replaces each value with its real value and keeps every source in place: an environment or computed value is plain data, which checkResult checked, and an input field is its module schema output with each pointer put back; the service schema validates the whole binding again when the target serializes it'`

## 5. Core: `isRuntimeValue()` goes, and what a pointer's misuse error says

### 5.1 `packages/0-framework/1-core/core/src/node.ts`

- In `sourceMisuse`, the second string of the branch for a source known only at boot becomes:

  ```ts
          'A module body can only pass it on, into a provision() binding; to compute with the value, do it in the service that reads it.'
  ```

  (in commit 1, § 13). The branch for a source with a pool key does not change.
- `isRuntimeValue` and its doc comment, from `/**` to the blank line after the function's closing brace, are removed (in commit 3).

### 5.2 `packages/0-framework/1-core/core/src/exports/index.ts`

The line `  isRuntimeValue,` is removed from the `../node.ts` export list (commit 3). `@prisma/composer` re-exports `@internal/core` with `export *`, so the public package needs no edit.

### 5.3 Doc comments in core (commit 1)

- `packages/0-framework/1-core/core/src/graph-types.ts`:
  - `SecretSourceUse`'s doc comment becomes `/** A secret source a binding in the graph names, wherever it sits (ADR-0029). Deploy preflight checks every one, including one in a module's input that no service receives. */`.
  - Its `address` doc comment becomes `  /** A service whose final binding holds it, if one does. Otherwise the module whose input holds it. */`.
  - `Graph.secretSources`'s doc comment becomes `  /** Every secret source a binding names, once each, in the order Load met them (ADR-0029). */`.
  - `nodeKind`'s type `'service' | 'module' | 'resource'` does not change (§ 16, decision 7).
- `packages/0-framework/1-core/core/src/config.ts`, `secretSourceManifest`'s doc comment, the two lines ` * Every secret source the graph names, in a binding or as a resolve()\n * dependency, wherever it sits: what a deploy target's preflight checks.` become ` * Every secret source a binding in the graph names, wherever it sits: what a\n * deploy target's preflight checks.`

## 6. Prisma Cloud target: doc comments only (commit 1)

No target code changes.

- `packages/1-prisma-cloud/1-extensions/target/src/secret.ts`, `envSecret`'s doc comment: the three lines ` * or the platform-owned \`DATABASE_URL(_POOLED)\` keys. It returns a value known\n * only at boot: a resolve() function that lists it receives a pointer, which\n * throws when turned into text.` become ` * or the platform-owned \`DATABASE_URL(_POOLED)\` keys. It returns a value known\n * only at boot, which a resolve() function cannot list, and which throws when\n * turned into text.`
- `packages/1-prisma-cloud/1-extensions/target/src/preflight-names.ts`:
  - The file header's four lines ` * Secrets also include every secret source the graph names elsewhere\n * (secretSourceManifest): one a resolve() lists but does not return, one in a\n * module's input that no service receives, and one a resolve() in a\n * resource's props lists.` become ` * Secrets also include every secret source the graph names elsewhere\n * (secretSourceManifest): one in a module's input that no service receives.`
  - `PreflightName.address`'s doc comment becomes `  /** The node that uses the name: a service whose binding holds it, or, when no service receives it, the module whose input holds it. */`.
- `packages/1-prisma-cloud/1-extensions/target/src/preflight.ts`, the doc comment of the extension's `preflight`: the three lines ` * The Prisma Cloud extension's \`preflight\`. Every secret source the graph\n * names is checked, including one only a resolve() dependency lists. Uses the\n * shared name collector (\`collectPreflightNames\`, ADR-0042): every secret` become ` * The Prisma Cloud extension's \`preflight\`. Every secret source the graph\n * names is checked, including one in a module's input that no service\n * receives. Uses the shared name collector (\`collectPreflightNames\`,\n * ADR-0042): every secret`. The lines after it do not change.

## 7. What breaks, and what does not

Breaks:

1. A `resolve()` that lists `envSecret()`, `generatedParam()` or `serviceOrigin()`: a compile error, and with a cast or no types a Load error. Before, `fn` received the pointer and could return it. The guide's own example, choosing between `STRIPE_LIVE_KEY` and `STRIPE_TEST_KEY` by environment, no longer works; the fix is one variable name with a different value on each environment (§ 9.4, § 10).
2. A `resolve()` that lists a field wrapped with `field()` or typed `secretString()`, or an object or array field holding one: a compile error, and a Load error when its real value holds a pointer.
3. A `resolve()` function that returns a source: always a Load error.
4. Code that calls `isRuntimeValue()`: a compile error and a missing export.
5. The text of a pointer's misuse error (§ 8).

Unchanged:

1. Every `resolve()` over `environment.name`, another `resolve()` result, `envParam()` or a plain field, its messages included.
2. The graph Load returns for any app that Loaded before and lists no runtime value, and so every input document, stack file and deploy report.
3. Preflight code, the serializer, boot and `prisma dev`.
4. A wrapped field bound to deploy-time data and listed through a cast: Load accepts it, because its real value holds no pointer (test 7).

The only existing tests this slice changes are listed in § 11.1. If any other existing test fails, the implementer stops and reports.

## 8. Error messages, verbatim

### 8.1 The compile error

The type `NotDeployTime` (§ 3.1) is the message. `tsc` prints it as the target of a TS2322 error at the dependency. Recorded with `tsc` for `resolve([environment.name, envSecret('GREETING_KEY')], ([name]) => …)` in `examples/env-param/module.ts`:

```text
module.ts(17,44): error TS2322: Type 'SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>' is not assignable to type '"a resolve() dependency must be a deploy-time value, never a value known only at boot or a field wrapped with field(); to compute with an input field, declare it plain"'.
```

For a module's wrapped field and a `secretString()` field the source type reads `Value<string | Pointer<string>>` and `Value<SecretString | Pointer<SecretString>>`.

### 8.2 Load messages

`<fn>` is what `fnLabelFor(site)` gives today, such as `The resolve() function for input key "url" of service "shop.echo"`, or `A resolve() function that … depends on`. `<label>` is the pointer's source label, such as `envSecret('K')`, or `a value known only at boot` when the source has no origin. `<listed>` is `input.<path> of module "<address>"`, and `<field>` is the input label of the pointer's own path.

New:

| Where | Condition | Message |
| --- | --- | --- |
| `refusePointerDependency` | a dependency that is not an input field, such as a source listed directly | `<fn> lists <label>, which is known only at boot. A resolve() dependency must be a deploy-time value. Bind <label> directly into the input of the service that reads it.` |
| `refusePointerDependency` | an input field whose real value is a plain pointer | `<fn> lists <listed>, whose real value is <label>, a value known only at boot. A resolve() dependency must be a deploy-time value. To compute with <field>, declare it plain, without field(), and bind it to deploy-time data.` |
| `refusePointerDependency` | an input field that holds a plain pointer below it | `<fn> lists <listed>, which holds <label> at <field>, a value known only at boot. A resolve() dependency must be a deploy-time value. To compute with <field>, declare it plain, without field(), and bind it to deploy-time data.` |
| `refusePointerDependency` | either input case, with a secret pointer | the same first two sentences, then `A secret has no deploy-time value: pass <field> on into a binding, and read it in the service.` |

Changed:

| Where | Before | After |
| --- | --- | --- |
| `checkResult` | `<fn> returned a source<at> it did not receive, such as envSecret() or envParam() called inside the function. A resolve() function may return a pointer it received from a dependency, unchanged; bind any other source directly.` | `<fn> returned a source<at>, such as envSecret() or envParam() called inside the function. resolve() returns plain data; bind a source directly.` |
| `sourceMisuse`, a source known only at boot | `<label> is known only at boot: the deploy holds a pointer to it, never its value, and <what>. A resolve() function may return the pointer, or put it in its result, unchanged; to compute with the value, do it in the service that reads it.` | `<label> is known only at boot: the deploy holds a pointer to it, never its value, and <what>. A module body can only pass it on, into a provision() binding; to compute with the value, do it in the service that reads it.` |

`<at>` is `` at "<path>"`` or nothing, as today.

Not changed: `resolve()`'s own run-time messages in `value.ts`, including `resolve() dependency at index <n> is not a value — list environment.name or another resolve() result.` (§ 16, decision 6).

## 9. Documentation

All in the same pull request (`.agents/rules/user-facing-surface-changes.mdc`). Each edit replaces the quoted text exactly; line breaks are written `\n`.

### 9.1 Glossary, `docs/design/03-domain-model/glossary.md`

1. **Module**, the **Input.** bullet: `  binding or as a \`resolve()\` dependency.` becomes `  binding or, for a [plain field](#field), as a \`resolve()\` dependency.`
2. **Value**, the **Deploy-time or runtime.** bullet: `  place. A \`resolve()\` function that lists a runtime value receives the\n  pointer and may return it unchanged; \`isRuntimeValue(x)\` is true for it.` becomes `  place. A \`resolve()\` lists deploy-time values only: listing a runtime\n  value fails to compile, and Load refuses a dependency whose real value is\n  a pointer or holds one.`
3. **RuntimeValue**, the last paragraph: `code turns it into text or a number.` becomes `code turns it into text or a number. A \`resolve()\` cannot list a runtime\nvalue, so its function never receives a pointer.`

### 9.2 Decision records

Each note is a paragraph of its own, directly after the decision's last amendment note, with a blank line on each side.

- **The `resolve()` and config adapters decision**, `ADR-0062-environment-values-come-from-resolve-and-config-adapters.md`, after the seventh-slice note:

  > Amended `<date>` (module-input project, eighth slice): a `resolve()` dependency must be a deploy-time value, which reverses two statements of the third-slice note. A `resolve()` function no longer receives a pointer, and it may not return one. Listing `envSecret()`, `generatedParam()`, `serviceOrigin()`, a field wrapped with `field()` or a `secretString()` field fails to compile, with a type error that says a dependency must be a deploy-time value. The compiler cannot see a field typed `unknown`, a schema without type information or a cast, so Load also refuses a dependency whose real value is a pointer or holds one at any depth, before `fn` runs, naming the field and saying to declare it plain. Load refuses any source `fn` returns. `isRuntimeValue()` is removed, because no function receives a pointer it would need to tell apart. So every secret deploy preflight checks is one a binding names. To use a different secret in each environment, give it one name and set a different value for it on each environment.

  Its index line in `docs/design/90-decisions/README.md` gains, at its end, after a space: ``*(Amended `<date>`, eighth slice: a `resolve()` dependency must be a deploy-time value; `isRuntimeValue()` is removed.)*``
- **The secrets decision**, `ADR-0029-secrets-are-a-forwardable-slot.md`, after the fifth-slice note:

  > Amended `<date>` (module-input project, eighth slice): a `resolve()` function cannot list `envSecret()`, so two statements of the third-slice note no longer hold. A function never receives the source and cannot return it: listing it fails to compile, and Load refuses it. And deploy preflight has no secret that only a function lists, or that a function in a resource's props lists, to check: Load refuses both, so every secret preflight checks is one a binding names ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)).

  Its index line gains: ``*(Amended `<date>`, eighth slice: `resolve()` cannot list `envSecret()`.)*``
- **The module input decision**, `ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md`, after the seventh-slice note:

  > Amended `<date>` (module-input project, eighth slice): only a plain field of the input can be a `resolve()` dependency. A field wrapped with `field()` or typed `secretString()` may hold a pointer, so listing it fails to compile, and Load refuses any listed field whose real value holds a pointer, naming it and saying to declare it plain ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)).

  Its index line gains: ``*(Amended `<date>`, eighth slice: only a plain field can be a `resolve()` dependency.)*``

### 9.3 Domain docs

- **`docs/design/10-domains/config-params.md`**, § Sources are values:
  - The table row `| A \`resolve()\` dependency | its string; unset or empty fails | its pointer | its pointer | its pointer |` becomes `| A \`resolve()\` dependency | its string; unset or empty fails | refused | refused | refused |`.
  - `text or a number throws an error that names the source. A \`resolve()\` function\nmay return a pointer it received, at any depth of its result, and the target\nthen receives it as if the source had been bound directly.` becomes `text or a number throws an error that names the source. A \`resolve()\` cannot\nlist any of the three: listing one fails to compile, and Load refuses a\ndependency whose real value is a pointer or holds one.`
  - `Deploy preflight checks every \`envSecret()\` the graph names, including one that\nonly a \`resolve()\` dependency lists and one in a module's input that no service\nreceives.` becomes `Deploy preflight checks every \`envSecret()\` the graph names, including one in a\nmodule's input that no service receives.`
- **`docs/design/10-domains/core-model.md`**, the paragraph on Load's second pass: `with the thrown error as \`cause\`), or \`fn\` returned a Promise, \`undefined\`, a\nvalue, a source it did not receive, or anything else that is neither plain\ndata nor a pointer it received. A value as a \`provision()\` id or in a \`deps\`` becomes `with the thrown error as \`cause\`), \`fn\` returned a Promise, \`undefined\`, a\nvalue, a source, or anything else that is not plain data, or a dependency's\nreal value is a pointer or holds one. A value as a \`provision()\` id or in a \`deps\``.
- **`docs/design/10-domains/module-composition.md`**, § Input, the list "An input field is accepted in four places": the item `- **a \`resolve()\` dependency**: \`fn\` receives the real value. For a field\n  bound to a runtime value, that is a pointer, which the function may return\n  unchanged;` becomes `- **a \`resolve()\` dependency**, for a plain field: \`fn\` receives the real\n  value. Listing a field wrapped with \`field()\` or typed \`secretString()\`\n  fails to compile, and Load refuses a listed field whose real value holds a\n  pointer, naming it and saying to declare it plain;`

### 9.4 The guide, `docs/guides/building-an-app.md`

1. **§ A module's input**, the first bullet after the example: `  It can pass a field into a \`provision()\` binding, or list it as a\n  \`resolve()\` dependency to compute with it.` becomes `  It can pass a field into a \`provision()\` binding, or, if the field is\n  plain, list it as a \`resolve()\` dependency to compute with it.`
2. **§ Values that differ per environment**, the list of what stops a deploy: the item `- \`fn\` returns a source it did not receive, such as \`envSecret()\` called\n  inside \`fn\`. It may return a pointer it received\n  ([below](#sources-in-resolve)).` is replaced by two items:

   ```markdown
   - `fn` returns a source, such as `envSecret()` called inside `fn`.
   - `fn` lists a value known only at boot, or a field whose real value holds
     one ([below](#sources-in-resolve)).
   ```

3. **§ Sources in resolve()**: everything from the line after the heading `### Sources in resolve()` up to, but not including, the paragraph that begins ``Turning `envParam()` itself into text in a module body`` is replaced by the text below. The heading stays, so the `#sources-in-resolve` link above still works. The replacement, between the two lines of `~~~`:

   ~~~markdown

   `envParam()` is known at deploy, so `resolve()` can list it: `fn` receives
   the variable's value at deploy, read from the config pool. `envSecret()`,
   `generatedParam()` and `serviceOrigin()` are known only at boot: the deploy
   never holds a secret, and it creates a generated value or a service's origin
   after it has run `fn`. So `fn` would have nothing to compute with, and
   `resolve()` cannot list them. Nor can it list a module's input field wrapped
   with `field()` or typed `secretString()`, because its real value may be one of
   them. A dependency must be a **deploy-time value**: `environment.name`,
   another `resolve()` result, `envParam()`, or a plain field of a module's
   input. Bind the other sources directly:

   ```ts
   import { module, resolve } from '@prisma/composer';
   import { field, secretString } from '@prisma/composer/arktype';
   import { envParam, envSecret, serviceOrigin } from '@prisma/composer-prisma-cloud';
   import { type } from 'arktype';

   const billing = module(
     'billing',
     { input: type({ greeting: 'string', stripeKey: secretString(), returnUrl: field(type('string')) }) },
     ({ input, provision }) => {
       provision(billingService, {
         id: 'service',
         input: { greeting: input.greeting, stripeKey: input.stripeKey, returnUrl: input.returnUrl },
       });
     },
   );

   export default module('shop', ({ provision }) => {
     provision(billing, {
       input: {
         greeting: resolve([envParam('GREETING')], ([greeting]) => greeting.toUpperCase()),
         stripeKey: envSecret('STRIPE_KEY'),
         returnUrl: serviceOrigin('shop.web'),
       },
     });
     // … shop.web
   });
   ```

   `GREETING=hi prisma deploy --environment staging` gives `shop.billing.service`
   the input binding `{ greeting: 'HI', stripeKey: envSecret('STRIPE_KEY'),
   returnUrl: serviceOrigin('shop.web') }`.

   Listing a value known only at boot, such as
   `resolve([envSecret('STRIPE_KEY')], ([key]) => …)`, fails to compile, with a
   type error that says a dependency must be a deploy-time value:

   ```text
   error TS2322: Type 'SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>' is not assignable to type '"a resolve() dependency must be a deploy-time value, never a value known only at boot or a field wrapped with field(); to compute with an input field, declare it plain"'.
   ```

   A second error can follow where the result is used, because TypeScript types
   the result of a call that fails as `Value<unknown>`. The compiler cannot see
   every case: a field typed `unknown`, a schema without type information and a
   cast all compile. So the deploy also refuses a dependency whose real value is
   a value known only at boot, or holds one at any depth, before anything
   reaches the platform. The message names the field and says to declare it
   plain:

   ```text
   The resolve() function for input key "url" of service "shop.email.service" lists input.from of module "shop.email", whose real value is serviceOrigin('shop.web'), a value known only at boot. A resolve() dependency must be a deploy-time value. To compute with input.from, declare it plain, without field(), and bind it to deploy-time data.
   ```

   To use a different secret in each environment, give the secret one name and
   set a different value for it on each environment, instead of choosing between
   two names in `resolve()`.

   ~~~

   The replacement starts with a blank line after the heading and ends with a blank line before ``Turning `envParam()` itself``, as the section does today.

### 9.5 The agent skill, `skills/prisma-composer-core-concepts/SKILL.md`

Written to `skills/README.md`. All in § Values that differ per environment:

1. In the first bullet, `and the body receives each field as a value it can pass into a binding or list in \`resolve()\`.` becomes `and the body receives each field as a value it can pass into a binding or, for a plain field, list in \`resolve()\`.`
2. In the `fn` is pure bullet, `(no \`undefined\`, Promise or value, and no source it did not receive);` becomes `(no \`undefined\`, Promise, value or source);`.
3. The bullet that begins `- Sources are values.` becomes exactly:

   ```markdown
   - Sources are values. `resolve([envParam('X')], ([x]) => …)` receives the string, and an unset `X` fails the deploy. A dependency must be a deploy-time value: `envSecret()`, `generatedParam()`, `serviceOrigin()`, a field wrapped with `field()` and a `secretString()` field cannot be listed (a compile error saying so; for a field typed `unknown` or a cast, the deploy fails naming the field). Bind those directly; to compute with a field, declare it plain. For a different secret per environment, use one name with a different value on each environment.
   ```

No other document mentions `isRuntimeValue()`, or a `resolve()` that receives or returns a pointer: a search of `docs/`, `skills/`, `website/`, `examples/`, the package READMEs and the root markdown files finds only the places above. The website has none.

## 10. The release note

The repo has no changesets; GitHub Release notes are generated from pull request titles (S5 spec § 7). So the pull request carries the release note:

- **Title**: `feat(core)!: resolve() takes deploy-time values only, and isRuntimeValue() is removed`.
- **Description**, a section `## Breaking change` holding, in this order:

  1. The before and after:

     ```ts
     // before: fn received each secret's pointer and returned one
     const stripeKey = resolve(
       [envSecret('STRIPE_LIVE_KEY'), envSecret('STRIPE_TEST_KEY'), environment.name],
       ([live, test, name]) => (name === 'production' ? live : test),
     );
     provision(billing, { input: { stripeKey } });

     // after: one variable name, with a different value on each environment
     provision(billing, { input: { stripeKey: envSecret('STRIPE_KEY') } });
     ```

     and the sentence: `A resolve() dependency must be a deploy-time value: environment.name, another resolve() result, envParam(), or a plain field of a module's input. Listing envSecret(), generatedParam(), serviceOrigin(), a field wrapped with field() or a secretString() field now fails to compile, with a type error that says "a resolve() dependency must be a deploy-time value". Where the compiler cannot see it, such as a field typed unknown or a cast, the deploy fails before anything is created, naming the field and saying to declare it plain.`
  2. `isRuntimeValue() is removed from @prisma/composer. A resolve() function never receives a pointer, so nothing needs it. To recognise a pointer elsewhere, use isPlainPointer() or isSecretPointer() from @prisma/composer: one of them is true exactly where isRuntimeValue() was.`
  3. `A resolve() function that returns a source now always fails the deploy. Before, it could return a pointer it had received.`

## 11. Tests

Runtime tests use `bun test`; type tests use vitest `expectTypeOf` and `@ts-expect-error`. Test files are exempt from the no-bare-casts instruction. A runtime test that lists a wrapped or secret field casts it with `as Value<unknown>`: that is the cast the design says gets past the compiler, and Load must still refuse it.

### 11.1 Existing tests this slice changes

Each change is the whole change to that test; its title is kept unless a new one is given.

**Core** (`packages/0-framework/1-core/core/src/__tests__/`)

- `source-load.test.ts`, all in commit 1:
  - In describe `real values`, four tests are removed: `resolve() over a secret source receives the source and may return it`, `resolve() may return a pointer inside its result`, `resolve() may choose between two pointers it received`, and `a pointer turned into text inside resolve() fails naming the binding and the pointer`. Tests 1 and 2 cover listing a source; a pointer is never inside `fn` to be turned into text.
  - `a resolve() function that returns a source it did not receive fails` is retitled `a resolve() function that returns a source fails`, and its expected message becomes `'The resolve() function for input key "key" of service "shop.echo" returned a source at ' + '"a", such as envSecret() or envParam() called inside the function. resolve() returns ' + 'plain data; bind a source directly.'`.
  - `a secret source a resolve() in a resource's props lists is listed under the resource` becomes:

    ```ts
    test("a secret source a resolve() in a resource's props lists fails at Load", () => {
      const url = resolve([pointer('K')], () => 'https://shop.example');

      expect(loadError(() => Load(site({ url }))).message).toBe(
        `The resolve() function for prop "url" of resource "shop.site" lists envSecret('K'), ` +
          'which is known only at boot. A resolve() dependency must be a deploy-time value. Bind ' +
          "envSecret('K') directly into the input of the service that reads it.",
      );
    });
    ```

  - `graph.secretSources lists every secret source a binding or a resolve() dependency names` is retitled `graph.secretSources lists every secret source a binding names`; the six lines from `const root = module('shop', ({ environment, provision }) => {` to `const graph = Load(root, staging);` become `const graph = Load(echoWith({ live, test }));`. Its three assertions do not change.
  - The file's `pointer('K')` is `secretSource({ name }, { label })` with no type argument, so it is `Value<unknown>` and needs no cast. No import changes.
- `module-input.test.ts`, commit 1: the import `import { isValue, resolve } from '../value.ts';` becomes `import { isValue, resolve, type Value } from '../value.ts';`, and `resolve() over a secret field receives the secret source` becomes:

  ```ts
  test('resolve() over a secret field fails at Load, saying a secret has no deploy-time value', () => {
    const ran: boolean[] = [];
    const email = module(
      'email',
      { input: type({ key: secretString() }) },
      ({ input, provision }) => {
        const marker = resolve([input.key as Value<unknown>], () => {
          ran.push(true);
          return 'x';
        });
        provision(echoService(), { input: { marker } });
      },
    );
    const key = secretSource({ name: 'EMAIL_KEY' }, { label: "envSecret('EMAIL_KEY')" });

    expect(loadError(() => Load(shopWith(email, { key }))).message).toBe(
      'The resolve() function for input key "marker" of service "shop.email.echo" lists ' +
        `input.key of module "shop.email", whose real value is envSecret('EMAIL_KEY'), a value ` +
        'known only at boot. A resolve() dependency must be a deploy-time value. A secret has ' +
        'no deploy-time value: pass input.key on into a binding, and read it in the service.',
    );
    expect(ran).toEqual([]);
  });
  ```

- `resolve-values.test.ts`, commit 1: in `fn returning a secret source, a function, or a class instance fails naming the binding`, the first expected message becomes `'The resolve() function for input key "greeting" of service "shop.echo" returned a source, ' + 'such as envSecret() or envParam() called inside the function. resolve() returns plain ' + 'data; bind a source directly.'`.
- `source-value.test.ts`:
  - Commit 1: in `turning a pointer into text or a number fails naming it and saying it is known only at boot`, the second line of `message` becomes `'A module body can only pass it on, into a provision() binding; to compute with the value, do it in the service that reads it.';`.
  - Commit 3: `isRuntimeValue() is true for a secret source and a param source without a pool key, and false otherwise` is removed; `isRuntimeValue,` is removed from the `../node.ts` import; and `import { environmentFacts, isValue, resolve } from '../value.ts';` becomes `import { isValue } from '../value.ts';`.
- `source-value.test-d.ts`, commit 3: `import { isRuntimeValue, paramSource, resolve, secretSource } from '../exports/index.ts';` becomes `import { paramSource, secretSource } from '../exports/index.ts';`; `a secret source is a SecretSource and a Value of its type, and resolve() receives that type` is retitled `a secret source is a SecretSource and a Value of its type` and loses its `resolve([secretValue], …)` statement (four lines); `isRuntimeValue() narrows to a source` is removed.

**Prisma Cloud target** (`packages/1-prisma-cloud/1-extensions/target/src/__tests__/`), all in commit 1

- `preflight.test.ts`: `a secret only a resolve() dependency lists is checked, and fails when missing` and `a secret a resolve() in a resource's props lists is named as used by the resource` are removed, and `import { Load, module, resolve, resource } from '@internal/core';` becomes `import { Load, module } from '@internal/core';`. Load now refuses both graphs; core tests 1 and the props test above cover that.
- `local-target-preflight.test.ts`: `prisma dev does not require a secret only a resolve() dependency lists` is removed. Its imports do not change: `resolve` is still used further down.
- `secret.test.ts`: in `envSecret() turned into text fails naming it and saying it is known only at boot`, the expected message's last three lines become `'its value, and it was turned into text (a template literal or String()). A module body ' + 'can only pass it on, into a provision() binding; to compute with the value, do it in ' + 'the service that reads it.',`.

No other existing test relies on `resolve()` receiving or returning a pointer. Checked: every `resolve(` in `packages/`, `examples/` and `test/`; the CLI fixtures and `operations.test.ts` list only `environment.name`; `pointer.test.ts`'s `environment.name, a resolve() result and plain data are no pointer` lists only `environment.name`; `root-input.test.ts`'s `resolve([input], …)` is the whole root input, which Load refuses before this check, unchanged.

### 11.2 New core runtime tests, a new `describe('resolve() takes deploy-time values only', …)` at the end of `pointer.test.ts` (commit 1)

The `../value.ts` import becomes `import { environmentFacts, isValue, resolve, type Value } from '../value.ts';`. One fixture inside the describe:

```ts
  /** A root `shop` that lists `dependency` in a resolve() bound to echo's `url`, recording each run of the function. */
  const listing = (dependency: Value<unknown>, ran: boolean[]): ModuleNode =>
    module('shop', ({ provision }) => {
      const url = resolve([dependency], () => {
        ran.push(true);
        return 'x';
      });
      provision(echoService(), { input: { url } });
    });
```

The file's existing `pointer`, `origin`, `shopWith`, `bindingOf`, `loadError` and `echoService` are used. Each module below is `module('email', { input: <schema> }, ({ input, provision }) => { const url = resolve([<dependency>], <fn>); provision(echoService(), { input: { url } }); })`.

1. `a secret source listed in resolve() fails at Load, naming it, and the function never runs` — `Load(listing(pointer('K'), ran))` fails with exactly `The resolve() function for input key "url" of service "shop.echo" lists envSecret('K'), which is known only at boot. A resolve() dependency must be a deploy-time value. Bind envSecret('K') directly into the input of the service that reads it.`, and `ran` equals `[]`.
2. `a plain runtime source listed in resolve() fails at Load the same way` — `Load(listing(origin(), []))` fails with exactly `The resolve() function for input key "url" of service "shop.echo" lists serviceOrigin('shop.web'), which is known only at boot. A resolve() dependency must be a deploy-time value. Bind serviceOrigin('shop.web') directly into the input of the service that reads it.`
3. `a wrapped field bound to a runtime value fails at Load, saying to declare it plain` — schema `type({ from: field(type('string')) })`, dependency `input.from as Value<unknown>`, fn `() => 'x'`; `Load(shopWith(email, { from: origin() }))` fails with exactly `The resolve() function for input key "url" of service "shop.email.echo" lists input.from of module "shop.email", whose real value is serviceOrigin('shop.web'), a value known only at boot. A resolve() dependency must be a deploy-time value. To compute with input.from, declare it plain, without field(), and bind it to deploy-time data.`
4. `an object field that holds a pointer fails at Load, naming the field that holds it` — schema `type({ smtp: { user: field(type('string')), host: 'string' } })`, dependency `input.smtp as Value<unknown>`; bound `{ smtp: { user: origin(), host: 'h' } }`, fails with exactly `The resolve() function for input key "url" of service "shop.email.echo" lists input.smtp of module "shop.email", which holds serviceOrigin('shop.web') at input.smtp.user, a value known only at boot. A resolve() dependency must be a deploy-time value. To compute with input.smtp.user, declare it plain, without field(), and bind it to deploy-time data.`
5. `a pointer in an array field is named by its index` — schema `type({ tags: field(type('string')).array() })`, dependency `input.tags as Value<unknown>`; bound `{ tags: ['a', origin()] }`, the message contains `lists input.tags of module "shop.email", which holds serviceOrigin('shop.web') at input.tags.1,`.
6. `a field typed unknown compiles in resolve(), and Load refuses it when it holds a pointer` — schema:

   ```ts
       const untyped: StandardSchemaV1<{ from: unknown }, { from: unknown }> = {
         '~standard': {
           version: 1,
           vendor: 'test',
           validate: (value) => ({ value: value as { from: unknown } }),
         },
       };
   ```

   dependency `input.from` with no cast; bound `{ from: origin() }`, the message contains `lists input.from of module "shop.email", whose real value is serviceOrigin('shop.web'),`. That the file type-checks is half the test: `pnpm typecheck` runs `tsc` over test files.
7. `a wrapped field bound to deploy-time data passes Load when a cast gets it past the compiler` — schema `type({ from: field(type('string')) })`, dependency `input.from as Value<unknown>`, fn `` ([from]) => `${String(from)}!` ``; `Load(shopWith(email, { from: 'shop@example.com' }))`, and `bindingOf(graph)['url']` is `'shop@example.com!'`.

### 11.3 New core type tests, appended to `field.test-d.ts` (commit 2)

The `../exports/index.ts` value import becomes `import { isPlainPointer, isSecretPointer, module, resolve, service } from '../exports/index.ts';`. After the last test, a constant and a type:

```ts
const NOT_DEPLOY_TIME =
  'a resolve() dependency must be a deploy-time value, never a value known only at boot or a field wrapped with field(); to compute with an input field, declare it plain' as const;

/** The type `resolve()` requires of the dependency tuple `D`. */
type Dependencies<D extends readonly Value<unknown>[]> = Parameters<typeof resolve<D, string>>[0];
```

8. `resolve() lists deploy-time values: a plain field, a computed value, and a field typed unknown or any` — in `module('m', { input: arkSchema }, ({ input, environment }) => …)`, `resolve([input.host, environment.name, text], (values) => …)` compiles, `values` is exactly `readonly [string, string, string]`, and the function returns `values[0]`. With `const untyped = z.object({ meta: z.unknown(), loose: z.any() })`, in `module('m', { input: untyped }, ({ input }) => …)`, `resolve([input.meta, input.loose], ([meta, loose]) => …)` compiles, `meta` is exactly `unknown`, `loose` passes `toBeAny()`, and the function returns `'x'`.
9. `listing a runtime value or a wrapped field in resolve() fails to compile` — each of these, with fn `() => 'x'`, under its own `@ts-expect-error` line with the reason as a trailing comment:
   - `resolve([plainRuntime], …)` — `a plain runtime value is not a deploy-time value`;
   - `resolve([secretRuntime], …)` — `a secret runtime value is not a deploy-time value`;
   - in a body over `arkSchema`: `[input.from]` — `a wrapped field may hold a pointer`; `[input.port]` — `a wrapped transforming field may hold a pointer`; `[input.key]` — `a secretString() field may hold a secret pointer`;
   - in a body over `zodSchema`: `[input.from]` — `a wrapped field may hold a pointer`; `[input.key]` — `a secretString() field may hold a secret pointer`;
   - in a body over `arkNested`: `[input.smtp]` — `an object field whose leaves are wrapped may hold a pointer`; `[input.tags]` — `an array of wrapped fields may hold a pointer`.
10. `the type error says a dependency must be a deploy-time value` — `Dependencies<readonly [Value<string>, RuntimeValue<string>]>` is exactly `readonly [Value<string>, typeof NOT_DEPLOY_TIME]`, and `Dependencies<readonly [Value<{ smtp: { user: string | Pointer<string> } }>]>` is exactly `readonly [typeof NOT_DEPLOY_TIME]`. This pins the message: a change to its text fails the type test.

### 11.4 New target type test, appended to `sources.test-d.ts` (commit 2)

The `@internal/core` import gains `resolve,` after `type RuntimeValue,` (Biome's order).

11. `resolve() lists envParam(), and refuses envSecret(), generatedParam() and serviceOrigin()` — `resolve([envParam('GREETING')], ([greeting]) => greeting.toUpperCase());` compiles; then each of these, with fn `() => 'x'`, under its own `@ts-expect-error` line: `[envSecret('KEY')]` — `envSecret() is known only at boot; a resolve() dependency must be a deploy-time value`; `[generatedParam()]` — `generatedParam() is known only at boot; a resolve() dependency must be a deploy-time value`; `[generatedParam({ redacted: false })]` — `a plain generatedParam() is known only at boot; a resolve() dependency must be a deploy-time value`; `[serviceOrigin('shop.web')]` — `serviceOrigin() is known only at boot; a resolve() dependency must be a deploy-time value`.

The target's type tests read `@internal/core` from its built `dist`, so `pnpm build` (or `pnpm turbo run build --filter @internal/core`) must run before them, as the turbo pipeline does.

## 12. Scope

In: `packages/0-framework/1-core/core` (§ 3, § 4, § 5, tests); `packages/1-prisma-cloud/1-extensions/target` (§ 6, tests); `docs/`; `skills/`.

Out, as the plan assigns: the brand on `input` and refusing the whole `input` (S9), including the "to narrow, forward the whole `input` or narrow inside a `resolve()`" sentences in the guide, `module-composition.md` and the module input decision; typing a service's binding from its schema (S10); `dotenv-flow` (S11); the configuration file and the "pool" names (S12); redaction (S13); `secret(schema)` (S17). Also out: the misuse error of an input field in the body, which still says `To compute with it, list it: resolve([…])` (§ 17, conflict 1).

## 13. Commits, in order

Each commit is made with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"` and has no `Co-Authored-By` line. Before each commit, run `pnpm lint:fix` and keep the formatting it writes. Each commit leaves `pnpm build`, `pnpm turbo run typecheck`, `pnpm turbo run test:types`, `pnpm lint`, `pnpm lint:casts` (`delta=0`) and the bun tests of § 14 green. If a commit cannot be made green as pinned, stop and report.

1. `feat(core)!: Load refuses a resolve() dependency that is or holds a pointer` — § 4; § 5.1's `sourceMisuse` change; § 5.3; § 6; the commit-1 changes of § 11.1; tests 1 to 7.
2. `feat(core)!: listing a runtime value or a wrapped field in resolve() fails to compile` — § 3; tests 8 to 11.
3. `feat(core)!: remove isRuntimeValue()` — § 5.1's removal; § 5.2; the commit-3 changes of § 11.1.
4. `docs(design): resolve() takes deploy-time values only` — § 9.1, § 9.2, § 9.3.
5. `docs: resolve() takes deploy-time values only, in the guide and the agent skill` — § 9.4, § 9.5.
6. `docs(drive): module-input S8 manual QA` — `qa.md` in this slice's folder (§ 14).

## 14. Done when

- Tests 1 to 11 pass, and every test changed in § 11.1 passes. At the root: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm lint:deps`, `pnpm test`, `pnpm turbo run test:types`, `pnpm check:floor-imports`, `pnpm check:publish-deps` and `pnpm check:skill-packaging` are green. `pnpm lint:casts` reports `delta=0`: this slice adds no cast to production code. `pnpm lint` reports 40 warnings and 20 infos, as the unchanged S7 branch does.
- Run `pnpm test` from this worktree, not from a scratch copy. Some target and local-target tests start emulator daemons, and S7's manual QA found a machine-wide postgres emulator left running from a deleted scratch copy. Stop no emulator you did not start. If tests fail because of an emulator this run did not start, record it and report; do not stop it.
- The four tests under `a hostname public URL under the Alchemy apply engine` in the Prisma Cloud target fail when `bun test` runs alone in that package, on the unchanged branch too (S7 spec § 16), and pass under `pnpm test`. If any other test fails, stop and report.
- Every document in § 9 is updated.
- **Manual QA**, recorded in `qa.md` in this slice's folder, after `pnpm build`. No Prisma Cloud deploy: deploy output does not change (§ 2), and nothing here reaches the platform.
  1. **The compile error an author sees.** In `examples/env-param/module.ts`, change the import to `import { envParam, envSecret, publicUrl } from '@prisma/composer-prisma-cloud';` and the `resolve` line to ``const label = resolve([environment.name, envSecret('GREETING_KEY')], ([name]) => `deployed to ${name}`);``. Run `pnpm --filter @prisma/example-env-param typecheck`. Record its output. It holds the line `module.ts(17,44): error TS2322: Type 'SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>' is not assignable to type '"a resolve() dependency must be a deploy-time value, never a value known only at boot or a field wrapped with field(); to compute with an input field, declare it plain"'.`, followed by the second errors § 3.2 describes. Then `git checkout -- examples/env-param/module.ts`.
  2. **The Load error an author sees.** Write `examples/env-param/s8-qa.ts` with exactly:

     ```ts
     import { Load, module, resolve, type Value } from '@prisma/composer';
     import { envSecret } from '@prisma/composer-prisma-cloud';
     import echoService from './src/service.ts';

     const root = module('env-param-example', ({ environment, provision }) => {
       const label = resolve(
         [environment.name, envSecret('GREETING_KEY') as Value<unknown>],
         ([name]) => `deployed to ${String(name)}`,
       );
       provision(echoService, { input: { greeting: 'hi', environment: label } });
     });

     try {
       Load(root, { environment: { name: 'production' } });
       console.log('loaded');
     } catch (error) {
       console.log(error instanceof Error ? error.message : error);
     }
     ```

     Run `bun s8-qa.ts` in `examples/env-param`. It prints exactly `The resolve() function for input key "environment" of service "env-param-example.echo" lists envSecret('GREETING_KEY'), which is known only at boot. A resolve() dependency must be a deploy-time value. Bind envSecret('GREETING_KEY') directly into the input of the service that reads it.` Record it, then delete `s8-qa.ts`.
  3. **The example still type-checks and loads.** `pnpm --filter @prisma/example-env-param typecheck` exits 0. `git status` shows only this slice's changes.

## 15. Checks the spec author ran

One scratch worktree of this branch, detached, under its git-ignored `wip/`, removed afterwards; no process was left running from it. The whole change, as one patch against this branch, is kept at `wip/s8-spec-probe/final.patch` (git-ignored) for the review to compare with; the spec, not the patch, is what the implementer follows.

- **The commit order.** Commits 1 to 5 of § 13 applied one at a time, each after `pnpm lint:fix`, each followed by `pnpm build`; `pnpm turbo run typecheck --continue`, 80 of 80 tasks green; `pnpm turbo run test:types --continue`, 43 of 43 green; `pnpm lint`, 40 warnings and 20 infos; `pnpm lint:casts`, `current=18 merge-base=18 delta=0`; and `bun test` in core (406 pass after commit 1 and 2, 405 after commit 3), foundation (93), auth (132), email (99), and the target's `preflight.test.ts`, `local-target-preflight.test.ts`, `secret.test.ts`, `input-serializer.test.ts` and `control-lowering.test.ts` (228). Core's type tests: 78 in 12 files; the target's: 18 in 5 files. After commit 5 the tree was byte for byte the whole change. Then `pnpm lint:deps`, `pnpm check:floor-imports`, `pnpm check:publish-deps`, `pnpm check:skill-packaging` and `pnpm typecheck:scripts` were green.
- **Not run:** `pnpm test` at the root and the target's whole `bun test`. Both start emulator daemons (`local-target-attach`, `local-target-current` and `local-target-serve` call `ensureDaemon`; the local-target package's app-data tests start postgres), and this spec's brief forbade starting any. The target tests that start daemons read nothing this slice changes.
- **The compile error.** Four signatures for `resolve()` were compared with `tsc`: the mapped parameter of § 3.2; `D & DeployTimeDependencies<D>`; the same with `NoInfer`; and `D` with a rest parameter that demands a third argument when the check fails. The mapped parameter is the only one whose error names the message and nothing else. The intersection forms print `Type 'RuntimeValue<string>' is not assignable to type 'RuntimeValue<string> & "…"' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' …`, which misleads, and the rest form prints `Expected 3 arguments, but got 2.`. Every form types a failed call's result `Value<unknown>`.
- **Manual QA steps 1 and 2** were run as written; their output is quoted in § 14.

## 16. Decisions this spec records, for the review

1. **The compile error is a string literal type in a mapped parameter** (§ 3). TypeScript cannot print a custom message, but it prints the target type of a failed assignment, so a string literal type is the message. § 15 compares the alternatives. The text names both refused kinds and says what to do, as design section 6 asks: "a dependency must be a deploy-time value. To compute with a field, declare it plain."
2. **The type check is deep, through arrays and plain object types** (§ 3.1). Design section 6 makes Load's check deep because an object field with wrapped leaves holds pointers; the same field's type holds `Pointer`, so the compiler refuses it too (test 9). It stops at interfaces and classes, as S7's `WithoutPointers` does after its code review.
3. **`any` and `unknown` compile** (§ 3.1). The design names "a field typed `unknown`" as a case the compiler cannot see. `any` is the same: `z.any()` must not be refused for holding a pointer it may not hold.
4. **`Value<SecretString>` with no pointer in its type compiles** (§ 3.1). The refusal follows the design's wording, a value that holds a pointer. Every `secretString()` field and every secret constructor is typed with `Pointer<SecretString>`, so all of them are refused. Only a hand-typed schema gives a bare `SecretString`, and Load refuses its pointer at run time.
5. **Load's advice differs for a secret pointer** (§ 4.3). Design section 6 says the error says to declare the field plain. For a `secretString()` field that is wrong: a secret has no deploy-time value (design section 4), and a plain field refuses a secret. So for a secret pointer the error says to pass the field on and read it in the service. For a source listed directly, no field exists, so it says to bind the source where the service reads it.
6. **`resolve()`'s run-time messages in `value.ts` do not change** (§ 8.2). `list environment.name or another resolve() result` is still right advice for a dependency that is not a value at all.
7. **`SecretSourceUse.nodeKind` keeps `'resource'`** (§ 5.3). No graph Load returns can now hold it: a secret in props is refused directly and through a `resolve()`. But `nodeKindOf` still maps a props site, which `recordSecret` sees just before the refusal, and the type is public. Removing it is a type change outside the plan for no behaviour; only the doc comments change.
8. **Tests that relied on a resolve-only secret are removed, not rewritten** (§ 11.1). What they tested, that preflight checks a secret only a function lists, cannot happen now. The refusal is tested once, in core, where it lives (tests 1, 2 and the props test).
9. **The new runtime tests sit in `pointer.test.ts`** (§ 11.2), which holds the pointer fixtures (`pointer`, `origin`, `field`) and S7's tests of pointers at Load.
10. **A wrapped field bound to deploy-time data passes Load** (test 7). The design refuses at Load only a real value that holds a pointer. Load cannot see from data that a field was wrapped, and refusing by type is the compiler's job.
11. **Three decision records are amended** (§ 9.2). Design section 12 names the `resolve()` decision's reversal. The secrets decision's third-slice note says a function receives and may return the source, and that preflight checks one a function lists, both now false. The module input decision says a body's field may be listed in `resolve()`, which now holds for plain fields only.
12. **The guide's per-environment secret example is replaced by one name per environment** (§ 9.4, § 10). The old guide already said one name is simpler; it is now the only way, and the release note shows it.
13. **Manual QA runs no deploy** (§ 14). Deploy output does not change, and `prisma deploy` reaches the platform. The two errors an author can see are reproduced through `tsc` on an example and through `Load`, which is what `prisma deploy` runs first.
14. **No `.drive/deferred.md` entry.** Nothing is deferred beyond what § 17 reports.

## 17. Conflicts

1. **The misuse error of an input field still says to list it in `resolve()`.** Design section 3, "What the body cannot do", says the error "names the field and says to declare it plain and list it in `resolve()`". Today's text (`module-input.ts`, `misuse`) ends `To compute with it, list it: resolve([input.from], ([v]) => …).`, and `readPath`'s non-object error ends the same way. For a wrapped field that advice now leads to a compile error. No slice of the plan names this change, and the brief limits S8 to the plan's paragraph, so this spec leaves it. Suggested text, for S8 or a later slice: `To compute with it, declare it plain and list it: resolve([input.from], ([v]) => …).` For the orchestrator.
2. **A failed `resolve()` call types its result `Value<unknown>`, so a second compile error can follow** (§ 3.2, § 15). TypeScript does this for every signature tried. The first error is the message, at the dependency; the guide says a second can follow. The plan's "fails to compile, with a type error that says a dependency must be a deploy-time value" holds, but not "only that error".
3. **The design's wording "naming the field and saying to declare it plain" does not fit a secret field or a source listed directly** (§ 16, decision 5). The spec follows the wording for a plain pointer in a field, and gives the other two cases their own advice.
4. **The S7 manual QA's `prisma dev` step is still open** (S7 `qa.md` step 4, blocked by a stale machine-wide postgres emulator). This slice does not need `prisma dev`, so its QA does not rerun it. A postgres emulator started from `wip/s7` was running while this spec was written; it was not touched.

## Settled by the orchestrator

1. **Conflict 1 is in scope.** The body's misuse error changes its last sentence from `To compute with it, list it: resolve([…], ([v]) => …).` to `To compute with it, it must be a plain field, not a wrapped or secret one; list it: resolve([…], ([v]) => …).` everywhere it is built, in its own commit placed before the docs commit. Every test that asserts the old text changes to the new one, and the guide and the agent skill quote the new text wherever they quote the old. (Changed after review: the first settled text, `declare it plain and list it`, was wrong for a `secretString()` field, which cannot be declared plain.)
2. Conflicts 2 and 3 are settled as the spec writes them.
