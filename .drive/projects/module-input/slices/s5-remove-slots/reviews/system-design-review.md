# S5 system-design review: a module takes its configuration only through `input`

Range: `claude/module-input-s4...claude/module-input-s5` (eight commits, `65aa76da`..`3bd0cc02`). Spec: [`../spec.md`](../spec.md). Project spec: [`../../../spec.md`](../../../spec.md).

Read for this review: `CLAUDE.md`; `docs/design/01-principles/` (both files); the module boundary decision (ADR-0016), the secrets decision (ADR-0029), the provision-time params decision (ADR-0032), the service input decision (ADR-0042), the module input decision (ADR-0061) and the `resolve()` and config adapters decision (ADR-0062), each in full with every amendment; the ADR index; the glossary entries Module, Configuration, Value, Config pool and Secrets pool; `module-composition.md` and `config-params.md`; `.drive/projects/module-input/design-notes.md`, `plan.md` and `spec.md`; the S5 slice spec and `qa.md`.

## What the slice changes in the system's shape

Before this slice a module had three configuration channels: per-key `params` slots (`paramNeed()`), per-key `secrets` slots (`secret()`), and the `input` schema S2 added. A slot took only a source, never a literal, and Load ran its own used-tracking for each slot kind. After it, a module has one channel, `input`, the same Standard Schema a compute service declares. That is what the module input decision says, and what its Consequences already promised ("There are no `paramNeed()` or module-level `secret()` slots").

Concretely:

- `secret()`, `SecretNeed`, `Secrets`, `SecretBindings`, `paramNeed()`, `ParamNeed`, `ParamNeeds` and `ParamNeedBindings` are gone from core and from the public `@prisma/composer` surface.
- `ModuleNode<D, E, S, PN, I>` becomes `ModuleNode<D, E, I>`, and `ModuleContext<D, S, PN, I>` becomes `ModuleContext<D, I>`. `module-composition.md` already wrote `ModuleNode<D, E, I>`, so the code now matches the domain doc.
- Load loses the slot machinery: the branded per-slot copies, `deepValues`, the two "declares a secret/param but never forwards it" checks, and the two root-slot checks. About 250 lines of `load-module.ts` go.
- Two new refusals replace the removed checks: `module()` throws on a `params` or `secrets` key, and `provision()` of a module throws on a `params` or `secrets` map. Both name `input`.
- `email()` and `auth()` declare `input` schemas. The examples move, and the email example's root takes its own `input` from `[dotenv(), environmentVariables()]`.

The new guarantee is simple and is the one the boundary decision wants: a consumer configures a provisioned module exactly as it configures a provisioned service, through one `input` binding judged by one schema.

## Subsystem fit and boundaries

- **Core stays target-neutral.** Core keeps `secretSource()`, `paramSource()`, `isSecretSource()`, `isParamSource()` and `isRuntimeValue()`, which targets use to build sources. `envSecret()`, `envParam()`, `generatedParam()` and `serviceOrigin()` stay in the Prisma Cloud target. Nothing in the diff makes core branch on a target. This matches "thin core, fat targets" and the target-agnostic principle.
- **A service's per-key `params` channel is untouched**, as the provision-time params decision's amendment says. `validateServiceParamBinding`, `ParamBindings` and the target's pointer rows do not change. That is right: the per-key params channel is a separate design (and a separate future project in the service input decision's Consequence 1), not a module slot.
- **The wire format does not change.** A source in a module's input reaches the service as the same object it reached it through a slot (S3), so `$secret` and `$generated` pointers, preflight and boot see what they saw before. QA 1, 4 and 5 deploy the three migrated examples and pass their smoke checks.
- **Dependency direction.** Shared modules import `secretString` from `@internal/foundation/arktype` and `type` from `arktype`. The examples import `secretString` from `@prisma/composer/arktype`. Both follow the opt-in arktype entry point the service input decision set up. No new cross-layer import.

## Naming and typology

- **No new names are introduced.** The slice only removes names. The surviving vocabulary (`input`, value, source, config pool, secrets pool) is the glossary's. The error messages say "a module no longer takes", "a field of the module's `input` schema" and "a `secretString()` field", which are the glossary's words.
- **Discriminator check on what survives.** With `SecretNeed` gone, `SecretSource` no longer has a sibling "need" type, so the old need/source split now has only one half in code. The surviving names still read correctly cold: `SecretSource` is "where a secret comes from", and nothing else in core claims the word "secret" for a declaration. `isSecretSource` and `isParamSource` had doc comments that mentioned "a forwarded ctx.secrets ref"; the slice rewrote both.
- **`ModuleNode`'s third parameter changed meaning.** For one release the third type argument of `ModuleNode` was the secret slots; now it is the input schema. `storage()` and `streams()` passed `Record<never, never>` there for their empty secret slots, and the slice drops that argument rather than passing it through as `I` (where `Record<never, never>` would not satisfy `StandardSchemaV1 | undefined` anyway). The type test that `ModuleNode` takes exactly three parameters (test 12) catches anyone who keeps writing five. This is the right move. See the code review for a small precision point about what the two-argument form defaults to.

## Decisions the slice spec takes, checked against the recorded design

1. **Refuse the retired keys with an error naming `input`, rather than ignore them** (spec decision 1). The brief asked only to remove the slot checks. Without a refusal, a JavaScript caller, or one that casts, would silently lose a `secrets` map, and the service would later fail with a schema message that does not say why. The `composer` section decision's handling of retired fields (`CONFIG.FIELD_RETIRED`, never migrated) is the precedent. I agree with this decision. It adds four error paths to a slice that otherwise only removes code, but each is two lines and each has a test. One asymmetry, which I accept: `module()` refuses the key whatever its value, `undefined` included, while `provision()` refuses only a map that is not `undefined`. A `provision()` call with `secrets: undefined` loses nothing, so there is nothing to warn about.
2. **`ModuleNode<D, E, I>` and `ModuleContext<D, I>`** (decision 2). Keeping `S` and `PN` as unused parameters would keep a type surface for slots that do not exist. Agreed.
3. **`email()` types `deliveryMode` as `'string'`, not as the three modes** (decision 3). This follows the module input decision ("A module that only forwards a value can use a permissive schema"), and the reason is real: `envParam()` is `Value<string>`, and a `Value<string>` does not fit a field typed `'resend' | 'smtp' | 'none'`, so a narrow module schema would make every existing `envParam('EMAIL_DELIVERY_MODE')` binding fail to compile. The email service's schema still checks the mode before anything is created, and a root that wants the earlier check types its own field narrowly, as the email example does (QA 2 shows the root's message). The cost is that `email()`'s public type no longer tells a reader the three modes; the README says them. Agreed.
4. **The module input schemas are module-level constants, not exported** (decision 4). Agreed; the return type names them with `typeof`.
5. **Per-example choices** (decision 5). `storefront-auth` keeps `envSecret()` at its root because a root's input takes no secret (S4's amendment to the module input decision). `env-param` stays as the guide's `envParam()` example on a service. Agreed.

No proposal in the diff contradicts a recorded decision. The five decision-record amendments are each a dated note after the last existing note, as the spec asks, and the index lines carry matching parentheticals.

## Findings

Each finding has an ID; the code review continues the numbering in its own `F` sequence.

### D01: `module-composition.md` lists the `module()` refusal as a Load error, but `module()` throws when it is called

Location: `docs/design/10-domains/module-composition.md`, lines 224–238 (the "Boundary validation — Load errors, each naming its fix" list).

The new last bullet reads "a `params` or `secrets` key on `module()`, or a `params` or `secrets` map on a module's `provision()`". The second half is a Load error (`LoadError`, thrown from the `provision` collector). The first half is not: `module()` throws a plain `Error` at construction, which in an app is when `module.ts` is imported, before Load starts. The list's lead says every item is a Load error. A reader who relies on the list (for example, to know that `Load` throws a `LoadError` for every boundary problem) gets the wrong answer for the `module()` case. The spec pinned this bullet's text, so this is a spec defect carried into the doc.

Suggestion: keep the `provision()` half in the list, and move the `module()` half to the boundary section above (lines 36–60), as a sentence such as "`module()` refuses a `params` or `secrets` key when it is called, with an error naming `input`."

### D02: `config-params.md` still says a secret is a forwardable slot read through `secrets()`

Location: `docs/design/10-domains/config-params.md`, lines 17–18 and line 295.

The header now says (line 7) that the module slots are removed and that § Secrets describes `input`. Two sentences outside the rewritten paragraphs still say otherwise:

- Lines 17–18, in the document's opening list of the decisions it rests on: "ADR-0029 (a secret is a distinct forwardable slot, read through `secrets()`)". After the service input decision and this slice, a secret is neither a slot nor read through `secrets()`.
- Line 295, in step 1 of the round trip this slice edited: "Load records one binding per resolved service secret slot: `{ serviceAddress, slot, name }`." The first half of the step was rewritten; this half still describes per-slot secret bindings, which Load no longer records (it records input bindings, and preflight collects `envSecret()` sources from them).

The spec's conflict 9 deliberately rewrote only what describes `secret()` slots in § Secrets and left the older `secrets()`/`SecretBox` material under its existing note. Line 295 is inside the step the spec rewrote, and lines 17–18 describe the slots by name, so both fall inside what the slice set out to fix.

Suggestion: lines 17–18 become "ADR-0029 (a secret is carried by name only, never by value)"; line 295's sentence becomes "Load records each service's input binding, and preflight collects every `envSecret()` it names."

### D03 (deferred): a module node from another copy of core can still carry slots

Location: `packages/0-framework/1-core/core/src/load-module.ts`, the removed `rootSecretKeys`/`rootParamKeys` checks; `packages/0-framework/1-core/core/src/node.ts`, `NODE = Symbol.for('prisma:node')`.

Load recognises a node by a global symbol, so it accepts a `ModuleNode` built by a different copy of core. A module package that bundled, rather than peer-depended on, a pre-0.37 core would hand Load a node with `secretSlots`/`paramSlots`. Load now ignores those fields, and the old body destructures `ctx.secrets`, which is `undefined`, so it fails with a bare `TypeError` instead of a message naming `input`. The module boundary decision says a module package declares `@prisma/composer*` as peer dependencies, so a correctly published module calls this copy's `module()`, which refuses the key with the right message. Deferred: the case needs a mis-published package, and guarding it would mean keeping a check for fields this copy of core no longer defines. If it is ever seen, the fix is a one-line check in `loadModule` for an own `secretSlots` or `paramSlots` key.

## Test strategy at the architectural level

The property this slice must prove is "a module has exactly one configuration channel". The tests prove it at each layer:

- The type layer: `module-retired-slots.test-d.ts` rejects `params`/`secrets` on `module()`, on a module's `provision()` and in the body, rejects a fourth type argument on `ModuleNode`, and rejects each removed type name on the public export.
- The runtime layer: `module-retired-slots.test.ts` asserts the four exact error messages, that a body's context has exactly `deps`, `environment`, `input` and `provision`, that a module node has exactly six own keys, and that the two removed value exports are gone.
- The shipped modules: the email and auth tests bind `input` with literals, `envParam()`, `envSecret()` and `serviceOrigin()`, and assert what reaches the service, including the case where the module's own schema refuses first.
- End to end: the two new example Load tests and QA 1 to 5 against Prisma Cloud.

The test files are named for the concept (`module-retired-slots`), not for the mechanism, which keeps them easy to delete once the refusals themselves are retired in a later major.

## Out of scope for this pass

Implementation correctness, test assertions and acceptance-criteria verification are in [`code-review.md`](code-review.md). Adopter learnability of the migration note ("Before Composer 0.37 …") is a developer-relations question; the note exists and names every removed function.
