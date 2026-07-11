# Design decisions — stage-as-branch slice

Numbered log of mid-flight decisions that amend the spec/plan. Each records the
trigger, what was learned, the decision, and the affected artefacts (Drive I12).

## 1. Branch idempotency is client-side; the API has no `ifExists` field

- **Trigger:** falsified assumption, found during D1 implementation. Spec §4 and plan
  D1 described creating a Branch "via `POST /v1/projects/:id/branches` (`ifExists:
  "return"`)" as if server-side create-or-return idempotency existed.
- **Learned:** it does not. Verified against `@prisma/management-api-sdk@1.47.0` (and
  the live OpenAPI): `POST /v1/projects/{projectId}/branches` accepts only `gitName` +
  `isDefault` (`additionalProperties: false`); a duplicate `gitName` returns `409`. The
  matching read, `GET …/branches?gitName=X`, **is** a real server-side exact-match
  filter returning ≤1 row.
- **Decision:** keep the spec's *outcome* (idempotent create-if-absent keyed by
  `gitName`) and implement idempotency client-side: observe via `GET ?gitName=`, `POST`
  only when absent, and on a racing `409` re-observe and adopt the winner. This mirrors
  the adopt-oldest/tolerate-races idiom already in `state/bootstrap.ts`. The mechanism
  changed; no architectural decision changed.
- **Affected:** spec §4 (rewritten), plan D1 (rewritten), `packages/alchemy/src/container.ts`
  (`resolveBranch`). Confirms spec §4's positional-role note: the API doc states the first
  Branch is `role=production`, later Branches `role=preview`, server-owned regardless of
  body — so explicit role control stays deferred.

## 2. Branch attachment is a PATCH, and ids are read at lowering time (not `PrismaCloudOptions`)

- **Trigger:** falsified assumption, found while grounding D3. Spec §6 said the `Database`/
  `ComputeService` **create bodies accept `branchId`**; spec §2/§7 said the ids arrive via a
  new `PrismaCloudOptions.projectId`/`fromEnv()`.
- **Learned (verified against `@prisma/management-api-sdk@1.47.0`):**
  1. `POST /v1/projects/:id/databases` and `.../compute-services` create bodies have **no
     `branchId`**. A resource is created project-scoped and **attached to a Branch by `PATCH
     /v1/databases/:id` / `PATCH /v1/compute-services/:id` with `{ branchId }`** (both PATCH
     bodies accept `branchId`/`branchGitName`). `EnvironmentVariable`'s create body **does**
     accept `branchId` + `class`.
  2. There is no `fromEnv()`/`PrismaCloudOptions` id path today — the target reads env in
     `resolveOptions`. And the CLI evaluates `prismaCloud()` in the **parent** at config-load
     (before `ensureContainers` computes the ids), so `projectId` **cannot be required at
     construction** — it must be read at **lowering time** in `application.provision` (child
     only).
- **Decision:** (a) providers gain an optional `branchId`; when set they PATCH-attach the
  resource after observe-or-create on **every** reconcile (idempotent, self-healing); unset =
  no PATCH = current behavior. (b) `resolveOptions` reads `PRISMA_PROJECT_ID`/`PRISMA_BRANCH_ID`
  **without requiring them**; the required check for `projectId` lives in `application.provision`.
  No `PrismaCloudOptions` field is added (config-file override deferred). Outcome (branch-isolated
  resources + `class` mechanical) is unchanged; only the mechanism was mis-specified.
- **Affected:** spec §2/§5/§6/§7 (rewritten); plan D3 split into **D3a** (providers, `@prisma/
  alchemy`) → **D3b** (target, `@prisma/app-cloud`); `packages/alchemy/src/postgres/Database.ts`,
  `.../compute/ComputeService.ts`, `packages/app-cloud/src/control.ts`.
