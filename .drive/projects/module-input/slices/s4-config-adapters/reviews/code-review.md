# S4 code review: config adapters and the root's input

**Range:** `claude/module-input-s3...claude/module-input-s4` (base is S3's branch, not `main`; 17 commits, 94 files). **Spec:** [`../spec.md`](../spec.md). **QA:** [`../qa.md`](../qa.md). **Companion:** [`system-design-review.md`](system-design-review.md).

## Summary

The slice builds what the spec pins, almost line for line, and the suites pass. Two findings are security issues the spec did not foresee: a root that forwards its whole `input` writes every pool value, secrets included, into a service's input document, and a refused root field prints the refused value. The rest are stale error texts and comments, a redaction gap, and small robustness fixes.

## Test runs

Run on this branch, 2026-10-30:

| Suite | Result |
| --- | --- |
| `@internal/foundation` (`bun test`) | 62 pass, 0 fail |
| `@internal/core` (`bun test`) | 396 pass, 0 fail |
| `@internal/core` type tests (`vitest --typecheck`) | 50 pass, no type errors |
| `@internal/cli` (`bun test`) | 403 pass, 1 skip, 0 fail |
| `@internal/local-target` (`bun test`) | 80 pass, 0 fail |
| `@internal/prisma-cloud` (`bun test --isolate`) | 573 pass, 6 fail. All 6 are files that start Postgres (`orm-migrate`, `orm-migration-local-diff`, `orm-migration-resource`, `orm-extension-packs`, `orm-postgres`, `pg-warm-resource`), each failing in `initdb` with `shmget` "No space left on device". A machine limit, not a code defect. |
| `tsc --noEmit` in core, CLI, local-target, target | pass |
| `pnpm lint:casts` | delta 0 |
| `pnpm lint` | no errors (40 warnings, 20 infos) |

## What looks solid

- **The spec's texts are exact.** Every pinned message (the root's refusal, the not-text errors, `CONFIG.ADAPTER_FAILED` and `CONFIG.ADAPTER_INVALID`, the dev advice, the `values-changed` warning) matches the spec verbatim.
- **Precedence is one rule in one place.** Deploy preflight takes secrets first, then env-sourced params, so a name used both ways is filled from the secrets pool; dev preflight and `materializeEnv` apply the same rule through `secretNames` and `pointed.secrets`.
- **The secrets pool is text by construction.** `readPool` refuses a non-text secret with its key and kind, and `readSecretsPool` asserts the type with a check instead of a cast, keeping the cast count flat.
- **The validator stays passive.** It checks shape, passes the file's own arrays through and never calls an adapter (test 36).
- **Commands read only what they use.** `destroy` never calls a `secrets` adapter (test 44); `log`, `devUrl` and `devStop` call none (test 45); the adapter failure stops deploy before any container is resolved (test 47).
- **The dev pause reuses the existing mechanism.** `paused()` folds the new condition into the config-edit check, so the watch callbacks and `rebuildUntilSettled` needed no new paths (test 49).

## Findings

<a id="f01"></a>

### F01. A root that forwards its whole `input` writes every pool value into a service's input document

**Location:** `packages/0-framework/1-core/core/src/load-module.ts` lines 902–917 (the root's entry binds `opts.configPool` whole); `packages/0-framework/1-core/core/src/resolve-values.ts` lines 555–563 (`validatedInputs` keeps the schema's output); `packages/1-prisma-cloud/1-extensions/target/src/serializer.ts` lines 583–620 (the document is the validated output).

**Issue:** The root's binding is the entire config pool. ArkType's default keeps undeclared keys in its output, so the root's validated input is the entire pool. A body may forward `input` whole, or return it from `resolve()`. Both reach a service. Probes against this branch (throwaway, in the scratchpad):

```ts
module('shop', { input: type({ GREETING: 'string' }) }, ({ input, provision }) => {
  provision(web, { input });
});
// Load(root, { configPool: { GREETING: 'hi', STRIPE_KEY: 'sk-123' } })
// serializeInput(...).value === '{"GREETING":"hi","STRIPE_KEY":"sk-123"}'
```

`resolve([input], ([i]) => i)` gives the same binding. The config pool holds every secret under the default lists (the whole shell, `PRISMA_SERVICE_TOKEN` included) and under the guides' recommended `[dotenv(), environmentVariables()]` (both lists read `.env.<environment>.local`). The input document is written to the platform and printed verbatim in the deploy report, because the secrets decision treats it as secret-free. This breaks the slice's central promise for a pattern the design notes explicitly allow ("`input` can be forwarded whole").

**Suggestion:** The fix needs a design decision (system design A01). The narrowest one: Load refuses the root's `input` used whole, as a binding value or a `resolve()` dependency, with an error such as `The input of root module "shop" is the config pool, which holds every value the config adapters return. Bind its fields one by one, e.g. { greeting: input.GREETING }.` Add a core test for each of the two forms.

<a id="f02"></a>

### F02. A refused root field prints the refused value, which may be a secret

**Location:** `packages/0-framework/1-core/core/src/resolve-values.ts` lines 326–336; `packages/0-framework/0-foundation/foundation/src/arktype.ts` line 18 (`secretString()`); test 8 in `packages/0-framework/1-core/core/src/__tests__/root-input.test.ts` lines 139–145.

**Issue:** The root's error passes the schema's messages through, and ArkType appends the actual value. Probe:

```text
The input of root module "shop" does not match its input schema: KEY must be a SecretString box — bind this field to a secret (was "sk_live_SENTINEL"). …
```

The spec designed for exactly this case: a root field typed `secretString()` refuses a plain string from the pool. Under the recommended configuration that string is the real secret from `.env.<environment>.local`, and it lands in the terminal, CI logs, the error envelope and the report. Test 8 checks only the message's start, so it passes.

**Suggestion:** Make `secretString()`'s refusal never describe the actual value (ArkType lets a type override how it describes the actual value). Extend test 8 to assert the message does not contain the pool's value. Values refused by other root fields are ordinary config and may stay in the message.

### F03. Two error messages still describe the process environment as the source

**Location:** `packages/0-framework/1-core/core/src/resolve-values.ts` line 494; `packages/1-prisma-cloud/1-extensions/target/src/preflight.ts` lines 273–276.

**Issue:** Both texts are now wrong:

- The no-config-pool error ends `the deploy and dev commands pass the process environment.` They now pass what the `config` adapters return.
- `fillFailedError` says `failed to provision "<key>" from the deploy shell`. The value now comes from a pool.

The spec kept S3's no-config-pool text and did not list `fillFailedError`, so the implementer left both. A user reading either one looks in the wrong place.

**Suggestion:**

```ts
`… Pass { configPool } to Load; the deploy and dev commands pass the values the \`config\` adapters return.`
`deploy preflight: failed to set "${key}" on the platform from its pool: ${JSON.stringify(error)}.`
```

Update the test that pins the first text, if any.

### F04. `envParam()`'s public doc comment and three code comments still say "the deploy shell"

**Location:** `packages/1-prisma-cloud/1-extensions/target/src/param.ts` lines 35–45 (user-facing JSDoc: "the config pool, the process environment of the deploying shell"); `serializer.ts` lines 271–272 and 425–428; `descriptors/compute.ts` line 153.

**Issue:** The `envParam()` comment is what an author sees in the editor, and it now states the old source. The other three describe the serializer and the report as reading the deploy shell.

**Suggestion:** `envParam()`: "…that is the variable's value in the config pool: what the `config` adapters in prisma.config.ts return, by default the process environment." Replace "the deploy shell" with "the config pool" in the other three.

### F05. The engine-failure redaction does not know about values the adapters read

**Location:** `packages/0-framework/3-tooling/cli/src/deployment-summary.ts` lines 147–167 and 237–255; `packages/0-framework/3-tooling/cli/src/generate-stack.ts` lines 87–90 (the rendered template).

**Issue:** `captureEngineFailure` redacts the child's output tail with `redactSecrets(text, process.env)`: the value of every secret-named environment variable. That tail becomes the engine failure cause in the deploy result. Under `dotenv()` the values are in the child's config pool, never in `process.env`, so a child error that prints one (F02's message, or a provider error echoing an input) is not redacted. The redaction was written when the process environment was the only source.

**Suggestion:** Pass the pool to the recorder: `report.captureEngineFailure?.(configPool)`, and redact secret-named keys of both. That means reading the pool before the call, which is the order the spec already pins; an adapter failure before the recorder is installed then surfaces as the child's raw import error, which is acceptable. Add a test beside the existing `redactSecrets` tests.

### F06. A `__proto__` key from an adapter changes the pool's prototype

**Location:** `packages/0-framework/3-tooling/cli/src/config-pools.ts` lines 89–100.

**Issue:** `pool[key] = value` on a plain `{}`. An adapter that returns `JSON.parse(...)` of a file with a `"__proto__"` key sets the pool's prototype, so `configPool[name]` can then return inherited values, and test 25's "plain object" property no longer holds. `dotenv()` itself is safe, because assigning a string to `__proto__` is ignored. This only matters for custom adapters, which the guide invites ("a project can write its own").

**Suggestion:** Assign with `Object.defineProperty(pool, key, { value, enumerable: true, writable: true, configurable: true })`, or skip the key `__proto__`. Add one case to test 25.

### F07. `deploy-cli.md` describes Load out of order

**Location:** `docs/design/10-domains/deploy-cli.md` lines 116–146.

**Issue:** Load is step 2, "Read the pools" is step 5, and step 2 now says it runs after steps 4 and 5. The code runs: config, entry, name, pools, Load, coverage, assemble. See system design A06.

**Suggestion:** Reorder the list to the code's order and drop the cross-reference sentence.

### F08. QA did not check the report file

**Location:** `../qa.md` § 3.

**Issue:** The spec's step 3 asks that the report file not contain `s4-qa-value`. The deploy ran without `--report`, so there was no report file to search; the grep covered `.prisma-composer`, `.prisma` and `.alchemy`. Operations test 46 covers the report in code, with a fake preflight.

**Suggestion:** Rerun step 3 with `--report <file>` and grep that file, or record in `qa.md` that test 46 stands in for it.

## Implementer adaptations, judged

The brief mentions ten adaptations listed in `qa.md` or the commit messages. I could not find a list of ten. `qa.md` names two, and the commit messages describe their work without listing deviations. Below is every place the branch departs from the spec's text, found by comparing the two, with a verdict.

| # | Adaptation | Verdict |
| --- | --- | --- |
| 1 | QA runs `pnpm run deploy`, because `pnpm deploy` is pnpm's own command | Correct. |
| 2 | QA deploys under `ENV_PARAM_STACK_NAME=s4qa-env-param` to leave an existing project alone | Correct; the hosted steps prove the same things under another name. |
| 3 | QA step 3 checks the fill through the Management API metadata, since the plain output shows no counts | Correct, and it reads metadata only. The report-file part is missing (F08). |
| 4 | `execute-log.ts` passes a frozen empty `NO_POOLS` to `attach` | Necessary: the spec made `pools` required on the attach input and said `log` reads no adapter, without saying what `log` passes. Acceptable; the cleaner shape is system design A04. |
| 5 | `appScopeOf` takes `Pick<LocalTargetProvidersInput, 'container' \| 'devDir'>` | Acceptable: it needs only those two fields, and the narrower type lets the attach path call it without pools. |
| 6 | `readSecretsPool` checks every value is text and throws `InternalError` otherwise, instead of casting | Better than a cast; the check cannot fail after `readPool`'s own check. |
| 7 | `envParamNotTextError` lives in `preflight-names.ts`, shared by deploy and dev preflight | Better than two copies of the pinned text. |
| 8 | `architecture.config.json` gains an entry for `pool-text.ts`; `tsconfig.depcruise.json` gains `@internal/cli/config` | Necessary. The spec's "needs no change" was about the CLI's glob; target files are listed one by one, and the cruiser needs the new path alias. |
| 9 | The local dev integration tests pass pools to `preflight` and `attach`, and expect the new advice text | Required by spec § 11.7 ("every test that builds a `PreflightInput` … gains `pools`") and decision 13. |
| 10 | The public `config.ts` exports `@internal/cli/config` before `@internal/core/config` | Lint's import order; no effect. |
| 11 | The no-config-pool error and `fillFailedError` keep "the process environment" and "the deploy shell" | Not an adaptation the spec asked for; the texts are now wrong (F03). |

## Deferred (out of scope)

- **Checking that the deploy child read the values the CLI validated.** Already recorded in `.drive/deferred.md` by this slice; a check needs a second transport, which spec decision 1 rejected.
- **Watching the files an adapter reads.** Recorded in `.drive/deferred.md`; adapters would need to name their files.
- **`CONFIG.ADAPTER_FAILED` carries the adapter's own message in `why`.** A custom adapter that puts a value in its error message would print it. The spec pins this text; changing it means deciding how much of a user's error Composer may show, which belongs with the secrets manager adapter the spec lists as later work.
- **Rebuild compares the pools only after assembling.** `samePools` runs after `rePipeline`, so a changed value still pays one assemble before the pause. Harmless, and the spec pins the position.

## Already addressed

None. This is the first review round for S4.

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: Tests 1–64 pass | **PASS** | All five suites pass apart from the six Postgres files. I read the assertions of tests 1–11 (exact messages, `toBe` on the pool, the shared `order` array in 9), 13–25 (24 checks `JSON.stringify(error)` and `error.message` exclude the value), 26–33, 37–38, 39–41, 42–49, 51–55, 62 and 63–64. Each asserts the behavior its name states. Test 40's sentinel check cannot fail, because the renderers never read the environment; it is a regression guard, as the spec intended. |
| AC2: Type tests | **PASS** | `config-adapters.test-d.ts` covers the four pinned cases; `vitest --typecheck` reports 50 pass, no errors. |
| AC3: `pnpm build`, `typecheck`, `lint`, `lint:casts`, `test` green at the root | **WEAK** | Verified per package: `tsc` in the four touched packages, lint with no errors, cast delta 0, the built `dist/config.mjs` current. Not run: the root `pnpm build` and the root `pnpm test`; the Postgres suites cannot run on this machine. |
| AC4: Each command reads only the pools in § 2's table | **PASS** | `readSecrets: action === 'deploy'` and `readSecrets: true` for dev; the deploy stack file never calls `readSecretsPool` (test 39). Tests 38, 44, 45 and 48 assert it with throwing and recording adapters. |
| AC5: A secrets pool value never reaches the stack files, events, results, reports, errors or deploy state (§ 7) | **FAIL** | Holds for the secrets pool object: tests 24, 40 and 46, and QA's grep. Fails for the same values arriving through the config pool: a root forwarding `input` whole writes them into the input document, which the report prints and the platform stores (F01); a refused `secretString()` root field prints the value in its error (F02). The spec's "the deploy engine's process never holds a secret value" is false under the recommended configuration (system design A01). |
| AC6: Existing apps behave as before (§ 8) | **PASS** | Default lists read `process.env` in the CLI (tests 13, 14, the renamed pipeline test) and in both children (`readConfigPool` defaults; stack-file import test). Wire format unchanged: the serializer, preflight and boot tests that predate the slice pass with only the § 11.7 edits. A root without `input` takes the old path. QA § 1 deployed and served the unchanged example. |
| AC7: Manual QA 1–7 | **PASS** | All seven steps recorded with output in `qa.md`. Step 3's report-file check is missing (F08). |
| AC8: Every document in § 9 is updated | **PASS** | All seven decision records carry the pinned amendment and index line; glossary, the five domain docs, four guides, the skill and `.drive/deferred.md` changed as listed. `deploy-cli.md`'s order is confusing (F07). Two code-level texts outside § 9 were missed (F03, F04). |
| AC9: Invariants (§ 3.7, § 6.7) | **PASS** | Core's `process.env` count and no-`node:` rule hold (core suite); the target's invariant 4 now expects `preflight.ts` count 1 and no `local-target/preflight.ts` entry, and passes; `pipeline.ts` has no `process.env`. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 7 | AC1, AC2, AC4, AC6, AC7, AC8, AC9 |
| FAIL | 1 | AC5 |
| NOT VERIFIED | 0 | |
| WEAK | 1 | AC3 |
