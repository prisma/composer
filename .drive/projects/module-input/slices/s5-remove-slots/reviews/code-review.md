# S5 code review: a module takes its configuration only through `input`

Range: `claude/module-input-s4...claude/module-input-s5` (eight commits, `65aa76da`..`3bd0cc02`), 60 files. Spec: [`../spec.md`](../spec.md). Companion: [`system-design-review.md`](system-design-review.md).

## Summary

The slice does what the spec pins, line for line: the module `params` and `secrets` slots, their types and their Load machinery are removed; four refusals naming `input` replace them; `email()`, `auth()` and three examples move to `input`; the docs, the skill and five decision records are updated; and QA deploys the three migrated examples to Prisma Cloud. The findings are stale comments, one imprecise type argument, and one QA criterion whose wording the run could not meet literally.

## What looks solid

- **The removal is complete and leaves no dead path.** `deepValues`, both slot validators, the branded per-slot copies, the two "never forwards it" loops and the two root-slot checks are gone, with their imports. The `flatten` signature loses its two slot parameters at both call sites. A repository grep for every removed name, outside the retired-slot tests and the guide's migration note, finds nothing in `packages`, `examples`, `docs/guides`, `skills` or `.github`.
- **The refusals sit where they cannot be bypassed.** `module()` checks `Object.hasOwn(boundary, …)` before anything else is read, so `{ params: undefined }` is refused too. The `provision()` refusal sits at the top of the module branch, after the resource and service branches have returned, so the existing service and resource errors keep their own messages.
- **No behaviour moved for services.** The service branch still refuses a `secrets` map with its ADR-0042 message, `validateServiceParamBinding` is untouched, and the kept `params.test.ts` tests pass.
- **The cycle test still tests something.** `a cyclic service input binding completes Load` lost the `deepValues` walk it was written for, but `resolveValues` still walks every service binding with its own `WeakSet` guard, so the test still proves that a self-referential binding does not hang Load.
- **The new example tests close a real gap.** Before this slice the email root's input and the auth example's bindings were checked only by a deploy. Tests 28 to 30 Load both roots with a config pool and assert what reaches each service.
- **The smoke-script fix.** `examples/email/scripts/smoke.ts` now looks up `${stack}.mailer`, the full-address app name. QA 1's smoke run passing is the evidence it was needed.

## Test runs

Run on this machine against the branch tip `3bd0cc02`:

| Suite | Result |
| --- | --- |
| core, `bun test` | 388 pass, 0 fail |
| core, `vitest --typecheck` (type tests, including `module-retired-slots.test-d.ts`) | 53 pass, no type errors |
| core, `tsc --noEmit` | clean |
| `@internal/auth`, `bun test src` | 77 pass, 5 fail; every failure is `initdb` failing with shmget "No space left on device" (Postgres) |
| `@internal/auth`, `tsc --noEmit` (includes `contract.test-d.ts`) | clean |
| `@internal/auth`, `module.test.ts` alone (tests 21 to 23) | 7 pass, 0 fail |
| `@internal/email`, `bun test src` | 92 pass, 1 fail; the failure is the same `initdb` shmget error |
| `@internal/email`, `tsc --noEmit` (includes `module.test-d.ts`) | clean |
| `@internal/email`, `module.test.ts` alone (tests 14 to 16) | 9 pass, 0 fail |
| Prisma Cloud target, `bun test --isolate` | 574 pass, 6 fail; every failure is the same `initdb` shmget error |
| Prisma Cloud target, `vitest --typecheck` (includes `sources.test-d.ts`) | 16 pass, no type errors |
| Prisma Cloud target, `tsc --noEmit` | clean |
| `examples/email`, `bun test tests` (tests 28, 29) and `tsc` | 6 pass, 0 fail; clean |
| `examples/auth`, `tests/module.test.ts` (test 30) and `tsc` | 1 pass; clean. The example's other test starts Postgres and fails with the shmget error. |
| `examples/storefront-auth`, `pnpm test` | 1 pass, 0 fail |
| root `pnpm lint` | 0 errors (40 warnings, 20 infos, none in a changed file) |
| root `pnpm lint:deps` | clean |

Not run here: root `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm lint:casts`. The diff adds no bare `as` cast outside test files, which `lint:casts` exempts.

## Findings

### F01: comments in changed files still describe the slots

Locations:

- `packages/0-framework/1-core/core/src/load-module.ts`, line 226: `validateServiceParamBinding`'s doc comment opens "unlike a secret slot, a declared param is never required to be bound here". The secret slot it contrasts with no longer exists.
- `packages/0-framework/1-core/core/src/load-module.ts`, lines 355–359: "`opts.deps`/`opts.secrets`/`opts.input`/`opts.params` carry the producers, the input binding and a service's param bindings that satisfy its slots." The spec pinned the ending, but the list still names `opts.secrets`, which now carries nothing any branch accepts.
- `packages/1-prisma-cloud/2-shared-modules/email/src/email-service.ts`, line 6: "The module (`email-module.ts`) binds the input at provision: forwarded boundary params/secret as leaves, `deliveryUrl` as a literal."
- `packages/1-prisma-cloud/2-shared-modules/email/src/__tests__/module.test.ts`, lines 5–6: the file doc comment still ends "this is the first shipped module using boundary params (spec §"Module factory")".

Each tells a reader about a mechanism they will not find. The last two are in the email package, which this slice migrated.

Suggestion:

- line 226: "Checks the params wired into a provisioned SERVICE: a declared param is never required to be bound here; it may fall back to its own `default` (checked later, at `buildConfig`), so this only rejects a wired key that names something other than a real declared param."
- lines 355–359: "The id defaults to the node's own `name`; `opts.deps`, `opts.input` and a service's `opts.params` carry the producers, the input binding and the param bindings. `opts.secrets` is read only to refuse it."
- `email-service.ts` line 6: "binds the input at provision: its own input fields as leaves, `deliveryUrl` as a literal."
- `module.test.ts`: drop the last sentence.

### F02: `storage()` and `streams()` now declare their input as "maybe a schema"

Locations: `packages/1-prisma-cloud/2-shared-modules/storage/src/storage-module.ts`, line 17; `packages/1-prisma-cloud/2-shared-modules/streams/src/streams-module.ts`, lines 21–24; `packages/1-prisma-cloud/1-extensions/target/src/__tests__/env-key-clash.test.ts`, line 15.

Dropping the third type argument makes `I` take `ModuleNode`'s default, `StandardSchemaV1 | undefined`, not `undefined`. Neither module declares an input, and `module()` infers `undefined` for them, so the declared return type is wider than the value. It does no harm today: `[I] extends [StandardSchemaV1]` is false for the union, so `provision(storage())` still needs no `input` and refuses one. But the two-argument form is now what an author copying these files will write, and on a module that does declare `input` it erases the compile-time requirement to bind it (Load still catches a missing binding). The default has to stay wide, because a bare `ModuleNode` means "any module" in Load's signatures.

Suggestion: pass `undefined` as the third argument in all three places, for example `ModuleNode<Record<never, never>, { store: typeof s3Contract }, undefined>`. This is a small deviation from spec § 4.3, which removed the argument outright.

### F03: QA 1's "preflight step reports one filled setting" was checked on the platform, not in the output

Location: `.drive/projects/module-input/slices/s5-remove-slots/qa.md`, § 1; spec § 11, QA item 1.

The criterion says the deploy's preflight step reports one filled setting. The run's plain output prints `✔ check environment variables (2.5s)` with no count, so the criterion as written was not met. The QA record says so and checks the fill on the Management API instead: one `EMAIL_DELIVERY_CREDENTIAL` row on the new Project, created during the deploy. That evidence is stronger than a count line. S4's QA met the same mismatch and handled it the same way. The fault is in the criterion's wording, not in the code.

Suggestion: no code change. Note in the PR description that the fill was checked on the platform because `pnpm run deploy`'s plain renderer prints no count, so a reader does not read the QA record as having skipped the check.

## Deferred (out of scope)

- **`envSecret()`'s doc comment says "Binds a secret slot"** (`packages/1-prisma-cloud/1-extensions/target/src/secret.ts`, line 30). Read today, "slot" means a field of a service's input, so the sentence is not wrong, only dated. The slice's scope for the target is tests only (spec § 9).
- **A module node from another copy of core** that still carries slot fields now fails with a bare `TypeError` instead of a message naming `input`. See D03 in the system-design review for why it is deferred.
- **Project close-out.** `design-notes.md` is not yet moved into `docs/design/`, and `.drive/projects/module-input/` still exists. Spec § 9 puts both out of this slice; they are the plan's close-out steps.

## Already addressed

No earlier review round exists for this slice.

## Acceptance-criteria verification

The criteria are spec § 11 ("Done when"), with tests 1 to 30 from § 10 checked by reading their assertions, and § 7 (the release note).

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: tests 1 to 8, core runtime (`module-retired-slots.test.ts`) | **PASS** | Read each assertion. Tests 1 and 2 assert the full § 3.3 messages (bun's `toThrow(string)` is a substring match, and the strings are the whole message). Test 3 passes `{ params: undefined }` and asserts the message's first sentence. Tests 4 and 5 use `toBe` on the exact § 3.5 messages. Test 6 collects `Object.keys(ctx).sort()` for a closed root and a module with a `{}` boundary. Test 7 asserts the six own keys. Test 8 checks `'paramNeed' in core` and `'secret' in core` on the export barrel. 388 core tests pass. |
| AC2: tests 9 to 13, core types (`module-retired-slots.test-d.ts`) | **PASS** | Each `@ts-expect-error` targets the retired key, map, destructure, fourth type argument or removed export name; vitest's typecheck reports no unused directive and no error. |
| AC3: tests 14 to 20, email | **PASS** | Test 14 asserts `'none'`, `'shop@example.com'`, `secretName(…) === 'EMAIL_DELIVERY_CREDENTIAL'` and the default `deliveryUrl`. Test 15 asserts `'smtp'` reaches the service. Test 16 asserts the exact module-schema message for a missing `from`. Test 18's `InferInput` equals `{ deliveryMode: string; from: string; deliveryCredential: SecretString }`. Test 20 covers the missing input, the narrow `Value<…>` mode, the plain-string credential and the `params` map. Runtime tests pass alone; type tests pass under `tsc`. |
| AC4: tests 21 to 27, auth | **PASS** | Test 21 asserts `isOriginParamSource(binding.baseUrl)`; 22 asserts the config-pool value `'https://app.example'` for `envParam()`; 23 the literal; 25's `InferInput` equals `{ baseUrl: string }`; 27 compiles the three binding forms and rejects `4` and a `params` map. |
| AC5: tests 28 to 30, examples | **PASS** | Test 28 asserts the three bound values on `email-example.email.service`, with `PATH` in the pool to show the root passes on only its fields. Test 29 asserts the message prefix and `(was "smpt")`. Test 30 asserts the mail service's three values and auth's `serviceOrigin()` source. All pass. |
| AC6: root `pnpm build`, `typecheck`, `lint`, `lint:casts`, `lint:deps`, `test` green | **WEAK** | `lint` and `lint:deps` pass here, and every package suite this review ran passes apart from tests that start Postgres, which fail on this machine with shmget "No space left on device". Root `build`, `typecheck`, `test` and `lint:casts` were not run here; the diff adds no bare cast outside tests. CI is the evidence still needed. |
| AC7: the removed-names grep finds nothing in `packages examples docs/guides skills .github` | **PASS** | It finds only the retired-slot tests and the guide's "Before Composer 0.37" note, both expected (they name the removed functions on purpose). In `docs/design/` it finds the decision records, the ADR index and the amendment line at the top of `config-params.md`. |
| AC8: exactly three tracked `.env` files under `examples/` | **PASS** | `git ls-files examples \| grep '/\.env'` lists `auth`, `email` and `storefront-auth`'s `.env.example`. |
| AC9: every document in § 6 updated | **PASS** | Checked each item: the five decision-record notes and index lines; `module-composition.md`'s header, § Input and § Load bullet; `config-params.md`'s header, table rows, § Secrets and § Introspection; both `core-model.md` comments; the guide's five edits and migration bullet; the skill's four edits; `gotchas.md`'s two edits; the `.drive/deferred.md` entry; and § 15's corrections to `email-module.md`, the email README and the gotcha's cause. The wording faults in D01 and D02 are in text the spec did or did not pin, not missing edits. |
| AC10: QA 1, the email example deployed with root input from `.env.production` | **WEAK** | Deploy, smoke (4 of 4), the two `curl` calls and the credential grep all pass as written. "Its preflight step reports one filled setting" was checked on the Management API instead, because the plain output prints no count (F03). |
| AC11: QA 2, the root's schema stops `smpt` first | **PASS** | The deploy fails in "load config and app" with the root message for the environment `production` and `(was "smpt")`. |
| AC12: QA 3, `prisma dev` with root input from `.env.dev` | **PASS** | `dev: ready`; both `curl` calls show `"from":"s5-qa-dev@example.com"`; `prisma dev stop`. |
| AC13: QA 4, the auth example deployed | **PASS** | No `auth-example` project existed; deploy succeeded; smoke 15 of 15. |
| AC14: QA 5, storefront-auth deployed | **PASS** | Deploy succeeded; `e2e-verify.sh` reports the round trip and the secret proof. |
| AC15: QA 6, tear down | **PASS** | Each destroy printed `Destroyed.` and removed its Project; the `.env` files were removed afterwards; the project list matches the start; `git status` was clean. |
| AC16: § 7, the PR title and "Breaking change" section | **NOT VERIFIED** | No pull request exists yet. The commit `23921b4c` carries the pinned title, `feat(core)!: a module takes its configuration only through input`. Check the PR description when it is opened. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 13 | AC1, AC2, AC3, AC4, AC5, AC7, AC8, AC9, AC11, AC12, AC13, AC14, AC15 |
| FAIL | 0 | |
| NOT VERIFIED | 1 | AC16 |
| WEAK | 2 | AC6, AC10 |

## The project's definition of done, across S2 to S5

From `.drive/projects/module-input/spec.md`:

| Item | State |
| --- | --- |
| 1. `module()` takes `input`; `provision(module, { input })` binds it; `params`, `paramNeed()`, `secrets` and the module `secret()` are gone | Met (S2, S5). |
| 2. Input fields are typed values; text, number, serialization, keys and iteration throw naming the field; `===` and `switch` fail to compile | Met (S2); `module-input.test.ts` and its type tests. |
| 3. The root declares `input`, filled from the `config` pool and validated before anything is created | Met (S4); S5 QA 1 and 2 show it on a real deploy. |
| 4. `config` and `secrets` default to `[environmentVariables()]`; `dotenv()` ships | Met (S4). |
| 5. `envParam()` reads the `config` pool; preflight fills `envSecret()` from the `secrets` pool; both are values | Met (S3, S4); S5 QA 1 shows a fill from `.env.production.local`. |
| 6. A `resolve()` over an `envSecret()` gets a pointer that throws as text; `isRuntimeValue()` ships | Met (S3). |
| 7. `auth()`, `email()` and every example use `input`; `prisma deploy` and `prisma dev` of the examples work against real targets, including root `input` from `.env.<environment>` | Met for deploy: the email, auth and storefront-auth examples deployed in S5 QA. Partly met for dev: S5 ran `prisma dev` only for the email example; the auth and storefront-auth examples were not run under `prisma dev` after their migration. The other examples never used the slots and are unchanged. |
| 8. Decision records, glossary, domain docs, guides and skill describe the new surface | Met, with the two wording faults in D01 and D02. The glossary's Module, Value, Config pool and Secrets pool entries already describe `input`; the spec's conflict 1 is right that no glossary entry described the slots. |

Not part of the definition of done, but still open for the project: the plan's close-out (move `design-notes.md` into `docs/design/`, remove references to `.drive/projects/module-input/`, delete that folder), and the S3 deferral that an absent `envParam()` in a module's input is missing from the deploy report's absent-keys list.
