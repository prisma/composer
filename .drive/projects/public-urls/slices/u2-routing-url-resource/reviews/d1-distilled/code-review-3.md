# Code review, round 3 — distilled `feat/prisma-routing-urls` (single pull request)

Range: `origin/main...6661db7c0`, five commits:

- the core change (`44663aaba`) and its added tests (`3ca59624b`);
- the regeneration (`680772450`);
- patch 006, `httpStatus` (`5c6463444`);
- the spec mirror pin (`6661db7c0`).

PR body: `wip/pr-bodies/distilled.md`. Since round 2, only the core tests and the pin changed. `management.ts` is unchanged, so the mirror's 2026-11-10 spec produces the same client.

Tests run: core `protocol-rest.test.ts`, 62 passed; `packages/prisma` `pnpm test`, 5 passed.

## Round 2 findings

| Finding | Status | Evidence |
| --- | --- | --- |
| F03 spec mirror pin stale | **Fixed** | `specUpdatedAt: "2026-11-10"`, submodule moved; regeneration changed nothing but the stamps. |
| F05 core raw-body and array-body branches untested | **Fixed** | `3ca59624b` adds both cases. |
| F06 optional `httpStatus` | **Unchanged**, accepted | Always set by `makeRestProtocol`. |
| F01/F04 typed RoutingUrl errors | **Deferred by plan** ("no typed RoutingUrl errors") | See below. |

## Findings

### F07 — The typed RoutingUrl errors belong in this pull request once the platform has codes

- **Location:** `packages/prisma/patches/` (no RoutingUrl error patch); `src/services/management.ts` `createServiceUrl` and `updateUrl` error lists.
- **Issue:** The plan says this pull request carries no typed RoutingUrl errors, so Alchemy matches English message text (alchemy code review round 3, F13). Distilled already has the mechanism to type them without a core change: patch 005 matches `{ "status": 422, "body": { "/error/code": "domain-ownership-required" } }`. What is missing is distinct codes on the platform. Today the duplicate `logicalId` 409 is the generic `client-error` and both 422s are `validation-error`. Only the quota 409 has its own code, `quota-exceeded`.
- **Suggestion:**
  1. Give the platform the three codes.
  2. Add `007-type-routing-url-refusals.patch.json` with four errors matched on `/error/code`, attached to `createServiceUrl` and `updateUrl`.
  3. Regenerate.

  This fits the plan's single distilled pull request, which is held until platform slice 8 anyway. The quota error can be typed today.

### F08 — The PR body should say how the core change was kept to the two Prisma operations

- **Location:** `wip/pr-bodies/distilled.md`.
- **Issue:** Reviewers on the Alchemy team will ask whether a protocol change touches every REST client. The answer is that it is a no-op without a `T.ResponseCode()` member, and only Prisma's generator binds `smithy.api#httpResponseCode`. The body explains why the two changes are in one pull request, but not this.
- **Suggestion:** Add one sentence saying that.

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| RoutingUrl operations exist | **PASS** | Unchanged. |
| Domain ownership `status` / `expiresAt` | **PASS** | Unchanged. |
| `httpStatus` on the two creates | **PASS** | Core tests for 201, 200, raw body and array body; alchemy's CustomDomain and DomainOwnership 200 tests go through the real protocol. |
| Generated from the deployed spec through the normal pipeline | **PASS** | Mirror pinned to 2026-11-10; the regeneration is a no-op apart from the stamps. |
| One distilled pull request for U2 | **PASS** | Core and regeneration on one branch; the PR body says why. |
| Typed RoutingUrl errors | **Deferred by plan**; see F07 | |
