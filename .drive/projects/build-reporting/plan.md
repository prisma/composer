# Plan: Composer reports its builds to Prisma Cloud

Three slices, each one PR. Slice A is unblocked and lands first. B and C need the pdp-control-plane stack merged and an SDK release; the work can be written and unit-tested before that, but cannot be verified end to end until the routes are deployed.

## Sequencing

```
A. JSON report ─────────────────────► can start now, no dependencies
B. Build lifecycle ─────────────────► needs #4853 → #4850 → #4855 merged
   └─ C. Resource reporting ────────► needs B (build-id plumbing)
```

The handed-off anchor amendment to #4855 blocks only the anchor-filling behaviour inside B. B can land without it and gain anchors in a follow-up if the amendment is declined.

---

## Slice A — the JSON report the Action reads

**Why first.** It depends on nothing, and it is what unblocks Action development in parallel with everything else.

**Starting point.** Most of the mechanism exists. `DeploymentSummary` in [deployment-summary.ts](packages/0-framework/3-tooling/cli/src/deployment-summary.ts) is already written by the report hook inside the alchemy child, to a per-run file named by `PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE`, and read back by the parent. It is an internal cross-process protocol, not a public contract.

**What changes.**

- A version field, so the Action can depend on the shape.
- The failure cause on the failure path. Today the file is written only by the report hook, which runs at the end of a successful apply — a failed deploy produces no file at all. The parent must write one carrying the error code and message.
- A user-facing way to ask for it: a flag or an env-var-named path, distinct from the internal per-run file the parent already deletes in its `finally`.
- Documentation of the shape, and a test that fails when it changes incompatibly.

**Care needed.** The internal file is deleted after every run, including on failure, specifically so resource ids and URLs do not accumulate on disk. The user-facing output must be a separate path that survives, without reintroducing that accumulation for people who did not ask for it.

**Verification.** Deploy an example app, parse the emitted file, assert the preview URL is present. Force a failure, assert the file exists and names the cause.

---

## Slice B — the build's lifecycle

**Scope.** Git identity, create-or-join, progress reporting, terminal reporting, and the guarantee that none of it can fail a deploy.

**Where it lives.** `runStackPipeline` in [execute-deploy-destroy.ts](packages/0-framework/3-tooling/cli/src/operations/execute-deploy-destroy.ts), which runs in the CLI's own process where async work is easy and where every failure path already funnels through one place. Reporting wraps it rather than threading through it.

**Sequence.**

1. Resolve git identity. No git, no reporting (D4).
2. Join `PRISMA_BUILD_ID`, or create a build — `source: "ci"` with a `runIdentity` under GitHub Actions, `source: "cli"` otherwise (D5). Created before the pipeline runs, so a bootstrap failure that orphans a project (composer#103) is recorded.
3. `phase: deploy`, `state: running`.
4. Fill `projectId` and `branchId` once `container.ensure()` resolves them — pending the anchor amendment.
5. Terminal `state`, `failingStep` and `errorMessage` on every exit path, including thrown errors and signals.

**Care needed.**

- Failures are values here, not throws — `runStackPipeline` returns a `Result` — but non-structured errors still rethrow, so the wrapper needs both branches plus a `finally`.
- `failingStep` truncates at 500 characters, `errorMessage` at 5000.
- Every mid-apply failure collapses into `DEPLOY.ENGINE_FAILED` with the message "alchemy deploy exited with status N". The report will be honest but coarse, and nobody should expect the Console to explain why an apply failed. Improving that is separate work.
- The signal handler for Ctrl-C and SIGTERM must not delay process exit if the platform is unresponsive.

**Verification.** Unit tests against a fake API for each path: joined build, created build, each failure code, and a platform that refuses every call. One end-to-end deploy once the routes are live.

---

## Slice C — resource reporting

**Scope.** One `PUT` per platform resource, reported as the run touches it, intercepted at the state layer (D2).

**Where it lives.** The state layer in `packages/1-prisma-cloud/0-lowering/lowering/src/state/`. It is alchemy's stock `makeHttpStateStore`, so this wraps the `State` service rather than modifying a store we own. It reads `PRISMA_BUILD_ID` from the environment (D3) and does nothing when it is absent (D9).

**The mapping.** Composer's Alchemy resources onto the platform's eight types:

| Alchemy resource | Platform type | Action |
| --- | --- | --- |
| `Prisma.Project` | `project` | `created` when this run created it; **not reported when adopted** |
| `Prisma.Database` | `database` | `created` / `acted_on` |
| `Prisma.Connection` | `service_key` | `created` / `acted_on` |
| `Prisma.Bucket` | `bucket` | `created` / `acted_on` |
| `Prisma.ComputeService` | `app` | `created` / `acted_on` |
| `Prisma.Deployment` | `deployment` | `created` — also makes the platform attach the deployment and record the app |
| `Prisma.EnvironmentVariable` | `config_variable` | `created` / `acted_on` |
| `Prisma.BucketKey` | — | not reported; no platform type corresponds |
| `PgWarm` and any non-Prisma resource | — | not reported |

Branch has no Alchemy resource of its own; it is resolved by the container, so it is reported only as the build's anchor, not as a touched resource.

**Care needed.**

- State holds a record for every resource in the stack, including ones this run left untouched. `acted_on` is still correct for those — the run reconciled them — but an adopted project must be excluded, per the rule that resolving is not acting.
- Reports must not serialise behind each other, or a large apply pays a round trip per resource.
- The resource must already exist in the workspace or the `PUT` returns 404. Reporting therefore has to happen after the resource is created, not before.
- The route caps its body small and rate-limits at the `high` tier, sized for exactly this burst.

**Verification.** Unit tests over the mapping table, including the adopted-project exclusion. An end-to-end deploy asserting the reported set matches the resources the run actually created, once the routes are live.

---

## Open decisions

Recorded in `spec.md` as D4, D5, D6 and D7, all taken by the orchestrator and all reversible. If any is wrong, the cheapest time to say so is before slice B starts.

## Not verifiable yet

Nothing can be tested against a live API until #4855 and its stack merge and deploy. Slices B and C will land with fake-API tests, and the definition of done stays unmet until one real deploy has been observed in the Console.
