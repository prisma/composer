# PR 390 system-design review, round 2: the term is environment

Branch `claude/environment-rename-fdf6ab`, range `origin/main...HEAD`, with attention to commit 401093f2. Reviewer: architect.

Read before reviewing: `CLAUDE.md`; both files in `docs/design/01-principles/`; ADR-0059, ADR-0044, ADR-0038, ADR-0043, ADR-0050 and ADR-0053 in full, and the head of ADR-0024; the glossary entry "Environment (formerly Stage)"; the C2 spec; the PR description; the round 1 review. I also read the released extension's container code at tag `v0.35.0`, and the ADR-0024 and ADR-0050 amendments in prisma/composer#386.

## Verdict

The rename is coherent, and the round 1 fixes landed well. One thing is wrong in the new commit: the version-mismatch check cannot detect the extension it was written for. With today's released `@prisma/composer-prisma-cloud` 0.35.0, `destroy({ environment: 'staging' })` would pass the check and destroy production. That needs fixing before merge. The rest is small.

## Findings

### S01. The mismatch check passes for the released extension, so it does not stop the case it exists for

- **Location:** `requireContainerForEnvironment` in `packages/0-framework/3-tooling/cli/src/operations/execute-deploy-destroy.ts`; its test in `cli/src/operations/__tests__/operations.test.ts`; the claims in `docs/design/10-domains/deploy-cli.md` step 6, ADR-0044's `CONTAINER_MISMATCH` line, `docs/guides/deploying.md`, the skill, the spec and the PR description.
- **Issue:** Core checks that `instance.input.environment` equals the name it asked for. The released extension (`v0.35.0`, `target/src/container.ts`, `ensureContainer` and `locateContainer`) builds its container with `new PrismaCloudContainer(input, …)`. It stores the input object it was given, unchanged. So when this CLI sends `{ appName, environment: 'staging' }`, the old extension:
  1. reads `input.stage`, finds `undefined`, and resolves the default Branch, which is production;
  2. returns a container whose `input` is the same object, so `input.environment === 'staging'`;
  3. passes core's check.

  Alchemy then runs with production's Branch id as its stage. For `deploy`, `staging` deploys into production. For `destroy`, `alchemy destroy` tears down production's resources. The old extension's preflight also reads `input.stage`, so its secret checks use the production scope.

  The test passes only because its fake extension builds a new `input` without `environment`. No real extension does that. The check compares a value the extension echoes back, which proves nothing about whether the extension used it.

  Smaller point: on `deploy`, the check runs after `ensure`, so an old extension may already have created a Project before the refusal. "Before anything is deployed" is true; "before anything is created" is not.
- **Suggestion:** Detect the version directly, not from the container's shape. Core cannot do it from the container: an old extension's `alchemyStage` for `staging` is the default Branch id, and only Prisma Cloud knows that means production. A target-neutral way:
  - Add a required field to `ExtensionDescriptor` that names the extension interface revision it implements, for example `composerInterface: 2`. Core checks it once, after loading the config and before calling any hook (container, preflight, reporter, teardown). An extension without the field, or with another number, is refused.
  - This covers every hook whose input changed from `stage` to `environment`, not only containers. It is target-agnostic: core compares a number it owns.
  - It changes `ExtensionDescriptor`, so ADR-0038 needs an amendment line, and the docs listed above need the new wording.
  - Replace the test's fake with one that behaves like `v0.35.0`: it echoes `input` and ignores `environment`. The test should fail on the current code.

  If Will prefers not to add a field now, the minimum is to stop claiming protection: remove the check and the docs' claim, and say in the upgrade notes that an older extension reads every environment as production. Keeping a check that passes in the dangerous case is worse than having none.

### S02. `CONTAINER_MISMATCH` names the symptom, and sits in the wrong namespace

- **Location:** ADR-0044's `DEPLOY` registry; `execute-deploy-destroy.ts`.
- **Issue:** The failure is "the installed extension is a different Composer version from the code running it". Read cold, `DEPLOY.CONTAINER_MISMATCH` says "the container differs from the one expected", which describes how the check detects it, not what is wrong. ADR-0044 assigns `DEPS` to "the consumer's installed dependency tree", and a version mismatch between the app's installed extension and the CLI is exactly that.
- **Suggestion:** With the fix in S01, raise `DEPS.EXTENSION_INCOMPATIBLE` (or `DEPS.EXTENSION_VERSION_MISMATCH`) and retire `CONTAINER_MISMATCH` before it ships. Name the extension, the revision it implements and the revision core expects in `meta`.

### S03. New host-neutral messages name the `prisma` CLI

- **Location:** `requireContainerForEnvironment` in core ("older than the prisma CLI's Composer", "as the prisma CLI uses"); `requireEnvironmentName` in `packages/1-prisma-cloud/1-extensions/target/src/container.ts` ("The prisma CLI is probably older than this extension").
- **Issue:** Both are raised from `@prisma/composer/control` operations, which ADR-0043 makes host-neutral. A `destroy` script is a host too, and there the Composer in use is the app's own `@prisma/composer`, not the `prisma` CLI's. The message then points the user at the wrong package. This is new text from 401093f2, so it is not the deferred round 1 S12, though it is the same pattern.
- **Suggestion:** Say "this Composer" and give the versions when known: "`@prisma/composer-prisma-cloud` implements interface 1; this Composer expects 2." Leave "upgrade the `prisma` CLI" to the CLI's own rendering, if at all.

### S04. One naming rule now has three copies, and it disagrees with the git-ref rule

- **Location:** `PLAIN_ENVIRONMENT_NAME` in `cli/src/validate-environment.ts`; `APP_NAME` in `packages/0-framework/1-core/core/src/graph.ts`; `ALCHEMY_STAGE_PATTERN` in the Prisma Cloud extension's `container.ts`.
- **Issue:** All three accept exactly the same set: letters, digits, `-` and `_`, starting with a letter or digit (the Alchemy one is case-insensitive, which is the same set). The new fast path is correct: every such name is a valid git ref. But it shows a gap in the model. An environment name is valid if it passes `git check-ref-format`, and core uses the name as the Alchemy stage when no container pins one. A git-valid name such as `feat/x` or `v1.2` passes validation, then fails Alchemy's stage pattern on any target without a container. Prisma Cloud hides this only because its Alchemy stage is a Branch id. This existed before for named stages, but the branch now states "the Alchemy stage is … else the environment name" as a general rule.
- **Suggestion:** Two steps, the second only if Will agrees.
  1. Export one named rule from core, such as `isPlainName`, and use it for the app name and the fast path. The Alchemy pattern can stay separate; it is the engine's rule.
  2. Consider making an environment name a plain name, full stop. That removes `git` from validation and `DEPLOY.ENVIRONMENT_UNVALIDATABLE`, and makes the Alchemy fallback always valid. It reverses ADR-0038's "must pass `git check-ref-format`" and `deploy-cli.md`'s contract, so it needs a decision record. It also means names like `feat/x` stop working on Prisma Cloud. Not for this PR.

### S05. Two older records stay wrong until #386 merges

- **Location:** ADR-0024 and ADR-0050 on this branch; the spec's scope line; the PR description's "#386 amends the others".
- **Issue:** This PR amends ADR-0038, ADR-0043, ADR-0044 and ADR-0053, and leaves ADR-0024 and ADR-0050 to #386. If #390 merges first, `main` has ADR-0050 saying `prisma deploy --stage` and `destroy({ target })` with no pointer to the change. Also, #386's ADR-0050 amendment does not address round 1's point that one of ADR-0050's two reasons for having no `destroy` command ("it would need a production flag that no other Composer command has") no longer holds.
- **Suggestion:** Merge #386 first, or add the two one-line amendment notes here and let #386 extend them. In #386, add one sentence: the decision stands on its other reason, that the CLI's destructive verb is `delete`.

### S06. Local dev skips the container check; C3 will need it

- **Location:** `cli/src/operations/execute-dev.ts`; `.drive/projects/public-urls/slices/c3-local-environments/spec.md`.
- **Issue:** Today `prisma dev` always runs as `dev`, so an old local target that ignores the name does no harm. Once C3 gives each environment its own local copy, an old local target would put every environment in one copy.
- **Suggestion:** Whatever check S01 settles on should run for `dev` too. Note it in the C3 spec. No change needed in this PR if the S01 check runs at config load, which covers `dev` automatically.

## Boundary checks

- **Core stays target-agnostic.** The only `'production'` literal under `packages/0-framework` outside tests is `DEFAULT_DEPLOY_ENVIRONMENT`. The new mismatch check compares two strings and knows nothing about Branches. Reading `instance.input` is within core's claim on a container in ADR-0038. The flaw in S01 is that the comparison proves nothing, not where it lives.
- **The extension's refusal of a request with no environment is right**, and it does work: a CLI older than this release sends `{ appName, stage }`, and the new extension refuses before calling the platform. It surfaces as `DEPLOY.CONTAINER_FAILED` in the old CLI, which is the best an old CLI can do.
- **Git-free validation is correct.** Every name the fast path accepts is a valid ref. Deploys with ordinary names no longer need `git` on PATH, and the injected `spawn` makes that testable.
- **Names.** `nodeDatabase`, `deployBranchId` and `retiredStageFlagRedirect` read true. `retiredStageFlagRedirect` is now private, which removes the public-API worry from round 1. `DEV_ENVIRONMENT` as the Alchemy local stage makes the rule visible in one place.
- **Docs against code.** The docs match the code everywhere except the mismatch claims in S01. The glossary, `deploy-cli.md`, `alchemy-lowering.md` and the guides say "environment", and name the Branch only where they describe what Prisma Cloud does, as ADR-0059 asks.
- **Recorded decisions.** Nothing contradicts a recorded decision. ADR-0044's registry, ADR-0038, ADR-0043 and ADR-0053 now point to ADR-0059. ADR-0024 and ADR-0050 depend on #386 (S05).

## Already addressed

| Round 1 | Resolution | Status |
| --- | --- | --- |
| S01 `deploy list --stage` not redirected | No redirect on purpose; spec and `deploy-cli.md` say why | Resolved. The reason (the engine refuses a redirect for an unmounted command) is sound. |
| S02 missing amendment notes | ADR-0044 registry edited; ADR-0038, ADR-0043, ADR-0053 amended | Resolved for this PR. ADR-0024 and ADR-0050 depend on #386; see S05. |
| S03 `branchDatabase` | Renamed `nodeDatabase` | Resolved. |
| S04 `targetBranchId` | Renamed `deployBranchId` | Resolved. `branchId` is kept with a doc comment, which is acceptable. |
| S05 `environmentFlagRedirect` | Renamed `retiredStageFlagRedirect`, made private | Resolved. |
| S06 default-Branch refusal code | Accepted as `DEPLOY.CONTAINER_FAILED`, recorded in the spec | Resolved. |
| S07 two `production` literals | `composer-cli/test/default-environment.test.ts` ties them | Resolved. |
| S08 `'dev'` twice | `DEV_ENVIRONMENT` is the Alchemy local stage | Resolved. |
| S09 "environment" homonym in the skill | Process-variable wording fixed; testing section renamed | Resolved. |
| S10 ADR-0059 ahead on `prisma dev` | Deferred to C3 | Deferred as agreed. #386's ADR-0050 amendment already says `prisma dev` gains the flag. |
| S11 leftover "stage" in design docs | Fixed | Resolved. |
| S12 errors name a CLI flag | Deferred, predates this branch | Deferred as agreed. New text with the same pattern is S03. |
