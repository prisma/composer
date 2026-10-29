# C1 code review: values, `resolve()` and the second pass of Load

Branch `claude/resolve-values-ca39d3` against `origin/main`. Spec: [spec.md](../spec.md), plan: [plan.md](../plan.md). Principal-engineer pass; naming and typology belong to the architect pass.

Read for this review: `CLAUDE.md`, `.agents/rules/README.md` and every rule there that touches the diff (no bare casts, type predicates, test imports, `expectTypeOf`, user-facing surface changes, no bundling), the decision records the spec cites with their amendment notes (resources, service input, structured errors, public URLs, `resolve()`), `docs/design/10-domains/core-model.md`, and the whole diff.

Checks run: core `bun test` (305 pass), core `test:types` (27 pass, no type errors), the five touched CLI test files (111 pass, 1 skipped), `@internal/lowering` (204 pass) and `@internal/prisma-cloud` (531 pass), the website content test (9 pass), `pnpm check:skill-packaging`, and root `pnpm typecheck`, `pnpm lint` and `pnpm lint:casts` (cast count unchanged at 20). Root `pnpm build` and the full root `pnpm test` were not run here. Two probes were written under the scratchpad (not in the repo).

## Summary

The slice does what the spec says. The second pass, its error texts, the seal, the resource slots and the environment's path into both Loads are implemented as pinned and tested by assertion, not by title. What remains is three gaps outside the happy path. A `destroy` of a removed environment can be blocked by the author's own `fn`. The Prisma Cloud target does not count a resource as a consumer of a minted value, though core now mints one for it. And the deployed proof that the spec's "Done when" asks for is not recorded.

## What looks solid

- **One plain-data rule everywhere.** `collect`, `checkResult` and `substitute` in `resolve-values.ts` use the same `isPlainObject` and stop at the same three branded kinds. A value inside a class instance is neither found nor substituted, so nothing can be found and then left behind.
- **The resolved resource copy.** `withResolvedProps` builds the copy with `Object.create` and a `props` descriptor, so it works on a frozen node. It keeps the prototype and the brand. `isPostgresResourceNode` is structural (own `config`), so it still matches a copy. No class in the repo built on `ResourceNodeBase` uses `#private` fields.
- **The seal is one flag shared by every nested `flatten`.** The leaked-closure case is tested (test 22). Each Load gets a fresh flag, so a second Load is not affected (test 23).
- **Errors wrap once with a cause.** A thrown `LoadError` passes through untouched. Anything else becomes one `LoadError` carrying the original as `cause`. This is what the structured-errors decision asks for, and it means a user's thrown error is not reported as a Composer bug.
- **The environment reaches both Loads.** `runPipeline` takes it at all three callers, and a missed caller cannot compile because the next parameter shifts an object into `cwd: string`. Both stack-file renderers emit `environment:` right after `name:`, and the evaluated stack files pass it to `lower()` (test 43).
- **Tolerance for a resource built by another copy of core.** An absent `inputs`, `deps` or `props` is read as empty in `dependencySlots`, `boundaryPortsOf` and the resource branch of `provision()`. A forged node proves it.
- **`stage` is gone cleanly.** No code, test or doc passes `stage` in `LowerOptions`. The remaining `stage` uses are Alchemy's own `--stage` flag. `core-model.md` shows `environment` in its place.

## Findings

### F01. `destroy` of an environment the author has removed from `fn` fails, and nothing tells the author how to get out

- **Location:** docs/guides/building-an-app.md lines 680–705; packages/0-framework/3-tooling/cli/src/operations/execute-deploy-destroy.ts lines 417–425
- **Issue:** `destroy` runs `runPipeline`, so it Loads and runs every `fn` for the environment being removed. The guide tells authors to fail rather than pick a default ("Return a result for every environment"). The natural way to retire an environment is to delete its case from the lookup table first, then destroy it. With that order, `fn` throws or returns `undefined` for that name, and `prisma destroy --environment staging` stops at Load. The platform resources stay up. The error names the binding but says nothing about destroy. The guide says destroy runs every `fn`, but not what that means for retiring an environment.
- **Suggestion:** Add one sentence to the guide section and one to the skill: "To retire an environment, keep its case in every `fn` until `prisma destroy` for it has finished." Whether `destroy` should need resolved values at all is a design question; it is listed under Deferred.

### F02. Core mints a value for a resource's slot, but the Prisma Cloud target never hands it to the provider

- **Location:** packages/0-framework/1-core/core/src/control/deploy.ts lines 691–735; packages/1-prisma-cloud/1-extensions/target/src/provisioned-edges.ts lines 34–41; packages/1-prisma-cloud/1-extensions/target/src/descriptors/compute.ts lines 338–349
- **Issue:** The minting loop in `lowering()` now accepts a consumer of kind `resource`, so a resource slot whose connection carries a provisioned param gets a minted value (for example, an RPC key). The provider learns which minted values to accept through `provisionedEdges(graph)`, and that function still skips any consumer that is not a service. The two scans now disagree. The first resource with a provisioned slot would get a key that its producer never accepts, and the failure would show at runtime as an authentication error, far from the cause. Nothing ships such a resource in this slice, so this is latent. P1's public URL is the first resource with a slot.
- **Suggestion:** Make `provisionedEdges` accept `consumer.kind === 'resource'` the same way, and add a test in the target that a resource consumer's edge is listed. If the target is held out of scope for C1, record the disagreement in `.drive/deferred.md` against P1, so it is fixed before any resource slot carries a provisioned param.

```ts
if (consumer === undefined || (consumer.kind !== 'service' && consumer.kind !== 'resource')) continue;
```

### F03. The minting loop's change for a resource consumer has no test

- **Location:** packages/0-framework/1-core/core/src/control/deploy.ts lines 696–700; packages/0-framework/1-core/core/src/__tests__/lowering.test.ts lines 602–706
- **Issue:** Spec § 6.5 requires that "a `provision` need on a resource slot is minted". Test 39 drives a resource slot through `connectionInputs`, but its connection has no provisioned param, so `ctx.provisioned` is empty and the new branch is never taken. Reverting the condition to `consumer.kind !== 'service'` leaves every test green.
- **Suggestion:** Add a `lowering.test.ts` case: a resource with a slot whose connection declares a `provision` need on the same extension, a fake provisioner, and an assertion that `connectionInputs` returns the minted value under `<resource address>.<slot>`.

### F04. The spec's deployed proof and its two failure cases are not recorded

- **Location:** .drive/projects/public-urls/slices/c1-resolve/ (no `qa.md`); spec.md lines 627–632
- **Issue:** The spec's "Done when" asks for a `qa.md` recording three things: the local `prisma dev` proof for two environments, a `prisma deploy` to production and to a second environment checked with `pnpm smoke:deployed`, and a scratch copy whose `provision`-inside-`fn` and `undefined`-returning `fn` each fail `prisma deploy` before any platform call. The spec's own notes (§ 14) say the local proof passed. The deployed proof and the two CLI failure runs are not recorded anywhere. Unit tests 13 and 20 prove the messages at Load, but not that the CLI stops before it reaches the platform.
- **Suggestion:** Run plan step D5 and write `qa.md` with the commands and their output: both `curl` results, both smoke runs, and the two failing `prisma deploy` runs with their messages.

### F05. A Load that fails before sealing leaves its `provision` open for good

- **Location:** packages/0-framework/1-core/core/src/load-module.ts lines 866–887
- **Issue:** `loading.sealed = true` runs only when the first pass, `validateWiring` and `assertDependencyDag` all succeed. If any of them throws, that Load's `provision` closures stay unsealed. A probe confirmed the effect. A module body stored its `provision` in an outer variable, and its Load failed on an unwired dependency. A later Load's `fn` then called the stored `provision`. It raised no error: the node went into the dead Load's arrays, and the new graph silently lacked it. A `prisma dev` rebuild after a wiring error is the realistic way to get here. It needs a closure leak, so it is rare, but the fix is one line, and the seal exists to turn exactly this misuse into an error.
- **Suggestion:** Seal in a `finally` around the first pass, so any exit seals:

```ts
try {
  flatten(root, /* … */, loading);
  for (const entry of pending) validateWiring(entry, byId);
  assertDependencyDag(edges);
} finally {
  loading.sealed = true;
}
```

  Add a test beside test 22: the first Load fails on an unwired dependency, and a second Load's `fn` calls the leaked `provision` and gets the sealed message.

### F06. Three of the five binding-site texts have no assertion

- **Location:** packages/0-framework/1-core/core/src/resolve-values.ts lines 24–37; packages/0-framework/1-core/core/src/__tests__/resolve-values.test.ts
- **Issue:** Every error in the second pass names its binding through `describeSite`. The tests assert only `input key "…" of service "…"`. The texts for a param (`param "port" of service …`), a resource prop (`prop "hosts.0" of resource …`), the whole props, and the root of an input binding are never asserted. A probe shows they render correctly today. P1's errors will all come through the props texts, and nothing pins them.
- **Suggestion:** Add one test with three cases: a param whose `fn` returns `undefined`, a resource whose `props` hold `[value]` loaded without an environment (expect `prop "hosts.0" of resource "shop.site" depends on environment.name, …`), and a value bound as the whole input binding.

### F07. The smoke script fails at once on an old revision instead of waiting for the new one

- **Location:** examples/env-param/scripts/smoke.ts lines 100–118
- **Issue:** The loop polls until the greeting matches, then checks `environment` once and exits 1 on a mismatch. On the first deploy of this change over an older deployment with the same greeting, the old revision may still be serving. It matches the greeting and has no `environment` field, so the smoke run fails on a rollout race instead of polling until the deadline. The spec pinned this placement, so the code follows the spec; the risk is a false failure in D5's QA.
- **Suggestion:** Treat a mismatched `environment` like a mismatched greeting: keep polling, and print the FAIL line only when the deadline passes. If the deploy command is known to return only once the new revision serves traffic, say so in the script's header and leave the code as it is.

## Deferred (out of scope)

| Item | Why it is out of scope |
| --- | --- |
| An older CLI loading an app built with this `@prisma/composer`. The CLI bundles its own core, so an older CLI builds a module context with no `environment`. A body that reads `environment.name` then throws a plain `TypeError`, which the CLI reports as a Composer bug. | Spec § 10 puts this with the extension-compatibility check (`DEPS.EXTENSION_INCOMPATIBLE`). The other direction works: a newer CLI with an older app core is tolerated and tested. |
| Whether `destroy` should run `resolve()` functions at all. | A design change to Load or to `destroy`. F01 covers the cheap documentation fix that fits this slice. |
| `connectionInputs` reads `node.inputs` without the absent-means-empty tolerance that `dependencySlots` has. | It is only reachable from a descriptor for its own node type, which no older extension copy ships yet. Worth folding into P1's first resource descriptor. |
| A cyclic plain object inside a binding keeps the original object, with its value, on the back-reference after substitution. | Such a binding cannot be serialized for a deploy anyway, and the input-document step rejects it later. |

## Already addressed

Findings from the earlier review of the spec ([reviews/design/code-review.md](design/code-review.md)), checked against the code that landed.

| Earlier finding | Status in code | Commit |
| --- | --- | --- |
| F01: the resolved resource copy threw on a frozen node | `withResolvedProps` passes `props` as a descriptor to `Object.create`; test 36 covers it | 4b3cb003 |
| F02: an error thrown by `fn` reached the user as a Composer bug | `LoadError` takes a `cause`; `fn`'s error is wrapped once; test 17 | 8c168c2f |
| F03: the seal could not reach nested modules | one `loading` flag passed through every `flatten`; tests 21 and 22 | 8c168c2f |
| F04: a value inside a non-plain object was found but not substituted | one `isPlainObject` predicate for the walk and the substitution; test 7 | 8c168c2f, 77b45ba6 |
| F05: the check on `fn`'s result was too narrow | `checkResult` covers Promise, `undefined`, value, source and non-plain data at any depth; tests 13 to 16 | 8c168c2f |
| F07: a required `LowerOptions.environment` broke the public escape hatch | optional, never defaulted | d666545f |
| F08: the `provision()` id check could never fire | runs before the `typeof id` check; test 24 | 8c168c2f |
| F09: the resource factory and base class did not compile as pinned | three pinned casts, shared `requireResourceWiring` | 77b45ba6 |
| F11: a failing dependency's `fn` was reported as the bound value's | `fnLabelFor` uses the depth of `visiting`; test 18 | 8c168c2f |
| F12: a resource slot's connection contract was never checked | `connectionInputs` shared with `buildConfig`; test 40 | a6244546 |
| F13: types a pack needs were not exported | `DepBindings`, `ResourceProp`, `ResourceProps`, `LoadOptions` and the value types are in the barrel | 8c168c2f, 77b45ba6 |

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: § 11.1 tests 1 to 3, the value type and `resolve()` | **PASS** | `value.test.ts` checks that the value, its origin and the dependency tuple are frozen, and that the tuple is a copy (mutated after the call, still equal to the original). It checks all three construction errors by exact `Error` text, and `isValue` true for `environment.name` and a `resolve()` result, false for a plain object, `null` and a secret source. |
| AC2: § 11.2 tests 4 to 27, Load's second pass | **PASS** | Each listed test exists and asserts the result or the exact message the spec gives. Substitution: input, param, nested objects and arrays, the same class instance left untouched (`toBe`), and a binding with no value returned by reference (`toBe`). Single run: counter is 1. Two levels: `HELLO FROM STAGING`. The no-environment, `undefined` (top and nested ` at "a"`), value (top and ` at "hosts.0"`), Promise, source, function and `Date` messages are exact. The cause is the thrown instance. The dependency label uses `startsWith`, as the spec says. The forged cycle, the seal (root, nested, leaked closure) and the double Load are covered. The id, deps, secrets and params rejections have exact texts. The param and props site texts are not asserted (F06). |
| AC3: § 11.3 tests 28 to 37, resource slots | **PASS** | Asserts the slot node's kind, both edges by value and topological order (28); the `in` port with `contractKind: 'fake/http'` and the `$out` port (29); the authored edge (30); the module-forwarded edge, where Load would throw if the input were not marked used (31); the three construction errors by text (32); the new `provision(resource, { deps })` text (33); the contract mismatch through `validateWiring` (34); and the cycle by regex over both orders (35). Test 36 checks `instanceof SiteNode`, the resolved `props.url`, `describe()`, `isNode`, that the copy is not the authored node, and that the authored node still holds the value. Test 37 uses `toBe`. A forged node from another copy of core is covered too. |
| AC4: § 11.4 tests 38 to 40, lowering | **PASS** | 38: `serialize` receives `config.service.label === 'test'`. 39: the resource descriptor sees `url: 'https://test.shop.example'` and `connectionInputs` returns `{ target: { url: 'https://hello.web.example' } }`. 40: the exact "did not supply it" `LowerError`. The minting loop's new resource branch (§ 6.5) is not reached by any test (F03). |
| AC5: § 11.5 type tests | **PASS** | `value.test-d.ts` covers every listed item: tuple types for one and two dependencies, `@ts-expect-error` on a second member, `Value<number>` from `resolve([], …)`, variance both ways, no readable `origin`, the `InputBinding` cases including `Value<Date>` and `Value<SecretSource>`, the param cases, `provision()`'s id, the three `resource()` cases and `ModuleContext['environment']['name']`. `vitest --typecheck` reports no type errors, and CI runs `test:types`. |
| AC6: § 11.6 tests 41 to 45, CLI | **PASS** | 41: the deploy stack contains `environment: "staging"` and no `stage:`. 42: the dev stack contains `  name: "app",\n  environment: "test",\n`, which also pins the position. 43: both evaluated stack files hand `environment: 'staging'` to a stubbed `lower()`. 44: `runPipeline` with the real Load returns `{ environment: 'deployed to staging' }`. 45: `destroy` with environment `staging` runs `fn` with `staging` (recorded through a global). The deploy side of `runStackPipelineInner` shares the call that test 45 covers. |
| AC7: § 11.7 test 46, the smoke script | **PASS** | `smoke.ts` checks `body.environment === "deployed to <environment>"` inside the greeting branch and exits 1 with the pinned FAIL text. It has not been run against a deploy (AC9). Its placement can fail on a rollout race (F07). |
| AC8: § 12, tests 1 to 46 and the root checks green | **PASS** | All the suites listed under "Checks run" are green, as are root `pnpm typecheck`, `pnpm lint` and `pnpm lint:casts`. |
| AC9: § 12, root `pnpm build` and the full root `pnpm test` | **NOT VERIFIED** | Not run in this review; the integration suite needs a database. The packages the diff touches pass on their own. |
| AC10: § 12, the local dev proof for two environments and the deploy proof for two environments, in `qa.md` | **NOT VERIFIED** | No `qa.md` exists. The spec's § 14 says the local proof printed `deployed to dev` and `deployed to test`, but the output is not recorded. The deploys to production and a second environment, with `pnpm smoke:deployed`, are not recorded (F04). |
| AC11: § 12, a scratch copy fails `prisma deploy` before any platform call for `provision` inside `fn` and for `undefined` | **NOT VERIFIED** | The messages are proven at Load by tests 13 and 20. No CLI run is recorded (F04). |
| AC12: § 12, every § 9 document updated, and the `ResolvedValue` check finds nothing | **PASS** | The `grep` over `docs/guides`, `docs/design/03-domain-model`, `docs/design/10-domains`, `skills` and `.drive/projects/public-urls/design` finds nothing. Each § 9 item was spot-checked: the amendment notes and index lines for the resource, scheduled-work, public-URL and `resolve()` decisions; the glossary's Value, Resource, Ingress / Egress, Load / Hydrate and Environment entries; `core-model.md`'s factory, Load paragraph and `LowerOptions`; `module-composition.md`; the new guide section and the pointer from `deploying.md`; the skill subsection; and both `.drive/deferred.md` entries. The website content test and `check:skill-packaging` pass. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 9 | AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC12 |
| FAIL | 0 | |
| NOT VERIFIED | 3 | AC9, AC10, AC11 |
| WEAK | 0 | |
