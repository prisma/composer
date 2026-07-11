# Slice Plan — Deploy an app to a named stage as an isolated environment

Spec: [`./spec.md`](./spec.md). Dispatches are sequential. Every design choice is in the
spec's **Pinned decisions**; a dispatch implements them, it does not decide them. Gate
for each code dispatch: `pnpm typecheck` + the touched package's tests; `pnpm build` on D3.

## Dispatch 1 — Container-resolution client (`@prisma/alchemy`)

**Outcome.** A client function, given the workspace token, returns
`{ projectId, branchId? }` by: (a) listing live Projects by name, adopting the oldest or
creating one (spec §3); (b) for a named stage, create-if-absent a Branch — observe via
`GET /v1/projects/:id/branches?gitName=X` (exact match), `POST` only when absent, tolerate
a racing `409` by re-observing (spec §4; the API has no `ifExists` field). For the default
stage it returns `branchId: undefined` and creates no Branch.

- **Builds on:** the existing `ManagementClient` (already does authed Management-API
  calls for `Project`/`EnvironmentVariable` providers).
- **Hands to:** D2 — a resolver returning the ids.
- **Focus:** client + resolver logic; Management-API HTTP mocked in tests. No CLI wiring.
  Do **not** add an ownership marker or `--project` handling (spec: deferred).

## Dispatch 2 — CLI ensure-containers step (`@prisma/app-cli`)

**Outcome.** Before running the stack, the pipeline (for **both** deploy and destroy):
enforces the **explicit-destroy-target** rule (spec §10) — bare `destroy` errors; `destroy`
takes `--stage <name>` or `--production`, mutually exclusive; `--production` is destroy-only;
validates a named stage against git `check-ref-format` (fail clearly if invalid, spec §4);
calls the D1 resolver with the app name (root system name or `--name`) and the stage —
`ensure: true` for deploy (create-if-absent), `ensure: false` for destroy (find-only,
clear "nothing deployed" error if absent, spec §10); and sets `PRISMA_PROJECT_ID` (always)
and `PRISMA_BRANCH_ID` (named stages only) on the `alchemy` child (spec §2). Default
`prisma-app deploy` from a fresh checkout still works with only a token. Adds the `ensure`
option to `@prisma/alchemy`'s `resolveContainer` and surfaces the Management-client layer
from its barrel so the CLI can provide `ManagementClient` over `PRISMA_SERVICE_TOKEN`.

- **Builds on:** D1.
- **Hands to:** D3 — an `alchemy` invocation carrying the ids in its env.
- **Focus:** `run-alchemy.ts` (child env) + the pre-stack step in `main.ts`; stage-name
  validation; the `ensure` flag + barrel export in `@prisma/alchemy`. No provider or
  target-lowering changes. Branch soft-delete on destroy is **D4**, not here.

## Dispatch 3a — Providers gain a `branchId` (PATCH-attach) (`@prisma/alchemy`)

**Outcome.** `Database` and `ComputeService` providers gain an optional `branchId` prop
(spec §6). The Management-API **create bodies do not accept `branchId`**, so when `branchId`
is set the provider **PATCHes** the resource to the Branch (`PATCH /v1/databases/:id` /
`PATCH /v1/compute-services/:id` with `{ branchId }`) after observe-or-create, on **every**
reconcile (idempotent). When unset, no PATCH — byte-for-byte current behavior. Backward-
compatible: `branchId` optional, undefined = today.

- **Builds on:** D2.
- **Hands to:** D3b — providers that accept a Branch assignment.
- **Focus:** `packages/alchemy/src/postgres/Database.ts`, `.../compute/ComputeService.ts` +
  their tests (mocked HTTP: assert PATCH fires when `branchId` set, and does NOT when unset).
  No `EnvironmentVariable` change (its create body already takes `branchId`+`class`). No
  `control.ts` change.

## Dispatch 3b — Target consumes the ids (`@prisma/app-cloud`)

**Outcome.** `resolveOptions` reads `PRISMA_PROJECT_ID`/`PRISMA_BRANCH_ID` from env **without
requiring them** (spec §2 — parent constructs before the ids exist). `application.provision`
stops calling `Prisma.Project(...)`; it reads `process.env['PRISMA_PROJECT_ID']` (**required
here**, clear error if absent) and emits it as its `projectId` output (spec §7). Every
resource site — the postgres `Database`, the compute `ComputeService`, and every
`EnvironmentVariable` (poison vars + serialized config) — passes `branchId` **iff** set and
sets config `class = branchId ? 'preview' : 'production'` (spec §5), removing the hardcoded
`production`.

- **Builds on:** D3a.
- **Hands to:** D4 — a target that provisions into `(Project, Branch?)`.
- **Focus:** `packages/app-cloud/src/control.ts` + `__tests__/control-*.test.ts`. Pure
  retargeting + the `branchId`/`class` conditional; no new provisioning logic, no migrations.

## Dispatch 4 — Prove it live: a second environment

**Outcome.** Against real Prisma Cloud (needs `.env` in the worktree root):
`prisma-app deploy` (production) then `prisma-app deploy --stage staging` for
`examples/storefront-auth` stand up two isolated environments; staging ingress →
`auth.verify()` returns `{ ok: true }`; re-deploy of each is a no-op;
`destroy --stage staging` removes the staging resources, then **soft-deletes the staging
Branch** via `DELETE /v1/branches/:branchId` (spec §10) — production untouched.

- **Builds on:** D1–D3.
- **Hands to:** — (slice DoD).
- **Focus:** the branch soft-delete teardown step (spec §10) + end-to-end proof + destroy.
  Report (do not fix) any gap in per-branch state segregation or Management-API branch/role
  behavior as follow-up.

## Notes

- D3 is the largest; if the provider `branchId` addition and the `target.ts` conditional
  want separate landings, the orchestrator splits at the plan-loop — that is an
  orchestration call, not an implementer design choice.
