# Code review: C2, the term is environment

Branch `claude/environment-rename-fdf6ab` against `main` (`main...HEAD`). Reviewer lens: principal engineer (failure modes, blast radius, operability). Spec: `.drive/projects/public-urls/slices/c2-environment/spec.md`. Decision: ADR-0059.

## Summary

The rename is thorough and the production path is preserved. A bare `prisma deploy` still resolves the default Branch by `isDefault`, sends resources and the Build without a branch reference, and runs Alchemy under the default Branch's id, so existing deploy state is found. Destroying `production` still removes the Project and never the default Branch. `destroy` refuses a missing or empty name for JavaScript callers too. The default-Branch refusal covers deploy, destroy and `deploy list`. Key package tests pass locally (CLI family and operations 221, composer-cli 30, target container and preflight 80, lowering container 36).

The biggest risk is not in the code paths the tests cover. It is version skew between the `prisma` host and the app's installed `@prisma/composer-prisma-cloud`. The container input changed shape, and an older extension reading a newer host's input treats every environment as production. That can deploy `staging` into production, and destroy production when asked to destroy `staging` (F01). Second, the engine's redirect rule now forces every host to mount `deploy`, which breaks the `prisma` repository's own mount test on upgrade and is why `deploy list --stage` is not redirected, contrary to the spec and to `deploy-cli.md` (F02, F03). Third, a bare `prisma deploy` now needs `git` on PATH, which it did not before (F04).

## What looks solid

- The production mapping is one function, `isProductionEnvironment`, used both where the container is resolved and where it is removed. Resolution and removal cannot disagree.
- `resolveBranch` checks `isDefault` on the found Branch before returning it, for both `ensure` and find-only. One check covers deploy, destroy and `deploy list`. Tests cover `ensure: true` and `false` in lowering, `ensure` and `locate` in the target, and the `deploy list` command.
- `DEPLOY.SCOPE_MISSING` is gone because a name always exists. The Alchemy stage falls back to the environment name, which removes a whole failure branch.
- `deserialize` now requires `input.environment` as a string. A payload without it fails loudly instead of being read as production. Round-trip tests cover production, a named environment, the dev shape and malformed payloads.
- `destroyWithDeps` checks the name before importing the executor, so the refusal costs nothing and cannot be skipped by a load failure. The test passes `undefined` and `''` through a cast, which is what a JavaScript caller does.
- Lease and empty-scope messages name the Branch id as a Branch, matching the spec's rule for errors that only know the Alchemy stage.
- The CI action threads one `environment` input through deploy, both verifications and destroy, with `production` as the default.

## Findings

**F01. An older Prisma Cloud extension under a newer `prisma` host treats every environment as production.** High.
Location: `packages/0-framework/1-core/core/src/container-transport.ts` lines 12-18; `packages/1-prisma-cloud/1-extensions/target/src/container.ts` lines 206-275 and 343-352.
Issue: `LocateContainerInput` changed from `{ appName, stage }` to `{ appName, environment }`. The CLI that builds this input ships inside the `prisma` host, which pins `@prisma/composer-cli` exactly. The extension that reads it is the app's own `@prisma/composer-prisma-cloud`, installed separately (getting-started installs `prisma` and `@prisma/composer-prisma-cloud` as two packages). With a newer host and an older extension, the old `ensureContainer` sees `input.stage === undefined` and resolves the default Branch. So `prisma deploy --environment staging` deploys into production. For destroy it is worse: the old `locate` finds production, `alchemy destroy` runs against production's state, and the old `remove` sees `stage === undefined` and deletes the Project. The reverse skew (older host, newer extension) passes `{ stage }`, so `input.environment` is `undefined`; `isProductionEnvironment(undefined)` is false and `resolveBranch` queries `gitName: undefined`. I found no check in this repository that refuses a mismatched host and extension pair.
Suggestion: Two cheap guards. In the extension's `ensure` and `locate`, reject an input whose `environment` is not a non-empty string, as `deserialize` already does. That covers the older-host case. For the newer-host case, nothing in the new extension can help, so the host must either refuse a mismatched extension (compare the extension package's version with its own before calling `ensure`/`locate`) or also send the old `stage` field for one release (`undefined` for `production`, the name otherwise). The old field is wire compatibility, not a user-facing alias, so it does not contradict the spec's "no alias". Add a test that an input without `environment` is refused by `ensure` and `locate`.

**F02. The `--stage` redirect forces every host to mount `deploy`.** Medium.
Location: `packages/0-framework/3-tooling/cli/src/family/family.ts` lines 69-91.
Issue: The engine throws at construction when a flag redirect names a command the host did not mount. `createComposerFamily` always adds the `deploy` redirect, so any host that mounts only part of the family fails to start. This branch already had to add `deploy` mounts to `dev-current-commands.test.ts`, `emulator-list.test.ts`, `deploy-list.test.ts` and `scripts/e2e-verify-deploy-list.ts` for that reason. The `prisma` repository's `packages/cli/tests/composer-mount.test.ts` (checked in `wip/prisma-cli`, lines 74-90) mounts only `dev`, `dev url`, `dev stop` and `emulator list`, so it will throw once that repository takes this release. The real `prisma` bin mounts `deploy`, so the shipped CLI is fine.
Suggestion: Land a matching change in the `prisma` repository's mount test with the version bump, and say so in the PR description. Longer term, either let the host opt into the family's redirects, or ask the engine to skip a flag redirect whose command is not mounted instead of throwing. That second change would also unblock F03.

**F03. `deploy list --stage` is not redirected, but the spec and the design doc say it is.** Medium.
Location: `packages/9-public/composer-cli/src/exports/family.ts` lines 41-50; `docs/design/10-domains/deploy-cli.md` lines 75-77; `packages/9-public/composer-cli/test/deploy-list.test.ts` lines 189-197.
Issue: The spec's chosen design retires `--stage` "on `deploy` and `deploy list`". The code redirects only `deploy`, deliberately, because the installed `prisma` host does not mount `deploy list` yet and a redirect for it would throw (F02). Typing `prisma deploy list --stage x` therefore fails with the engine's generic unknown-flag error, which does not name `--environment`. `deploy-cli.md` states that both commands fail with `CLI.COMMAND_MOVED`, which is false today. The test for this case asserts only a non-zero exit code, so it cannot tell a redirect from any other failure.
Suggestion: Make the docs say what the code does: `deploy` redirects; `deploy list` will once the host mounts it. Record the deviation in the spec. Assert the actual error code in the test, so that adding the redirect later turns it into a deliberate change.

**F04. A bare `prisma deploy` and `prisma deploy list` now need `git` on PATH.** Medium.
Location: `packages/0-framework/3-tooling/cli/src/operations/execute-deploy-destroy.ts` lines 354-362; `packages/0-framework/3-tooling/cli/src/validate-environment.ts` lines 5-21; `packages/9-public/composer-cli/src/family/list-deployed.ts` line 41.
Issue: Before, validation ran only when `--stage` was given, so a production deploy never spawned `git`. Now it always validates, so a CI image without `git` (common in slim Node images) fails a bare deploy with `DEPLOY.ENVIRONMENT_UNVALIDATABLE`. Elsewhere the deploy treats `git` as optional (`builds/run-identity.ts` lines 33-46 swallow a missing binary). The spec asks for validation of defaults too, but validating the constant `production` buys nothing.
Suggestion: Either skip the spawn for a name equal to the command's default (it is a constant known to pass), or keep the rule and state in the deploying guide that `git` is required. If the first, amend the spec bullet. Add a test either way: a deploy with no `git` on PATH and no `--environment`.

**F05. The default-Branch refusal gives deploy advice on destroy, and has no code of its own.** Low.
Location: `packages/1-prisma-cloud/0-lowering/lowering/src/container.ts` lines 45-58; `packages/1-prisma-cloud/1-extensions/target/src/container.ts` line 264.
Issue: The message says "Deploy it with --environment production (or no --environment)". On destroy, the caller is a script passing `environment: 'main'`, and the right fix is `environment: 'production'`. The message also starts in lower case after the `DEPLOY.CONTAINER_FAILED` prefix. A script or agent cannot tell this refusal from a Management API failure, because both are `DEPLOY.CONTAINER_FAILED`.
Suggestion: Word the fix by operation, or neutrally ("production is the environment `production`"). Consider a dedicated structured code so automation can branch on it.

**F06. Validation errors name the `--environment` flag for JavaScript callers.** Low.
Location: `packages/0-framework/3-tooling/cli/src/validate-environment.ts` lines 13 and 19.
Issue: `deploy({ environment: 'bad..ref' })` and `destroy({ environment: 'bad..ref' })` report "Invalid --environment". Neither caller typed a flag. The old message had the same flaw for `--stage`.
Suggestion: Say "environment name" in the message; the CLI context already shows which flag was used.

**F07. No test pins the report format version at 2.** Low.
Location: `packages/0-framework/3-tooling/cli/src/__tests__/run-report.test.ts` lines 38-48; `packages/0-framework/3-tooling/cli/src/operations/__tests__/operations.test.ts` line 2769.
Issue: Both tests compare against `RUN_REPORT_VERSION` itself. Reverting the bump to 1 keeps them green, so the test does not protect the contract that consumers read.
Suggestion: Assert the literal `2` once, next to the `environment` field assertion.

**F08. Users get no written migration note.** Low.
Location: `docs/guides/deploying.md`; `skills/prisma-composer-core-concepts/SKILL.md`.
Issue: The guide and skill now describe `--environment` correctly but never say that `--stage` was renamed, that `destroy({ target })` became `destroy({ environment })`, or that the `--report` file's `stage` field became `environment` at version 2. CLI users get the redirect message, but a report consumer silently reads `undefined` and a script calling `destroy` gets a type error with no pointer. The rule in `.agents/rules/user-facing-surface-changes.mdc` asks for the consequence a user hits to be written down.
Suggestion: Add a short "Upgrading" note to the deploying guide covering the three changes, and mirror one line in the skill.

## Deferred

| Item | Why deferred |
| --- | --- |
| Callers of `--stage` in other repositories, such as a GitHub action that deploys every pushed branch | Out of this repository's scope. Not verified. Worth a search before release. |
| Documenting the `--report` file format in the guides | The format was undocumented before this branch. Only the change note belongs here (F08). |

## Already addressed

| Item | Where |
| --- | --- |
| | |

## Acceptance-criteria verification

### Slice-specific done conditions

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| `prisma deploy --environment staging` works end to end | PASS | `operations.test.ts` locate and ensure tests; lowering `container.test.ts` named-environment create and adopt; orchestrator's real deploy to the Branch with gitName `staging`. |
| `prisma deploy` deploys `production` to the same Branch as before | PASS | `resolveContainer` reads `defaultBranchId` via `resolveDefaultBranchId` (`isDefault`, line 190) and omits `branchId`; `PrismaCloudContainer.alchemyStage` falls back to `defaultBranchId`; reporter sends `branchId: undefined` to the Build; tests in lowering `container.test.ts`, target `container.test.ts` round-trip, `build-reporter.test.ts`; orchestrator's real deploy landed on the `isDefault` Branch. Caveat: now needs `git` (F04). |
| `--stage` fails naming `--environment` | WEAK | `deploy`: PASS, `deploy.test.ts` lines 156-167 assert `CLI.COMMAND_MOVED` and the summary. `deploy list`: FAIL, generic unknown-flag error; test asserts only non-zero exit (F03). |
| `destroy` takes a name and refuses without one | PASS | `destroy.ts` lines 44-46; `operations.test.ts` lines 1239-1263 for `undefined` and `''`; `composer-destroy.test.ts`; orchestrator's real refusals. |
| Boundary search for `stage` over user-facing text finds only Alchemy's own API | PASS | My boundary grep over `docs/guides`, `skills`, `website`, `examples`, `README.md`, `gotchas.md` found nothing. In `packages/**/src`, `scripts`, `.github` only Alchemy's `--stage` and the redirect's own comment remain. |
| The examples' CI deploys with `--environment` | PASS | `.github/actions/deploy-verify-destroy/action.yml` passes `--environment` to deploy, `deploy list` (via `ENVIRONMENT`), identity check and destroy. |

### Chosen design bullets

| Bullet | Verdict | Evidence |
| --- | --- | --- |
| Core knows only environment names | PASS | `container-transport.ts`, `app-config.ts` carry `environment: string`; no `production` or `dev` literal in core source. |
| Defaults are command parameters | PASS | `DEFAULT_DEPLOY_ENVIRONMENT` on `deploy` and `deploy list` flags and in `executeDeploy`; `DEV_ENVIRONMENT` in dev and log; `destroy` has no default. Test at `operations.test.ts` line 1581 for dev. |
| Name validation applies to every environment | PASS | Always called in deploy, destroy, `deploy list`. Codes `DEPLOY.ENVIRONMENT_INVALID` and `DEPLOY.ENVIRONMENT_UNVALIDATABLE`. See F04 for the cost. |
| `--stage` retired through the redirect table on `deploy` and `deploy list` | FAIL | `deploy` only (F02, F03). |
| Prisma Cloud maps the name, including the default-Branch refusal | PASS | `resolveContainer` and `resolveBranch`; refusal tested for ensure, locate and `deploy list`; `remove` keyed on `isProductionEnvironment`, test at target `container.test.ts` line 519 shows production removes the Project and no Branch. |
| Alchemy stage is the container's, else the name; `SCOPE_MISSING` gone | PASS | `execute-deploy-destroy.ts` line 478; test at `operations.test.ts` line 503. |
| Local dev out of slice; local-dev doc updated | PASS | `local-dev.md` and `running-locally.md` say dev runs as `dev`. |
| Public output | PASS | Report field `environment`, version 2 (test is WEAK, F07); summary line names the environment; lease and empty-scope errors name the Branch. |
| This repository's tooling | PASS | `composer-destroy.ts` requires `--environment`; examples pass `--environment production`; `env-param` uses `ENV_PARAM_ENVIRONMENT` and `destroy:environment`; CI action takes `environment`. |

### Pre-investigated edge cases

| Case | Verdict |
| --- | --- |
| `--environment main` names the default Branch | PASS (wording, F05) |
| `--environment production` explicitly | PASS, same code path as the default |
| Container payload across the parent and Alchemy child | PASS within one install; FAIL across a host and extension version skew (F01) |
| Help examples and `--help` text say `--environment` | PASS |
