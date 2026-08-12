# Design notes: Composer reports its builds to Prisma Cloud

Design review of the incoming brief, 2026-08-12. Verified against pdp-control-plane PR #4855 (`feat/builds-api` branch) and the Composer deploy pipeline. Records what the review found, including where the brief and the reviewer were wrong.

## Where the brief was wrong

**`PRISMA_WORKSPACE_ID` is not part of this contract.** The brief says `fromEnv` in `credentials.ts` loads both it and `PRISMA_SERVICE_TOKEN`. It loads only the token. The builds routes take the workspace from the token and reject a token spanning several workspaces, so the workspace id is never sent.

**`commitSha` and `branchName` are required, and Composer reads no git.** The brief does not mention either field. Both are `min(1)` on `POST /v1/builds`, and Composer has no git-reading code anywhere. This collides directly with the brief's hard requirement that a laptop deploy always creates a build: a deploy from a directory that is not a git checkout can satisfy neither field.

**The SDK cannot make these calls.** The brief says to reuse `createManagementApiClient` rather than adding a second HTTP path. The installed `@prisma/management-api-sdk` is 1.50.0 and exposes only `/v1/builds/{buildId}/logs`; `main` is at 1.57.0 and has none of the new endpoints. #4855 is open and stacked on two further open PRs. The instruction is right in principle and impossible in practice until the stack lands.

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

## Constraints discovered in the Composer pipeline

**The apply runs in a child process.** `prisma-composer deploy` generates `.prisma-composer/alchemy.run.ts` and shells out to `alchemy`. The `report` hook fires inside that child, not the CLI. This is why the build id must travel through the environment, and why the JSON summary already exists as a cross-process file protocol.

**`report` is synchronous and returns `void`.** It cannot await HTTP calls. Anything requiring async work belongs in `runStackPipeline` in the parent, which is already async and where every failure path funnels through one place.

**The project is created before the apply.** `container.ensure()` runs in the parent, at step 3 of the pipeline, well before alchemy starts. That is where composer#103's orphaned project comes from, and it is why the build has to be created before the pipeline runs rather than after the project id is known.

**Named failure causes exist but stop at the apply boundary.** `DEPLOY.BUILD_REQUIRED`, `DEPLOY.CONTAINER_FAILED`, `DEPLOY.SCOPE_MISSING`, `DEPLOY.PREFLIGHT_FAILED`, `DEPLOY.STACK_WRITE_FAILED`, `DEPLOY.ENGINE_FAILED`, `DEPLOY.TEARDOWN_FAILED`, `DEPLOY.CONTAINER_REMOVE_FAILED`. The brief is right that these are what `failingStep` is for. What it does not say is that every failure *inside* the apply — the interesting ones — collapses into `DEPLOY.ENGINE_FAILED` with the message "alchemy deploy exited with status N". The report will be accurate and nearly useless for diagnosing a failed apply. Improving that is separate work and worth its own ticket.

**The result file is deleted after every run.** Deliberately, so resource ids and URLs do not accumulate on disk. Any user-facing JSON output must be a separate path that survives, without reintroducing that accumulation for people who did not ask for it.

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
