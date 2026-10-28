# Code review, round 2: C2, the term is environment

Branch `claude/environment-rename-fdf6ab` (PR prisma/composer#390, head `742caf62`) against `origin/main` (`origin/main...HEAD`). Reviewer lens: principal engineer. Spec: `.drive/projects/public-urls/slices/c2-environment/spec.md`. Decision: ADR-0059. Round 1: `../code-review.md`.

## Summary

The rename itself is in good shape. The git-free name check is correct, no user-facing "stage" is left, and the branch merges cleanly with `origin/main`.

The new version-mismatch check does not work against the real older extension. Both the released extension (0.35.0, identical to `origin/main`) and this branch's extension build the container's `input` by passing the request object through unchanged. So `instance.input.environment` always equals the name core asked for, and the check never fires. With a newer `prisma` CLI and the app's 0.35.0 extension, `prisma deploy --environment staging` still deploys into production, and destroying `staging` still runs `alchemy destroy` on production's state and then deletes the Project. The unit test passes only because its fixture rebuilds `input` in a way the real extension never did (F01).

Second, the reason for not redirecting `deploy list --stage` went stale today. The `prisma` CLI's main branch mounts `deploy list` since 2026-10-27, so its next release will offer `deploy list --stage` (F02).

Local runs: CLI 344 tests, Prisma Cloud target 500, lowering 203, composer-cli 31, `composer-destroy` and `deploy-list-check` scripts 25. All pass. On the PR, Type Check and the deploy-verify-destroy jobs for the default and `orm-demo` examples pass; Test and the `bucket` example were still pending.

## What looks solid

- **The git-free regex is a strict subset of git's rules.** `^[A-Za-z0-9][A-Za-z0-9_-]*$` admits no `.`, `/`, `@`, `{`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, space or control character. So `..`, `@{`, a lone `@`, a trailing `.`, a trailing `/` and a `.lock` suffix are all impossible. `git check-ref-format` has no length limit; I confirmed it accepts `refs/heads/` plus 5000 characters, and `HEAD`, `FETCH_HEAD`, `0`, `a_` and `A_B-`. JavaScript's `$` without the `m` flag does not match before a trailing newline, so `"abc\n"` falls through to git. Tests prove plain names spawn nothing and a name with `/` still runs git.
- **The newer extension refuses an older CLI before any platform call.** `requireEnvironmentName` runs first in `ensureContainer` and `locateContainer`. The test asserts no Project or Branch was created.
- **Merge with main is clean.** `git merge-tree` reports no conflicts. Release `51c834f3` only bumped versions to 0.35.0 in `package.json` files, the lockfile and the skill's `library_version`. Nothing in this branch names a version number that the release made wrong.
- **No user-facing "stage" is left.** Searches over the guides, skills, website source, examples (excluding built `dist`), `README.md`, `gotchas.md`, `.github`, `scripts` and non-ADR design docs find only the upgrade notes, Alchemy's own `--stage`, the redirect itself, a test of the retired flag, and the word "stage" meaning "copy files". In `packages/**/src`, "stage" appears only in Alchemy-side names (`LowerOptions.stage`, state API scopes, `ALCHEMY_STAGE_PATTERN`).
- **The refusal text and report version are fixed properly.** The default-Branch refusal now reads correctly for deploy and destroy. The report test asserts the literal `2`. A new test ties `DEFAULT_DEPLOY_ENVIRONMENT` to the lowering's `PRODUCTION_ENVIRONMENT`, so the two cannot drift.
- **The error registry is updated.** ADR-0044 lists the four new codes and the three retired ones. No retired code is used anywhere in `packages`, the guides or the skill.

## Findings

**F01. The version-mismatch check never fires for the real Prisma Cloud extension, so an older extension still deploys into, and destroys, production.** High.

Location: `packages/0-framework/3-tooling/cli/src/operations/execute-deploy-destroy.ts` lines 289-302 and 464-483; the test at `packages/0-framework/3-tooling/cli/src/operations/__tests__/operations.test.ts` lines 1294-1353; the released extension at `origin/main:packages/1-prisma-cloud/1-extensions/target/src/container.ts` lines 235-236, 267-268 and 343; this branch's extension at `packages/1-prisma-cloud/1-extensions/target/src/container.ts` lines 250-251 and 284-285.

Issue: `requireContainerForEnvironment` compares `instance.input.environment` with the requested name. The released extension builds its instance with `new PrismaCloudContainer(input, …)`, where `input` is the object core passed in. Core passes `{ appName, environment: 'staging' }`, so the instance carries `environment: 'staging'` and the check passes. Meanwhile that extension resolved the container from `input.stage`, which is `undefined`, so it resolved production.

What then happens with a newer CLI and the 0.35.0 extension:

- `prisma deploy --environment staging`: the check passes, `alchemyStage` is the default Branch's id, and the deploy lands on production. The Alchemy child calls the old `deserialize`, which also reads production.
- `destroy({ environment: 'staging' })`: the old `locate` finds production, the check passes, and `alchemy destroy` runs against production's state. The old `remove` sees `input.stage === undefined` and deletes the Project.

The unit test does not catch this because its fixture returns `input: { appName, stage: undefined }`, a shape no released extension produces. The orchestrator's evidence that `pr-1` "passed the mismatch check with the real extension" is consistent with this: the check passes for every extension that passes `input` through. The PR description rejects sending the old `stage` field because this check makes it unnecessary. The guide's upgrade note (`docs/guides/deploying.md` lines 533-535), the skill (line 442), `deploy-cli.md` (lines 162-165), the ADR-0044 registry entry and the spec's "Mismatched versions are refused" bullet all claim a refusal that does not happen.

Same-version installs are never refused by the current check, and the dev and log paths do not call it. So the check is harmless but does not protect anything.

Suggestion: Make the check depend on something an older extension cannot produce. Two target-neutral options:

1. **Round-trip through the extension's own `deserialize`.** In `requireContainerForEnvironment`, compare `extension.container.deserialize(instance.serialize()).input.environment` with the requested name. The released `deserialize` rebuilds `input` as `{ appName, stage }` (lines 138-139), so `environment` comes back `undefined` and the check fires. The new `deserialize` already requires `input.environment`. Core already relies on this round-trip for the Alchemy child, so it adds no new contract. This runs after `ensure`. Under an old extension, `ensure` resolves production and may create the app's Project if none exists. That is an empty Project that a later correct deploy adopts by its `logicalId`. It is not destructive. `locate` creates nothing.
2. **A marker on the container descriptor, checked before `ensure` or `locate`.** For example, a required field saying the descriptor reads `environment`. An older extension lacks it and is refused before any platform call. This is cleaner, but it adds a field to the extension interface.

Either way, change the test fixture to behave like the released extension: pass `input` through unchanged in `ensure` and `locate`, and rebuild `{ appName, stage }` in `deserialize`. Then assert that both deploy and destroy fail with `DEPLOY.CONTAINER_MISMATCH` and that neither Alchemy nor `remove` runs. Then re-run the end-to-end skew case for real: this branch's CLI with `@prisma/composer-prisma-cloud@0.35.0` installed in the app.

**F02. The reason for not redirecting `deploy list --stage` is out of date.** Medium.

Location: `packages/0-framework/3-tooling/cli/src/family/family.ts` line 91; `docs/design/10-domains/deploy-cli.md` lines 75-80; the spec's `--stage` bullet; the PR description; `packages/9-public/composer-cli/test/deploy-list.test.ts` lines 189-197.

Issue: The docs and PR say released hosts do not mount `deploy list`, and that no released host ever offered `deploy list --stage`. The `prisma` CLI repository's main branch now mounts it: commit `155206e`, "Move to Composer 0.35.0 and mount prisma deploy list" (prisma-cli#371, 2026-10-27). That commit is not in a tag yet, so the second claim is true today. The next `prisma` release will ship `deploy list --stage` from Composer 0.35.0. When that release later takes this branch's version, `deploy list --stage` will fail with a generic unknown-flag error that does not name `--environment`.

The redirect would also no longer crash anything that matters. Any host that takes this branch's version is at or after `155206e`, which mounts `deploy list`. That repository's mount test (`packages/cli/tests/composer-mount.test.ts`, `COMPOSER_PATHS`) mounts `deploy list` but still not `deploy`. So it already needs the change the PR describes, and a `deploy list` redirect adds no further breakage.

The test still asserts only a non-zero exit code. Round 1 asked for the actual error code, and that part was not done.

Suggestion: Add `retiredStageFlagRedirect('deploy list')` in composer-cli's family, where `deploy list` is added. Assert `CLI.COMMAND_MOVED` in the test. Update `deploy-cli.md`, the spec, the upgrade notes and the PR description. If you keep it unredirected, at least correct the "released hosts" sentence and pin the unknown-flag code in the test.

## Deferred

| Item | Why deferred |
| --- | --- |
| Round 1 F02: the family's `deploy` redirect forces every host to mount `deploy`. | Accepted. The PR says the `prisma` repository's mount test must add `deploy`. Still true at that repository's `155206e`. |
| Round 1 F06: validation errors name `--environment` for JavaScript callers. | Accepted as a pattern that predates this branch. |
| The `prisma` CLI's `deploy` group text says "list what a stage has deployed" (`packages/cli/src/cli.ts` line 351 in that repository). | Another repository. It should change when that repository takes this release. |
| A newer extension under an older CLI on `prisma dev`. The dev container does not call `requireEnvironmentName`, so the dev stack fails later with "`input.environment` is not a string". | Local only and not destructive. The message is unclear, but dev is out of this slice. |

## Already addressed

| Round 1 finding | Resolution in `401093f2` | Verdict |
| --- | --- | --- |
| F01: an older extension treats every environment as production | Core refuses a container whose `input.environment` differs, with `DEPLOY.CONTAINER_MISMATCH`. The extension refuses a request with no environment. | **Incomplete.** The extension side works. The core side never fires for the real extension (this review's F01). |
| F02: the redirect forces hosts to mount `deploy` | Deferred. The PR tells the `prisma` repository to add `deploy` to its mount test. | Accepted. |
| F03: `deploy list --stage` not redirected | Kept unredirected on purpose, with the reason in the docs. | **Reason now stale, and the test still asserts only the exit code** (this review's F02). |
| F04: a bare deploy needed `git` | Plain names validate without `git`. | Resolved. The regex is a strict subset of git's rules, with tests. |
| F05: the refusal gave deploy advice on destroy | Neutral wording: "Use the environment production for it". | Resolved. |
| F06: errors name the flag for JavaScript callers | Deferred as a pattern that predates this branch. | Accepted. |
| F07: report version not pinned | The test asserts the literal `2`. | Resolved. |
| F08: no upgrade notes | Added to the deploying guide and the skill. | Resolved, but the version-mismatch sentence is wrong until F01 is fixed. |

## Acceptance-criteria verification

### Slice-specific done conditions

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| `prisma deploy --environment staging` works end to end | PASS | Lowering and target container tests for creating and adopting a named Branch. The orchestrator's real deploy landed on the `staging` Branch. |
| `prisma deploy` deploys `production` to the same Branch as before | PASS | `isDefault` lookup, no `branchId`, default Branch id as the Alchemy stage. `default-environment.test.ts` ties the default to `PRODUCTION_ENVIRONMENT`. No `git` is needed now. The real deploy landed on the `isDefault` Branch. |
| `--stage` fails naming `--environment` | PARTIAL | `deploy`: `CLI.COMMAND_MOVED`, tested and seen for real. `deploy list`: unknown flag, and the test asserts only the exit code (F02). |
| `destroy` takes a name and refuses without one | PASS | `destroy.ts` lines 44-45 return `DEPLOY.ENVIRONMENT_REQUIRED` for a missing or empty name; the type makes `environment: string` required. Tests cover `undefined` and `''`. Seen for real. |
| A boundary search for `stage` over user-facing text finds only Alchemy's own API | PASS | See "What looks solid". |
| The examples' CI deploys with `--environment` | PASS | `.github/actions/deploy-verify-destroy/action.yml` passes `--environment` to deploy, `deploy list` and destroy. The examples' `destroy` scripts pass `--environment production`. The website uses `DOCS_ENVIRONMENT`, defaulting to `production`. |

### Chosen-design bullets

| Bullet | Verdict | Evidence |
| --- | --- | --- |
| Core knows only environment names | PASS | `LocateContainerInput` and the preflight and teardown inputs carry `environment: string`. Core has no `production` or `dev` comparison. |
| Defaults are command parameters | PASS | `DEFAULT_DEPLOY_ENVIRONMENT` on `deploy` and `deploy list`, and in the `deploy` operation. `DEV_ENVIRONMENT` in `execute-dev.ts` and `execute-log.ts`. `destroy` has no default. |
| Name validation applies to every environment, with plain names checked without `git` | PASS | `validate-environment.ts`. It runs in deploy, destroy and `deploy list`. Both codes are renamed. |
| `--stage` retired on `deploy` through the redirect table; `deploy list` gets none | PASS as written | The spec's stated reason is stale (F02). |
| Prisma Cloud maps the name, and refuses the default Branch under another name | PASS | `resolveContainer` and `resolveBranch`. The refusal is tested for ensure, locate and `deploy list`. Removing `production` deletes the Project and never the default Branch. |
| Mismatched versions are refused, not misread | **FAIL** | The extension refuses an older CLI (tested). Core does not refuse the real older extension (F01). |
| The default-Branch refusal arrives as `DEPLOY.CONTAINER_FAILED` with a clear message | PASS | `DefaultBranchUnderAnotherNameError` is wrapped by `toStructured('DEPLOY.CONTAINER_FAILED', …)`. |
| The Alchemy stage is the container's, else the name; `SCOPE_MISSING` gone | PASS | `execute-deploy-destroy.ts` line 498. The code is gone from source and the registry. |
| Local dev is out of this slice; dev runs as `dev` | PASS | `execute-dev.ts` lines 188 and 253. `local-dev.md` is updated. |
| Public output | PASS | The report uses `environment` at version 2, pinned. The summary line names the environment. Lease and empty-scope errors name the Branch. |
| This repository's tooling | PASS | `scripts/composer-destroy.ts` requires `--environment`, and its test refuses `--stage`. The examples, `env-param` and the CI action are updated. |

### Pre-investigated edge cases

| Case | Verdict |
| --- | --- |
| `--environment main` names the default Branch | PASS |
| `--environment production` explicitly | PASS. It is the same code path as the default. |
| Container payload across parent and Alchemy child | PASS within one version. Across versions, see F01. |
| Help text says `--environment` | PASS |
