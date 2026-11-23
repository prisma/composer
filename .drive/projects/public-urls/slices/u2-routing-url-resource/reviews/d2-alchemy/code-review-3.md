# Code review, round 3 — D3, `Prisma.RoutingUrl` (alchemy)

Range: `283b8402c..405bd01af` on `feat/prisma-domain-ownership-status`. That is one commit, `feat(prisma): Prisma.RoutingUrl`, on top of the D2 code reviewed in rounds 1 and 2. `submodules/distilled` is pinned to `6661db7c0`. Expectations: [spec.md](../../spec.md) and [plan.md](../../plan.md) as updated 2026-11-10, and pdp-control-plane `origin/main` (`docs/compute/RoutingUrls.md`, `routes/v1/urls.ts`, `interactors/src/compute/routingUrl.ts`, `management-api/lib/httpError.ts`, `lib/errorHandler.ts`).

Tests run, with fakes: `RoutingUrl.test.ts`, `DomainOwnership.test.ts`, `CustomDomain.test.ts` and `PublicSurface.test.ts`. 27 passed and 1 skipped (the live RoutingUrl test). The round 2 D2 findings F09–F11 are addressed: the `reconcile` adoption rule has a test without `--adopt`, the three-state DNS check is in place, and there are success-path fake tests.

## Summary

The resource does what the spec asks, and every done condition has a fake test except the live one. Three things need attention:

- The 409/422 handling depends on English message text.
- The adoption of a row with no `logicalId` will take over rows that `Prisma.CustomDomain` made, once the platform's backfill runs. That turns the planned CustomDomain-to-RoutingUrl migration into an outage if both changes ship in one deploy.
- The hostname-change check refuses with "publish the CNAME" when it could not look the CNAME up at all, and it can never pass for an apex hostname.

## What looks solid

- **Redeploys are free.** An unchanged redeploy sends no `PATCH`: `reconcile` builds a delta from the observed row and returns early when it is empty (lines 359–364). The lifecycle test asserts `PATCHES == []`.
- **The hostname-change check runs before any write.** It runs only for a hostname change on an `active` row, it checks both covering domains (the exact hostname and the one-label wildcard) for `verified` (not `expiring`, matching the platform's "becoming active needs `verified`"), and it checks the CNAME against the new service's regional switchboard. The refused-change test asserts no `PATCH` and an unchanged row.
- **The resource never touches domain ownerships.** Destroy deletes only the RoutingUrl. The test asserts no request to `domain-ownerships`.
- **The Branch list is not paginated on the platform** (`projects/branches/urls.ts` returns `hasMore: false`), so reading one page is complete.
- **`logicalId` defaults to the FQN**, as `Prisma.App` does.

## Findings

### F13 — The 409/422 refusals are told apart by English message text

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 239–267.
- **Issue:** The resource tells the four refusals apart with `startsWith("Quota exceeded")`, `includes("logicalId")`, `includes("is not a hostname")` and `includes("Branch")`. These strings are prose from the platform's interactors and `httpError` (`getInteractorErrorMessage`). We rewrite that prose freely, so any rewording silently turns a typed error into `RoutingUrlOperationFailed`. The deploy still fails, but with the wrong type. This also contradicts Alchemy's typed-error rule ("never match error bodies in alchemy; patch distilled").
- **What each layer gives today:**
  - 409 quota: the wire code is `quota-exceeded`.
  - 409 duplicate `logicalId`: `client-error` (the generic code for 409).
  - Both 422s: `validation-error`.
  - Distilled's generic `Conflict` and `UnprocessableEntity` carry only a numeric `code` and `message`, so even the distinct quota code is lost.
- **The right fix is both, and it needs no core change in distilled:**
  1. **Platform.** Give each case its own wire code, for example `logical-id-taken`, `invalid-hostname` and `service-on-another-branch`, next to the existing `quota-exceeded`. The code is the contract; the message stays prose. This is needed whatever distilled does: without it, nothing downstream can tell the two 422s apart except by message text. The platform is ours.
  2. **Distilled.** Add a Prisma patch, like patch 005, whose errors match `{ "status": 409|422, "body": { "/error/code": "<code>" } }` on `createServiceUrl` and `updateUrl`. Patch 005 already matches `/error/code`, so the mechanism exists and this is a patch to one package, not a core change. It goes in the same single distilled pull request, which is held until platform slice 8 anyway.
  3. **Alchemy.** Replace `refusals` with `catchTags` on the four typed errors.

  "Distilled exposes `code` on its generic errors" is not recommended. It is a second core change touching every client, and it would leave consumers matching on strings, only moved from message to code.
- **Until then:** keep the message matching (the existing test pins today's exact platform strings), and add the platform change to the project plan.

### F14 — Adopting a row with no `logicalId` will take over `Prisma.CustomDomain` rows and break a migration

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 224–237 (`ownRow`), 318–333 (`read` returns plain attributes, not `Unowned`) and 359–371.
- **Issue:** The spec adopts a row with no `logicalId` on the same service and hostname without `--adopt`, so P3 can take over the platform's backfilled rows. Once the backfill runs and `/v1/services/{id}/domains` becomes a view over RoutingUrls, every domain a `Prisma.CustomDomain` made is such a row. So:
  - A stack that replaces `Prisma.CustomDomain("api", …)` with `Prisma.RoutingUrl("api", …)` in one deploy: the RoutingUrl adopts the row (`PATCH logicalId`), then the removed CustomDomain's delete (`DELETE /v1/domains/{id}`) deletes the same row through the view. The hostname stops serving until the next deploy recreates it and a new certificate is issued.
  - Another stack's live `Prisma.CustomDomain` for the same service and hostname is taken over silently, and either stack's destroy removes it for both.
- **Suggestion:** Keep the adoption, since P3 needs it, but make the migration safe and visible. Document the migration order in the JSDoc and `apps.mdx`: first set `RemovalPolicy.retain()` on the `Prisma.CustomDomain` (or drop it in a deploy before the RoutingUrl), then add the RoutingUrl. Also put the same order into P2/P3's plan. Optionally, make `CustomDomain.delete` refuse when the platform reports the domain's RoutingUrl now has a `logicalId`, if the view exposes it.

### F15 — When the CNAME cannot be checked, the hostname-change refusal tells the user to publish it

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 293–313.
- **Issue:** `routed` is `checkRecord(...) === "seen"`, so `unknown` (no nameservers found, DNS blocked, every query timed out) is treated like `absent`. Refusing on `unknown` is the right, conservative choice for a serving row. But the error then says "Publish CNAME … then redeploy" for a record that may well be published, and redeploying will fail the same way on that network.
- **Suggestion:** Keep the three states. On `unknown`, refuse with a message that says the CNAME could not be checked from this machine and why, and leave the CNAME out of `records` (or add a `reason` field to `RoutingUrlHostnameChangeRefused`). Add a fake test for `unknown`.

### F16 — A hostname change to an apex domain can never pass the check

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 292–297; `packages/prisma/src/internal/AuthoritativeDns.ts` lines 88–96.
- **Issue:** An apex hostname (`example.com`) cannot have a CNAME. DNS hosts that serve one ("CNAME flattening", ALIAS) answer with A and AAAA records. `resolveCname` then finds nothing and the check reports `absent` forever, even when the platform's own `dnsPointsAtSwitchboard` (Foundry's acceptance) would pass.
- **Suggestion:** Ask the platform whether a flattened apex is accepted. If it is, accept an A/AAAA answer whose addresses match the switchboard's for a 2-label hostname. If it is not, say in the JSDoc that apex hostnames are not supported.

### F17 — The check ignores a new hostname that another RoutingUrl holds

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 282–314.
- **Issue:** Two workspaces can both hold verified domain ownerships for one domain (RoutingUrls.md). If another workspace's RoutingUrl holds the new hostname's custom domain, both of this resource's checks pass. The `PATCH` then removes the old hostname's custom domain and the new one stays `pending` behind `heldBy`, so the serving row goes dark. Design note 12 lists only ownership and CNAME, so this is outside the note's letter, but it is the same outage the note exists to prevent.
- **Suggestion:** Before the `PATCH`, list RoutingUrls for the new hostname if the platform offers a lookup across workspaces. If it does not, record this as a known limit in the JSDoc and in design note 12, and add a platform task for a cheap "is this hostname held" check.

### F18 — The spec's "generated reference page" does not exist for any Prisma resource

- **Location:** `website/src/content/docs/providers/` (no Prisma resource pages).
- **Issue:** The spec's Scope lists "the resource's JSDoc and generated reference page". `docs:gen` produces no page for `Prisma.RoutingUrl`, or for `Prisma.CustomDomain`, because Prisma is not in the generator's source roots. The JSDoc and `apps.mdx` section exist.
- **Suggestion:** Either drop "generated reference page" from the spec, or add Prisma to the generator's roots in a separate change. Do not hand-write the page.

## Deferred (out of scope)

- Two Alchemy stages deploying to the same Prisma Branch with the same FQN share one row, because the default `logicalId` is the FQN. `Prisma.App` has the same behaviour; changing the default belongs to all Prisma resources at once.

## Acceptance-criteria verification (spec "Done conditions")

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: Deploy with no DNS succeeds, showing `pending`, the unmet conditions and both records | **PASS** | Lifecycle test asserts `status: "pending"`, `firstUnmetCondition: "ownershipVerified"`, `conditions.ownershipVerified: "unmet"`, records `["TXT","CNAME"]`. The live test asserts the same against production but is skipped (not run). |
| AC2: Unchanged redeploy sends no `PATCH` | **PASS** | Lifecycle test asserts no `PATCH` after the second deploy. |
| AC3a: Row found by `logicalId` is updated in place | **PASS** | Test asserts `PATCH /v1/urls/url-existing` and no `POST`. |
| AC3b: Row with no `logicalId` on the same service and hostname is adopted | **PASS** | Test asserts the `PATCH` body is `{ logicalId: "Url" }`. See F14 for the migration hazard. |
| AC3c: Conflicting row fails, naming it | **PASS** | Test asserts `RoutingUrlHostnameTaken` with `url-other` and no `POST`. |
| AC4: Hostname change on an `active` row without verified ownership fails before any `PATCH`, proved by a test | **PASS** | Test asserts the error names the TXT and the switchboard CNAME, no `PATCH`, and the row's hostname unchanged. The allowed path is also tested. The `unknown` path is not (F15). |
| AC5: Destroy deletes the row and sends no domain ownership request | **PASS** | Lifecycle test asserts `DELETE /v1/urls/{id}` and no route containing `domain-ownerships`. |
| AC6: Errors are typed: quota, duplicate `logicalId`, invalid hostname, service on another Branch | **WEAK** | Test drives all four through the fake and asserts the tags, but only by message text the platform does not promise (F13). |
| AC7: Released in an Alchemy version Composer can depend on | **NOT VERIFIED** | Held until platform slice 8 by plan. |
| AC8: Live test against production | **NOT VERIFIED** | Skipped. |

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 7 | AC1, AC2, AC3a, AC3b, AC3c, AC4, AC5 |
| WEAK | 1 | AC6 |
| NOT VERIFIED | 2 | AC7, AC8 |
| FAIL | 0 | |
