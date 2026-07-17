# Design notes — State Under Branch

Running design record. The decision here becomes **ADR-0033** at slice S1; this
file is the exhaustive implementation-grade design the slices execute against.
It is written to leave zero interpretation gaps: where a choice existed, the
choice is made and recorded here.

Settled in operator/agent discussion 2026-07-17 (session
`0feb1bb2-7810-4fd6-9cbb-7d348f8c32f0` and its continuation), including two
corrections sourced from the PDP team (see § Verified platform facts, items
1–2).

## The decision

Each stage's Alchemy deploy state lives in a **framework-owned Prisma Postgres
database attached to that stage's own Branch**, inside the app's own Project.
Production's state database attaches to the Project's **implicit default
Branch** (a platform invariant — every live Project owns one). The
workspace-level `prisma-composer-state` Project is retired.

Consequence: state has exactly the lifetime of the environment it describes.
Deleting a Branch — by GitHub webhook, by Console, or by the CLI — deletes the
stage's state with it, without the platform knowing Composer exists. Deleting
the Project deletes everything. This supersedes
[ADR-0009](../../../docs/design/90-decisions/ADR-0009-deploy-state-is-hosted-in-the-workspace.md).

### Why the inputs changed (the supersession case, not a relitigation)

ADR-0009 rejected "state inside the app's own project" on two grounds:

1. **Circularity** — "the project is created and destroyed *by* the deploys
   whose state it would hold." Dissolved by ADR-0023/0024: `ensure-containers`
   creates the Project and Branch via the Management API **before** Alchemy
   runs, and deletes them **after** destroy, entirely outside state
   ([ensure-containers.ts](../../../packages/0-framework/3-tooling/cli/src/ensure-containers.ts)).
   The container lifecycle is already framework-managed; a state store
   bootstrapped in the container-ensure phase is container-scoped
   infrastructure, not a circular dependency.
2. **Fragmentation** — workspace-level questions (list all stacks, cross-stack
   references, fresh-machine bootstrap) want one place to look. Neither feature
   exists today; "list Projects" is a Management API query the platform owns;
   and bootstrap discovery gets *simpler* (resolve Project/Branch by id instead
   of scanning same-named candidate projects).

Two forces that did not exist when ADR-0009 was written now push the other way:

- **Teardown correctness.** Platform-side Branch/Project deletion (Console
  today; GitHub-webhook branch-delete in the successor project) orphans
  workspace-hosted stage state. Under containment every platform teardown path
  is correct by construction — the state database is an ordinary enumerable
  platform child.
- **Credential scoping** (successor project). A webhook build against a
  workspace-hosted store needs a workspace-scoped token in an untrusted
  sandbox; with in-project state, everything a deploy touches is
  project-scoped.

## Verified platform facts

Everything below was read from source on 2026-07-17. **Read the checkout in
this worktree (`./pdp-control-plane`, at `e79d07bd8`), not
`~/Projects/prisma/pdp-control-plane`** — the home checkout is older
(`b44a38615`) and already diverges: `deleteProject` has moved to its own file
and the offer-limit enforcement has flipped to Prisma Next. Facts 1–6 below
were originally taken from the home checkout and have since been re-verified
against the worktree copy; `resolveDefaultOrPinnedBranchId` (fact 1, the one
the whole design rests on) is byte-identical in both, invariant comment
included.

1. **Resources always belong to a Branch.** `POST /v1/compute-services` and
   `POST /v1/projects/{projectId}/databases` resolve an omitted `branchId` to
   the project's **default Branch** via `resolveDefaultOrPinnedBranchId`
   (`packages/interactors/src/branch/resolveDefaultOrPinnedBranchId.ts`), whose
   doc comment states the invariant: "every live Project is supposed to own
   one (the post-#3902 invariant + the production backfill)." A project with
   no live default Branch is a recoverable data error, not a supported state.
   The nullable `branchId` schema columns and the link-time
   `updateMany({ branchId: null } → defaultBranchId)` sweep
   (`packages/interactors/src/scm/linkProjectToScmRepo.ts:241-254`) are
   backfill remnants, **not** the live contract. (Confirmed directly with the
   PDP team 2026-07-17.)
2. **Production therefore already lives on a Branch.** Composer's ADR-0024
   phase 1 "ensures only the Project" and the lowering omits `branchId` for
   the default stage — but the platform lands those resources on the implicit
   default Branch. ADR-0024's *addressing* model is unchanged; its "lives at
   the Project level" wording gets a correction note (S1).
3. **Database create accepts branch + inherited region.**
   `POST /v1/projects/{projectId}/databases` accepts optional
   `branchId`/`branchGitName` (mutually exclusive) and
   `region: "inherit"` = "use the project default database region"; `region`
   defaults to `us-east-1` (`services/management-api/routes/v1/databases.ts:397-537`).
   Composer's own `Database` provider today creates then attaches via
   `PATCH /v1/databases/{databaseId}` `{ branchId }`
   ([Database.ts:56-77](../../../packages/1-prisma-cloud/0-lowering/lowering/src/postgres/Database.ts)).
4. **Database list is branch-filterable and branch-attributed.**
   `GET /v1/projects/{projectId}/databases` accepts `branchId` /
   `branchGitName` query filters and each row carries `branchId`
   (`services/management-api/routes/v1/databases.ts:227-371`).
5. **Branch deletion via the Management API refuses live members.**
   `DELETE /v1/branches/{branchId}` "refuses if the Branch still has live
   members or is the production/default Branch"
   ([container.ts:166-179](../../../packages/1-prisma-cloud/0-lowering/lowering/src/container.ts));
   `Database.branchId` is `onDelete: Restrict` in the platform schema.
6. **Platform teardown is enumerate-and-delete, best-effort, cron-backstopped.**
   The GitHub branch-delete webhook path
   (`services/github-webhook/webhook-handlers/handleDelete.ts` →
   `tearDownBranchByGitName` → `deprovisionBranchDatabases`) soft-deletes the
   Branch first, then deletes each App/version, each **non-default** database
   (tenant then row; `where: { branchId, isDefault: false }`), and non-production
   config vars. It refuses default and production branches. Console project
   deletion (`packages/interactors/src/project.ts:314` `deleteProject`)
   refuses while deployments are active, then deletes **all** the project's
   database tenants (all branches) before removing the project.
7. **`deleteAppProject` works today against a project that has its implicit
   default Branch and auto-provisioned default database** — the API's
   dependency check tolerates those implicit children (observed: "Removed the
   Project — nothing was left in it" on hand-run stacks). A non-default
   database (our state DB) **is** expected to count as a dependency. Open
   question OQ-2 asks PDP to confirm the contract.
8. **Container ids already reach the state layer's process.** `runAlchemy`
   sets `PRISMA_PROJECT_ID` (always) and `PRISMA_BRANCH_ID` (named stages
   only) on the alchemy child
   ([run-alchemy.ts:55-58](../../../packages/0-framework/3-tooling/cli/src/run-alchemy.ts)),
   where `prismaState()`'s layer runs.

## Current implementation inventory (what changes, what doesn't)

All in `packages/1-prisma-cloud/0-lowering/lowering/src/state/` unless noted.

| Surface | Today | Under this design |
| --- | --- | --- |
| `bootstrap.ts` `resolveStateProject`, `listStateProjects`, `listAllProjects`, `createStateProject`, `bareWorkspaceId`, `findDefaultDatabase`, `STATE_PROJECT_NAME` | find-or-create workspace project by name, adopt its default DB | **Deleted.** Replaced by branch-scoped database find-or-create (§ Bootstrap) |
| `bootstrap.ts` `verifyOwnership`, `OwnershipVerdict`, `mintConnection`, `cleanupAgedConnections`, `listAllConnections`, `deleteConnection` | ownership marker check; fresh connection per run; aged-connection GC | **Retained**, re-pointed at the per-branch database |
| `schema.ts` (`migratePrismaState`, `STATE_META_MARKER`, tables `alchemy_resource_state`/`alchemy_stack_output`/`prisma_app_state_meta`) | idempotent DDL + marker | **Unchanged.** The `stack`/`stage` key columns become redundant inside a per-stage DB; keeping them means zero store-code changes and zero migration risk. Do not remove them. |
| `lock.ts` (ADR-0010 session advisory lock keyed `hash(stack, stage)`) | serializes deploys per app+stage on the shared store | **Unchanged.** Key is redundant inside a per-stage DB; harmless. New emergent property recorded in ADR: deleting the state DB severs the lock connection, so an in-flight deploy of that stage fails its lease check within the trust window — platform teardown doubles as a kill switch. |
| `service.ts`, `errors.ts`, `transient.ts` | store CRUD, error wrapping | **Unchanged** |
| `layer.ts` `prismaState()` | requires `PRISMA_WORKSPACE_ID`; bootstrap by workspace | Requires `PRISMA_PROJECT_ID`; optional `PRISMA_BRANCH_ID` (§ Bootstrap). `workspaceId` option and its env fallback are deleted. |
| CLI `main.ts` destroy tail (steps after alchemy exit 0) | `deleteStageBranch` (named stage) / `deleteAppProject` (production) | New step **before** each: delete the stage's state database (§ Destroy ordering) |
| `ensure-containers.ts` | resolve/delete containers | gains `deleteStateDatabase` wiring (the implementation lives in lowering; see § Destroy ordering) |

## The design, exhaustively

### Constants

- State database display name: `prisma-composer-state` (reuse the existing
  constant value; rename the constant `STATE_PROJECT_NAME` →
  `STATE_DATABASE_NAME`).
- Marker value `STATE_META_MARKER = 'prisma-composer-state-v1'` — unchanged
  (the marker proves ownership of a *database*; nothing in it encodes
  workspace-vs-branch placement).
- Connection-name prefix and 24 h GC threshold — unchanged.
- The state database is **never** created with `isDefault: true` and never
  adopts a database whose `isDefault` is true (two reasons: the platform's
  webhook teardown only auto-deletes `isDefault: false` databases, and the
  default database is the user's).

### Bootstrap (replaces `resolveStateProject`)

`bootstrapStateConnection` signature changes from `(workspaceId)` to
`(input: { projectId: string; branchId?: string })`. `prismaState()` reads
`PRISMA_PROJECT_ID` (throw the existing-style error if missing/empty:
`` `prismaState(): environment variable PRISMA_PROJECT_ID is required (the CLI sets it — deploy via \`prisma-composer deploy\`).` ``)
and `PRISMA_BRANCH_ID` (optional; empty string = absent). The test seam
(`bootstrapStateConnectionWith`, injectable `OwnershipVerifier`) is preserved.

Algorithm, in order:

1. **Resolve the target branch id.**
   - `branchId` provided (named stage): use it as-is.
   - `branchId` absent (default stage / production): resolve the project's
     default Branch — `GET` the project's branches (the same endpoint family
     `resolveBranch` in `container.ts` already pages through), select the
     branch with `isDefault: true`. Exactly this filter; not "first", not
     "role production". If none exists, fail with a `PrismaApiError`-wrapped
     message: `` `project ${projectId} has no default Branch — the platform guarantees every live Project owns one; contact support.` ``
     Do not create a Branch here under any circumstances.
2. **List candidates.** `GET /v1/projects/{projectId}/databases` with query
   `branchId: <resolved>` (paged, as `listAllDatabases` pages today), filtered
   to `name === STATE_DATABASE_NAME` and `isDefault === false`.
3. **Zero candidates → create.**
   `POST /v1/projects/{projectId}/databases` with body
   `{ name: STATE_DATABASE_NAME, region: 'inherit', branchId: <resolved> }`.
   If the generated `@prisma/management-api-sdk` types do not admit `branchId`
   or `region: 'inherit'` in that body yet, use the same two-step the
   `Database` provider uses today: create with
   `{ name, region: 'inherit' }` then
   `PATCH /v1/databases/{databaseId}` `{ branchId: <resolved> }` — and if
   `'inherit'` is also not in the SDK's region union, regenerate/update the SDK
   dependency rather than hard-coding a region; hard-coding a region literal is
   forbidden. Then mint a connection (§ below) and return — a brand-new
   database needs no ownership check (only this run can have touched it;
   `migratePrismaState` writes the marker on first use). Log (to stderr, and
   without bare create/update verbs — the e2e noop assertion greps deploy
   output for them):
   `` `hosted state: provisioned state database ${databaseId} on branch ${branchId} (project ${projectId})` ``.
4. **One or more candidates → verify, oldest first.** Sort by `createdAt`
   ascending (add `createdAt` to the summary selection; the list response
   carries it). For each: mint a connection, run `verifyOwnership`:
   - `ours` → adopt.
   - `empty` → adopt (freshly provisioned earlier run that died before
     migrating).
   - `legacy` → adopt (cannot occur on a per-branch DB in practice — legacy
     shape lives in the workspace store — but adoption is harmless and keeps
     the verifier unchanged).
   - `squatter` → record and skip.
   Log on adopt:
   `` `hosted state: using state database ${databaseId} on branch ${branchId} (${verdict.kind}) — ${candidates.length} candidate(s) named ${STATE_DATABASE_NAME}` ``.
5. **All candidates squatters → fail** with a message naming every rejected
   database id and its foreign tables, and the remedy:
   `` `found N database(s) named "prisma-composer-state" on branch ${branchId}, but none verified as Composer's state store: <list>. Rename or remove the offending database(s).` ``
   Never create a second same-named database next to a squatter.
6. **Connection minting and GC** — unchanged in mechanism
   (`mintConnection` fresh per run reading `endpoints.direct.connectionString`
   only; `cleanupAgedConnections` best-effort against the resolved state
   database id).

The layer sequence in `prismaState()` after bootstrap is byte-for-byte today's:
pool (`max: 5`), finalizer, `migratePrismaState` with the 2-minute
fresh-database retry schedule, `acquireStateLock(sql, stack.name, stack.stage)`,
lease-guarded service, `Layer.orDie` with `hostedStateBootstrapError` wrapping.
The bootstrap-error step strings change to name the new steps
(`'resolving the state database on the stage branch'` for steps 1–5).

### Destroy ordering (CLI `main.ts` + lowering)

New exported operation in lowering (`state/` or next to `container.ts` —
implementer's choice of file, the seam is what's fixed):
`deleteStateDatabase(input: { projectId: string; branchId?: string })`, which:

1. Resolves the branch id exactly as bootstrap step 1.
2. Finds candidates exactly as bootstrap step 2, sorted as step 4.
3. For each candidate: mint connection, `verifyOwnership`; on `ours`,
   `legacy`, or `empty` → `DELETE /v1/databases/{databaseId}` (tolerate 404),
   log `` `removed state database ${databaseId} from branch ${branchId}` ``,
   and continue through remaining candidates (duplicates from a crashed run
   are all ours to remove). `squatter` → leave it, log a warning naming it.
4. Zero candidates → no-op success (idempotent; a retried destroy after a
   partial run lands here).

Ownership verification before deletion is **mandatory** — deleting by name
alone would destroy a user database that happens to share the name, which is
exactly the guessing ADR-0005 bans.

`main.ts` step 9's destroy tail becomes:

```
if destroy && exit 0:
  named stage:  await deleteStateDatabase({ projectId, branchId })   // throws CliError on failure
                await deleteStageBranch({ branchId })                 // unchanged
  production:   await deleteStateDatabase({ projectId })              // warn-and-continue on failure
                await deleteAppProject({ projectId })                 // unchanged
```

Failure semantics, deliberately asymmetric:

- **Named stage: throw.** If the state DB can't be deleted, `deleteStageBranch`
  would fail anyway (live member, fact 5); failing at the state step names the
  actual cause. The command is retryable end-to-end: re-run destroy → alchemy
  destroys nothing (state already empty or DB absent → bootstrap provisions an
  empty store, destroy over empty state is a no-op) → state delete no-ops or
  completes → branch delete proceeds. Every crash window between alchemy
  success and branch deletion converges on retry.
- **Production: warn and continue.** `deleteAppProject` is already best-effort
  ("failing the command over a cleanup step would be worse than leaving a
  Project shell"); the state step inherits that stance. If state deletion
  failed, `deleteAppProject` reports "Kept the Project — it still has another
  stage's resources", which is now accurate in spirit; the warning from the
  state step tells the operator what actually remains.

Ordering rule, recorded in the ADR: **the CLI deletes state last among the
stage's members it destroys itself, and before the container** — Alchemy
destroy reads state, so state must outlive every managed resource; the
container delete refuses while state remains. The platform's own teardown
paths are the opposite (state DB deleted like any child, in arbitrary order) —
correct for them, because they enumerate platform children and never read
Composer state, and deleting the state DB early severs in-flight deploys'
locks (the kill-switch property).

### What is deliberately unchanged

- **Store schema and lock** (see inventory table) — including the redundant
  `stack`/`stage` columns and lock key.
- **`ensure-containers` deploy path** — the default stage still ensures only
  the Project (ADR-0024 addressing unchanged); resource lowering still omits
  `branchId` for production (the platform's implicit default Branch receives
  them, fact 1). Only *state* resolves the default branch explicitly, read-only.
- **Credentials contract** — `PRISMA_SERVICE_TOKEN` everywhere;
  `PRISMA_WORKSPACE_ID` still required by the CLI (`ensure-containers`
  resolves the Project by name within the workspace); it is only the *state
  layer* that stops needing it.
- **`transient.ts` / non-hosted stores** — untouched (ADR-0011: targets supply
  the state layer; only what `prismaState()` constructs changes).

### Legacy workspace store: manual cutover, no migration code

Decision: **no automated migration.** The store is dogfood-stage; the only
known real deployment is the datahub port (forcing-function-apps S4, not yet
cut over to production use). Redeploying an existing app under the new store
with empty state would make providers re-create live resources (duplicates /
409s), so the documented cutover is:

1. On the **old** framework version: `prisma-composer destroy` each stage,
   then `--production` (tears down resources using the workspace store).
2. Upgrade the framework.
3. Deploy again (fresh state provisions per branch).
4. Delete the now-idle `prisma-composer-state` Project(s) from Console at
   leisure — nothing reads them after the upgrade.

The `legacy` ownership verdict and `migratePrismaState`'s marker-on-adopt
behavior are retained solely so an in-place workspace-store database never
breaks mid-transition; they are not a migration path. This procedure goes in
the deploying guide's upgrade note (S1).

### Teardown-path matrix (the containment audit, recorded for the ADR)

| Path | Mechanism | Outcome |
| --- | --- | --- |
| CLI `destroy --stage` | alchemy destroy (reads state) → delete state DB → delete Branch | Correct; every crash window retry-converges |
| CLI `destroy --production` | alchemy destroy → delete state DB (warn-only) → best-effort project delete | Correct; project shell only if state delete failed, with a warning naming it |
| Console branch delete / webhook branch delete (successor project) | platform enumerates Branch children; state DB deleted like any non-default database; cron backstop for stragglers | Correct by construction; no Composer involvement; severed lock kills in-flight deploys within the lease window |
| Console project delete | refuses while deployments active; deletes all tenants incl. every state DB | Correct by construction |
| Workspace delete | cascades projects | Correct |
| User manually deletes a state DB | resources orphaned from state; next deploy provisions fresh empty state and re-creates resources (duplicates/conflicts possible) | Same exposure class as today's deletable state project, smaller blast radius (one stage). Accepted; platform ask filed for a framework-owned/protected flag (platform-ask.md) |
| Branch/Project deleted while a deploy is in flight | teardown deletes state DB → lock lease check fails within its trust window → deploy halts | Bounded, accepted; full policy work belongs to the successor project |
| Resources provisioned outside Prisma Cloud (future non-platform extensions) | platform teardown deletes the state DB — the only record of external resources | **Documented limitation** in the ADR: platform-side teardown covers platform resources only; graphs with non-platform resources must be destroyed via the CLI |

### Resolved questions (answered from source 2026-07-17; no PDP ask needed)

Both were answered by reading the newer pdp-control-plane checkout in this
worktree (`e79d07bd8`). `assets/pdp-asks.md` is retained only as the record of
what was asked and why; nothing is outstanding with the PDP team.

- **OQ-1 — quota: real; billing: negligible.**
  - *Quota:* the plan's `createDatabase` offer is a **workspace-wide database
    cap**, counted as `prisma.database.count({ where: { project: {
    organizationId: workspaceId } } })` — every database in every project of
    the workspace, so each stage's state database consumes one slot. Limits:
    **50** (free — `FREE_PLAN_DATABASE_LIMIT`), **1000** (starter/pro/business/
    enterprise — `PAID_PLAN_DATABASE_LIMIT_DEFAULT`), 5000 (partner entry);
    `packages/billing/src/domain/limits/constants.ts`, enforced in
    `services/management-api/models/helpers/offerLimitHelpers.ts`.
  - *Billing:* `createDatabase` carries a **limit but never a price** in any
    plan — there is no per-database fee or floor. Postgres bills on usage:
    storage in GiB-hours ($0.00278/GiB-hour beyond 720 GiB-hours ≈ 1 GiB for a
    30-day month) and queries ($0.0018 beyond 100k/cycle). A state database
    holding a few rows of JSON, queried only during deploys, rounds to
    nothing.
  - *Conclusion:* the cost of a per-stage state database is **a quota slot, not
    money**. Relevant only to a free-plan workspace running many concurrent PR
    stages (50 databases total, and the app's own databases compete for the
    same pool). Worth a line in the ADR's consequences, not a design change.
- **OQ-2 — only active compute deployments block project deletion.**
  `deleteProject` (`packages/interactors/src/project/deleteProject.ts`) checks
  auth, calls `guardNoActiveDeployments(projectId)`, syncs Stripe usage,
  **deletes every one of the project's database tenants itself**, then calls
  `projectRepository.deleteWithGuard`, which re-checks for a live `Deployment`
  (ComputeVersion) on any of the project's Apps, soft-deletes the Apps, and
  hard-deletes the Project row (children cascade). **Neither Branches nor
  databases — default or not — ever block it**; the schema comment on
  `App.branchId` says so outright ("Project hard-delete now cascades through
  ComputeService so branch membership does not block it"). The 400 that
  `deleteAppProject` relies on comes from *another stage's live compute
  versions*, which is exactly the semantic it wants.

  **This corrects an earlier claim of mine** ("the production state DB is
  always a dependency, so empty projects would accumulate") — false. A project
  delete would take the state database with it. The production state-delete
  step therefore stays, but for a different reason: when the project delete is
  *refused* because another stage is live, production's state database would
  otherwise outlive production and hold a quota slot. It is tidiness plus
  quota, not a precondition. The named-stage step **is** a precondition and is
  unaffected: `DELETE /v1/branches/{branchId}` genuinely refuses a Branch with
  live members (`Database.branchId` is `onDelete: Restrict`).

## Key decisions log

1. **Containment model** (operator, 2026-07-17): one branch holds its own
   state, production included; delete the branch → stage and state go
   together; delete the project → everything goes.
2. **Production state rides the implicit default Branch** (operator + PDP
   correction, 2026-07-17): no branchless special case exists on the platform;
   no Composer-side production Branch creation either — resolve, never create.
3. **CLI owns explicit state-DB deletion; platform delegation later**
   (operator, 2026-07-17): "We can add special handling for it in the CLI...
   we can delegate deleting the branch to the management API in future."
4. **Schema/lock unchanged** (agent proposal, operator-unchallenged): redundant
   keys are cheaper than a store rewrite and keep the diff reviewable.
5. **No migration code; manual cutover** (operator-ratified 2026-07-17).
6. **GitHub App integration explicitly out of scope**, recorded as the
   successor project in [plan.md](plan.md) § Successor project.

## References

- ADR-0009, ADR-0010, ADR-0011, ADR-0012, ADR-0023, ADR-0024
  (`docs/design/90-decisions/`)
- `packages/1-prisma-cloud/0-lowering/lowering/src/state/{bootstrap,layer,schema,lock}.ts`
- `packages/1-prisma-cloud/0-lowering/lowering/src/{container,postgres/Database}.ts`
- `packages/0-framework/3-tooling/cli/src/{main,ensure-containers,run-alchemy}.ts`
- pdp-control-plane: `services/management-api/routes/v1/databases.ts`,
  `packages/interactors/src/branch/{resolveDefaultOrPinnedBranchId,tearDownBranchByGitName}.ts`,
  `packages/interactors/src/scm/linkProjectToScmRepo.ts`,
  `packages/interactors/src/project.ts`,
  `services/github-webhook/webhook-handlers/{handleDelete,deprovisionBranchDatabases}.ts`
- Discussion transcript: `/Users/will/claude-other/rendered/0feb1bb2-7810-4fd6-9cbb-7d348f8c32f0.md`
