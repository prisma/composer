# Project: Composer reports its builds to Prisma Cloud

> Status: **implemented** on [PR #227](https://github.com/prisma/composer/pull/227); the platform API is in production. The definition of done is met — verified live 2026-08-14, build `bld_cqdzjjlja99nmcd4f27bn69g`. The follow-up topology design is in [topology-design.md](topology-design.md). The discussion history behind every decision here is in [design-notes.md](design-notes.md) — a log, not a reference.

## The design

Every `prisma-composer deploy` records itself on the platform as a **Build**: that a run happened, how far it got, how it ended, and which platform resources it touched. Reporting is observability — it can never fail a deploy.

Four pieces, and where each lives:

1. **A `reporter` hook on `ExtensionDescriptor`** ([app-config.ts](../../../packages/0-framework/1-core/core/src/control/app-config.ts)), driven generically by the CLI: `begin` after the graph loads and *before* containers resolve (so the failure that orphans a freshly created project, composer#103, is still recorded), `attach` once the Project/Branch exist, `finish` on every exit path — success, structured failure, thrown defect, SIGINT/SIGTERM. Core defines the vocabulary and knows nothing about Builds; the CLI drives the lifecycle and makes no HTTP calls; the Prisma Cloud extension supplies the implementation. This indirection is forced by the architecture: the framework domain may import nothing (`architecture.config.json`), so reporting reaches the CLI only through the extension seam.
2. **The reporting session** in `packages/1-prisma-cloud/0-lowering/lowering/src/builds/` — build create/join, git identity, progress and terminal PATCHes, all through the generated `@prisma/management-api-sdk` client with every request/response shape *derived* from its `operations` types (a hand-kept copy of someone else's contract drifts; a derived one breaks the build). It lives in `lowering` rather than beside the extension because the extension package may read no environment and import no node builtin (its invariants 4 and 5) — which is most of what a reporter does. The extension keeps a five-line adapter supplying the one thing lowering cannot know: how to read its own container.
3. **Resource reporting through the state store** ([state-store.ts](../../../packages/1-prisma-cloud/0-lowering/lowering/src/builds/state-store.ts), wired in [state/layer.ts](../../../packages/1-prisma-cloud/0-lowering/lowering/src/state/layer.ts)): each platform resource is reported as Alchemy converges it, fired without blocking the apply and drained before the deploy lease releases. The state store is the interception point because every resource write passes through it whichever provider performed it; the deploy's own report hook sees only three entity kinds against the platform's eight resource types.
4. **The run report** ([run-report.ts](../../../packages/0-framework/3-tooling/cli/src/run-report.ts)): `--report <path>` or `PRISMA_COMPOSER_REPORT_FILE` writes a versioned JSON file with the app, its entities, preview URLs, and the failure cause — written on failure too. **Transitional**: it dies once the GitHub Action reads Build + topology + Versions from the platform (topology-design.md R4).

How a run gets its Build: join the id from `--build-id` or `PRISMA_BUILD_ID` (flag wins — passed deliberately for that step; empty string is unset on both), else create one — `source: "ci"` with a GitHub run identity when inside GitHub Actions, `source: "cli"` otherwise. The id reaches the apply child through `PRISMA_BUILD_ID`, injected like the other pipeline env.

## Requirements, and what satisfies them

| # | Requirement | Satisfied by |
| --- | --- | --- |
| FR1 | Join an existing build or create one; a deploy that reports nothing is invisible, so creating is a requirement, not a fallback. | The join/create logic above; both channels exist because a runner exporting one id per job wants the variable, a job deploying several stages wants the per-step flag. |
| FR2 | Report progress and outcome, with Composer's error codes as the `failingStep` vocabulary and human detail in `errorMessage`. | `begin` PATCHes `phase: deploy, state: running`; `finish` PATCHes the terminal state on every exit path; codes truncate to the platform's 500/5000 caps. |
| FR3 | Report the resources the run acted on: `acted_on` default, `created` only when this run created it, `deleted` on teardown; never report what was merely resolved. | The state-store interceptor; terminal statuses map created→`created`, updated→`acted_on`, deleting→`deleted`; adopted resources are excluded by the `adopting` flag on the state record. |
| FR4 | The Action can consume the outcome as data. | Today: the run-report JSON. Target state: the platform (topology-design.md R4); the file is transitional. |
| FR5 | Reporting never fails a deploy, including a platform unreachable all run. | Every API call warns and returns; the CLI additionally swallows anything a reporter throws; the drain never rejects. |

Non-functional: one credential path (`PRISMA_SERVICE_TOKEN`, workspace from the token — `PRISMA_WORKSPACE_ID` is not part of this contract); no change to what a deploy provisions or in what order; resource reports must not serialise behind each other.

## Decisions

Ids are stable (they are referenced from design-notes.md and plan.md); the order here is logical, not chronological.

**Architecture**

- **D10 — reporting reaches the CLI through the `reporter` extension hook, and the session lives on the lowering side.** Both placements forced by machine-checked rules; see The design.
- **D2 — resource reporting is incremental, intercepted at the state layer.** Not primarily for crash resilience: end-of-run reporting from the deploy's report hook could never cover more than three of the platform's eight resource types, and misses `deployment` — the type that makes the platform maintain the build↔app link — entirely.
- **D3 — the build id reaches the apply through the environment** (`PRISMA_BUILD_ID` on the alchemy child), so the child reads one variable whether Composer created the build or CI did.

**Semantics**

- **D1 — Composer only ever reports `phase: deploy`.** Composer never builds the user's code (composer ADR-0005); `build` belongs to whoever ran the build.
- **D4 — no git metadata means no report.** `commitSha`/`branchName` are required fields; placeholders would sit in a workspace's history permanently. Prefer `GITHUB_SHA`/`GITHUB_REF_NAME`, fall back to git, skip with a warning outside a checkout.
- **D5 — GitHub Actions runs report `source: "ci"` with a run identity** from `GITHUB_REPOSITORY_ID`/`GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT` — that is what buys create-idempotency and the repository link. The platform owns the dedup key (`sourceEventIdForRun`) but reads no GitHub environment itself, so Composer, the Action, and the platform webhook must derive the identity from the same three variables or one run produces multiple builds.
- **D11 — the build records `appId`/`deployedUrl` only when the run deployed exactly one compute service.** The columns hold one value each; picking a service arbitrarily would imply it was the app's address. Multi-service apps lose nothing — every service is reported through the resources endpoint.
- **D8 — a killed process leaves a permanently `running` build, accepted.** Nothing sweeps builds; SIGINT/SIGTERM are caught (with a 1.5s budget so Ctrl-C never hangs), SIGKILL and torn-down runners cannot be.

**Scope**

- **D7 — `destroy` is not reported.** Only source of the `deleted` action, but `phase` has no teardown value and `source` cannot distinguish it — it would render as a deploy that deleted everything.
- **D9 — a direct `alchemy deploy` of the generated stack file reports nothing** (no CLI parent, no build; the state store skips resource reporting when `PRISMA_BUILD_ID` is absent).
- `prisma-composer dev` never reports — local providers, no token.
- **D6 — resolved.** The hand-written HTTP client that bridged the pre-SDK gap was deleted the day SDK 1.60.0 shipped; shapes are now derived from the SDK.

## Platform contract notes

The authoritative surface is `services/management-api/routes/v1/builds/` in pdp-control-plane (see its `docs/prisma-next-in-mgmt-api/builds.builds-surface.md`). Points this design leans on: the workspace comes from the token, never the body; `projectId`/`branchId`/`appId`/`deployedUrl` are fill-only on PATCH (409 on a genuine change, no-op on re-send) — which is why the `attach` call is separate, so a disagreeing creator costs those fields alone; resource reporting is an idempotent upsert whose action never weakens; reporting a created `deployment` also attaches it to the build and records the app, in one transaction.

## Non-goals

Publishing the GitHub Action; platform-side work beyond what topology-design.md names; the Alchemy state-store migration; Composer's auth rework.

## Definition of done

- A deploy against Prisma Cloud produces a build with the right phase, outcome and resources. ✓ **Verified live 2026-08-14**: `bld_cqdzjjlja99nmcd4f27bn69g` (dev workspace, storage example) — `source: cli`, `phase: deploy`, `state: succeeded`, correct branch and commit, project attached via the fill-only PATCH, `appId`/`deployedUrl` correctly absent (two services, D11), and 21 resource rows all `created`: 2 apps, 2 deployments, 1 database, 1 service_key, 15 config_variables. Two observations from the live run, neither blocking: the Project itself appears as no resource row, because the hosted flow creates it through the container step rather than the state store (the build's `projectId` carries the association); and `branchId` stays null on a default-stage deploy, since only named stages carry a branch id into `attach` — attaching the default Branch id is a possible refinement.
- A failing deploy shows its named cause and human detail. ✓ (fake-API and pipeline tests)
- A reporting outage does not fail the deploy. ✓
- The JSON report is emitted, versioned, parseable, written on failure. ✓
- No git → deploys normally, reports nothing, says why. ✓
- `dev` and direct `alchemy deploy` report nothing. ✓
