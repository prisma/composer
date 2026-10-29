# S3 code review: sources are values

**Range:** `claude/module-input...claude/module-input-s3` (base is S2's branch, prisma/composer#401). **Spec:** [`../spec.md`](../spec.md). **QA:** [`../qa.md`](../qa.md).

## Summary

The slice does what the spec says: the four Prisma Cloud source constructors return values, a service's bindings keep receiving the same objects, and Load computes real values only for a module's input, a `resolve()` dependency and a resource's props. The behaviour is well tested. The findings are two cases where the graph's secret list names the wrong node kind, one misleading error hint, and stale comments.

## What looks solid

- **The compatibility argument is tested by identity.** Tests 8 to 11 assert `toBe` on service bindings and params with no config pool, and the shared-module and example suites that read those leaves pass unchanged (`auth`, `email`, `streams`, `examples/storefront-auth`: 18 tests).
- **The pointer rule is narrow and exact.** `pointersIn(args)` collects what the function received, and `checkResult` accepts a source only if it is one of those objects. A source made inside the function fails, and so does an `envParam()`, because a function receives its string, never the source.
- **Errors wrap once.** `isSourceMisuse` lets a pointer misuse inside a function be wrapped with the binding's name, while every other `LoadError` (such as the sealed `provision` error) still propagates as it is. Test 21 checks both the text and the `cause`.
- **The props check covers the early return.** `refusePointersInProps` also runs when Load found no values, so a source from another installed copy of core in props is refused too (spec § 4.9).
- **The cast ratchet is flat.** `pnpm lint:casts` reports delta 0; the CLI fixture types its schema instead of casting (`b0cd04e5`).

## Findings

### F01. A secret listed by a `resolve()` in a resource's props is recorded as used by a service

**Location:** `packages/0-framework/1-core/core/src/resolve-values.ts` lines 379–389 (`recordSecret`) and 438–439 (`case 'source'`); `packages/0-framework/1-core/core/src/graph-types.ts` line 124.

**Issue:** `collect` skips recording a source found directly in props, but `resolveOne`'s `'source'` case records every secret source it resolves, for any site. `recordSecret` maps every site that is not `moduleInput` to `nodeKind: 'service'`. So:

```ts
props: { url: resolve([envSecret('K')], () => 'https://x') }
```

gives `graph.secretSources = [{ address: 'shop.site', nodeKind: 'service' }]` (confirmed with a throwaway probe test, since removed). Deploy preflight would then report `K  (used by service "shop.site")` for a resource. The Load succeeds, because the function returns a plain string, so this reaches preflight.

**Suggestion:** add `'resource'` to `nodeKind` in `SecretSourceUse` and `PreflightName`, map `site.kind === 'props'` to it, and add a source-load test for this case. `missingError` already prints `used by ${m.nodeKind}`, so the message becomes correct with no other change. (The design side of this is A02 in the system design review.)

### F02. A secret a service receives through a module's input is listed under the module

**Location:** `packages/0-framework/1-core/core/src/resolve-values.ts` lines 392–404 and 506; `packages/1-prisma-cloud/1-extensions/target/src/preflight-names.ts` lines 27–31 and 75–86.

**Issue:** when a module forwards `input.key` to a service and the root binds `key: envSecret('K')`, the service's binding holds `input.key` (a value) when `collect` walks it, so nothing is recorded there. The source is first met when the module's binding is validated, and `graph.secretSources` lists it as `{ address: 'shop.email', nodeKind: 'module' }`, although `shop.email.echo` receives it (confirmed with a probe). Deploy preflight still prints the service, but only because `collectPreflightNames` walks `inputManifest(graph)` first and `dedupedNames` keeps the first entry. Two orderings in two packages must agree for the message to be right, and `PreflightName.address`'s comment ("a module whose input holds a secret no service receives") is true only because of that. Any other reader of `graph.secretSources` gets the module.

**Suggestion:** build `secretSources` so a service that receives the source wins. For example, after the final service bindings are computed, record the secret leaves of `inputBindings` first, then append the remaining recorded sources. Add a preflight test that forwards an `envSecret()` through a module's input to a service and asserts `used by service "…"`. If you keep the current order, change the `SecretSourceUse.address` and `PreflightName.address` comments to say the address is where Load first met the source, and that preflight relies on walking service bindings first.

### F03. The path error for a runtime param source suggests a fix that cannot work

**Location:** `packages/0-framework/1-core/core/src/resolve-values.ts` lines 226–246 (`describeData`, `readPath`); test `source-load.test.ts`, "a path through a runtime param source fails naming the path".

**Issue:** for `input.base.x` with `base` bound to `serviceOrigin()`, the error ends "To compute with it, list it: `resolve([input.base], ([v]) => …)`". A function that lists `input.base` receives a pointer, which throws when read. The hint sends the author to a second error.

**Suggestion:** when the parent is a pointer (`isSecretSource || isParamSource`), end the message with "Its value is known only at boot; pass `input.base` on whole." instead of the `resolve()` hint, and update the test's expected text. The spec quotes this message only up to "…", so the tail is not pinned.

### F04. Comments still describe preflight as reading only service input bindings

**Location:** `packages/1-prisma-cloud/1-extensions/target/src/preflight-names.ts` line 35 (`PreflightNames.secrets`: "Every input-binding secret leaf's bound platform var name … first service wins the reported address"); `packages/1-prisma-cloud/1-extensions/target/src/preflight.ts` lines 355–360 (the `runPreflight` comment continues "every service's input-binding `envSecret` leaf").

**Issue:** both lists now include `graph.secretSources`, and the reported address can be a module.

**Suggestion:** say "every secret source in a service's input binding or in `graph.secretSources`, deduped by name; the first entry wins the reported address".

### F05. A fixture variable is named after a Drive slice

**Location:** `packages/0-framework/3-tooling/cli/src/__tests__/pipeline.test.ts` lines 30 and 43; `packages/0-framework/3-tooling/cli/src/__tests__/fixtures/pipeline-config-pool/module.ts` line 41. Also the two renamed test titles in `stack-file-import.test.ts` (lines 46 and 56), which read "the composer export of prisma.config.ts the environment and the process environment as the config pool".

**Issue:** `S3_PIPELINE_PROBE` means "slice 3" only inside this project's Drive folder; once merged it reads like AWS S3. The spec pinned the name, but it will outlive the spec. The two test titles are missing their list commas and are hard to parse.

**Suggestion:** `PIPELINE_CONFIG_POOL_PROBE`; and "passes the composer export of prisma.config.ts, the environment, and the process environment as the config pool, to lower()".

## Deferred (out of scope)

- **Teardown now needs deploy-time configuration in more cases.** `destroy` Loads the graph, so a `resolve()` that lists an unset `envParam()`, or a module input whose required field is bound to one, now fails teardown. QA already notes that `destroy` for `examples/env-param` needs `ENV_PARAM_GREETING`. The config adapters slice owns where these values come from, so it should decide how teardown gets them.
- **An absent `envParam()` in a module's input is not in the deploy report's absent-key list.** Recorded in `.drive/deferred.md` by this slice, as the spec says.
- **A spread copy of a source does not throw when turned into text.** Recorded in `.drive/deferred.md`; removed with the module slots in S5.
- **Dev preflight does not require a secret only a `resolve()` lists.** A recorded decision (spec § 14, decision 10), not a defect.

## Already addressed

No earlier review round for this slice.

## The implementer's adaptations of the spec

Neither `qa.md` nor the commit messages lists the adaptations, so this table lists the differences from the spec found by reading the code. I found seven.

| # | Where the code differs from the spec | Verdict |
| --- | --- | --- |
| 1 | `config.test-d.ts` and `params.test-d.ts` change, although § 8 says every type test passes unchanged. `f0a03a2b` asserts `SecretSource<string> & Value<unknown>`. | **Correct.** `toEqualTypeOf` is exact, so the old assertion cannot pass once the return type is an intersection; the spec was wrong. The spec asked the implementer to stop and report a conflict instead of deciding. |
| 2 | `refusePointersInProps` also runs on the `found.length === 0` early return. | **Correct and needed.** Without it a source from another copy of core in props passes, which § 4.9 says must fail. |
| 3 | `recordSecret` takes `isSecretSource(original) ? original : source` instead of `sourceOriginOf(source)?.source ?? source`. | **Correct.** Same behaviour; the narrower form gives `SecretSource` without a cast. |
| 4 | The graph literal in `control-lowering.test.ts` does not gain `secretSources: []` (§ 4.10, § 11.6). | **Acceptable.** The literal is cast to `LowerContext` and that test never reads the field, so the compiler does not require it and nothing breaks. |
| 5 | The `pipeline-config-pool` fixture types its module's schema instead of casting (`b0cd04e5`). | **Correct.** The fixture is not a test file, so a cast would count against the cast ratchet. |
| 6 | `examples/auth/scripts/smoke.ts` looks up apps by full address (`181dc28c`), outside § 10's scope list. | **Correct.** The script was already broken by the full-address decision; QA step 1 needed it. Mention it in the PR description. |
| 7 | QA ran env-param under the stack name `s3qa-env-param`, so step 5 names `s3qa-env-param.greeter` and step 3 curls `env-param-example.greeter.echo`. | **Correct.** It avoids touching the workspace's existing project; the evidence is equivalent. |

## Test runs (this review, on this machine)

| Suite | Result |
| --- | --- |
| `@internal/core` typecheck, `bun test`, `vitest --typecheck` | pass; 384 tests; 46 type tests |
| `@internal/cli` typecheck, `bun test` | pass; 366 tests |
| `@internal/prisma-cloud` typecheck, `vitest --typecheck` | pass; 16 type tests |
| `@internal/prisma-cloud` `bun test --isolate` | 559 pass, 6 fail. All 6 are `initdb` failures (Postgres cannot start: shmget "No space left on device"), in the Postgres integration files. None is in a file this slice touches. |
| Shared-module and example suites named in § 8.1 | pass; 18 tests |
| `pnpm lint:casts` | pass, delta 0 |
| `biome check` on the changed files | clean (infos only) |

Not run: root `pnpm build`, `pnpm lint` and `pnpm test` across every package.

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| Tests 1–5: building a source (values and sources, JSON, spread copy, option checks, `isRuntimeValue`) | **PASS** | `source-value.test.ts` asserts `isValue`/`isSecretSource` together, `Object.keys` is `['payload']`, frozen, exact JSON, the four § 3.3 messages verbatim, and `isRuntimeValue` true/false across the spec's list. |
| Tests 6–7: reading a source throws | **PASS** | Six coercions each produce the exact § 3.4 first form; test 7 Loads a module body with `` `${variable('G')}` `` and asserts the second form. |
| Tests 8–11: sources a service takes stay in place | **PASS** | `toBe` identity on service input and params with no config pool; forwarded slots keep the payload by identity. |
| Tests 12–16: `envParam()` real values | **PASS** | Config pool value reaches the service; `{}` and `{G: ''}` leave the key out (`in` is false); the no-pool and unset-in-`resolve()` messages match exactly. |
| Tests 17–21: pointers in `resolve()` | **PASS** | Returning a received pointer at the root, nested, and chosen by environment all reach the binding by identity; a made-inside source fails with the path; text conversion inside `fn` is wrapped with a `LoadError` cause. |
| Tests 22–26: runtime param sources in a module's input | **PASS** | The schema sees `https://origin.invalid`; a redacted source survives an ArkType morph by identity; a changed sentinel and a raw source fail verbatim; the path error matches (see F03 for its hint). |
| Tests 27–28: props | **PASS** | `envParam()` resolves into props; `envSecret()` in props fails with the § 4.12 text. The `resolve()`-in-props recording case is untested (F01). |
| Tests 29–32: the secret list and forwarded slots | **PASS** | Exact `toEqual` on `secretSources` for both pointers, the module-only case and the dedupe; the forwarded slot used only in `resolve()` Loads and binds the root's source. A secret a service receives through a module's input is untested (F02). |
| Tests 33–40: Prisma Cloud target | **PASS** | Config pool through a module input; exact `envSecret` misuse text; `serviceOrigin()` and redacted `generatedParam()` forwarded through a module serialize to `$generated` pointers with the right `redacted` and `origin`; deploy preflight names `B` under the service and `MAIL_KEY` under the module; dev preflight passes with `B` unset; `sources.test-d.ts` asserts each constructor's exact type and slot fit. |
| Tests 41–44: CLI and lowering | **PASS** | `runPipeline` with the env var set gives `{ greeting: 'probe' }`; both renderers emit `configPool: process.env,` directly after `environment`; the evaluated stack files pass `process.env` itself; `lowering()` forwards `configPool` and the descriptor sees `'probe'`. |
| § 11.3 core type tests | **PASS** | `source-value.test-d.ts` covers every bullet, including the refusals. |
| § 11.6 changed existing tests | **PASS** with one difference | `value`, `resolve-values` and `module-input` tests changed as specified; `control-lowering.test.ts` unchanged (adaptation 4). |
| § 8: every existing app keeps working | **PASS** | Unchanged target suites pass; § 8.1's module suites pass; § 8.4's type tests changed (adaptation 1), because the spec's claim was wrong. QA steps 1 and 2 deploy and serve both examples. |
| Root build, typecheck, lint, lint:casts, test green | **NOT VERIFIED** | Package-level runs above pass, apart from the Postgres environment failures; the full root commands were not run. |
| Manual QA 1–6 | **PASS** | `qa.md` records each step's command and output; step 1's auth smoke ran with the edit later committed in `181dc28c`. |
| § 9 documentation | **PASS** with gaps | Every listed document is updated as specified. Gaps outside the spec's list are in the system design review (A03 to A06). |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 15 | Tests 1–44 in ten groups, § 11.3, § 11.6, § 8, QA, § 9 |
| FAIL | 0 | |
| NOT VERIFIED | 1 | Root build/lint/test |
| WEAK | 0 | |
