# Project: Composer reports its builds to Prisma Cloud

> Status: design verified against the platform contract and the Composer deploy pipeline, 2026-08-12. Findings and the reasoning behind each decision are in `design-notes.md`. Decisions marked **assumed** below were taken by the orchestrator and are open to override.

## Summary

Every `prisma-composer deploy` run reports itself to Prisma Cloud as a `Build` record — how far it got, whether it worked, and which platform resources it touched — and emits the run's outcome as a JSON file the Prisma GitHub Action can read.

## Why

Prisma Cloud is moving builds out of the platform and into users' CI. The platform side is built: a `Build` record with provenance and a Management API any deploy tool can report to (pdp-control-plane PR #4855). Composer is the first real reporter.

Two audiences consume one run:

- **Prisma Cloud**, so the Console can show deploy history for apps the platform never built.
- **The Prisma GitHub Action**, which needs the outcome as data so it can post a pull-request comment carrying preview links.

## The platform contract

Verified against `services/management-api/routes/v1/builds/` and `models/v1/builds.ts` on the `feat/builds-api` branch.

```http
POST  /v1/builds                                          Authorization: Bearer <workspace token>
      { source, commitSha, branchName, runIdentity?, externalLogUrl?, projectId?, branchId?, appId? }
      → 201 { id, phase, state, ... }

PATCH /v1/builds/:id                                      { phase?, state?, failingStep?, errorMessage?, externalLogUrl? }
PUT   /v1/builds/:id/resources/:resourceType/:resourceId   { action }
```

Facts that shape the design, each confirmed in the route or model source:

- The workspace comes from the token, never the body. A token spanning several workspaces is rejected outright. `PRISMA_WORKSPACE_ID` is **not** part of this contract.
- `commitSha` and `branchName` are required, `min(1)`. Composer reads no git metadata today.
- `phase` is `queued | build | deploy` and is nullable — the platform never invents an observation it did not receive. `state` is `pending | running | succeeded | failed | cancelled`.
- `source` for an external reporter is `ci | cli` only. `webhook`, `setup` and `manual` name build-runner's own surfaces and are rejected.
- `runIdentity` is what makes `POST` idempotent, and it is also what resolves `gitRepoId` — without it the build carries no repository and every call creates a new build.
- Resource reporting is an idempotent upsert whose recorded action never weakens: `created` survives a later `acted_on`, and `deleted` beats both.
- Reporting a `deployment` as `created` also attaches it to the build and records the implied `app` row, in one transaction.
- Every reported resource is checked to exist inside the caller's workspace before a provenance row is written.
- `failingStep` is free text, max 500. `errorMessage` max 5000. Both need truncation at the call site.
- **The build's anchors (`projectId`, `branchId`, `appId`) are settable only at creation.** This blocks the design and is being amended — see Dependencies.

## Requirements

### Functional

**FR1 — Join an existing build, or create one.** Read `PRISMA_BUILD_ID` from the environment and join that build when present. When absent, Composer creates the build itself. A deploy that reports nothing is invisible in the Console, so creating one is a requirement, not a fallback.

**FR2 — Report progress and outcome.** Set `phase: deploy` and `state: running` when the run starts, and the terminal `state` with `failingStep` and `errorMessage` when it ends, on both the success and failure paths. Composer's own error codes (`DEPLOY.PREFLIGHT_FAILED`, `DEPLOY.CONTAINER_FAILED`, `DEPLOY.ENGINE_FAILED` and the rest) are the `failingStep` vocabulary.

**FR3 — Report the resources the run acted on.** One `PUT` per platform resource, mapped from Composer's Alchemy resources onto the platform's eight resource types. `acted_on` is the default; `created` only when this run created the thing; `deleted` on teardown. Resources merely read or resolved are not reported — adopting an existing project is not acting on it.

**FR4 — Emit the run's outcome as JSON.** A versioned, documented file the Action can depend on: the app, its nodes and entities, preview URLs, and the failure cause when there is one. Not stdout — stdout already carries the human-readable tree.

**FR5 — Reporting never fails a deploy.** Reporting is observability, not a step of the deploy. Every failure is logged and swallowed. This includes the case where the platform is unreachable for the entire run.

### Non-functional

- Reuse the existing credentials (`PRISMA_SERVICE_TOKEN` via `fromEnv`) and the existing API origin. No second authentication path.
- No change to what a deploy provisions, in what order, or with what result. The reporting overlay observes; it does not steer.
- Reporting latency must not meaningfully extend a deploy. Resource reports are per-resource and fire during apply, so they cannot be allowed to serialise behind each other.

### Non-goals

- Publishing the GitHub Action itself.
- Work in pdp-control-plane, beyond the one amendment handed off as a dependency.
- The Alchemy state-store migration, and Composer's own auth rework.
- Reporting `prisma-composer destroy` — see decision D7.
- Reporting `prisma-composer dev`, which never touches Prisma Cloud.

## Decisions

**D1 — Composer only ever reports `phase: deploy`.** Composer never builds the user's code; ADR-0005 is explicit that users build and the framework assembles. `phase: build` belongs to whoever ran the build — the Action, or nobody.

**D2 — Resource reporting is incremental, intercepted at the state layer.** Not primarily for crash resilience. The descriptors emit only three entity kinds (`postgres-database`, `bucket`, `compute-service`) against the platform's eight resource types, and the most valuable type — `deployment` — is not an entity at all. The Alchemy providers in `packages/1-prisma-cloud/0-lowering/lowering/src/` do cover the vocabulary. End-of-run reporting from `report()` could never cover more than three of eight.

**D3 — The build id always reaches the apply through the environment.** The parent injects `PRISMA_BUILD_ID` into the alchemy child exactly as it already injects the result-file path, so the child reads one variable whether Composer created the build or the Action did.

**D4 — No git metadata means no report. (assumed)** `commitSha` and `branchName` are required fields. Composer reads git, preferring `GITHUB_SHA` / `GITHUB_REF_NAME` when present. Outside a git checkout entirely, skip reporting and log why — filling required fields with placeholders puts permanent junk in the Console.

**D5 — Detect GitHub Actions and report `source: "ci"` with a `runIdentity`. (assumed)** `GITHUB_REPOSITORY_ID`, `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT` are exactly the numeric fields the schema wants. Supplying them buys idempotency across retries and is what resolves `gitRepoId`, so the build appears against its repository. Fall back to `source: "cli"` with no run identity everywhere else.

**D6 — Hand-write the three API calls until the SDK ships them. (assumed)** A deliberate, temporary exception to "no second HTTP path": the installed SDK exposes only `/v1/builds/{buildId}/logs`, and the endpoints cannot compile against it. Confine them to one small typed module using the same token and origin, and delete it when the SDK catches up.

**D7 — `destroy` is out of the first cut. (assumed)** It is the only source of the `deleted` action and would be nearly free to wire, but `phase` has no value meaning teardown and `source` has none distinguishing it, so a destroy would render in the Console as an ordinary deploy with a pile of deleted resources. Better to omit it than to report it misleadingly.

**D8 — A killed process leaves a permanently running build, and that is accepted.** Nothing sweeps a build that stops reporting. A signal handler covers Ctrl-C and SIGTERM; SIGKILL and a torn-down runner cannot be covered. Since cancellation is common in CI, a visible population of permanently-running builds is the expected steady state, not a defect.

**D9 — Direct `alchemy deploy` of the generated stack file reports nothing.** That path has no parent process, so no build exists. With no `PRISMA_BUILD_ID` in the environment, skip resource reporting and log one line. Inventing a build from inside the child would defeat the purpose of a path that exists to isolate CLI bugs from Alchemy bugs.

## Dependencies

**Blocking for slices 1 and 2:**

1. The pdp-control-plane stack merges: #4853 → #4850 → #4855.
2. A `@prisma/management-api-sdk` release carrying the builds endpoints. Composer has 1.50.0; `main` is 1.57.0 and has none of them. D6 unblocks development but not correctness — the hand-written module still needs the routes deployed.

**Handed off, blocking the anchor behaviour:** an amendment to #4855 adding `projectId`, `branchId` and `appId` as optional fields on `UpdateBuildInputSchema`, with the anchors merged against the row's existing values before `verifyBuildAnchors` runs, and fill-only semantics. Without it, Composer-reported builds carry no project and are invisible to `GET /v1/builds?projectId=`.

Slice 3 (the JSON report) depends on none of these and can land first.

## Definition of done

- A `prisma-composer deploy` against Prisma Cloud produces a build in the Console with the right phase, outcome and resources — both when `PRISMA_BUILD_ID` is supplied and when Composer creates its own.
- A failing deploy shows its named cause and a human-readable message.
- A deploy whose reporting calls all fail still succeeds, and says why reporting failed.
- The JSON report is emitted, versioned, documented, and parses.
- A run from a directory with no git metadata deploys normally and reports nothing.
- `prisma-composer dev` and a direct `alchemy deploy` of the generated stack file report nothing.
