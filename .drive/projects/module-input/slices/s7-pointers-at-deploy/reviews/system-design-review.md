# S7 system-design review — schemas see pointers at deploy

Range: `claude/module-input-s6...claude/module-input-s7` (9 commits, `a5403f61` to `acb05a17`). Spec: [../spec.md](../spec.md). Design: [../../../design.md](../../../design.md).

Read for this review: `CLAUDE.md`; `docs/design/01-principles/`; the service input decision (ADR-0042), the module input decision (ADR-0061) and the `resolve()` and config adapters decision (ADR-0062), each with every amendment note; the glossary entries Input, Value, RuntimeValue and `field()`; `module-composition.md` § Input; `config-params.md` § Sources are values; design.md sections 3 and 11; the spec in full.

## What changes in the system

Before this slice, a schema at deploy never saw a value known only at boot. Load and the Prisma Cloud serializer each built a stand-in for it: an empty `SecretBox` for a secret, `''` for a plain generated value, `https://origin.invalid` for `serviceOrigin()`. Afterwards they put the original source back by path or by box identity.

After this slice, the schema receives the source object itself, the pointer. Its kind (secret or plain, recorded since S6) decides which field accepts it: `secretString()` takes a secret pointer, `field()` takes a plain pointer, a plain field takes neither. Load and the serializer recognise a pointer, or a copy the schema made of it, by its brands rather than by identity or path.

One stand-in remains, on purpose: the serializer's second check runs the service's schema again with `new SecretBox('composer-stand-in-not-a-secret')` in place of each secret pointer, to detect a schema that copies its input and so would lose the secret at boot. The stand-in's output is never used to build the document.

New guarantees:

- A plain field bound to `serviceOrigin()` or a plain `generatedParam()` fails at deploy, and fails to compile in a module's binding, because the three constructors are now typed `RuntimeValue`.
- A redacted `generatedParam()` beside an ArkType copy is refused at deploy, as `envSecret()` already was.
- `service.input()` and `mockService()` never expose a pointer type.

## Subsystem fit and boundaries

- The type changes sit where they belong: `secretString()` in foundation, `InputValueOf` in core, constructor types in the Prisma Cloud target. Core still knows nothing of Prisma Cloud; the serializer imports core's `isSecretPointer` and brands only.
- Pointer recognition is now one mechanism (brands plus kind) used in every walk: Load's `refuseSecretBoxes` and `restore` (`resolve-values.ts`), and the serializer's `resolveInputBinding`, `refuseLostSecrets` and `substitutePointers`. The boot side (`readInput`, `hydrateInputDocument`) and preflight (`inputSecretNames`, `prisma dev`'s preflight, env-key clash, the compute descriptor) read the binding's sources, which did not change. No other site used the removed stand-ins; a search for `sentinel` and `origin.invalid` in packages, docs and skills finds none left.
- The code matches the spec's own patch exactly (`wip/s7-spec-probe/final.patch` reverse-applies cleanly to the branch).

## Findings

**D01 — "pointer" now means two things in the serializer.** The glossary (RuntimeValue) defines a pointer as the source object, and says "the deploy writes the pointer into the service's input document". The serializer's new doc comments call what lands in the document a "marker" (`SECRET_MARKER`, `GENERATED_MARKER`, "writes each pointer as its document marker"). But the file still has its own `isSecretPointer`, which recognises the document's `{ "$secret": … }` object, so core's `isSecretPointer` has to be imported under the alias `isSecretPointerValue`. `PointerName`, `assertDistinctPointerNames` and the "Input channel" comment ("swaps each pointer for a redacting box") also use "pointer" for the document form. A reader meets two functions named `isSecretPointer` that test different things. Suggestion: give the document form its own glossary word (the code already says "marker"), rename the serializer's local function to `isSecretMarker`, and correct the glossary's RuntimeValue sentence to say the deploy writes a marker naming the variable. Adding a glossary term is a vocabulary decision: **needs Will**.

**D02 — Load no longer refuses a module schema that replaces a runtime value's field, and the spec's reason for that is wrong.** Spec decision 7 removes the S6 refusal ("The input schema of module … changed input key …") and argues that "the service's own deploy check then sees no pointer where it expected one". It does not: the service's binding is built from the module schema's output, so if the module schema replaced `serviceOrigin()` with a string, the service's binding simply holds that string, and the serializer has no generated leaf at that path to compare against. The replacement is passed on silently. This is consistent with the recorded rule that a field's real value is the schema's output, and only a hand-written schema can do it (an ArkType or Zod `field()` passes the pointer through untouched). But it removes a refusal that `module-composition.md` documented until this slice ("a schema that changes such a field fails the Load"). Suggestion: either accept it and correct decision 7's reasoning in the spec, or keep a narrow check in `restore` that a path bound to a pointer still holds a pointer of the same source. Whether to keep that check: **needs Will**.

**D03 — The design's own example of a wrapped field cannot sit beside a secret in an ArkType service schema.** Spec conflict 3 found that `field(type('string.integer.parse'))` makes ArkType copy the whole input, so in a service schema with a `secretString()` field the deploy refuses it. design.md section 3 now says so in one added sentence, and the guide and agent skill warn about it. The design's example pair (`port: field(type('string.integer.parse'))` beside `deliveryCredential: secretString()`) is still unlabelled; it is valid only in a module schema. The spec already raised this; it is listed here so it is not lost: **needs Will** (mark the example as a module schema, or accept the limit as written).

**D04 — The lost-secret check is Prisma Cloud code, but the problem it detects is not.** A copied `SecretBox` losing its value is a property of foundation's `SecretBox` and ArkType, and any target that validates at deploy and reads boxes at boot would need the same check. `refuseLostSecrets` lives in the Prisma Cloud serializer only. Today Prisma Cloud is the only target that serializes service input, so this is not a defect now. Deferred: move the check into core when a second target serializes input (design section 11 already defers a box that survives the copy).

## Decision records

- The three amendment notes follow the repo's convention (a dated paragraph at the top, the body left as written) and each says what it reverses: ADR-0042's note says the sentinels are gone; ADR-0061's corrects "secrets as opaque boxes"; ADR-0062's says it reverses the sixth-slice note's last sentence. The index lines match.
- ADR-0032's third-slice amendment note still lists `sentinel` among `paramSource()`'s options. Spec decision 15 says no other decision mentions stand-ins; this one does. See code-review F06.

## Test strategy

The architectural properties to prove are: a schema receives the pointer itself (tests 6, 14, 15), a copy still counts as the pointer (tests 9, 13), each field kind accepts exactly its pointer kind (tests 7, 8, 10 to 12, 22), the stand-in never reaches the document (test 15), and a copy that loses a secret is refused (tests 16 to 18). Each has a test whose assertions check the property directly, not a proxy. The type tests (1 to 5, 22) pin the `RuntimeValue` constructor types and the pointer-free `service.input()`. What is missing is a type test with a non-plain output type (a `Date`), which would have caught code-review F01.

## Out of scope for this pass

Implementation failure modes, error-message correctness and acceptance criteria: see [code-review.md](code-review.md).
