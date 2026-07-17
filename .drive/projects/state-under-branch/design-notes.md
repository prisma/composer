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
3. **Two different database endpoints exist, and only the flat one speaks
   Branch.** Corrected 2026-07-17 after the implementer caught the original
   claim here being wrong — it attributed the flat endpoint's parameters to
   the project-scoped one.
   - **Project-scoped** `…/v1/projects/{projectId}/databases`
     (`services/management-api/routes/v1/projects/databases.ts`): `GET` takes
     `{ cursor, limit }` **only** — no branch filter. `POST` takes
     `name`/`region`/`isDefault`/`source` and has **no `branchId` field**; its
     response even hard-codes `branchId: null`, which is a reporting bug, not
     the truth (see fact 3a).
   - **Flat** `…/v1/databases` (`services/management-api/routes/v1/databases.ts`):
     `GET` accepts `projectId` + `branchId`/`branchGitName` filters (mutually
     exclusive) and returns `branchId` and `createdAt` per row. `POST`
     (`FlatCreateDatabaseInputSchema`, ~:394) accepts `projectId`, `name`,
     `region` (including `"inherit"` = the project's default database region),
     `isDefault`, and `branchId`/`branchGitName` — **everything needed, in one
     call**.
   - **Use the flat endpoint for both discovery and creation.** See § Bootstrap
     step 3 for why the client-side create-then-`PATCH` two-step is rejected.
   - **The flat create is not atomic** (corrected 2026-07-17, second time this
     endpoint has caught us out — found by the reviewer). It is a *server-side*
     create-then-attach: `services/management-api/routes/v1/databases.ts:574`
     calls `createPrismaPostgresDatabase` **without** `branchId` (so by fact 3a
     the row is born on the default Branch), then `:629` calls
     `attachResourceToBranch` to move it and returns an HTTP error if that
     fails. The route's authors document the window themselves at `:526-530`
     and narrow it with a Branch pre-check at `:531-540`. Narrowed, not closed.
     What this buys over the client-side two-step is still decisive — one
     request instead of two, the Branch validated before the row exists, and no
     client-crash window between the two calls — but "atomic" was never true
     and must not be claimed.
3a. **A database created without a `branchId` lands on the default Branch —
   it is never branchless.** `createPrismaPostgresDatabase`
   (`packages/interactors/src/database.ts:1010-1027`) calls
   `getOrCreateDefaultBranch(tx, { projectId })` inside the create transaction
   and connects `branch: { connect: { id: branchId } }`. This is the database
   half of fact 1, verified directly rather than inferred from the
   compute-service path — and it is what makes the two-step create hazardous.
4. **Composer's own `Database` provider uses the project-scoped create then
   attaches** via `PATCH /v1/databases/{databaseId}` `{ branchId }`
   ([Database.ts:56-77](../../../packages/1-prisma-cloud/0-lowering/lowering/src/postgres/Database.ts)).
   That pattern predates this design; the state store deliberately does not
   copy it (§ Bootstrap step 3). Whether the provider itself should move to
   the flat single-call endpoint is a separate question — recorded under
   Follow-ups, not fixed here.
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
| `service.ts`, `transient.ts` | store CRUD, transient store | **Unchanged** |
| `errors.ts` | `hostedStateBootstrapError(workspaceId, step, cause)` | **One rename** (amended 2026-07-17): the error's only identifying field is `workspaceId`, and there is no workspace at this layer anymore. Carrying the project id in a field called `workspaceId` produces the operator-facing line "hosted-state bootstrap failed for workspace prj_x/br_y", which is simply false. Rename the field to `target` and pass `projectId` (or `projectId/branchId` for a named stage). The "unchanged" list protects the store's *behaviour*; it was never a licence to print a wrong noun. |
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
2. **List candidates.** `GET /v1/databases` (the **flat** endpoint — the
   project-scoped one has no branch filter, fact 3) with query
   `{ projectId, branchId: <resolved> }`, paged, filtered to
   `name === STATE_DATABASE_NAME` and `isDefault === false`.
3. **Zero candidates → create, in one call.**
   `POST /v1/databases` (the **flat** endpoint) with body
   `{ projectId, name: STATE_DATABASE_NAME, region: 'inherit', branchId: <resolved> }`.
   Never hard-code a region literal; if `'inherit'` is missing from the
   generated SDK's region union, update the SDK dependency and say so.

   **The client-side create-then-`PATCH` two-step is rejected** (amended
   2026-07-17). The project-scoped create has no `branchId` field, so a
   database made that way is born on the **default Branch** (fact 3a) and only
   moves on the follow-up `PATCH`. Two calls means two failure points plus a
   client-crash window between them.

   **What the flat endpoint actually buys, stated honestly** (corrected
   2026-07-17 after the reviewer read the route): not atomicity — it is a
   server-side create-then-attach with the same shape (fact 3). It buys one
   request instead of two, a Branch validated *before* the row exists, and no
   window in which our own process can die between create and attach. The
   window narrows to "the platform's attach failed after its create
   succeeded"; it does not vanish.

   **The residual, and why it is acceptable.** A failed attach strands a
   database named `prisma-composer-state` — empty, never migrated,
   `isDefault: false` — on the project's default Branch. Follow it through:
   a later *production* bootstrap resolves that same default Branch and lists
   it as a candidate. If production already has a real store, that store is
   older, wins the oldest-first tiebreak, and the stray is ignored. If
   production has no store yet, the stray verifies as `empty` and is adopted —
   which is **correct**: an empty state database on production's own Branch is
   exactly what production's bootstrap would have created. Either way there is
   no corruption and no wrong adoption. The real cost is junk: one stranded
   database per failed attach, each holding a quota slot (§ Resolved questions,
   OQ-1). That is worth accepting for a failure that requires the platform's
   own attach to fail after its own pre-check passed.

   Then mint a connection (§ below) and return — a brand-new database needs no
   ownership check (only this run can have touched it; `migratePrismaState`
   writes the marker on first use). Log to stderr using this wording:
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
| **Webhook branch delete** (successor project) and the **idle-preview reclaim cron** — both call `tearDownBranchByGitName` | soft-deletes the Branch row directly (bypassing the guarded delete), then enumerates and deletes apps, versions, non-default databases (incl. state), and non-production `ConfigVariable`s; cron backstop for stragglers | **Correct by construction** — verified live 2026-07-17. No Composer involvement; severed lock kills in-flight deploys within the lease window. This is the row the containment argument rests on. |
| **Console branch delete** — calls the guarded `deleteBranch` | `branch.repository.prisma.ts:122-131`'s `updateMany` requires `databases: { none: {} }` and `apps: { none: { deletedAt: null } }` | **Refuses (409 "Branch has live members")** — corrected 2026-07-17; the original row wrongly claimed this path cascades. Our state database is a database, so a deployed stage refuses here where a compute-only stage previously would not. Safe (nothing is orphaned), not silent, and the remedy is `destroy --stage`. But "delete the preview from Console" is not a working teardown for a Composer stage, and the ADR now says so. |
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

## The latency cost, measured (CI, 2026-07-17)

The design listed "first-deploy-of-stage latency for provisioning it" as an
unquantified cost. Measured on the passing CI run:

```
12:44:30.8  prisma-composer deploy starts
12:44:37.1  hosted state: provisioned state database …     ← 6.3s, whole bootstrap
12:44:57.4  Done: 20 succeeded                             ← 27s, whole deploy
```

**6.3 seconds** for the entire state bootstrap on a stage's first deploy —
resolve the Branch, list candidates, create the database, mint a connection,
migrate the schema, take the lock. Not the minute-plus I claimed. `pn-widgets`
end to end: **89s on this branch vs 92s on main**. There is no measurable
regression; the branch is marginally faster, which is noise.

**How I got this wrong, because the mistake is instructive.** Two e2e runs
timed out at exactly 3m22s. I read "52 seconds" as the state-database
provisioning time — it was the time from *job* start, which is checkout,
install and build, work both branches do identically. The deploy command hadn't
even started. I then built a causal story on that number ("two databases
provisioned end to end, roughly a minute each"), wrote it into ADR-0033's
consequences, raised the CI budget from 3 to 8 minutes to accommodate it, and
told the operator the decision had a per-preview latency cost. All of it false.

What actually happened: **a platform degradation window**. Three different
branches died between 12:18 and 12:26 — `spi-inversion` (failure), this branch
(timeout), `streams-minted-key` (failure) — and every run from 12:37 onward
succeeded, including this one. My two timeouts sat inside that window. The
timeouts were environmental and had nothing to do with this change.

The commit built on that story (`1e41f0e`) was dropped rather than reverted, so
the false claim never enters the ADR's record. The CI budget stays at 3
minutes, which the measurements say is correct.

**The lesson is the same one this project has now taught four times**, twice
against me: I asserted a cause from a number I hadn't checked the provenance
of. The implementer caught it on the endpoint contract, the reviewer caught it
on atomicity, and here CI caught it by passing. The pattern to break: when a
number supports a story, find out what the number measures *before* writing the
story down.

## The e2e budget is marginal — a real issue, separate from this change

Worth filing on its own honest evidence rather than smuggled in here: the 3
minute e2e budget has little headroom (the storefront-auth job took 119s of its
180s on a healthy run), so a slow platform window fails multiple branches at
once rather than running slow. That is a pre-existing flakiness question about
CI budgets and platform variance. It deserves its own change, with the
degradation-window data above as the argument — not a rationale invented to fit
a misdiagnosis.

## What the live run taught us that the tests could not (D3, 2026-07-17)

All four Project-DoD conditions passed against the real workspace, and it was
left clean. Three findings the unit tests could never have produced:

1. **There are two platform Branch-delete paths, not one** — see the teardown
   matrix. This corrected a wrong row in an already-approved ADR. The claim
   "platform-side teardown cleans state up" is true of the cascading path
   (webhook, reclaim cron) and false of the guarded one (Console), which
   refuses instead. Found only because the live run tried the Console's path
   and got a 409.
2. **A Branch's configuration and its state must die together.** Deleting a
   Branch's children by hand — resources and state, but not its preview-class
   `ConfigVariable`s — leaves variables whose `branchId` points at a deleted
   Branch, and the next deploy of that stage **fails**: it finds a reserved
   `COMPOSER_*` variable untracked in its (fresh) state and refuses to
   overwrite it. That refusal is correct — it is the guard doing its job — and
   the real cascading teardown deletes the config vars, so no platform or CLI
   path reaches this state. Only manual API surgery does. Recorded because the
   coupling is invisible until you break it.
3. **A failed deploy strands its containers.** `ensureContainers` runs *before*
   preflight, so a deploy that fails preflight (e.g. a missing `envParam`) has
   already created the Project, Branch, and default database. This is ordering,
   not luck, and it predates this slice — but it means "a failed deploy costs
   nothing" is false, and the quota arithmetic in § Resolved questions (OQ-1)
   should assume failed attempts leave residue until someone cleans it.

Also observed and worth keeping: the documented convergence window is real. A
`destroy --production` against a project that never had a production deploy
provisions a state database purely so it can destroy over empty state and
delete it seconds later. Correct, and cheap; noted so nobody reads it as a bug.

## Known limit of the test suite (recorded, accepted)

The residual accepted in § Bootstrap step 3 — the platform's attach failing
after its own create succeeded, stranding an empty database on the default
Branch — **cannot be regression-tested as the fake stands.** The fake models
`POST /v1/databases` as one step, because from the client's side it *is* one
call; the two-step is the platform's business. So no test reaches the
failed-attach outcome. That is the right shape for a fake of a client-visible
API, and inventing a two-phase fake to chase a failure mode we cannot trigger
from the client would be modelling the platform's internals in our suite.
Recorded because the gap is real and someone should know it exists before
assuming green tests cover this path. If the residual ever needs pinning, the
fake would have to model create-then-attach with an injectable attach failure.

## Follow-ups (out of scope here, worth their own change)

- **`postgres/Database.ts` has the same stray-database window this slice
  rejected for the state store.** The user-facing database provider creates
  through the project-scoped endpoint and then attaches with
  `PATCH /v1/databases/{databaseId}` `{ branchId }`. By fact 3a the database is
  born on the project's **default** Branch, so a failed `PATCH` on a named-stage
  deploy strands a user database on production's Branch. The flat
  `POST /v1/databases` would create it attached in one call. Not fixed here:
  resource lowering is explicitly out of this slice's scope, and the fix wants
  its own tests and its own review.
- **`errors.ts`'s error carries one identifying field.** After the `target`
  rename it is honest, but a bootstrap failure still cannot say *which* of
  project/branch/database it was resolving beyond the step string. Fine for
  now; worth revisiting if operators report confusion.
- **`scripts/ci-cleanup-utils.ts` protects the wrong thing after cutover.** It
  exempts a *project* named `prisma-composer-state` from CI cleanup. That
  project is the retired workspace store; the live store is now a database
  inside each app's own project. The exemption is harmless but guards a ghost,
  and CI cleanup that deletes app projects will now take their state databases
  with them — which is correct and is the whole point, but nobody has looked
  at whether CI cleanup ordering assumes otherwise. Worth one pass.

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
7. **The state database is created in one call against the flat
   `POST /v1/databases`, never a client-side create-then-`PATCH`**
   (orchestrator, 2026-07-17, after the implementer surfaced the endpoint
   error; **reason corrected the same day** after the reviewer read the route).
   The decision stands; the first justification for it did not. I claimed the
   flat endpoint "attaches at birth and closes the window entirely" — it does
   not. It is a server-side create-then-attach with a Branch pre-check, so the
   window narrows rather than closing. The decision survives on what is
   actually true: one request instead of two, the Branch validated before the
   row exists, no client-crash window, and a residual failure that costs a
   stranded empty database (a quota slot) rather than any corruption — see
   § Bootstrap step 3. **Lesson worth carrying:** I asserted atomicity from an
   endpoint's *input shape* without reading its body. Twice now this one
   endpoint has punished reading the schema instead of the implementation.
8. **`errors.ts`'s `workspaceId` field is renamed to `target`** (orchestrator,
   2026-07-17). Pinning a file unchanged does not license printing a false
   noun at an operator.

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
