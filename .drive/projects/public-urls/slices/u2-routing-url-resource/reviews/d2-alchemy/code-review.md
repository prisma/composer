# Code review — D2, `Prisma.DomainOwnership` with statuses (alchemy)

Range: `origin/main...feat/prisma-domain-ownership-status` at `7e53733ca`, one commit, 18 files. Expectations: [spec.md](../../spec.md) and [plan.md](../../plan.md) step D2, the PR body `wip/pr-bodies/alchemy.md`, the platform contract on pdp-control-plane `origin/main` (`docs/compute/RoutingUrls.md`, `routes/v1/workspaces/domain-ownerships.ts`, `routes/v1/domain-ownerships.ts`, `routes/v1/services.ts`), and alchemy-run/alchemy#2701 (`gh pr diff 2701`).

Tests run: `pnpm test:integration test/Prisma/DomainOwnership.test.ts test/Prisma/PublicSurface.test.ts`, 14 passed. Live tests were not run (the PR says so too).

## Summary

The core change is right: `reconcile` counts a domain ownership as proved only when Prisma reports `verified`, and `expiring` is never accepted. Two parts are not safe yet. The new "delete what this deploy created" rule can delete a row this deploy did not create, including an `expiring` one that keeps live hostnames serving. And `Prisma.CustomDomain` lost main's guard against silently taking over a domain that a create returns with 200.

## What looks solid

- `reconcile` returns early only for `status === "verified"`; `unverified` and `expiring` both go through the authoritative-DNS wait and the verify loop (`DomainOwnershipProof.ts` lines 189, 197–209). The test "does not count an expiring domain ownership as proved" asserts the verify call was made.
- `verifyOwnership` is bounded (7 calls, 5 seconds apart), within the repo's speed doctrine.
- `read` never judges status; it reports it, and a row this resource did not record comes back `Unowned`.
- `AuthoritativeDns` cancels a timed-out query, matching main's old `CustomDomain` helper.
- The Cloudflare, skills and scripts changes that reached #2701 through merges are not carried over.

## Answers to the three questions

**1. Is "delete a domain ownership this deploy created but could not verify" right? Can it delete someone else's row?**

Yes, it can. The code decides "this deploy created it" by `existing === undefined`, not by what the platform did. `createWorkspaceDomainOwnership` returns 201 when it creates and 200 when the workspace already has the row, and the distilled client does not expose the status code, so the provider cannot tell them apart. Three ways it deletes a row it did not create:

- **Race between find and create.** The Console, another stack, or the platform itself (a `Prisma.RoutingUrl` create with `createDomainOwnership: true`) creates the row in the gap between `findOwnership` and `createWorkspaceDomainOwnership`. The create returns that row with 200, and the failure path deletes it. The gap is short, so this is rare.
- **Someone starts relying on our row while we wait.** Between create and the final verify there are up to about 70 seconds of authoritative-DNS waiting and 30 seconds of verify calls. A RoutingUrl created in that window for the same exact hostname finds our row and does not create its own. We then delete it, and that RoutingUrl has no domain ownership until its next create or update. Low impact: the row is `unverified`, so nothing that serves depends on it.
- **The stored id is gone (most serious).** When `output.domainOwnershipId` is set but `getOwnership` returns nothing (deleted by hand), the code does not fall back to `findOwnership`. `existing` is `undefined`, the create returns whatever row the workspace now holds for the domain with 200, and if that row is not verified after the loop, it is deleted. That row can be `expiring`, created and verified by someone else after ours was deleted. Deleting an `expiring` row stops every hostname it keeps serving (RoutingUrls.md, "no covering domain ownership keeps it serving any more ... the custom domain is removed").

The rule exists only because D2 creates the row before the TXT record is visible. #2701 did it the other way round: read the record with `getWorkspaceDomainOwnershipsVerification` (creates nothing), wait for it at the authoritative nameservers, and only then create. With that order, the usual failure (the user has not published the record) creates nothing and needs no cleanup. See F01 and F02.

**2. Is `verifiedAt` honest?**

No, drop it. It is filled from `verificationRecordLastSeenAt`, which is "when DNS last answered the lookup", not when the ownership became verified. The platform does not look up verified rows on a schedule, so the value changes whenever any lookup at the same record name happens, in any workspace, and otherwise stays old. A reader will take `verifiedAt` to mean "verified since". The attribute was kept only to preserve #2698's shape, and nothing is released with it. It also changes the props of every `Prisma.CustomDomain` that takes `ownership`, which makes those plan an update for no reason. See F04.

**3. Does anything treat `expiring` as proved?**

Not in the code. `reconcile`, `verifyOwnership` and the tests all require `verified`. Two places overstate what the attributes say, though. The resource JSDoc says "its `status` and `expiresAt` show whether it still is", and `apps.mdx` says "If the record later disappears, its `status` becomes `expiring`". On an unchanged redeploy the engine plans a noop and never calls `reconcile` or `read` (`Plan.ts`, the `diff == null` and unchanged-props path), so the stored `status` stays `verified` after Prisma has moved the row to `expiring`. Nothing consumes `status` for a decision today, so this is a documentation error, not a wrong decision. See F05.

## Findings

### F01 — The failure path can delete a row another actor created, including an `expiring` one

- **Location:** `packages/prisma/src/internal/DomainOwnershipProof.ts` lines 184–191 and 210–216.
- **Issue:** "Created by this deploy" is inferred from `existing === undefined`. The create returns an existing row with 200 and the client cannot see the status. When the stored id no longer resolves, there is no fallback to `findOwnership`, so a live row someone else owns is treated as ours and deleted on failure.
- **Suggestion:** When `getOwnership(storedId)` returns nothing, fall back to `findOwnership(workspaceId, domain)` before creating, and treat a found row as existing. Delete on failure only when the row's status is `unverified`; never delete a `verified` or `expiring` row from this path. Add a fake test where the create answers 200 with an `expiring` row and assert no `DELETE`.

### F02 — Create comes before the TXT record is visible, which is why a cleanup is needed at all

- **Location:** `packages/prisma/src/internal/DomainOwnershipProof.ts` lines 190–207.
- **Issue:** D2 reversed #2701's order. It creates the row first, then waits for the record. A user who has not published the record (the common failure, and the one the `dns`-less docs example describes) gets a row created and deleted on every failed deploy, and each create and verify call is on the platform's `low` rate-limit tier.
- **Suggestion:** Restore #2701's order: `getWorkspaceDomainOwnershipsVerification` → `waitForAuthoritativeRecord` → if not every authoritative nameserver has the record, fail with `PrismaDomainOwnershipRequired` without creating anything → create → verify loop. Keep the narrowed delete from F01 only for the remaining case, where authoritative servers have the record but Prisma's resolver still does not.

### F03 — `Prisma.CustomDomain` silently takes over a domain that the create returns with 200

- **Location:** `packages/prisma/src/CustomDomain.ts` lines 334–353; tests removed from `test/Prisma/Resources.test.ts` and `test/Prisma/ManagementLifecycle.test.ts`.
- **Issue:** `POST /v1/services/{id}/domains` returns 200 "Custom domain already registered on this service". Main refused that case (`result.status === 201 ? ... : adoptionRequiredError(...)`) and had a test, "routes a 200 custom-domain create race through explicit adoption". The move to distilled drops both, because the distilled response has no status. A domain registered by someone else between `findDomain` and the create is now adopted without `--adopt`, and this stack's destroy later deletes it. This comes from #2701 unchanged, but D2 ships it.
- **Suggestion:** Restore the guard. Have distilled expose the HTTP status (or a typed "already existed" marker) on `createServiceDomain` and `createWorkspaceDomainOwnership`, and fail with `adoptionRequiredError` on 200 as main did. This also removes F01's root cause. This review did not check whether `@distilled.cloud/core` can surface a response status today; if it cannot, that is a core change and this finding blocks on it. Restore the removed race test against the fake API.

### F04 — `verifiedAt` does not mean what its name says

- **Location:** `packages/prisma/src/internal/DomainOwnershipProof.ts` lines 58–59 and 79; `ProviderLocal` line 238; tests lines 111 and 245.
- **Issue:** See question 2. It is the time of the last DNS answer, it changes without any action by this stack, and it causes needless `CustomDomain` updates.
- **Suggestion:** Remove `verifiedAt` from the attributes, the local provider and the tests. If a timestamp is wanted, expose `verificationRecordLastSeenAt` under its platform name with the platform's description.

### F05 — Docs say `status` tracks Prisma; it only reflects the last reconcile

- **Location:** `packages/prisma/src/DomainOwnership.ts` lines 41–44; `website/src/content/docs/prisma/compute/apps.mdx` (the paragraph starting "A deploy succeeds only once").
- **Issue:** See question 3.
- **Suggestion:** Say that `status` and `expiresAt` are what Prisma reported when the deploy last proved the domain, and that an unchanged redeploy does not re-check it.

### F06 — `Prisma.Website` with `domain: { name, dns }` now fails for existing users who already hold a domain ownership for the hostname

- **Location:** `packages/prisma/src/Website/FrameworkSite.ts` lines 186–203.
- **Issue:** Every Website with a DNS host now declares a `Prisma.DomainOwnership` for its exact hostname. A workspace that already proved the hostname by hand (the legacy domain route has required the TXT since 2026-10-29) holds a row this new resource did not record, so the first deploy after upgrading fails with `OwnedBySomeoneElse` until the user passes `--adopt`. Neither the PR body nor `websites.mdx` says so.
- **Suggestion:** State it in the PR body and `websites.mdx` as an upgrade step ("run the first deploy with `--adopt`"), or add a fake test that pins the behaviour so the choice is deliberate.

### F07 — Tests do not cover the 200 path or the stored-id-gone path

- **Location:** `packages/integration-tests/test/Prisma/DomainOwnership.test.ts` lines 54–72.
- **Issue:** The fake's create always answers 201 with a fresh row, and the fake has no `GET /v1/domain-ownerships/{id}` route, so neither failure mode in F01 can be exercised.
- **Suggestion:** Add the `GET` route and two cases: create answers 200 with an existing row; stored id returns 404 while the list holds an `expiring` row. Assert no `DELETE` in both.

### F08 — Unit tests call `reconcile` and `read` directly and make real DNS queries

- **Location:** `packages/integration-tests/test/Prisma/DomainOwnership.test.ts` lines 94–98 and 233–240.
- **Issue:** AGENTS.md says not to invoke provider lifecycle methods directly as a substitute for a deploy. `waitForAuthoritativeRecord` also runs real `resolveNs` lookups for `custom.test` inside a test tagged `unit`. It passes because the lookups fail fast.
- **Suggestion:** Acceptable as fake-API tests if the maintainers accept the pattern; otherwise drive them through `stack.deploy` with the fake layer. Either way, tag them `local` only, not `unit`, since they touch the network.

## Deferred (out of scope)

- **Changing `project` to one in another workspace does not replace the ownership** (`diff`, lines 154–161). The stored id still resolves to the old workspace's row and its attributes are returned. Carried over from #2701; fixing it needs a decision on whether a workspace change is a replacement. Belongs in a follow-up, not this port.
- **A `Prisma.RoutingUrl` (D3) and a `Prisma.DomainOwnership` for the same exact hostname in one workspace.** The platform creates an `unverified` row for the RoutingUrl, so a later `Prisma.DomainOwnership` reads it as `Unowned`. D3's concern; note it in D3's spec.

## Already addressed

None; first review round.

## Acceptance-criteria verification

The plan's D2 outcome is the acceptance criteria for this branch.

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: Proving waits for status `verified` instead of retrying on a rejected create | **PASS** | `reconcile` returns only on `verified` (lines 189, 209); tests "creates the domain ownership and verifies it until Prisma reports verified" and "fails with the record to publish" assert the verify calls and the final status. |
| AC2: `expiring` is not treated as proved | **PASS** | Test "does not count an expiring domain ownership as proved" asserts a verify call follows an `expiring` list result. |
| AC3: Attributes carry `status` and `expiresAt` | **PASS** | `attrsFrom` lines 77–78; the `read` test asserts both for an `expiring` row. |
| AC4: `verifiedAt` is nullable | **PASS**, but see F04 | Typed `string \| null`; the `read` test asserts null for `expiring`. The value it holds is misleading. |
| AC5: The Prisma parts of #2698 and #2701, nothing else | **PASS** | File list matches #2701's Prisma files; no Cloudflare, skills or scripts files. |
| AC6: Behaviour carried over unchanged from #2698/#2701 is correct | **FAIL** | F03: the 200-create guard from main is gone; #2701's TXT-before-create order was reversed (F02). |
| AC7: Live proof against production (`CustomDomainDns.test.ts` checks `status: "verified"`) | **NOT VERIFIED** | Live tests were not run for this branch. |

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 5 | AC1, AC2, AC3, AC4, AC5 |
| FAIL | 1 | AC6 |
| NOT VERIFIED | 1 | AC7 |
| WEAK | 0 | |
