# State Under Branch — Project Plan

## Summary

**One slice** — ADR-0033 and its implementation in one PR
([#113](https://github.com/prisma/composer/pull/113)). The binding design it
executes is [design-notes.md](design-notes.md).

This started as two strictly-sequenced slices (ADR first, then code) on the
reasoning that principles bind until an ADR supersedes them. That was wrong:
it produces a docs-only PR, which delivers nothing on its own and costs a
review cycle to say so. Operator direction, 2026-07-17: *"Don't separate docs
and implementation. A docs PR on its own is useless."* The ADR half is already
written, reviewed, and approved on #113; the implementation lands on the same
branch before it merges.

**Spec:** [spec.md](spec.md) · **Design notes:** [design-notes.md](design-notes.md)

## Tracker

Slices are identified by their S-number here; this plan is the source of
truth. Linear issues are created per-slice when the slice starts, not during
planning. Tracker project:
[Prisma Composer: State Under Branch](https://linear.app/prisma-company/project/prisma-composer-state-under-branch-5754597a6981).

## External dependencies

- ~~**PDP team answers**~~ — both resolved from source 2026-07-17, no ask
  outstanding; see design-notes § Resolved questions. Quota is a real
  constraint (a state DB per stage takes one of the workspace's 50 free /
  1000 paid database slots); billing is negligible (no per-database fee).
  Project deletion is blocked only by active compute deployments — never by
  Branches or databases.
- **`@prisma/management-api-sdk` types** — the implementation needs `branchId` +
  `region: 'inherit'` admitted on database create (or falls back to the
  documented create-then-PATCH; a stale region union requires an SDK update,
  never a hard-coded region). Verified against the live API source; only the
  generated types may lag.

## The slice — State under Branch (TML-3049, PR #113)

Two halves of one PR, in this order on the branch.

### Half 1 — ADR-0033 + documentation corrections — DONE, APPROVED

ADR-0033 ("Deploy state lives in the stage's Branch"); ADR-0009 marked
superseded; the consequence note on ADR-0010 (lock scoped within the per-stage
DB; severed-lock kill-switch property; redundant key retained) and the
correction note on ADR-0024 (resources land on the platform's implicit default
Branch; addressing model unchanged); the cutover note in
`docs/guides/deploying.md`; `docs/design/10-domains/deploy-cli.md`'s state
section and the ADR index. The staleness sweep also reached ADR-0011,
ADR-0023, ADR-0030, `layering.md`, and `alchemy-lowering.md`.

### Half 2 — Per-branch state bootstrap + destroy ordering

Implement design-notes § The design, exhaustively: bootstrap rework in
`packages/1-prisma-cloud/0-lowering/lowering/src/state/`, `prismaState()` env
contract change, `deleteStateDatabase`, and the CLI destroy-tail ordering in
`packages/0-framework/3-tooling/cli/src/main.ts`. Tests reworked/added per
[slices/per-branch-state/spec.md](slices/per-branch-state/spec.md).

- **Builds on:** half 1, already on the branch.
- **Hands to:** project close-out; the successor project's precondition
  (project-scoped state) is now true.

Nothing here merges until both halves are on #113 and green.

## Successor project (recorded, not started): Compute GitHub App integration

Out of scope for this project by operator decision (2026-07-17), to be opened
as its own Drive project afterwards. Recording the settled inputs so shaping
starts warm:

**Goal.** Push-to-deploy for Composer repos through pdp-control-plane's
existing GitHub App pipeline (webhook → build-runner → E2B sandbox), with the
sandbox running the user's declared build + `prisma-composer deploy` instead
of the `BuildStrategy` pipeline.

**Already settled in discussion** (transcript
`0feb1bb2-7810-4fd6-9cbb-7d348f8c32f0` + continuation):

- The webhook service, repo↔Project link (`ProjectScmRepo`), Branch
  resolution, `Build` row lifecycle, sandbox spawning, and log streaming are
  reused unchanged; the runner's kickoff/finalize legs (App find-or-create,
  ComputeVersion + presigned upload, Foundry start/promote) are skipped for
  Composer builds — the CLI performs versions/promote itself.
- Composer detection must be deterministic (repo-link flag or
  `prisma-composer.config.ts` presence), never inferred.
- `Build.appId`/`deploymentId` stay null for Composer builds;
  `computeProjectId` is the scope; two pdp consumers need re-scoping
  (failure-email cron, setup-activation notifications).
- Branch-delete teardown needs no Composer involvement — this project's
  containment model makes the platform's existing enumerate-and-delete
  correct, and deleting the state DB severs in-flight deploys' locks.

**Open design points carried forward** (the hard ones first):

1. Per-build credential: short-lived **project-scoped** service token minted
   by the control plane into the sandbox — machinery and Management API
   scoping support don't exist yet (PDP dependency).
2. Where the `{ entry, build command }` declaration lives (Composer-side ADR;
   ADR-0017 currently forbids app settings in `prisma-composer.config.ts`).
3. Supersede-vs-lock ordering: runner must kill the old sandbox (dropping its
   lock connection) before dispatching the successor, plus a short acquire
   retry.
4. Pinned-id deploy mode: CLI accepts pinned Project/Branch ids and fails
   rather than find-or-creates (closes the delete/push resurrection race —
   GitHub webhook ordering is not guaranteed).
5. Stage seeding policy for `envParam`/`envSecret` on first webhook deploy of
   a fresh stage (likely: copy production's platform variables, else fail with
   a "set these in Console" build error).
6. Restrict webhook-managed apps to platform-backed extensions until a
   pre-teardown destroy-run exists (external-resource limitation).

## Close-out (required)

- [ ] Verify all acceptance criteria in [spec.md](spec.md) § Project-DoD
- [ ] Migrate long-lived docs into `docs/` (S1 lands them; verify nothing
      else accrued — the teardown matrix and cutover note must live in
      `docs/`, not here)
- [ ] Open the successor project from § Successor project above (or
      explicitly defer it with the operator)
- [ ] Strip repo-wide references to `.drive/projects/state-under-branch/**`
- [ ] Delete `.drive/projects/state-under-branch/`
