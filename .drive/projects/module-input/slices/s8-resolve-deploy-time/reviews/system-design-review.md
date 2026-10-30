# S8 system-design review — `resolve()` takes deploy-time values only

Range: `claude/module-input-s7...claude/module-input-s8` (commits `94bd41cb` to `cd6e7e2d`). S7's QA commit `81aa2070` is on the base but not in S8's history and is ignored.

Read for this review: `CLAUDE.md`; `docs/design/01-principles/` (both files); the decision record index; the `resolve()` and config adapters decision, the secrets decision and the module input decision, each in full with every amendment note; the glossary entries Value, RuntimeValue and `field()`; `config-params.md`, `core-model.md` and `module-composition.md` where the diff touches them; the project design (`design.md`, sections 3 to 6, 10 and 12); this slice's `spec.md` including "Settled by the orchestrator"; and `qa.md`.

## What the slice changes in the system's shape

Before S8, a `resolve()` function could list a value known only at boot. It received that value's pointer, could return it unchanged, and `isRuntimeValue()` let it tell a pointer apart. Load carried a special case that accepted a returned pointer only if the function had received it.

After S8, a `resolve()` dependency must be a deploy-time value: `environment.name`, another `resolve()` result, `envParam()`, or a plain field of a module's input. Two checks enforce it:

- **At compile time**, `resolve()`'s first parameter is `DeployTimeDependencies<D>`, which replaces any dependency whose real-value type is or holds a `Pointer` with a string literal type that is the error message.
- **At Load**, `refusePointerDependency` walks each dependency's real value before `fn` runs and refuses any pointer it finds, naming the field that holds it.

The new guarantee: `fn` never receives a pointer, so it never returns one, and every secret that deploy preflight checks is one a binding names. Pointers now stay entirely inside Composer (Load creates them, the serializer writes them, boot reads them), which is what design section 6 asks for.

This removes a concept (`isRuntimeValue()`) and a special case (accepting a received pointer in a result). The system gets smaller. That fits the guiding principle "Compose, don't special-case".

## Fit with the recorded design

- **Design section 6** is built as written: the dependency set, the compile error, the deep Load check, and "`fn` never receives a pointer".
- **Design section 10** ("What goes away"): `isRuntimeValue()` and the received-pointer special case are both gone.
- **Design section 12** asks each amendment note to say plainly which recorded statement it reverses. The notes mostly do; the `resolve()` decision's note miscounts and misses one (see "Decision records" below).
- **The secret-field advice** (spec decision 5, conflict 3, settled by the orchestrator): design section 6 says the Load error says "declare it plain". For a `secretString()` field that is wrong, since a plain field refuses a secret, so the Load error tells the author to pass the field on and read it in the service. This is a deliberate, recorded departure from the design's wording, and the right one.
- **No principle is contradicted.** The check is a deterministic walk of data Load already holds; it does not inspect `fn`, so the service-input decision's "the framework introspects nothing" stands. Core stays target-agnostic: it recognises pointers by brand, never by target payload.

## Naming and vocabulary

- **`DeployTimeDependencies`, `IsDeployTime`, `NotDeployTime`, `HoldsPointer`** all use glossary words ("deploy-time value", "pointer"). None is exported, so none adds public vocabulary. `NotDeployTime`'s text is the user-visible vocabulary, and it uses "deploy-time value", "known only at boot", "field wrapped with field()" and "plain", which are the glossary's and the design's words.
- **`refusePointerDependency` and `firstPointer`** name what they do. No qualifier prefixes or coined terms were introduced.
- **Error text** consistently says "a value known only at boot", which matches the glossary's RuntimeValue entry, and "deploy-time value", which matches the Value entry.
- The guide calls the dependency set "a **deploy-time value**" in bold, which matches the glossary. Good.

## Boundaries and dependency direction

- `resolve-values.ts` now imports `isSecretPointer` from `@internal/foundation/pointer`. Core depending on foundation is the existing direction.
- The Prisma Cloud target changes doc comments only. Preflight code is unchanged, and it is correct that it is: preflight reads `graph.secretSources`, and what changed is only which graphs Load lets through.
- **`SecretSourceUse.nodeKind` keeps `'resource'`** (spec decision 7). No graph Load returns can now hold a secret attributed to a resource: Load refuses a secret in props directly, and through a `resolve()`. So the public type has a variant nothing produces. The spec's reason (removing it is a type change outside the plan, for no behaviour) is sound for this slice. It should be removed when the binding types are reworked (S10) or at project close-out; it is listed as deferred in the code review.

## Decision records

The repo's decision record index says records are append-only, and every earlier slice added a dated note at the top rather than editing older text. So leaving the older notes that mention `isRuntimeValue()` unchanged follows the established convention. That convention only works if each new note says exactly which earlier statements it reverses, because a reader of the third-slice note alone is now told something false. Judged against that:

- **The secrets decision** says "two statements of the third-slice note no longer hold" and then states both replacements. The count is right and both are clear. It reads as the current decision.
- **The module input decision** says only a plain field can be a `resolve()` dependency. The Decision section's sentence "which it can only pass on: … or as a `resolve()` dependency" is now narrowed rather than reversed, and the note makes that clear enough.
- **The `resolve()` and config adapters decision** does not read cleanly. Its note says it "reverses two statements of the third-slice note". The third-slice note actually holds three statements that are now false: `fn` receives a secret input as a pointer and `isRuntimeValue(x)` is true for one; `fn` returns plain data or a pointer it received; and preflight checks a secret "a function lists but does not return". And the seventh-slice note says "So a `resolve()` function that lists one receives a value typed `Pointer<SecretString>` or `Pointer<string>`", which the eighth note reverses without saying so. A reader who reads the notes in order meets an unacknowledged contradiction between the seventh and eighth notes. The Decision section's "Secret inputs arrive as opaque `SecretString` boxes" was already corrected by the third note; with the eighth note, a secret never reaches `fn` at all, and the note should say so in those words. Code review finding F03 gives the fix.
- **The date** in all three new notes and their index lines is written in backticks, `` `2026-10-30` ``, because the spec's `<date>` placeholder was in backticks. Every other note writes the date as plain text. Code review finding F02.
- The `resolve()` decision now has seven amendment notes above a Decision section that still says `ResolvedValue` and "opaque `SecretString` boxes". That is a project close-out question, not an S8 defect: whether to fold the notes into a rewritten record when the project lands. **Needs Will** at close-out; not a blocker here.

## Test strategy at the architectural level

The property to prove is two-sided: the compiler refuses every typed case, and Load refuses every case the compiler cannot see, before `fn` runs.

- Compile side: `field.test-d.ts` covers each refused kind (plain and secret runtime values; wrapped, transforming wrapped, secret, nested and array fields, in ArkType and Zod) and each accepted kind (plain field, environment value, computed value, `unknown`, `any`). `sources.test-d.ts` covers each target constructor. A test pins the message text through the mapped type.
- Load side: `pointer.test.ts` covers a directly listed secret and plain source, a top-level, nested and array pointer in a field, a field typed `unknown`, and the negative case (a wrapped field bound to plain data passes). `module-input.test.ts` covers the secret-field advice.
- Gap: no type test lists a field or value whose type is recursive, such as a JSON type. That gap hides a real failure (code review F01).

## Out of scope for this pass

Failure modes, test-assertion strength and acceptance-criteria verification are in `code-review.md`. Adopter learnability of the new compile error (a string-literal type message plus a possible second error) is a developer-experience question; the guide documents both errors, and the spec compared the alternative signatures.
