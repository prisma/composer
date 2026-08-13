# Design notes: Composer reports its builds to Prisma Cloud

> **This is a chronological log, not a reference.** It records what was believed at each point, including claims later corrected further down. For the current design, read [spec.md](spec.md) and [topology-design.md](topology-design.md); come here only for the reasoning behind a decision.

Design review of the incoming brief, 2026-08-12. Verified against pdp-control-plane PR #4855 (`feat/builds-api` branch) and the Composer deploy pipeline. Records what the review found, including where the brief and the reviewer were wrong.

## Where the brief was wrong

**`PRISMA_WORKSPACE_ID` is not part of this contract.** The brief says `fromEnv` in `credentials.ts` loads both it and `PRISMA_SERVICE_TOKEN`. It loads only the token. The builds routes take the workspace from the token and reject a token spanning several workspaces, so the workspace id is never sent.

**`commitSha` and `branchName` are required, and Composer reads no git.** The brief does not mention either field. Both are `min(1)` on `POST /v1/builds`, and Composer has no git-reading code anywhere. This collides directly with the brief's hard requirement that a laptop deploy always creates a build: a deploy from a directory that is not a git checkout can satisfy neither field.

**The SDK cannot make these calls — resolved before this shipped.** The brief says to reuse `createManagementApiClient` rather than adding a second HTTP path. At review time the installed `@prisma/management-api-sdk` was 1.50.0 and exposed only `/v1/builds/{buildId}/logs`. The stack then merged and 1.60.0 shipped with all three endpoints, so the temporary hand-written module was deleted and the brief's instruction holds as written. The release also closed a pre-existing gap nobody had chased: the hosted-state lease and scope endpoints were missing too, which is why `lowering` carried seven type errors on a clean tree. It typechecks now.

Two things worth keeping from that episode. The worktree was also half-installed — `@prisma/orm-*` was absent from `node_modules` entirely, which produced a second set of "pre-existing" typecheck, build and invariant-test failures that had nothing to do with the SDK. A plain `pnpm install` cleared them. When a repository appears to have a large baseline of failures, check that it is fully installed before concluding anything about the code.

And once the SDK was in place, the request and response shapes were **derived** from its generated `operations` type rather than restated. A hand-kept copy of a contract someone else owns drifts silently; a derived one breaks the build. The derivation was verified with a compiled probe in both directions — that each alias accepts its real values and rejects invented ones — because a type that collapses to `never` or widens to `any` typechecks just as quietly as a correct one.

**End-of-run resource reporting cannot meet the brief's own goal.** The brief presents incremental versus end-of-run as a judgement call about crash resilience. It is not close. Descriptors emit exactly three entity kinds — `postgres-database`, `bucket`, `compute-service` — against eight platform resource types, and `deployment`, the type that makes the platform maintain the deployment-to-build link and the implied app row, is not an entity at all. The Alchemy providers do cover the vocabulary. Reporting from `report()` could never cover more than three of eight, whatever its crash behaviour.

## Where the review was wrong

The first review claimed a build's project **cannot** be set after creation and offered three ways to work around it. Will challenged this, correctly.

The schema draws exactly the distinction he pointed at:

```prisma
workspace   Workspace @relation(..., onDelete: Cascade)
workspaceId String                                        // required
project     Project?  @relation(..., onDelete: SetNull)
projectId   String?                                       // nullable, mutable
branch      Branch?   @relation(..., onDelete: SetNull)
branchId    String?                                       // nullable, mutable
appId       String?   @map("computeServiceId")            // nullable, no relation
```

`workspaceId` is required and cascades — genuinely hard to change, and it never needs to be, since it comes from the token. The three anchors are ordinary nullable foreign keys that already null themselves when their target is deleted. `verifyBuildAnchors` is already a standalone function taking a `Pick` of the create input, reusable from a PATCH handler unchanged.

So the constraint is that `UpdateBuildInputSchema` lists five fields and these are not among them. An omission in an unmerged PR, not a property of the model. The correct response is to amend the PR, which was handed to that PR's author with two details attached: merge the row's existing anchors before verifying, or the mutual-agreement checks silently pass; and make it fill-only, matching the never-weaken rule the same PR already applies to resource actions.

**Outcome: the amendment landed in full.** The merged `UpdateBuildInputSchema` takes all three references, fill-only, verified against what the build already carries, with a 409 when a recorded value would change and a no-op when the same value is re-sent. `deployedUrl` was added on the same terms — the secondary ask that was flagged as decline-able — which is what lets a Composer build show a working link in the Console.

**Correction (2026-08-13, operator).** Two claims above overstated the project reference's weight, and the vocabulary was wrong. A Build's required scope is its **workspace**, which comes from the token; `projectId`/`branchId`/`appId` are optional foreign keys that only add narrower views. The Console's builds pages (pdp #4860) list at workspace level as well as project level, so a build without a project reference is still visible — it just does not appear in the project-filtered view. And the platform's own "anchor" wording is outdated; these are plain optional fks. The code now says `attach`/`refsOf` and nothing says anchor.

## Constraints discovered in the Composer pipeline

**The apply runs in a child process.** `prisma-composer deploy` generates `.prisma-composer/alchemy.run.ts` and shells out to `alchemy`. The `report` hook fires inside that child, not the CLI. This is why the build id must travel through the environment, and why the JSON summary already exists as a cross-process file protocol.

**`report` is synchronous and returns `void`.** It cannot await HTTP calls. Anything requiring async work belongs in `runStackPipeline` in the parent, which is already async and where every failure path funnels through one place.

**The project is created before the apply.** `container.ensure()` runs in the parent, at step 3 of the pipeline, well before alchemy starts. That is where composer#103's orphaned project comes from, and it is why the build has to be created before the pipeline runs rather than after the project id is known.

**Named failure causes exist but stop at the apply boundary.** `DEPLOY.BUILD_REQUIRED`, `DEPLOY.CONTAINER_FAILED`, `DEPLOY.SCOPE_MISSING`, `DEPLOY.PREFLIGHT_FAILED`, `DEPLOY.STACK_WRITE_FAILED`, `DEPLOY.ENGINE_FAILED`, `DEPLOY.TEARDOWN_FAILED`, `DEPLOY.CONTAINER_REMOVE_FAILED`. The brief is right that these are what `failingStep` is for. What it does not say is that every failure *inside* the apply — the interesting ones — collapses into `DEPLOY.ENGINE_FAILED` with the message "alchemy deploy exited with status N". The report will be accurate and nearly useless for diagnosing a failed apply. Improving that is separate work and worth its own ticket.

**The result file is deleted after every run.** Deliberately, so resource ids and URLs do not accumulate on disk. Any user-facing JSON output must be a separate path that survives, without reintroducing that accumulation for people who did not ask for it.

**The framework may not import Prisma Cloud, so reporting reaches the CLI through a new extension hook.** `architecture.config.json` gives the framework domain `mayImportFrom: []`, and the CLI is framework tooling. The reporting client cannot live there. The existing seam for exactly this is the extension descriptor, which already carries `container`, `preflight` and `teardown` hooks the CLI calls generically — so `reporter` joins them: core defines the vocabulary, the CLI drives the lifecycle, and Prisma Cloud supplies the implementation.

**The extension package may not read the environment or import a node builtin, which decided where the reporter lives.** `packages/1-prisma-cloud/1-extensions/target` ships into runtime surfaces, and two of its own tests enforce this: invariant 4 asserts an exact per-file list of `process.env` uses, and invariant 5 bans every `node:` import across the package. Reading git and the deploy shell is precisely what a reporter does, so the session lives in `0-lowering/lowering/src/builds/` — which already uses `node:fs`, `node:os` and `node:crypto` freely — and the extension keeps only a five-line adapter supplying the one thing the lowering side cannot know: how to read its own container.

**The repository's cast counter treats an import alias as a cast.** `import { buildReporter as reportBuilds }` raised `lint:casts` by one. Renaming the export removed it. Worth knowing before someone spends time hunting for a type assertion that was never there.

## How two reporters of one CI run converge

Checked against `origin/main` because it decides where the GitHub-env reading belongs.

The platform owns the dedup key and nothing else. `sourceEventIdForRun(workspaceId, runIdentity)` in `packages/interactors/src/compute/build.ts` returns `github:<workspaceId>:<repositoryId>:<runId>:<runAttempt>`, and `Build.sourceEventId` carries a unique constraint, so any two reporters that supply the same `runIdentity` land on one `Build` row rather than two. `createBuild` looks the key up before inserting and treats a duplicate-key error as "already recorded", so the race is closed on both sides.

What the platform does **not** do is work out that identity for you. It reads no GitHub environment variable anywhere outside its own CI scripts — the four fields arrive in the `POST` body, and a reporter that omits `runIdentity` gets a fresh build every call plus no repository link, since `gitRepoId` is resolved from `runIdentity.repositoryId`. So deriving the identity from `GITHUB_REPOSITORY_ID` / `GITHUB_RUN_ID` / `GITHUB_RUN_ATTEMPT` is the reporter's job, and `builds/run-identity.ts` is the right home for it. There is no shared helper to reuse and nothing to keep in step beyond those three variable names.

The consequence worth remembering: **Composer and the GitHub Action must derive the identity identically, or one run produces two builds.** Passing a build id down side-steps it entirely, which is why that path exists — but the fallback only converges because both sides read the same three variables.

~~Separately, a platform webhook build and a CI-run build for the same push do *not* converge.~~ **Superseded 2026-08-13:** pdp #4877 makes the git webhook correlate `workflow_run` events for `prisma-deploy.yml` into the same Build row via the run's `sourceEventId`, and it marks the build `queued` the moment GitHub accepts the run — before any user code executes. So the webhook and the CI run now converge on one row, and the webhook is usually the first reporter. This strengthens the identity requirement: Composer's derivation must match not only the Action's but the webhook's.

## Invocation cases

Walked through with Will. The brief covers the first and third; the rest were found during review.

| Case | `PRISMA_BUILD_ID` | Behaviour |
| --- | --- | --- |
| Laptop | absent | Create, `source: "cli"`, no run identity. Not idempotent — each retry is a new build. Failed local commands create build records; accepted noise. |
| Generic CI on GitHub Actions | absent | Create, `source: "ci"`, **with** a run identity from `GITHUB_REPOSITORY_ID` / `GITHUB_RUN_ID` / `GITHUB_RUN_ATTEMPT`. Buys idempotency and resolves `gitRepoId`. The brief conflates this with the laptop case. |
| Prisma GitHub Action | present | Join. Never re-POST, never overwrite `externalLogUrl`, never touch `source`. The path that most needs the anchor amendment. |
| Direct `alchemy deploy` of the generated file | absent | Documented path for isolating CLI bugs from Alchemy bugs. No parent process, so no build. Skip and log. |
| `destroy` | either | Only source of the `deleted` action, but `phase` has no teardown value and `source` cannot distinguish it. Out of the first cut. |
| `dev` | n/a | Local providers, no Prisma Cloud, no token. Never reports. |
| Programmatic `deploy()` | either | Behaves as laptop or CI per environment. Worth a test — a host application might already hold a build id. |
| Process killed | either | No terminal report; the build stays running forever. Signal handling covers Ctrl-C and SIGTERM only. Since CI cancellation is common, this is the steady state, not a defect. |

## Follow-ups worth their own tickets

- A failed apply reports `DEPLOY.ENGINE_FAILED` and nothing else. Structuring the child's failure so the real cause survives to the parent would make `failingStep` and `errorMessage` genuinely useful.
- `deployedUrl` is on the build response but not settable via PATCH, so a Composer-reported build shows no deploy URL in the Console. Raised as a secondary ask on #4855; not a blocker, since preview URLs reach the Action through the JSON report.
