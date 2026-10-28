# C2 system-design review: the term is environment

Branch `claude/environment-rename-fdf6ab`, range `main...HEAD`. Reviewer: architect.

Read before reviewing: `CLAUDE.md`; both files in `docs/design/01-principles/`; ADR-0059, ADR-0024, ADR-0038, ADR-0043, ADR-0050 in full; ADR-0044's code registry and ADR-0053's `deploy list` amendment (both name the old flag and codes); the glossary entry "Environment (formerly Stage)" and the Alchemy "Stage" entry; the C2 spec and plan; the C3 spec.

## The problem and the new invariants

Composer called a place the app runs a "stage", and core treated "no stage" as production. So core carried `stage: string | undefined` everywhere, the destroy operation needed a two-arm `DestroyTarget` union to name production, and the CLI needed `DEPLOY.SCOPE_MISSING` for the case where nothing named the Alchemy stage. ADR-0059 renames the concept to "environment" and makes every environment a name.

The change establishes these invariants:

1. Core carries an environment name, always a non-empty string. It never compares that name with `production` or `dev`.
2. The names a user does not type are command defaults: `production` for `deploy` and `deploy list`, `dev` for the `dev` and `log` operations. `destroy` has no default.
3. Every name, defaults included, passes `git check-ref-format`.
4. Only the Prisma Cloud extension maps a name onto the platform. `production` is the default Branch, found by `isDefault`. Any other name is the Branch with that `gitName`. A non-production name that finds the default Branch is refused.
5. The Alchemy stage is the state-owning container's `alchemyStage`, else the environment name. It is never undefined.
6. Alchemy's own word "stage" stays inside Alchemy-facing code.

The shape is right. Removing `DestroyTarget` and `DEPLOY.SCOPE_MISSING` is a real simplification: two special cases disappear because production stopped being "absent". This is the "Compose, don't special-case" principle working as intended.

## Subsystem fit and dependency direction

**Core stays target-agnostic.** I searched `packages/0-framework` for the literals `'production'` and `"production"` outside tests. The only hit is `DEFAULT_DEPLOY_ENVIRONMENT = 'production'` in `cli/src/operations/deploy.ts`. That is a default value, not a comparison. Every comparison with `production` lives in `@internal/lowering`'s `container.ts` (`isProductionEnvironment`) and its one caller in the Prisma Cloud target's `container.ts` (`remove`). Core never compares with `dev` either; `DEV_ENVIRONMENT` is only ever passed in.

**Where the constants live.**

- `DEFAULT_DEPLOY_ENVIRONMENT` lives in the CLI's `operations/deploy.ts`. That is right: it is a parameter default of the `deploy` operation. It is re-exported through `@internal/cli/family` because `deploy list` in `@prisma/composer-cli` uses the same default. That keeps the two commands' defaults from drifting.
- `DEV_ENVIRONMENT` lives in `operations/shared.ts`, used by `dev` and `log`. Right place for now (see S08).
- `PRODUCTION_ENVIRONMENT` lives in `@internal/lowering`. Right place: it names the mapping the target owns.

The one structural cost is that core's default and the target's mapping are two separate literals that must agree (S07).

**Dependency direction holds.** `@prisma/composer-cli` imports from both `@internal/cli/family` and `@internal/lowering/deployed`, which is what that package exists to do. Nothing in `0-framework` imports from `1-prisma-cloud`.

## Findings

### S01. `deploy list --stage` is not redirected

- **Location:** `packages/9-public/composer-cli/src/exports/family.ts` (unchanged on this branch); `packages/0-framework/3-tooling/cli/src/family/family.ts`.
- **Issue:** The spec, the plan and `deploy-cli.md` all say `--stage` fails with `CLI.COMMAND_MOVED` on both `deploy` and `deploy list`. The framework family registers `environmentFlagRedirect('deploy')` only. The engine keys flag redirects by command path, so `deploy list` has no redirect. `@prisma/composer-cli` adds the `deploy list` command but never passes `redirects: [environmentFlagRedirect('deploy list')]`. A user who types `prisma deploy list --stage pr-42` gets an unknown-flag error, not "use `--environment <name>`". The helper was exported for this caller and is unused. The test `rejects --stage` in `composer-cli/test/deploy-list.test.ts` only asserts a non-zero exit, so it passes for the wrong reason.
- **Suggestion:** Pass the redirect from `createComposerFamily` in `@prisma/composer-cli`, next to the command it retires. Make the test assert `CLI.COMMAND_MOVED` and the replacement text.

### S02. ADR-0059 promises amendment notes that no older ADR carries

- **Location:** `docs/design/90-decisions/ADR-0024`, `ADR-0038`, `ADR-0043`, `ADR-0044`, `ADR-0050`, `ADR-0053`; the spec's "Deliberately out" line.
- **Issue:** ADR-0059's consequences say "Earlier ADRs that say 'stage' describe the same concept under the old word; their amendment notes point here." None do. The spec puts older ADRs out of scope, which contradicts that consequence. After this branch, these records state things that are now false:
  - ADR-0050: `prisma deploy` takes `--stage`; `destroy`'s target is `{ kind: 'stage' } | { kind: 'production' }`; the examples' scripts pass `--production` or `--stage`.
  - ADR-0043: the example calls `deploy({ stage })` and branches on `DEPLOY.STAGE_INVALID`.
  - ADR-0038: `LocateContainerInput.stage: string | undefined`; "Stage-name validation stays in the CLI".
  - ADR-0044: the closed `DEPLOY` registry lists `STAGE_INVALID`, `STAGE_UNVALIDATABLE` and `SCOPE_MISSING`, and lacks `ENVIRONMENT_REQUIRED`, `ENVIRONMENT_INVALID` and `ENVIRONMENT_UNVALIDATABLE`. ADR-0044 already has an amendment for an added code, so the precedent is to amend it.
  - ADR-0053: `deploy list` takes `--stage` and fails with `DEPLOY.STAGE_INVALID`.
  - ADR-0024: `--stage`, the destroy target union.
- **Suggestion:** Add a one-line amendment note to each, pointing to ADR-0059 and naming what changed (flag, destroy input, codes). Do not rewrite their bodies. Drop "older decision records" from the spec's out-of-scope list, or narrow it to "bodies of older decision records".

### S03. `branchDatabase` names the wrong thing

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/descriptors/shared.ts`, used by `orm-postgres.ts` and `raw-postgres.ts`.
- **Issue:** The function provisions one node's Database and Connection. It attaches the Database to a Branch when one exists, and in the branchless dev container it attaches to nothing. Read cold, `branchDatabase` says "the Branch's database", singular per Branch. That reads like the old per-Branch state database, which this codebase used to have. It is also false for the dev arm, which has no Branch.
- **Suggestion:** Name it for what it makes: `nodeDatabase` or `postgresDatabase`.

### S04. `targetBranchId` uses a word the codebase already owns

- **Location:** `packages/1-prisma-cloud/0-lowering/lowering/src/builds/reporter.ts` (`BuildContainerRefs`), `target/src/reporting/reporter.ts`, and the local variable in `PrismaCloudContainer`'s constructor.
- **Issue:** In this codebase "target" means a deployment target, such as Prisma Cloud. `targetBranchId` reads cold as "the Prisma Cloud target's Branch". Its sibling `branchId` also reads badly: it is not "the Branch", it is the Branch reference on the Build row, absent for production. The pair does not tell the reader which is which.
- **Suggestion:** Name both for their use: `buildBranchId` (the Build row's reference, absent for production) and `topologyBranchId` or `deployBranchId` (the Branch the deploy lands on, which receives the topology).

### S05. `environmentFlagRedirect` reads as the opposite of what it does

- **Location:** `packages/0-framework/3-tooling/cli/src/family/family.ts`, exported through `@internal/cli/family` and therefore through `@prisma/composer-cli/family`.
- **Issue:** It retires the `--stage` flag. Read cold, `environmentFlagRedirect` says it redirects the `--environment` flag. It is also now public API of `@prisma/composer-cli` through `export *`, so the name is harder to change later.
- **Suggestion:** `retiredStageFlagRedirect(command)` or `stageFlagRedirect(command)`. Once S01 moves the `deploy list` redirect into `@prisma/composer-cli`, the function is the shared way both packages build the spec, and the name should say what is retired.

### S06. The production refusal has no code of its own

- **Location:** `DefaultBranchUnderAnotherNameError` in `@internal/lowering/src/container.ts`; its catches in `target/src/container.ts` and `lowering/src/deployed.ts`.
- **Issue:** The refusal is the safety rule that stops `destroy({ environment: 'main' })` tearing production down. It reaches the caller as `DEPLOY.CONTAINER_FAILED`, the code that also means "the Management API call failed". An agent cannot tell "you named production under another name; use `production`" from "the platform was unreachable" without parsing the message. The Agent-first principle asks for machine-readable failures. Core cannot own a code that mentions default Branches, so this is a real design tension, not an oversight.
- **Suggestion:** Decide it explicitly. Either accept `CONTAINER_FAILED` and say so in `deploy-cli.md`, or add a target-neutral code such as `DEPLOY.ENVIRONMENT_REFUSED` ("the target refused this environment name") that any extension can raise. The second fits ADR-0044's registry without core learning about Branches. The class name itself is acceptable target vocabulary; `ProductionUnderAnotherNameError` would match the user-facing message more closely.

### S07. Core's default and the target's mapping are two literals that must agree

- **Location:** `DEFAULT_DEPLOY_ENVIRONMENT` in `cli/src/operations/deploy.ts`; `PRODUCTION_ENVIRONMENT` in `lowering/src/container.ts`.
- **Issue:** A bare `prisma deploy` lands on the default Branch only because both constants are the string `production`. ADR-0059 fixes that name, so the design is right. But nothing in the code ties them: if one changes, a bare deploy silently creates a Branch called by the new default. Core must not import from Prisma Cloud, so they cannot share one constant.
- **Suggestion:** Add one test in `@prisma/composer-cli`, which may import both domains, asserting the two are equal, or asserting that a bare `deploy` resolves the default Branch through the real container code. The `deploy list` tests already do the second for `deploy list`; `deploy` itself is only covered by real CI deploys.

### S08. Local dev hard-codes `'dev'` twice

- **Location:** `cli/src/operations/execute-dev.ts`, where the Alchemy invocation passes `stage: 'dev'` while the containers receive `DEV_ENVIRONMENT`.
- **Issue:** For hosted deploys, the Alchemy stage falls back to the environment name. For dev, the environment name and the Alchemy stage are two independent `'dev'` literals that happen to match. C3 says "Alchemy's local stage is the environment name". Today a reader cannot see that rule in the code.
- **Suggestion:** Pass `DEV_ENVIRONMENT` as the Alchemy stage in `execute-dev.ts`. Then C3 changes one value, not two. Also consider `DEFAULT_DEV_ENVIRONMENT` in C3 to match `DEFAULT_DEPLOY_ENVIRONMENT` once `dev` takes a flag. In C2, `DEV_ENVIRONMENT` is correct because it is not yet a default.

### S09. "Environment" now means two things in the agent skill

- **Location:** `skills/prisma-composer-core-concepts/SKILL.md`: the principle "Your code never reads its environment", the dev-server paragraph ("restarts a dev server only when its environment changed"), and the section "Testing is an environment seam" ("A test is just another environment").
- **Issue:** ADR-0059 accepts the overlap with environment variables. But these lines were written when "environment" meant only the process environment. Now "A test is just another environment" reads as a deploy environment, and C3 will add `prisma dev --environment test`, which is a different thing. The skill is what agents read, so the homonym will cause wrong answers.
- **Suggestion:** Where the text means process variables, say "environment variables" or "the process environment". Rename the testing section to something like "Testing is a dependency-injection seam".

### S10. ADR-0059 is ahead of the code on `prisma dev`

- **Location:** ADR-0059 consequences ("`--environment` is the public flag on `prisma deploy` and `prisma dev`").
- **Issue:** C2 gives `prisma dev` no flag, on purpose; C3 adds it. The ADR states it as already true. `deploy-cli.md` and `local-dev.md` say the right thing.
- **Suggestion:** Add a one-line amendment to ADR-0059 saying `prisma dev` runs as `dev` and gains `--environment` in the per-environment local copies work. ADR-0059's own examples also still pass a positional `module.ts`, which the 2026-10-23 amendment to ADR-0050 retired; fix them in the same edit.

### S11. Leftover "stage" in edited design-doc lines

- **Location:** `docs/design/05-prisma-cloud/alchemy-lowering.md`: "On a stage that never had the old ID" and "exactly one row on the stage's Branch". `docs/design/10-domains/deploy-cli.md`: "the error for a missing one, `DEPLOY.SCOPE_MISSING`, is gone".
- **Issue:** The first two are Composer's concept under the old word, in lines this branch already edited. The third describes the change, not the system; a design doc should state what is true.
- **Suggestion:** "On an environment that never had the old ID"; "on the environment's Branch"; drop the `SCOPE_MISSING` sentence, or move it to the ADR-0044 amendment from S02.

### S12. Operation-level errors name a CLI flag

- **Location:** `cli/src/validate-environment.ts` ("Invalid --environment ..."); `DefaultBranchUnderAnotherNameError.message` ("Deploy it with --environment production").
- **Issue:** Both are raised from the `destroy` operation, which has no flag, and from scripts. The Prisma Cloud extension's message names the `prisma deploy` flag, so the target knows one host's grammar. This pattern existed before with `--stage`, so it is not new debt, but the rename was the cheap moment to fix it.
- **Suggestion:** Say "the environment name `x`" in the message. Leave flag spelling to the `fix` text that the CLI renders, or accept the existing pattern and move on. Low priority.

## User-facing text that still says "stage"

I searched every tracked file under `docs/guides`, `skills`, `examples`, `README.md`, `gotchas.md`, `website/src`, `.github`, `scripts` and `packages` (tests excluded) for the whole word "stage" or "stages". What remains is:

- Alchemy's own vocabulary: the `--stage` argument in `run-alchemy.ts`, generated-stack header comments, `LowerOptions.stage`, `ALCHEMY_STAGE_PATTERN`, state-API path segments, lease and state-store scope fields, and the skill's description of running Alchemy directly. All correct per ADR-0059.
- The verb "to stage" (copying files into a bundle) in the build and assembly code and guides. A different word, correct.
- The redirect that retires `--stage`, and the destroy script's test of the retired flag. Correct.
- The glossary's Alchemy "Stage" entry, which points to Environment. Correct.

No guide, error message or help text uses "stage" for Composer's concept. The only exceptions are the design-doc lines in S11 and the older ADRs in S02.

## Do the design docs and guides contradict a recorded decision?

- **ADR-0024's "production/preview classification belongs to the platform"** still holds. Preflight still picks the variable class from whether a Branch id is present, never from the Branch's role. Resolving production by `isDefault`, never by `role`, matches.
- **ADR-0038's "core never interprets the container"** still holds. Core reads `alchemyStage` and `input`, and now documents that it never interprets `input.environment`.
- **ADR-0050's reason for having no destroy command** included "it would need a production flag that no other Composer command has". With production as a name, that reason is gone. The decision still stands on its other reason (a second destructive verb next to `delete`). This is worth one sentence in the ADR-0050 amendment from S02, so nobody reopens it thinking the reasoning is intact.
- **The guides** say once, in `deploying.md`, that on Prisma Cloud an environment is a Branch, as ADR-0059 asks. No contradiction found.
- Contradictions that do exist: the older ADRs (S02), ADR-0059 itself on `prisma dev` (S10), and `deploy-cli.md`'s claim about `deploy list --stage` (S01; the doc is right and the code is wrong).

## Test strategy, at the architectural level

What is covered well:

- The operations tests pin core's half: a bare deploy uses the name `production` and runs Alchemy under it when the container pins nothing; an invalid name fails before any container call; `destroy` hands the container the name it was given; `dev` hands the local target `dev`. These tests use a fake extension, so they also show core treats `production` as just a name.
- The Prisma Cloud container tests pin the target's half: explicit and default `production` both resolve the default Branch without creating one; other names find or create by `gitName`; `ensure` and `locate` both refuse a name whose Branch is the default Branch; remove deletes a Branch for any other name and never the default Branch.
- The run report's version was bumped for the field rename, which is the right boundary handling for a published JSON shape.
- The container payload's `environment` is required on deserialize. That is safe because parent and child are always the same version.

Gaps:

- The `deploy list --stage` redirect is not really tested (S01).
- Nothing pins that core's default and the target's production name agree, except real CI deploys (S07).
- No test shows that core never compares names. A cheap check is a test that runs `deploy` with a fake extension and an environment called `production`, and asserts the fake receives exactly that string with no other branch taken. The existing default-environment test nearly does this. Alternatively, add a lint that rejects the literal `'production'` under `packages/0-framework` outside the one default.
