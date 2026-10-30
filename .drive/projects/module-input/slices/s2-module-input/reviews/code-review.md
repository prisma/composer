# Code review — S2, `module()` takes `input`

Branch `claude/module-input`, range `origin/main...HEAD` (commits `2431cbfc` to `579542d5`). No pull request exists yet. Spec: [`../spec.md`](../spec.md). Design-level findings are in [`system-design-review.md`](system-design-review.md).

## Summary

The core change matches the spec closely and its tests assert exact messages and real behaviour. One serious problem sits in the Prisma Cloud serializer fix: it lets a service whose ArkType schema has a secret field and a morph deploy, but that service's secret cannot be read at boot (F01). The rest are stale cast reasons, a dead map, a weaker secret tag, untested new behaviour and documentation gaps.

## What looks solid

- The Proxy in `module-input.ts` is the spike's, with every trap the spec lists, and the same path always returns the same object, so Load's identity-keyed maps work.
- The second pass is small and readable. `validatedInputOf` and `resolveOne` recurse into each other with a cache and a cycle check, so the order of `moduleInputs` does not matter for correctness.
- The secret sentinel tag survives an ArkType clone. I checked this directly with ArkType 2.2: the clone is a new `SecretBox` and keeps the non-enumerable symbol property. If a library drops it, Load fails with the "produced a SecretString" error, never silently.
- Tests use real ArkType where the behaviour depends on ArkType copying its input, and compare full error messages, not substrings.
- `deepValues` stopping at a value and `isThenable` checking `isValue` first both fix real traps in the existing code that the Proxy would otherwise hit with a misleading message.

## Findings

### F01 — The morph fix makes a service deployable whose secret cannot be read at boot

**Location:** `packages/1-prisma-cloud/1-extensions/target/src/serializer.ts` lines 357–359, 476, 680–695; `packages/1-prisma-cloud/1-extensions/target/src/__tests__/input-serializer.test.ts` lines 541–551.

**Issue:** A service's input is validated twice: at deploy, then at boot by `readInput`, which returns the schema's output. An ArkType morph anywhere in the schema makes ArkType clone the whole input, `SecretBox` included. A `SecretBox` keeps its value in a private field (`#value`), and the clone does not have it. So at boot the service receives a box whose `expose()` throws.

Reproduced on this branch with `type({ key: secretString(), name: 'string.trim' })`: `serializeInput` succeeds and writes `{"key":{"$secret":"KEY"},"name":"shop"}`; with `KEY=s3cret` set, `readInput(node, 'web').key.expose()` throws `Cannot access invalid private field (evaluating 'this.#value')`.

On `main`, the same service fails at deploy ("validated to a SecretString the binding did not supply"). After this branch it deploys and fails inside the running service on first use. The failure moves from an early, loud deploy error to a production runtime error.

Test 35's own schema is worse: `count: 'string.integer.parse'` writes `count: 4` into the document, and boot re-validates it with the same schema, which expects a string. That service can never boot (`count must be a string (was a number)`). The test asserts a deploy that is guaranteed to fail at boot.

**Suggestion:** This needs a decision, because both fixes reach outside the serializer:

1. Make `SecretBox` survive a schema's copy, for example by keeping the value under a non-enumerable symbol-keyed own property instead of a private field. ArkType copies those, as the sentinel tag shows. It touches foundation and the redaction design in the service input decision.
2. Or revert the serializer change and replace the error with one that names the cause: "an ArkType schema with a morph copies a secret box, and a copied box loses its value; remove the morph or move it out of this schema".

Either way, add a deploy-then-boot test: `serializeInput`, set the row and the secret variable, `readInput`, then `expose()`. Use an idempotent morph such as `string.trim`, since a parsing morph cannot pass the boot re-validation at all. The core side of this slice (module schemas with morphs) is not affected: core restores the original `SecretSource`, and a module never boots.

### F02 — Two cast reasons in the second pass now claim something false

**Location:** `packages/0-framework/1-core/core/src/resolve-values.ts` lines 398–401 and 412–415.

**Issue:** Both `blindCast` reasons say each value's real value is one "which checkResult proved plain data". An input field's real value skips `checkResult` on purpose (spec § 5.2, decision 8): it is the module schema's output, so it may be a `SecretSource`, a number from a morph, or, from a schema typed `unknown`, anything at all. The repo's casts rule treats a reason as a claim a reviewer relies on. For service input this is mostly harmless, because the service's own schema validates again at serialization. For resource props nothing validates again, so a non-plain real value would reach the target unchecked.

**Suggestion:** Reword both reasons to say what is true now: environment and computed values were checked by `checkResult`, and an input field's real value is a module schema's output, which a service's schema validates again. For resource props and service params, either check input-origin real values with `describeNotPlain` at substitution and throw a named Load error, or say in the reason why it is safe.

### F03 — `ResolvedInputBinding.sentinels` is now dead in production code

**Location:** `packages/1-prisma-cloud/1-extensions/target/src/serializer.ts` lines 371, 439, 477, 536.

**Issue:** After the fix, `serializeInput` reads the pointer name from the tag on the box and no longer uses the map. Only two tests read `sentinels` (`input-serializer.test.ts` lines 55–81 and 503–509). Production code still builds and returns a second copy of the box-to-name mapping, which can drift from the tag. (This is the "sentinels map" adaptation; I do not accept it.)

**Suggestion:** Remove `sentinels` from `ResolvedInputBinding` and from `resolveInputBinding`. Change the two tests to read the name through the tag or through `serializeInput`'s output. If F01 is resolved by reverting the serializer change, this finding goes away with it.

### F04 — The serializer's tag uses a global symbol, and its comment is wrong

**Location:** `packages/1-prisma-cloud/1-extensions/target/src/serializer.ts` lines 357–359.

**Issue:** `Symbol.for('prisma:secret-sentinel')` is reachable by any code, including a schema's transform. A transform can therefore build `new SecretBox('')`, set that symbol to any variable name, and the serializer will write a `$secret` pointer for it. The old identity match could not be forged, which is what the "a schema must not mint secret boxes" error relied on. Core uses a module-private `Symbol(…)` for the same job, and the spec's own reasoning for core applies here too: the box is made and consumed inside one call, so no other copy of the package needs to recognise it. The spec pinned `Symbol.for`; this is a spec defect, not an implementer one.

The comment also says the copy "holds the same box under a different parent". It does not: ArkType clones the box itself (`out.key !== box`), which is why identity matching failed.

**Suggestion:** Use `Symbol('prisma:secret-sentinel')`. Rewrite the comment: "An ArkType schema with a morph copies its input, secret boxes included, so the copy is a different object; the box carries its pointer name as an own property, which the copy keeps."

### F05 — New behaviour in the second pass has no test

**Location:** `packages/0-framework/1-core/core/src/resolve-values.ts` lines 171–180 and 418–422; `packages/0-framework/1-core/core/src/__tests__/module-input.test.ts`.

**Issue:** Spec § 5.3 adds three behaviours that no test covers:

- a service param bound to an input field with no real value is dropped, so the param falls back to its `default`;
- an array member whose real value is `undefined` is kept as `undefined`;
- the whole `input` forwarded into a child module, `provision(child, { input })`, at runtime. Only the type test covers it.

The spec's test list does not include them, so this is a gap in the spec carried into the code. The first is reachable only through a schema whose output type is `unknown`, but it changes what a deploy writes.

**Suggestion:** Add three tests to `module-input.test.ts`: an `anyInputSchema` module that forwards `input.missing` as a service param and asserts `graph.params` has no entry for it; one that forwards `[input.missing]` and asserts the binding holds `[undefined]`; one that forwards the whole `input` from `relay` into `email` and asserts the service binding.

### F06 — The guide and the skill say reading a field fails, but not that a truthiness check does not

**Location:** `docs/guides/building-an-app.md` lines 312–316, 404–425, 719–725; `skills/prisma-composer-core-concepts/SKILL.md` lines 168–175.

**Issue:** The guide's bullet says "Reading a field in the body fails the deploy with a message naming the field". A reader will believe `if (input.enabled) provision(extra)` fails too. It does not: the body sees an object, so the branch always runs, and `extra` is provisioned in every environment. This is the most likely misuse of a boolean field. The decision record's amendment and `module-composition.md` state it; the two documents adopters and agents read do not.

Two smaller gaps in the same guide section: the intro sentence listing what the builder function receives (`provision`, `deps`, `secrets`, `params`, `environment`) omits `input`; and the "Values that differ per environment" list of where a value can go omits a module's `input` binding and a resource prop.

**Suggestion:** Add a bullet to "A module's input" and to the skill: "A truthiness check such as `if (input.enabled)` is not caught: the field is an object, so the branch always runs. A module's structure cannot depend on its input; to provision something only sometimes, let the parent decide whether to provision it." Add `input` to the intro sentence, and the two missing places to the list.

### F07 — The `provision()` sketch in `module-composition.md` shows `input` as a positional argument

**Location:** `docs/design/10-domains/module-composition.md` lines 192–197.

**Issue:** The implementer added `input` as a fourth positional parameter after `wiring`. The real call takes it in the options object: `provision(child, { id?, deps?, input })`. The sketch was already out of date (it shows `id` as the first positional argument), and the addition makes it more misleading, now in the section a reader opens to learn the module overload. (This is the "module-composition.md sketch" adaptation; I do not accept it.)

**Suggestion:** Replace the sketch with the current options form:

```ts
provision<D extends Deps, E extends Expose, I extends StandardSchemaV1 | undefined>(
  child: ModuleNode<D, E, I>,
  opts: {
    id?: string;
    deps: DepBindings<D>;                                      // omitted when D is empty
    input: ModuleInputBinding<StandardSchemaV1.InferInput<I>>; // required when the module declares an input schema
  },
): ProvisionedRef<E>;
```

## The seven adaptations

| Adaptation | Verdict |
| --- | --- |
| Closed-root overload: the implementation's function arm is typed with `input: undefined`, and the wrapper calls `boundaryOrBody({ ...ctx, input: undefined })` (`node.ts` line 993). | Acceptable. The copy is redundant at runtime, because a closed root has no `inputSchema` and Load already sets `input: undefined`, but it is harmless. A purely type-level fix would be tidier; not worth a finding. |
| Renamed test in `secrets.test.ts`, with its expected message updated. | Acceptable and required: the spec changed that error's text, and the old title described a rule that no longer holds. |
| Lint-driven syntax: `Record<never, never>` for `{}`, export order, formatting. | Acceptable. The types are equivalent, and the optional-key type tests pass. |
| Guide subsection placed at the end of "Reusable Modules" rather than between the auth example and "The root then treats it like any other node". | Acceptable and better: the spec's position would have split the auth example from its continuation. |
| `module-composition.md` `provision()` sketch with a positional `input`. | Not acceptable: F07. |
| Serializer keeps the `sentinels` map. | Not acceptable: F03. |
| Test details: test 9's `relay` binds the literal `'4'` instead of forwarding `input.n`; test 18 compares `payload` rather than identity; helpers cast with `as never`. | Acceptable. Forwarding the parsed number into a parsing schema would fail by design. `ctx.secrets` hands the body a branded copy of the bound source, so identity cannot hold, and the test still proves the slot counts as used: Load would otherwise fail with the unused-secret error. |

## Deferred (out of scope)

- **One shared helper for the secret sentinel tag** used by core and the serializer. It removes the duplication noted in the system design review, but it changes foundation's surface, which is beyond this slice. F04 aligns the symbol policy now.
- **Renaming `InputField<T>` to `ModuleInputField<T>`** (system design review, D1). It is a public name, so it is cheapest now; whether to rename is Will's call, not a defect.
- **A generic `ModuleNode` (wide `I`) passed to the first module overload refuses an `input` key.** Only a generic wrapper hits it, and the second overload accepts `input?`. No caller does this today.

## Already addressed

None. This is the first review round.

## Acceptance-criteria verification

The spec's acceptance criteria are its § 11, "Done when".

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: tests 1 to 34 and the § 10.2 type tests pass | **PASS** | Read every test body against § 10. Each asserts the behaviour the spec names, with full messages where § 5.4 pins one. Ran `bun test` in core: 344 pass, 0 fail. Ran `vitest --typecheck` in core: 41 type tests in 8 files pass, among them the 12 in `module-input.test-d.ts`. Ran `input-serializer.test.ts` in the target: 39 pass, including tests 34 and 35. Test 35 passes, but what it proves is wrong (F01). |
| AC2: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm test` green at the root | **NOT VERIFIED** (in part) | `pnpm typecheck`: exit 0 (turbo, full cache hit). `pnpm lint`: no errors; its warnings are in files this branch does not touch, and biome on the 40 changed files is clean. `pnpm lint:casts`: delta 0. Target `bun test --isolate`: 510 pass, 6 fail, all six from Postgres failing `shmget` ("No space left on device"): the machine is out of shared memory segments, not a code defect. `pnpm build` and the full root `pnpm test` were not run. |
| AC3: the `examples/env-param` edit serves `"environment":"deployed to dev"` under `prisma dev`, and the template-literal edit fails with the § 3.2 message | **PASS** (recorded evidence) | `qa.md` records both runs: the curl output, and the exact misuse message with exit code 2. The message matches § 3.2. Not re-run in this review. |
| AC4: every document in § 8 is updated | **PASS** | Checked each § 8 item. The amendment to the module input decision, its index line, the boundary decision's sentence, the glossary's three edits, `core-model.md`, the skill and the guide's `provision` list item are verbatim. Two placements differ from the spec, judged above. F06 and F07 are accuracy gaps inside updated documents, not missing updates. |

### Spot checks against §§ 3–7

- Misuse message and every `<what>` in § 3.2: verbatim in `module-input.ts`; test 4 covers 16 operations.
- Every § 5.4 message: verbatim in `load-module.ts`, `node.ts` and `resolve-values.ts`; tests 19 to 33 compare full strings.
- Second-pass order: module bindings are validated before service values are resolved and before the `found.length === 0` early return.
- `SENTINEL_SOURCE` is a module-private `Symbol()`, as § 5.2 requires.
- Exports: `InputField`, `ModuleInput`, `InputBindingData` and `ModuleInputBinding` are exported; `buildModuleInput`, `InputOrigin`, `VALUE` and `VALUE_ORIGIN` are not.

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 3 | AC1, AC3, AC4 |
| FAIL | 0 | |
| NOT VERIFIED | 1 | AC2 (`pnpm build` and the full root `pnpm test`) |
| WEAK | 0 | |
