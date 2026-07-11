# Slice Spec — Deploy an app to a named stage as an isolated environment

## At a glance

`prisma-app deploy --stage <name>` provisions the topology into an isolated **Branch**
of the app's single **Project** — its own compute, database, config, and Alchemy state —
so an app can have production plus staging plus per-PR previews. Implements
[ADR-0019](../../../docs/design/90-decisions/ADR-0019-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md).

## Pinned decisions — no implementer latitude

Every design/architecture choice is fixed here. An implementer resolves *how to code*
these, never *what they are*.

1. **Two-phase deploy.** The CLI ensures containers (Project, Branch) via the
   Management API **before** running Alchemy; Alchemy then provisions resources
   *within* them. Neither Project nor Branch is an Alchemy resource.

2. **Id threading = environment variables.** The CLI, after resolving, sets
   `PRISMA_PROJECT_ID` and (named stages only) `PRISMA_BRANCH_ID` on the `alchemy deploy`
   child process (`run-alchemy.ts`). `fromEnv()` reads them; `PrismaCloudOptions` gains
   `projectId: string` and `branchId?: string`. This mirrors the existing
   `PRISMA_WORKSPACE_ID` → `fromEnv()` path. **Not** codegen into the stack file.

3. **Project resolver.** List *live* Projects in the workspace whose name matches the
   app name (root system name, or `--name`), oldest-first; **adopt the oldest**; if none,
   **create** one. No ownership marker, no `--project` override in this slice (both
   deferred). The app name comes from the root `system("<name>", …)`.

4. **Stage → Branch.**
   - **No `--stage` (the default) = production = project level.** No Branch is created;
     resources and config are written with **no `branchId`**, exactly as today. Zero
     change to current production behavior.
   - **`--stage X` (named) = a Branch.** `gitName = X`, which **must pass git
     `check-ref-format`**; if invalid, the CLI **fails with a clear error** — no silent
     normalization. The Branch is **created-if-absent**: observe first via
     `GET /v1/projects/:id/branches?gitName=X` (server-side exact match, ≤1 row), create
     via `POST` only when absent, and tolerate a racing `409` by re-observing and adopting
     the winner. The branches API has **no** `ifExists`/server-side idempotency field
     (verified against `@prisma/management-api-sdk@1.47.0`: the POST body accepts only
     `gitName` + `isDefault`); a `409` on duplicate `gitName` is the only signal, so
     idempotency is client-side. Its **role is PDP's positional default** (first Branch =
     production, later = preview; server-owned, unsettable) — cosmetic for us, does not
     affect our provisioning, deferred.

5. **Provisioning asymmetry (mechanical, no role lookup).**
   - Default stage: `Database`, `ComputeService`, `EnvironmentVariable` written with **no
     `branchId`**, config `class: production` — as today.
   - Named stage: all three written with **`branchId` = the resolved Branch**; config
     `class: preview`.
   - The rule is exactly: **`branchId` present ⟺ named stage ⟺ `class: preview`.** The
     pack computes `class = branchId ? 'preview' : 'production'`; it never reads a Branch
     `role`. (Platform-derived `class` is the deferred end-state, ADR-0019.)

6. **`branchId` must be added to providers.** `Database` and `ComputeService` alchemy
   providers currently carry **no** `branchId`; add the prop and forward it to the
   Management-API create body (the API bodies already accept it). `EnvironmentVariable`
   already has `branchId`.

7. **`application.provision` references, never mints.** It stops calling
   `Prisma.Project(...)`; it emits the injected `projectId` (from `PrismaCloudOptions`) as
   its output. Project creation is the CLI's job (decision 3).

8. **No migrations, no schema.** The framework runs no migrations today and this slice
   adds none. A named stage's Postgres is created empty; the `storefront-auth` verify
   (`await sql\`select 1\``) needs only a reachable DB, which an empty Postgres satisfies.
   Apps that need per-environment schema are out of scope (migrations are a separate,
   unbuilt capability).

9. **State is inherited.** Alchemy's `--stage` already segregates deploy state and
   physical names per environment; the store keys by `(stack, stage)`. No state work in
   this slice.

## Scope

**In:** decisions 1–9. **Out (deferred):** explicit `prisma-app create`; explicit branch
`role` control; platform-derived config `class`; migrations / per-branch schema;
ownership marker + `--project` override; copy-on-write preview data; git-triggered
previews; the platform state-API.

## Slice-DoD

- `prisma-app deploy` (default) — behavior byte-for-byte unchanged.
- `prisma-app deploy --stage staging` — stands up an isolated staging environment (own
  Branch, compute, empty Postgres, `branchId`+preview config) alongside production;
  re-deploy is a no-op; **proven live** on `examples/storefront-auth` (staging ingress →
  `auth.verify()` returns `{ ok: true }`); `destroy --stage staging` removes the Branch
  and its resources without touching production.
- Requires `.env` (`PRISMA_SERVICE_TOKEN` + `PRISMA_WORKSPACE_ID`) copied into the
  worktree root for D4.

## References

[ADR-0019](../../../docs/design/90-decisions/ADR-0019-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)
· [ADR-0018](../../../docs/design/90-decisions/ADR-0018-a-prisma-app-is-one-project-a-stage-is-a-branch.md)
· Plan: [`./plan.md`](./plan.md)
