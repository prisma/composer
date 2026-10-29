# System design review — S2, `module()` takes `input`

Branch `claude/module-input`, range `origin/main...HEAD` (commits `2431cbfc` to `579542d5`). No pull request exists yet. Spec: [`../spec.md`](../spec.md). The project's spec, plan, design notes and the S1 spike under `.drive/projects/module-input/` are context, not review targets.

Read before reviewing: `CLAUDE.md`; [`docs/design/01-principles/`](../../../../../../docs/design/01-principles/) (both files); in full, the module input decision ([ADR-0061](../../../../../../docs/design/90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)), the `resolve()` and config adapters decision ([ADR-0062](../../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), the module boundary decision ([ADR-0016](../../../../../../docs/design/90-decisions/ADR-0016-a-module-has-the-same-boundary-as-a-service.md)) and the service input decision ([ADR-0042](../../../../../../docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md)); [`design-notes.md`](../../../design-notes.md); the glossary entries for Module, Value and Load / Hydrate.

## What the branch adds

A module may declare `input`, one Standard Schema, as a service does. Its body receives `input` as a tree of values: `input.from` is a `Value<string>`, the same kind of thing as `environment.name`. The body can put a field into a `provision()` binding or list it in `resolve()`. Any attempt to read it (text, number, keys, iteration, `in`, assignment, freezing) throws a Load error naming the field.

Load records each module's binding at its `provision()` call. The second pass then validates every module's binding with that module's schema, parents first and once each, and reads each field's real value out of the validated output. A secret source crosses the schema as an empty `SecretString` box tagged with the source, and is put back after validation. The Graph handed to targets is unchanged: service bindings hold real values, and a forwarded secret arrives as the original `envSecret()` source.

New invariants:

- An input field's real value is the module schema's output at that path, not the bound data.
- Every provisioned module's binding is validated, whether or not the body uses a field.
- A module's binding never holds a param source or a literal `SecretString` (interim, until the `envParam()`-as-value slice).
- A root may not declare `input` (interim, until the config adapters slice).
- Load now runs user code beyond module bodies and `resolve()` functions: module input schemas. The glossary's Load / Hydrate entry says so.

## Fit with the recorded design

**The module boundary decision.** A module now takes configuration the way a service does, which is what that decision's amendment asked for. `provision(module, { input })` mirrors `provision(service, { input })`, and the requirement rule ("required exactly when the node declares an input schema") is the same for both. This keeps "a consumer cannot tell a provisioned module from a provisioned service".

**The service input decision.** It says the framework never looks inside a schema and only calls `validate`. Core keeps that: Load calls `~standard.validate` and walks only the binding and the output. Its "secretness is enforced by validation" rule carries over: core refuses a literal `SecretString`, and an ArkType `secretString()` field refuses a plain string through its own message.

That decision also validates a service's input twice, at deploy and again at boot, on the deploy's *output*. That contract assumes `validate(output)` succeeds. A schema with a parsing morph does not satisfy it, and a morph also clones a `SecretBox` without its private value. The branch's serializer change makes such schemas deployable without addressing the boot side. That is filed as F01 in [`code-review.md`](code-review.md). It is a design question as much as a bug: either secrets must survive a schema's copy, or morphs in service schemas must be refused at deploy with a clear reason. Will should decide which.

**The `resolve()` decision.** "Every value a body passes is a `Value`, and the structure of the graph cannot vary" still holds. The amendment to the module input decision records the one gap honestly: a truthiness check (`if (input.enabled)`) cannot be caught, because the body sees an object, so the branch always goes the same way. The structure rule holds. But the author's intent is silently ignored: `if (input.stripeEnabled) provision(stripe)` provisions Stripe in every environment. The decision record and `module-composition.md` say this; the guide and the skill do not (F06 in the code review). Will should know this amendment is being made in this pull request, since it weakens the original decision's "it cannot read it or branch on it".

**Interim states.** The module input decision still says "Load accepts `input` on a root" and "modules have no `params` or `secrets` slots". The code refuses a root's input and keeps both slots. The spec records both as conflicts resolved by later slices, `module-composition.md` lists them under "Not supported yet", and the error messages say what to do instead. This is acceptable for a slice; nothing that works today stops working.

**Principles.** Core stays target-neutral: it refuses a param source in a module binding rather than reading the target's payload, and it handles secrets only through foundation's `SecretBox` and core's own `SecretSource`. "Wiring precedes execution" holds: schemas run during Load, before any service runs. Nothing here guesses or bundles.

## Boundaries and dependency direction

- `module-input.ts` (the field type and the Proxy) depends on `value.ts` and `graph-types.ts`. `resolve-values.ts` depends on `module-input.ts` only for the error label. `node.ts` depends on `module-input.ts` only for a type. No cycles, and nothing new crosses from core to a target.
- `VALUE` and `VALUE_ORIGIN` become runtime exports of `value.ts` so the Proxy can answer the brand. The public barrel still does not export them. Good.
- The validated module inputs stay inside the second pass and are not put on the Graph. A target cannot see them, so a deploy report cannot show a module's validated input. That is in the spec's out-of-scope list and is the right call for now.

## Naming and typology

| Name | Verdict |
| --- | --- |
| `Value<T>`, "real value", "provided value" | Glossary terms, used correctly. |
| "input field" | New working term for one key of `input`. The glossary's Module entry now defines it in passing. Fine. |
| `ModuleInput<S>` | Clear: the `input` a module body receives. |
| `ModuleInputBinding<T>` | Clear, and distinct from the service's untyped `InputBinding`. |
| `InputField<T>` | **Missing qualifier.** Its siblings say `Module`; it does not. It sits in the public barrel beside `InputBinding`, `InputBindingData`, `InputRef` and `InputValueOf`, which are all service-side or dependency concepts. A reader seeing `InputField<string>` in a service file would expect a field of the service's input data, which is plain data, not a value. Suggest `ModuleInputField<T>`. It is public, so renaming is cheaper now than later. (D1) |
| `InputBindingData` | Says "data" but includes `SecretString` and `undefined`. Its doc comment states exactly what it holds, so this is acceptable. |
| `ValueOrigin` kind `'input'` | Fine: only modules have input origins. |
| `ValueBindingSite.kind` `'input'` beside `'moduleInput'` | Asymmetric. `'input'` means a service's input. Internal only; renaming to `'serviceInput'` would make each discriminator say what it is. Low priority. (D2) |
| `buildModuleInput`, `inputFieldLabel`, `ProvisionedModuleInput` | Internal, clear. |

The spec's reason for avoiding `InputValue` (it would sit one letter from `InputValueOf`, which means real data) is sound.

## Conceptual duplication

The same mechanism now exists twice: a secret source crosses a schema as an empty `SecretBox` carrying its identity in a symbol-keyed own property, and is restored afterwards. Core tags with a module-private `Symbol()` holding the `SecretSource`. The Prisma Cloud serializer tags with the global `Symbol.for('prisma:secret-sentinel')` holding the platform variable's name. Two policies for one idea. The global symbol also weakens the serializer's "a schema must not mint secret boxes" guard (F04 in the code review). One shared foundation helper would remove the duplication; that can wait, but the symbol policy should match now. (D3)

Both tags rely on ArkType copying own property descriptors, non-enumerable symbols included, when a morph clones a box. I checked this with ArkType 2.2: the clone is a new object, it is still an instance of `SecretBox`, and the tag survives. If a library or a later ArkType drops the tag, the restore step fails loudly with the "schema produced a SecretString" error, never silently. That is the right failure direction.

## Error wording

The "not provisioned" error says "an input field can be passed on only inside the body of the module that received it". Load does not enforce that in general: a field captured by a sibling module's body resolves by address without error. `module-composition.md` already says a body capturing another scope's ref is not enforced, so this is consistent, but the message states a rule more strongly than Load checks it. Low priority; no finding.

## Test strategy at the architectural level

What must be proven, and where it is:

- **The structure rule.** Every read of a field fails in the body (test 4's table covers every Proxy trap but `getOwnPropertyDescriptor` and `defineProperty`), and the untrappable truthiness case is pinned as "always takes the branch" (test 5). Good.
- **The real value is the schema's output, parents first.** Tests 7, 8, 10 and 12 prove it, and test 9 does so through two ArkType schemas with morphs, using real ArkType rather than a hand-written schema. Good.
- **A forwarded secret reaches the target as the original pointer.** Core test 9 and target test 34 prove it end to end through Load and the serializer.
- **Missing:** a deploy-then-boot round trip for the serializer change (`serializeInput` then `readInput` then `expose()`). Its absence is why F01 went unseen.

Test names describe behaviour and group by concern (the body's input; forwarding and the second pass; errors), which matches how the design partitions the feature.

## Referrals out of this pass

- Adopter learnability of the guide and skill (truthiness, where a value can go): routed to the code review as F06.
- Whether to make `SecretBox` survive a schema's copy, or to refuse morphs in service schemas: a decision for Will (F01).
