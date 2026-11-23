# Code review — D1, regenerated `@distilled.cloud/prisma` (distilled)

Range: `origin/main...feat/prisma-routing-urls` at `ecdf829a1`, one commit, 3 files: `packages/prisma/package.json`, `patches/005-type-domain-ownership-required.patch.json`, and the generated `src/services/management.ts`. Expectations: [spec.md](../../spec.md) (Scope and "Errors are typed"), [plan.md](../../plan.md) step D1, `wip/pr-bodies/distilled.md`, and the platform routes on pdp-control-plane `origin/main`.

Tests run: `pnpm test` in `packages/prisma`, 5 passed.

## Summary

The generated surface is complete for the RoutingUrl routes and the domain ownership statuses, and the one hand-written change (patch 005) is correct. The gap is typed errors: the spec asks for the RoutingUrl conflicts and validation failures as distinct typed errors, and the client only has the generic `Conflict` and `UnprocessableEntity`. The branch cannot merge until the spec mirror is regenerated, as the PR says.

## What looks solid

- All seven RoutingUrl operations exist: `createServiceUrl`, `getServiceUrls`, `getUrl`, `updateUrl`, `deleteUrl`, `createUrlCheck`, `getProjectBranchUrls` (with `logicalId`).
- The RoutingUrl response carries every field the spec's attributes need: `status`, `conditions` (each `met | unmet | unknown`), `firstUnmetCondition`, `records`, `ownershipExpiry`, `heldBy`, `customDomain`, `customDomainSyncError`, `switchboardDns`, `setupUrl`, and nullable `serviceId` and `logicalId`.
- Requests match the routes: `createDomainOwnership?: boolean` on create and update, `logicalId?: string | null` on update.
- Domain ownership responses have `status: "unverified" | "verified" | "expiring"` and `expiresAt: string | null` on every read and write operation, plus the new `createDomainOwnershipVerify`.
- Patch 005 now types `DomainOwnershipRequired` only on `createServiceDomain`, where the platform still documents the 422, and its description says why it left `createWorkspaceDomainOwnership`. Confirmed against `routes/v1/workspaces/domain-ownerships.ts`: the create no longer has a `domain-ownership-required` 422.
- No exported operation was removed or renamed. The two interfaces that disappeared (`CreateWorkspaceDomainOwnershipResponseDataVerification`, `GetServiceDomainsResponsePagination`) remain as type aliases.

## Findings

### F01 — RoutingUrl conflicts and validation errors are not typed

- **Location:** `packages/prisma/src/services/management.ts` lines 4136–4151 (`createServiceUrl`) and 5923–5933 (`updateUrl`); no patch under `packages/prisma/patches/`.
- **Issue:** The spec says: "A 409 on create or update is either the service's hostname quota or another live row on the Branch with the same `logicalId`; each gets its own error. A 422 is an invalid hostname or a service on another Branch." Its Scope puts "so the RoutingUrl operations and their typed errors exist" in this pull request. Both operations only have the generic `Conflict` and `UnprocessableEntity`. Alchemy's typed-error rule says the fix belongs in a distilled patch, not in a check on the error body inside the D3 resource.
- **Suggestion:** Add a patch `006-type-routing-url-errors.patch.json` with two 409 errors (hostname quota, duplicate `logicalId`) and two 422 errors (invalid hostname, service on another Branch), matched on the wire `error.code` and, where the codes are shared, on `error.message`. Capture the exact bodies from the live API first (the interactor uses `quota:exceeded` for the quota and `invalidFailure` with `field: hostname` or `serviceId` for the 422s), and attach them to `createServiceUrl` and `updateUrl`.

### F02 — A create cannot tell "created" from "already existed"

- **Location:** `createWorkspaceDomainOwnership` (line 4221) and `createServiceDomain`.
- **Issue:** The platform answers 201 when it creates and 200 when the row already existed. The generated response has no status, so callers cannot tell them apart. This is the root cause of two findings in the D2 review (deleting a row someone else created; `CustomDomain` adopting a domain without `--adopt`).
- **Suggestion:** Check whether `@distilled.cloud/core` can surface the response status for an operation. If it can, enable it for these two operations in this pull request. If it cannot, record it as a core follow-up and link it from the D2 review.

### F03 — The spec mirror and submodule pin still say 2026-10-29

- **Location:** `packages/prisma/package.json` (`specUpdatedAt: "2026-10-29"`), the spec submodule pin.
- **Issue:** The client was generated from a local copy of the live spec, not from the mirror. The PR body says so and keeps the PR a draft.
- **Suggestion:** Once the mirror's daily run picks up the 2026-11-06 spec, run `specs:update` and regenerate, and confirm the diff to this branch is empty except the pin and `specUpdatedAt`.

### F04 — `createUrlCheck` does not type the 429 the route documents

- **Location:** line 4181.
- **Issue:** `POST /v1/urls/{id}/check` returns 429 when the certificate is `failed` and the hourly limit is used up. It falls into the catch-all. D3 does not call check, so nothing breaks now.
- **Suggestion:** Add it to F01's patch if it is cheap; otherwise leave it until a caller needs it.

## Deferred (out of scope)

None.

## Already addressed

None; first review round.

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: RoutingUrl operations exist (create, list, read, update, delete, check, find by Branch and `logicalId`) | **PASS** | All seven operations generated with request and response types matching the platform routes. No test exercises them; generated code, and D3's tests will. |
| AC2: Domain ownership `status` and `expiresAt` exist | **PASS** | On create, list, get and verify responses, with the platform's enum and nullability. |
| AC3: RoutingUrl errors are typed (spec Scope, "Errors are typed") | **FAIL** | F01: only generic `Conflict` / `UnprocessableEntity`. |
| AC4: Generated from the deployed spec through the normal pipeline | **NOT VERIFIED** | F03: generated from a local spec copy; mirror not updated yet. |
| AC5: Package generate, typecheck and test scripts pass | **PASS** | `pnpm test` passes here (5 tests); typecheck reported by the implementer, not rerun. |

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 3 | AC1, AC2, AC5 |
| FAIL | 1 | AC3 |
| NOT VERIFIED | 1 | AC4 |
| WEAK | 0 | |
