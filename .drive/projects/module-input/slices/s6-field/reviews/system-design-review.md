# S6 system-design review: `field()` and the two kinds of pointer

Range: `claude/module-input-s5...claude/module-input-s6` (13 commits, `81c6386c` to `960a15ab`). Spec: [`../spec.md`](../spec.md). Design: [`../../../design.md`](../../../design.md) § 3 to § 5.

Read for this review: `CLAUDE.md`; `docs/design/01-principles/` (guiding and architectural principles); the service input decision (ADR-0042) and the `resolve()` and config adapters decision (ADR-0062) with every amendment; the glossary entries Input, Value, RuntimeValue and `field()` as this branch writes them; `module-composition.md` § Input; `core-model.md`'s entry table; `design.md` § 3 to § 6 and § 12; `.agents/rules/no-bare-casts.mdc`.

## What the slice adds

- **A pointer records its kind.** A source whose real value at deploy is a pointer now carries `'secret'` or `'plain'` under the registered symbol `Symbol.for('prisma:pointer')`. `secretSource()` is always secret. `paramSource()` is no pointer with a pool key, secret when `redacted`, plain otherwise.
- **`Pointer<T>` and `RuntimeValue<T>`** are new public types; `isPlainPointer()` and `isSecretPointer()` are new public checks.
- **`field(inner)`** for ArkType and Zod wraps a leaf schema in a union with a plain-pointer branch. **`secretString()`** also accepts a secret pointer. `@prisma/composer/zod` is a new public entry.
- **A service binding takes a pointer** (`InputBindingData` gains `Pointer<unknown>`).
- Nothing in Load, preflight or the serializer changes. New tests prove that an ArkType copy of a source is still recognised everywhere a source is.

## Subsystem fit and boundaries

- **The pointer lives in `@internal/foundation`**, below core, beside `SecretString`. That is a domain concept in a utilities package. It is forced: `secretString()` lives in foundation and must recognise a secret pointer, and foundation cannot import core. The `SecretString` precedent is the same shape, and core re-exports only the public names. Accepted.
- **Dependency direction is right.** Core imports `POINTER` from foundation to stamp the kind; foundation never reads a source's payload or brand. The new Zod entry is opt-in at load time: only `src/zod.ts` imports `zod`. `architecture.config.json` and `tsconfig.depcruise.json` place the new public entry in the public layer, and `pnpm lint:deps` passes.
- **The wire format does not move.** The kind is under a symbol key, so `Object.keys` and `JSON.stringify` of a source are unchanged (test 49), and the serializer writes the same `$secret` and `$generated` documents for a copy (tests 59 to 61).

## Naming and typology

- The names come from the design and the glossary: pointer, secret pointer, plain pointer, runtime value, wrapped field, plain field. The code uses them exactly (`PointerKind = 'secret' | 'plain'`, `RuntimeValue`, `isPlainPointer`, `isSecretPointer`). No qualifier prefixes are introduced. The glossary rename of "Configuration" to "Input" follows design § 12; `grep Configuration` on the glossary finds nothing left.
- I did not reopen the name `field()`; the design chose it.

## Findings

**D01. The kind is not in the type.** `Pointer<T>` declares `readonly [POINTER]: PointerKind`, so the type admits a `Pointer<string>` whose data says `'secret'`. The design separates the two kinds by `T` (`Pointer<SecretString>` against `Pointer<string>`), and the data repeats it. Today nothing builds a typed pointer by hand, so the two cannot disagree in practice. Suggestion: tie the property to `T`, for example `readonly [POINTER]: T extends SecretString ? 'secret' : 'plain'`, so the type and the data say the same thing. Low priority; can wait for S7, which retypes the constructors.

**D02. The resolve-decision amendment says slightly more than the code does.** It says "recognising a pointer never relies on object identity". Recognising is by brands, which is true. But treating a copy as the same secret (one entry in `graph.secretSources`) works because a copy shares its original's origin object, whose `source` is the original (spec § 10). That is identity of the shared origin. Suggestion: reword to "Composer recognises a pointer by its brands, never by object identity, and a copy shares its original's origin, so it counts as the same pointer." Spec § 18, conflict 2 already explains why core cannot use "the variable it names".

**D03. `InputBindingData` admits any pointer anywhere.** `Pointer<unknown>` lets a secret pointer sit in any key of a service binding at compile time. The deploy check still refuses the wrong kind, and S10 replaces the loose type. Accepted as temporary; no action in S6.

**D04. A Zod schema from another copy of Zod.** `field()` takes the author's schema object and puts it inside a union built by Composer's own Zod (`z.union([inner, pointer])`). An app on Zod 3, which is still common, or on a Zod 4 copy that pnpm does not deduplicate, hands Composer a schema from a different library instance. The same mixing already exists for ArkType's `secretString()`, but there the author's library wraps Composer's leaf, not the other way round. See code review F02 for the failure modes. Choosing an optional peer dependency instead reverses the spec's decision 10. **Needs Will** for that choice; documenting the Zod 4 requirement does not.

## Recorded conflicts, re-checked

- **Missing-key wording for ArkType** (spec § 18, conflict 1, marked "needs Will's acceptance"). `design.md` § 3, "Error messages", now records the exception in words. The ADR-0042 amendment, the guide and `deferred.md` match. Nothing is left for Will here.
- **Which slice types the constructors as `RuntimeValue`** (conflict 3). Still open. S7's spec must include it, or S8's compile error for listing a runtime value in `resolve()` has nothing to match. For the orchestrator, not Will.
- **The slice teaches `field()` in the guide and the skill before S7 makes it the idiom** (conflict 5). Correct under `user-facing-surface-changes`.

## Test strategy

The tests split along the right line. Foundation tests prove each helper's run-time behaviour against the plain field's messages. Core type tests prove the types the design states. Core run-time tests prove Load. Target tests prove that a copy is recognised by the serializer and preflight. Every place spec § 10 lists has a test that binds an ArkType copy there.

## Out of scope for this pass

Failure modes, test fragility and packaging behaviour are in `code-review.md`. How easy the guide is to learn from is a documentation-review concern and was not assessed.
