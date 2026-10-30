# S8 code review — `resolve()` takes deploy-time values only

Range: `claude/module-input-s7...claude/module-input-s8`. Spec: [`../spec.md`](../spec.md), including "Settled by the orchestrator". Design: [`../../../design.md`](../../../design.md).

## Summary

The implementation matches the spec line for line: compared with the spec author's probe patch (`wip/s8-spec-probe/final.patch`), the only differences are the orchestrator's settled change to the body's misuse error and the filled-in dates. One real defect: the new compile-time check makes TypeScript fail with "excessively deep" on any dependency whose type is recursive, such as a JSON field. The `resolve()` decision record's new note also miscounts the statements it reverses and misses one.

Checked here: core `bun test` 405 pass, 0 fail; core `pnpm test:types` 78 pass, no type errors.

## What looks solid

- The Load check runs once per dependency, after its real value is known and before `fn` runs, so `fn` cannot observe a pointer, and the first test asserts that `fn` never ran.
- `firstPointer` recognises a pointer by brand before the plain-object test, so a copy an ArkType schema made is still caught. Its `WeakSet` guards against cycles.
- `checkResult` lost its `received` set, which removes a special case.
- `resolve()` narrows each dependency with `isValue()` in a `map`, so the new mapped parameter type adds no cast. `pnpm lint:casts` stays at `delta=0`, per the spec's record.
- The secret-field advice ("a secret has no deploy-time value: pass it on") is right where design section 6's literal wording would have been wrong.
- The type test that pins `NotDeployTime` through `Parameters<typeof resolve<…>>` means a change to the message text fails a test.

## Findings

### F01 — Listing a dependency with a recursive type fails to compile with "excessively deep"

- **Location:** `packages/0-framework/1-core/core/src/value.ts`, lines 75–99 (`HoldsPointer`, `IsDeployTime`, `DeployTimeDependencies`).
- **Issue:** `HoldsPointer<T>` recurses through arrays and object types with no depth limit. For a recursive type it never terminates, and TypeScript reports TS2589, "Type instantiation is excessively deep and possibly infinite", at the `resolve()` call. Reproduced with `tsc` against this branch, in a scratch file outside the worktree:

  ```ts
  declare const p: Value<PlainData>;
  resolve([p], ([a]) => a); // error TS2589

  module('m', { input: z.object({ meta: z.json() }) }, ({ input }) => {
    resolve([input.meta], () => 'x'); // error TS2589
  });
  ```

  On S7 both compile. So a module with a JSON-typed plain field, which is deploy-time data the author is entitled to compute with, can no longer list it, and the error says nothing about why. `PlainData` is Composer's own type, so any value typed with it hits this too. The spec's decision 2 (the check is deep) did not consider recursive types, and no test lists one.
- **Suggestion:** Bound the recursion. A depth counter is the smallest change; past the limit, treat the type as holding no pointer, and Load's run-time check still covers it, as it does for `unknown`. Add both cases above to `field.test-d.ts`, as compiling.

  ```ts
  type HoldsPointer<T, Depth extends readonly unknown[] = []> =
    Depth['length'] extends 8
      ? false
      : T extends Pointer<unknown>
        ? true
        : T extends readonly (infer E)[]
          ? HoldsPointer<E, [...Depth, unknown]>
          : T extends Record<PropertyKey, unknown>
            ? HoldsPointer<T[keyof T], [...Depth, unknown]>
            : false;
  ```

  In a scratch copy of these types, this version compiles `Value<PlainData>` and still refuses the nested and array cases. Run the existing type tests to confirm, including the pinned-message test.

### F02 — The new decision record notes write the date in backticks

- **Location:** `docs/design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md` line 11; `ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md` line 13; `ADR-0062-environment-values-come-from-resolve-and-config-adapters.md` line 13; `docs/design/90-decisions/README.md` lines 53, 85, 86.
- **Issue:** Each reads ``Amended `2026-10-30` ``. Every other note and index line writes ``Amended 2026-10-30`` as plain text. The spec's `<date>` placeholder sat inside backticks, and the implementer filled it in place. The date value itself is correct.
- **Suggestion:** Remove the backticks in all six places.

### F03 — The `resolve()` decision's eighth-slice note miscounts what it reverses and misses a seventh-slice statement

- **Location:** `docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md`, line 13.
- **Issue:** Decision records here are append-only, so leaving the older notes unchanged is right, but then the new note must say which statements it reverses, as design section 12 asks. It says it "reverses two statements of the third-slice note". The third-slice note holds three statements that are now false:
  1. "A `resolve()` function receives a secret input as that pointer … and `isRuntimeValue(x)` is true for one."
  2. "`fn` returns plain data or a pointer it received …"
  3. "Deploy preflight checks every `envSecret()` the graph names, including one a function lists but does not return."

  The seventh-slice note's "So a `resolve()` function that lists one receives a value typed `Pointer<SecretString>` or `Pointer<string>`" is also now false, and the eighth note does not mention it. So a reader going through the notes in order finds the seventh and eighth contradicting each other with nothing saying which wins. The record reads as current only to someone who already knows the answer.
- **Suggestion:** Change the opening to say it reverses three statements of the third-slice note and the seventh-slice note's last sentence. Then say plainly that a secret input never reaches `fn`, because the Decision section still says "Secret inputs arrive as opaque `SecretString` boxes". For example: "… which reverses three statements of the third-slice note and the last sentence of the seventh-slice note. A `resolve()` function never receives a pointer, or a secret input in any form, and it may not return a source. …"

### F04 — Two decision record notes and two docs say Load's error always says "declare it plain"

- **Location:** ADR-0062 line 13 ("naming the field and saying to declare it plain"); ADR-0061 line 13 ("naming it and saying to declare it plain"); `docs/design/10-domains/module-composition.md`, the `resolve()` dependency item in § Input; `docs/guides/building-an-app.md`, § Sources in resolve() ("The message names the field and says to declare it plain").
- **Issue:** For a secret pointer, the Load error says "A secret has no deploy-time value: pass … on into a binding, and read it in the service", and for a source listed directly it says to bind the source directly. Both choices were settled by the orchestrator. These documents describe only the plain-pointer case, so they are wrong for the other two.
- **Suggestion:** Say "naming the field and saying what to do instead: declare it plain, or, for a secret, pass it on". The guide could add one sentence after its example: "For a secret field, the message says to pass the field on and read it in the service."

### F05 — The body's misuse error tells a secret field to "declare it plain"

- **Location:** `packages/0-framework/1-core/core/src/module-input.ts`, line 48.
- **Issue:** The settled text "To compute with it, declare it plain and list it: resolve([…])" is built for every input field, including a `secretString()` field. Following it fails: a plain field refuses a secret pointer, and design section 4 says a secret has no deploy-time value. This is the same problem spec conflict 3 solved for the Load error, now present in the body's misuse error. The misuse error already knows the field's origin; it does not know the schema, so it cannot tell that a field is secret.
- **Suggestion:** The orchestrator settled this wording, so it is the orchestrator's call. Either accept it for now and record it for S17 (when `secretString()` becomes `secret(schema)`), or soften the sentence for all fields: "To compute with it, declare it plain and list it: resolve([…]); a secret cannot be computed with."

### F06 — No test covers the secret advice for a secret held below a listed field

- **Location:** `packages/0-framework/1-core/core/src/__tests__/pointer.test.ts`, describe `resolve() takes deploy-time values only`.
- **Issue:** The secret-pointer branch of `refusePointerDependency` is tested only for a top-level `secretString()` field (`module-input.test.ts`). Its message uses the pointer's own path (`pass input.smtp.password on …`) when the secret sits below the listed field; nothing asserts that.
- **Suggestion:** Add a test: schema `type({ smtp: { user: 'string', password: secretString() } })`, list `input.smtp as Value<unknown>`, bind a secret source to `password`, and assert the message contains `which holds envSecret('…') at input.smtp.password` and `pass input.smtp.password on into a binding`.

### F07 — A guide bullet says "`fn` lists" where `resolve()` lists

- **Location:** `docs/guides/building-an-app.md`, § Values that differ per environment, the list of what stops a deploy: "`fn` lists a value known only at boot, or a field whose real value holds one".
- **Issue:** `fn` receives values; `resolve()` lists them. The neighbouring bullet "`fn` lists `envParam('NAME')`" already had this wording, so this repeats an existing slip.
- **Suggestion:** "`resolve()` lists a value known only at boot …", and fix the neighbouring `envParam` bullet the same way.

## Judgement on the implementer's adaptations

- **`node.ts`'s `sourceMisuse` sentence for `envParam()` left unchanged:** correct. That branch is for a source with a pool key, which is deploy-time and may be listed. There is no field to "declare plain", so "To compute with it, list it: resolve([envParam('G')], …)" is still the right advice. The settled item covered input fields, not sources.
- **Dates filled with 2026-10-30:** the value is right; the formatting is not (F02).
- **Older amendment notes that mention `isRuntimeValue()` left unchanged:** correct under the index's append-only convention. The secrets and module input records read as current. The `resolve()` record does not, because its new note does not name everything it reverses (F03).

## Deferred (out of scope)

- **`SecretSourceUse.nodeKind`'s `'resource'` variant is now never produced** (`packages/0-framework/1-core/core/src/graph-types.ts`, line 124). Removing it changes a public type, which the plan does not give this slice (spec decision 7). Belongs with S10's binding-type work or project close-out.
- **Folding the `resolve()` decision's seven amendment notes into a rewritten record.** That is a close-out decision about the decision-record convention. **Needs Will** at close-out.

## Already addressed

None; this is the first review round for S8.

## Acceptance-criteria verification

The spec has no numbered acceptance criteria. These are taken from § 2 (the model), § 7 (what breaks) and § 14 (done when).

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: listing `envSecret()`, `generatedParam()` or `serviceOrigin()` fails to compile with the deploy-time message | **PASS** | `value.ts` maps each pointer-holding dependency to `NotDeployTime`. `sources.test-d.ts` has an `@ts-expect-error` for each constructor; `field.test-d.ts` pins the message through `Dependencies<…>`. QA step 1 shows the real `tsc` output. |
| AC2: listing a wrapped, `secretString()`, nested-wrapped or array-of-wrapped field fails to compile | **PASS** | `field.test-d.ts` covers each, in ArkType and Zod. |
| AC3: plain fields, `environment.name`, `resolve()` results, `envParam()`, `unknown` and `any` compile, with `fn`'s tuple types intact | **WEAK** | The type tests assert these, including exact tuple types. But a plain field with a recursive type fails with TS2589 (F01), and no test covers one. |
| AC4: Load refuses a dependency whose real value is a pointer or holds one, before `fn` runs, naming the field | **PASS** | `refusePointerDependency` runs in the dependency map before `fn`. `pointer.test.ts` tests 1–6 assert exact messages or the naming part, for direct sources, top-level, nested and array fields and an `unknown` field; test 1 asserts `fn` never ran. |
| AC5: the advice differs for a secret pointer and for a source listed directly | **PASS** (one gap) | Asserted for a top-level secret field (`module-input.test.ts`) and for direct sources (tests 1, 2). A secret below the listed field is not tested (F06). |
| AC6: a wrapped field bound to deploy-time data passes Load through a cast | **PASS** | `pointer.test.ts` test 7 asserts the binding `'shop@example.com!'`. |
| AC7: a `resolve()` function that returns a source always fails | **PASS** | `checkResult` has no `received` exception. `source-load.test.ts` and `resolve-values.test.ts` assert the new message. |
| AC8: `isRuntimeValue()` is removed from `@internal/core` and so from `@prisma/composer` | **PASS** | Removed from `node.ts` and `exports/index.ts`; the public package re-exports with `export *`. Its tests are removed. `git grep isRuntimeValue` finds only the third-slice note and the index line, which are historical. |
| AC9: a secret in a resource's props through a `resolve()` fails at Load | **PASS** | `source-load.test.ts` asserts the exact message for a props site. |
| AC10: preflight is unchanged, and checks only secrets a binding names | **PASS** | No preflight code changed. The two preflight tests and one local-target test that relied on a secret only a `resolve()` lists are removed, because Load now refuses those graphs. |
| AC11: the body's misuse error says "declare it plain and list it" everywhere it is built (settled item 1) | **PASS** | `module-input.ts` `misuse` and `resolve-values.ts` `readPath` both changed; three assertions in `module-input.test.ts` changed with them. Nothing in the guide or skill quoted the old text. |
| AC12: deploy output does not change | **PASS** | No example or shared module lists a source or wrapped field in `resolve()`; QA step 3 type-checks the example. No deploy was run, as the spec decides. |
| AC13: every document in § 9 is updated | **PASS** (with F02–F04, F07) | Glossary, three decision records and index lines, three domain docs, the guide and the agent skill all match the spec text. |
| AC14: manual QA recorded | **PASS** | `qa.md` records all three steps, with the compile error, the Load error and a clean `git status`. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 13 | AC1, AC2, AC4–AC14 |
| FAIL | 0 | — |
| NOT VERIFIED | 0 | — |
| WEAK | 1 | AC3 |
