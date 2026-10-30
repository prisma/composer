# S7 code review — schemas see pointers at deploy

Range: `claude/module-input-s6...claude/module-input-s7`. Spec: [../spec.md](../spec.md). Architecture findings are in [system-design-review.md](system-design-review.md).

## Summary

The slice removes the deploy-time stand-ins and lets schemas check each value known only at boot as its pointer, with a second check for ArkType schemas that lose a secret by copying it. The code is exactly the spec's patch and its tests pass; one type regression in `service.input()` and one misleading error need fixing.

## What looks solid

- **Secrets stay out of the document and the logs.** The document is built from the first check's output only; the stand-in box exists only inside `refuseLostSecrets`, and test 15 asserts that `composer-stand-in-not-a-secret` is not in the row. The stand-in holds a known non-secret text, so even an issue message that printed it would leak nothing. No error message prints a pointer's payload beyond the variable name.
- **One way to recognise a pointer.** Every walk tests brands (`isSecretSource`, `isParamSource`) and kind (`isSecretPointer`), and the source test always comes before `isPlainObject` (a source is a frozen plain object). The removed identity map (`sentinels`) and path set (`secretPaths`) were the fragile part of S6.
- **The second check runs only when it can matter**: after the first check passes and only when the binding holds a secret pointer (test 14 asserts one run otherwise).
- `pnpm lint:casts` loses one `blindCast` (the sentinel tag read in `resolve-values.ts`).

## Findings

### F01 — `service.input()` breaks for any output that is a class instance, such as a `Date`

- **Location:** packages/0-framework/1-core/core/src/node.ts — `WithoutPointers`, near line 332.
- **Issue:** `WithoutPointers<T>` recurses into every `T extends object`. A `Date`, `Map`, `URL` or function is an object, so it is turned into a mapped type of its members, and each method (itself an object) loses its call signature. A schema such as `type({ when: 'string.date.parse' })` or `z.object({ when: z.coerce.date() })` now gives `service.input().when` a type on which `.getTime()` is "not callable" and which is not assignable to `Date`. Checked with `tsc` against a probe file (removed afterwards): four errors, TS2349 and TS2322. Before this slice `InputValueOf` was the schema's output type and these compiled. ADR-0042 allows transforms in a service schema, so this is a regression for existing users, and it is not in the release note.
- **Suggestion:** recurse only into arrays and plain object types; leave everything else as it is. Add a type test with a `Date` and a `Map` output in both libraries.

  ```ts
  type WithoutPointers<T> =
    T extends Pointer<unknown>
      ? never
      : T extends readonly unknown[]
        ? { [K in keyof T]: WithoutPointers<T[K]> }
        : T extends Record<PropertyKey, unknown>
          ? { [K in keyof T]: WithoutPointers<T[K]> }
          : T;
  ```

  `Date`, `Map` and `SecretString` are interfaces or classes, which TypeScript does not treat as assignable to `Record<PropertyKey, unknown>`, so they stop the recursion; object literal output types do recurse. Run tests 1 to 4 again with this form.

### F02 — A schema that mints its own secret box gets the "copied secret" error when the binding also holds a secret

- **Location:** packages/1-prisma-cloud/1-extensions/target/src/serializer.ts — `refuseLostSecrets`, near lines 613–668, and its call in `serializeInput`.
- **Issue:** `refuseLostSecrets` runs before `substitutePointers` and judges every `SecretBox` in the second output. A box the schema created itself (a default) does not hold the stand-in text, so it is reported as "validated to a copy of its secret … the schema copies its input". Reproduced with a probe test (removed afterwards): `z.object({ key: secretString(), other: secretString().default(new SecretBox('minted')) })` bound `{ key: envSecret('KEY') }` throws that message for `other`. The right message, "a schema must not mint secret boxes … bind the field with envSecret('NAME')", is only reached when the binding has no secret pointer. The deploy is still refused, so nothing leaks, but the advice ("move the transform into the service code") is wrong for this case.
- **Suggestion:** in `withStandIns`, record the paths where a stand-in was placed, and in the second walk judge only boxes at those paths; leave any other box for `substitutePointers` to refuse with its own message. Add a test for this binding.

### F03 — The release note does not tell users of other schema libraries what to do

- **Location:** spec § 12 (the pull request description, not yet written).
- **Issue:** item 1 tells ArkType and Zod users to wrap with `field()`. A service whose schema is Valibot or hand-written, with a plain string check on a field bound to `serviceOrigin()` or a plain `generatedParam()`, also starts failing at deploy, and has no `field()`. The guide covers this case in the module section only.
- **Suggestion:** add one sentence to item 1: "With another Standard Schema library, accept the pointer with `isPlainPointer()` from `@prisma/composer`, as `field()` does."

### F04 — "Wrap every leaf field" in the guide and the skill also reads as wrapping secret fields

- **Location:** docs/guides/building-an-app.md — § A module's input, the `field()` bullet; skills/prisma-composer-core-concepts/SKILL.md — the `field(inner)` bullet.
- **Issue:** both say to wrap every leaf of a reusable module's schema unless a `resolve()` lists it. A `secretString()` field is a leaf. `field(secretString())` would accept a plain pointer into a secret field at deploy, and the service would then fail at boot when the plain text reaches `secretString()`. The glossary already says a secret field "needs no `field()`"; the guide and skill do not.
- **Suggestion:** "Wrap every leaf field of a reusable module's schema other than a `secretString()` field, unless a `resolve()` lists it."

### F05 — The service-input paragraph about wrapping does not show where `field` comes from

- **Location:** docs/guides/building-an-app.md — § Binding the input at provision, the new paragraph "A field bound to `serviceOrigin()` … is wrapped."
- **Issue:** it shows `type({ returnUrl: field(type('string')) })` with no import, in a section whose earlier examples import nothing from `@prisma/composer/arktype`. A reader arriving at this section from a link has to search for it.
- **Suggestion:** name the import in the sentence: "`field()` from `@prisma/composer/arktype` (or `/zod`)".

### F06 — ADR-0032's amendment note still lists `sentinel`

- **Location:** docs/design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md — line 5.
- **Issue:** the third-slice note says "`paramSource()` takes an optional `label`, `poolKey`, `sentinel` and `redacted`." The option is gone. Spec decision 15 states no other decision mentions stand-ins, which this contradicts.
- **Suggestion:** add a seventh-slice amendment note to ADR-0032, one sentence: `paramSource()` no longer takes `sentinel`; see ADR-0061. Update its index line.

## Deferred (out of scope)

- Moving the lost-secret check into core for other targets: system-design D04. Only Prisma Cloud serializes service input today.
- A `SecretBox` that survives an ArkType copy: design section 11, already deferred.
- Typing a service's binding from its schema, so a plain field bound to `serviceOrigin()` fails to compile in a service's binding too: S10.

## Already addressed

None; this is the first review round for S7.

## Acceptance-criteria verification

The spec's § 16 "Done when" and the model in § 2 are the acceptance criteria.

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: tests 1–22 and every changed test pass | **PASS** | Ran `bun test` in foundation (93 pass), core's pointer, source-load, source-value and module-input files (81 pass), the target's input-serializer, control-lowering and local-target-preflight files (176 pass), auth (132) and email (99); `test:types` in core (75) and the target (17), no type errors. Read the assertions of tests 10–21: each asserts the exact message or the exact document. |
| AC2: the root commands are green (build, typecheck, lint, lint:casts delta 0, test, check:*) | **NOT VERIFIED** | Not re-run by this review. The spec records them green on its scratch copy, and the branch equals that patch. |
| AC3: a schema sees each runtime value as its pointer | **PASS** | `resolveInputBinding` returns each source in place; `validateModuleInput` passes `resolved` unchanged. Test 6 and test 15 assert `toBe` identity with the bound source. |
| AC4: the stand-in never reaches the input document | **PASS** | The document is built from `judged.validated`, the first check. Test 15 asserts the row lacks the stand-in text and equals the expected markers. |
| AC5: a copy of a pointer counts as the same pointer | **PASS** | Load: test 9 asserts the original sources reach the service after an ArkType copy. Serializer: test 13 asserts the `$generated` marker after a copy. |
| AC6: an ArkType copy that loses a secret is refused, for `envSecret()` and redacted `generatedParam()` | **PASS** | Tests 16, 17, 18 assert the field-naming message for `'+': 'delete'`, a wrapped transforming field, and a redacted `generatedParam()` beside `'string.trim'`. F02 is a wrong message in a different case. |
| AC7: constructors typed `RuntimeValue`; a runtime value fails to compile in a plain field | **PASS** | `sources.test-d.ts` asserts the four exact types; test 22 has three `@ts-expect-error` lines, which fail the type test if the error disappears. |
| AC8: `service.input()` and `mockService()` have no pointers | **WEAK** | Tests 1–4 assert exact types for plain-object outputs and pass. They do not cover a class-instance output, which F01 shows is broken. |
| AC9: `auth()` and `email()` wrap their fields; examples unchanged | **PASS** | Read the schema changes; `contract.test-d.ts` and `module.test-d.ts` assert the wrapped types; the email message test asserts the union wording. QA step 3 shows `serviceOrigin()` reaching auth through the wrapped `baseUrl` on Prisma Cloud. |
| AC10: every document in § 11 updated | **PASS** | Each listed edit is present. F04, F05 and F06 are gaps beyond the list. |
| AC11: manual QA against Prisma Cloud | **NOT VERIFIED** (step 4) | `qa.md` records steps 1, 2, 3 and 5 passing (deploy, 15 of 15 smoke checks, clean teardown). Step 4, `prisma dev`, failed on the known stale machine-wide postgres emulator and needs a rerun once it is stopped. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 8 | AC1, AC3, AC4, AC5, AC6, AC7, AC9, AC10 |
| FAIL | 0 | |
| NOT VERIFIED | 2 | AC2, AC11 |
| WEAK | 1 | AC8 |
