# S6 code review: `field()` and the two kinds of pointer

Range: `claude/module-input-s5...claude/module-input-s6`. Spec: [`../spec.md`](../spec.md). Companion: [`system-design-review.md`](system-design-review.md).

## Summary

The slice builds what the spec pins, almost line for line, and every check I could run passes. Two things need work: a Zod test that only passes when the tests before it have run, and the case of an app whose Zod or ArkType is a different copy from Composer's.

## What looks solid

- The kind is stamped in one place (`buildSource`) from one expression, so the two constructors cannot drift apart.
- `field()` for ArkType reproduces the plain field's message for every present value by delegating to `inner`, not by copying ArkType's wording. Tests 8 and 9 compare the two outputs over five inner schemas and five wrong values.
- The copy tests (51 to 53, 59 to 62) build a real ArkType copy and assert both "a different object" and "still recognised", so they would catch a regression in either direction.
- `pnpm lint:casts` reports no change in bare casts. The four new casts are `blindCast` calls with reasons.

## Checks run

On this worktree: foundation `bun test` (92 pass), core `pointer.test.ts` (11 pass), core `test:types` (69 pass, no type errors), the four target test files (109 pass), `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm lint:deps`, `pnpm check:floor-imports`, `pnpm check:publish-deps`, `pnpm check:skill-packaging`, and `pnpm install --frozen-lockfile --lockfile-only`. All green. Not rerun: `pnpm build` and the full `pnpm test`; the Postgres tests cannot start on this machine (shmget "No space left on device"), which is not a defect of this branch.

## Findings

### F01. Zod test 27 passes only when tests 23 to 25 run first

- **Location:** `packages/0-framework/0-foundation/foundation/src/zod.test.ts`, lines 24 to 29 and 95 to 101.
- **Issue:** Test 27 reads a module-level `seen` array that `compare()` fills during tests 23 to 25. Run on its own (`bun test src/zod.test.ts -t 'no message names'`) it fails, because `seen` is empty. It fails loudly rather than passing with nothing checked, which is the better of the two ways, but a test that depends on the order of other tests breaks under filtering, and under any runner that shuffles.
- **Suggestion:** Let test 27 compute its own messages: loop over the same inners and values as tests 23 to 25, collect the wrapped field's messages, and assert on those. Drop `seen` from `compare()`.

### F02. An app's Zod or ArkType that is not Composer's copy

- **Location:** `packages/9-public/composer/package.json`, line 50 (`"zod": "^4.4.3"` in `dependencies`); `packages/0-framework/0-foundation/foundation/src/zod.ts`, lines 45 to 56; `packages/0-framework/0-foundation/foundation/src/arktype.ts`, `field()`.
- **Issue:** `field(inner)` puts the author's schema object inside a union built by Composer's own copy of the library. Composer installs its own `zod` (and `arktype`). Two cases break:
  - An app on Zod 3. `z.string()` from Zod 3 is not a Zod 4 schema. `field()` should then fail to compile against Composer's `z.ZodType`, and at run time Zod 4's union cannot run a Zod 3 schema. Zod 3 is still common, and nothing in the guide, the skill or the glossary says the Zod entry needs Zod 4.
  - An app on a Zod 4 or ArkType 2 version that pnpm or npm does not deduplicate with Composer's. The run-time union may work across copies, but the types come from two copies of the library and may not match.
  I did not reproduce either case; QA step 1 installed the exact versions Composer pins, so both copies were deduplicated.
- **Suggestion:** In this slice, say "Zod 4" wherever the guide and the skill introduce `@prisma/composer/zod`, and add a QA probe that installs a different minor version of `zod` beside the packed tarball and runs `check.mjs`. Whether to make `zod` (and `arktype`) an optional peer dependency instead is a reversal of the spec's decision 10. **Needs Will.**

### F03. `kindOf()` casts where it need not

- **Location:** `packages/0-framework/0-foundation/foundation/src/pointer.ts`, lines 24 to 29.
- **Issue:** After the `typeof value !== 'object' || value === null` check, `value` is `object`, and `Reflect.get(value, POINTER)` reads the symbol with no cast. The casts instruction asks for a rewrite before a `blindCast`. The spec pinned the cast, so this is a small departure from the spec if taken.
- **Suggestion:** `return Reflect.get(value, POINTER);` and drop the `blindCast` import from `pointer.ts`.

### F04. Wrapping an object schema gives an error with no field path

- **Location:** `packages/0-framework/0-foundation/foundation/src/arktype.ts`, `innerProblem()`.
- **Issue:** `field()` is for leaves, and it has no run-time check (spec decision 12). If an author wraps an object schema anyway, the error loses the path. Probed: `type({ u: field(type({ a: 'string' })) })({ u: { a: 1 } })` prints `must be a string (was a number)`, naming neither `u` nor `a`. `innerProblem()` joins the inner errors' `problem` texts, which carry no path.
- **Suggestion:** Either use each inner error's `message` when its path is not empty, or record the case in `.drive/deferred.md` beside the missing-key entry. Both are small; the first keeps the error usable for a misuse the guide warns against.

## The implementer's adaptations

| Adaptation | Verdict |
| --- | --- |
| Import order differs from the spec (`{ type Type, type }`, `POINTER_TYPE, Pointer`) | Correct. Biome sorts imports; the spec's order would fail `pnpm lint`. |
| Imports moved to the commit that uses them (commit 3 imports only `isPlainPointer` and `isSecretPointer`; `Type`, `blindCast` and `Pointer` arrive with `field()` in commit 4; `type Pointer` arrives in core with commit 7) | Correct. Unused imports would fail lint in the earlier commit, and the spec asks every commit to stay green. |
| Bare casts in test files (`Object.values(inners) as …`, `as [() => Type<unknown>, string][]`, `copyOf`'s `as T`, `as unknown as`) | Acceptable. Test files are exempt from the no-bare-casts instruction, and `copyOf`'s cast is the spec's own. |
| Zod test 27 depends on test execution order | Not acceptable as written; see F01. |
| `copyOf` placed after the other fixtures in `pointer.test.ts`, before them in the target files | Fine. "At the top of the file" is met in spirit; it is defined before first use in each file. |
| Lockfile edited by hand rather than by `pnpm install` | Fine. The three importer entries are the only change, `zod@4.4.3` was already in the packages section, and `pnpm install --frozen-lockfile --lockfile-only` passes. |
| Amendment notes written as plain paragraphs, not block quotes | Correct. Every earlier amendment note in both decision records is a plain paragraph; the spec's `>` marked the text as verbatim. |
| Test 41 omits `id` where the other provision calls give one | Harmless. `id` is optional, and test 38 shows the same binding compiles once the tested key is valid. |

## Deferred (out of scope)

- **Typing the source constructors as `RuntimeValue`** (spec § 18, conflict 3). It belongs in S7, which wraps the fields the new types would break.
- **Copying `copyOf` into four test files.** Core and target cannot share a test helper without a new export; the spec pinned the duplication. Not worth a shared test package for one function.

## Already addressed

None. This is the first review round for S6.

## Acceptance-criteria verification

The spec's acceptance criteria are § 16 ("Done when") and the behaviour in § 2, § 11 and § 13.

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: Tests 1 to 62 pass | **PASS** | Ran each file. Read the assertions of tests 5, 8, 11, 15, 20, 25, 49, 52, 53, 56, 59 to 62; each asserts the exact message or the identity the spec names. Test 27 passes in a full run but not alone (F01). |
| AC2: A source records its kind: `secretSource()` secret; `paramSource()` none with a pool key, secret when redacted, plain otherwise | **PASS** | `node.ts` `buildSource` and its two callers; tests 46 to 48 and 57, 58 assert each case through the public checks. |
| AC3: The kind is invisible to `Object.keys` and `JSON.stringify` | **PASS** | Test 49 asserts `['payload']` and the exact JSON. |
| AC4: An ArkType copy of a source is recognised by Load, preflight and the serializer | **PASS** | Tests 51 to 53 (Load, `secretSources` dedupe by original), 59 to 61 (serializer documents), 62 (preflight names). Each builds a real copy and asserts it is a different object. |
| AC5: `secretString()` accepts a secret pointer and refuses a plain one with the § 11 message, in both libraries | **PASS** | Tests 4, 5, 18, 20 assert identity and exact text. |
| AC6: A wrapped field accepts a plain pointer, passes text through `inner` with transforms, and reports the plain field's message for a present value | **PASS** | Tests 6 to 10, 21 to 24, 26, 54, 56 compare wrapped and plain outputs, and pin exact text for the named cases. |
| AC7: Missing key: Zod gives the plain message; ArkType gives `from must be a string or an object (was missing)` and names no Composer class | **PASS** | Tests 11 and 25. The ArkType exception is recorded in `design.md` § 3 and the service-input amendment. |
| AC8: Types: `In \| Pointer<In>` in, `Out \| Pointer<In>` out; plain field, wrong-type wrapped field and secret pointer refused; `secretString()` still `SecretString`; body and binding types; forwarding into a service binding | **PASS** | `field.test-d.ts` tests 30 to 45 use `toEqualTypeOf` and `@ts-expect-error`; `test:types` reports no unused expect-error and no type error. |
| AC9: Root commands green (`install --frozen-lockfile`, `build`, `typecheck`, `lint`, `lint:casts`, `lint:deps`, `test`, `test:types`, floor imports, publish deps, skill packaging) | **NOT VERIFIED** (partly) | All green except two I did not rerun: `pnpm build`, and the full `pnpm test`, whose Postgres tests cannot start here. The frozen-lockfile check ran with `--lockfile-only`. |
| AC10: Every § 12 document updated | **PASS** | Read each change: glossary (Input, Value, RuntimeValue, `field()`, ten edits, no "Configuration" left), both decision records and their index lines, `core-model.md` (rows and fixed anchor), `module-composition.md`, the guide, the skill, `deferred.md`. |
| AC11: QA 1, the packed package outside the workspace | **PASS** | `qa.md` records `npm ls zod` and the four exact lines. |
| AC12: QA 2, sources reach a running service | **PASS** | `qa.md` records the signup id and `"from":"s6-qa-dev@example.com"`. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 11 | AC1 to AC8, AC10 to AC12 |
| FAIL | 0 | |
| NOT VERIFIED | 1 | AC9 (build and full test not rerun) |
| WEAK | 0 | |
