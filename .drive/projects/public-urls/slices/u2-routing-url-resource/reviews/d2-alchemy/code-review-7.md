# Code review, round 7 — the whole Alchemy branch before it goes upstream

Range: `upstream/main...HEAD` on `feat/prisma-domain-ownership-status` (merge base `dbfd0ddb`; upstream `main` is one commit ahead and touches no Prisma file). The last commit, `bf238ca7db`, only points `submodules/distilled` at the local draft `625a8ae46` and is not part of the change. Two commits no reviewer had seen, read line by line:

- `0ce9f5db0f`: fixes for round 6. The Website's released CNAME alias gets `adopt(true)` and `RemovalPolicy.retain()` and takes its value from the required records; record resources are keyed by the raw hostname; the ownership TXT is looked up through the new hostname's nameservers; renames (`ownership`, `waitForRecords`, `Prisma.RoutingUrlRequiredRecords`); one shared rule for "a RoutingUrl manages this row"; `websiteDomain` moves to `internal/WebsiteDomain.ts`; `DomainOwnership` docs rewritten.
- `7208f801b1`: the create and update refusals are caught by the typed errors Distilled generates from the error code; a service on no Branch now raises the new `RoutingUrlServiceNotOnABranch`.

Expectations: the pull request description (`.drive/projects/public-urls/slices/u2-routing-url-resource/pr-bodies/alchemy.md`), the done conditions in `wip/u2/project-docs/spec.md`, Alchemy's `AGENTS.md` (resource testing conventions, typed error doctrine, pull request conventions), `.claude/skills/audit/procedure.md`, the jargon sweep in `.drive/CODE-REVIEW.md`, and the round 6 reviews. I also read `plan.md`, `platform-error-codes-brief.md`, the generated Distilled error classes and operation unions, Cloudflare's `RecordList` and `Records`, the three DNS adapters, core `RemovalPolicy`, `Resource` (repeated declarations) and `FQN` / the state stores.

What I ran (working tree clean afterwards):

- `pnpm exec tsrs -b`: clean.
- `pnpm test:integration test/Prisma/RoutingUrl.test.ts test/Prisma/Website/Domain.test.ts test/Prisma/CustomDomain.test.ts test/Prisma/PublicSurface.test.ts test/Prisma/AuthoritativeDns.test.ts test/Prisma/DomainOwnership.test.ts --retry 0`: 80 passed, 6 skipped (the live cases).
- `oxfmt --check` on `packages/prisma/src` and `test/Prisma`, `pnpm docs:check-jsdoc`, `pnpm exports:check`, `pnpm lint:tests`: all clean.
- Six mutations, each restored:

| Mutation | Result |
| --- | --- |
| `RoutingUrlLogicalIdTaken` mapped to `RoutingUrlQuotaExceeded` | Both `logical-id-taken` cases (create and update) fail. The tests depend on the mapping. |
| The no-Branch pre-check raises `RoutingUrlOperationFailed` | Nothing fails (F53). |
| `adopt(true)` removed from the Website alias | Two Website tests fail. |
| `RemovalPolicy.retain()` removed from the Website alias | Nothing fails (F54). |
| TXT check searches from the parent, without `serversOf` | Nothing fails in `RoutingUrl.test.ts` (F55). |
| `CustomDomain`'s delete skip removed | Both upgrade tests fail on "one row left" (round 6 F42 is fixed). |

## Summary

The two new commits do what they say, and the round 6 findings are fixed. The most serious problem is outside the code: the typed refusals match error codes Prisma does not send yet, so if this merges before Prisma ships them, three of the four refusals the description calls typed arrive as `RoutingUrlOperationFailed`, and the description does not say so. The other findings are missing test evidence for three behaviours the description claims (the no-Branch pre-check, `retain()` on the alias, the TXT check's nameserver search) and description text that breaks Alchemy's pull request conventions.

## What looks solid

- **Each operation catches exactly the typed errors its union has.** `createServiceUrl`'s union has the quota, `logicalId`, invalid-hostname and not-on-a-Branch errors; `updateUrl`'s has the first three and on-another-Branch. `createRefusals` and `updateRefusals` catch exactly those, plus `Conflict` and `UnprocessableEntity`, and nothing else. `BadRequest`, `NotFound` and `UnknownPrismaError` pass through unchanged, as before. The code-specific matchers win over the plain status matchers: "409 some-new-conflict" and "422 validation-error" on create both become `RoutingUrlOperationFailed`, and the typed cases do not.
- **The tests depend on the tag mapping.** Mapping `logical-id-taken` to the wrong error fails both its cases. Every case uses the message "arbitrary text 4711", so nothing matches on text any more.
- **`adopt(true)` on the Website alias exposes nothing new.** The alias takes its value from the RoutingUrl, whose hostname comes from the record set's output, so the record set (`Url/Records-<hostname>`) always runs first. On Cloudflare that `RecordList` already overwrites a differing CNAME at the name without asking (`RecordList.ts` lines 129–140), so by the time the alias reads, the only CNAME there is the switchboard one this deploy just wrote. Route 53's `Record.read` adopts silently anyway, and Hetzner's `RecordList` has no ownership check. Cloudflare's `Records.read` looks only at CNAMEs, so `adopt(true)` cannot take an A or TXT record. The fake alias now reads like Cloudflare's, and removing `adopt(true)` fails two Website tests, so round 6 S10 is covered.
- **`RemovalPolicy.retain()` leaves nothing behind on any adapter.** Retain skips the alias's own delete on destroy, on removal and on a replaced generation; it does not stop `Records` from removing a name that leaves its set during an update. On destroy the record set deletes the CNAME by value on all three hosts (Cloudflare `removeEntries`, Route 53 `DELETE`, Hetzner value removal). Both owners compute the same value from the same required records, and on Cloudflare both use TTL 1 and DNS-only, so they do not overwrite each other on every deploy. One thing is left behind, and only on the path the docs now warn against: upgrading and changing the hostname in one deploy on Route 53, where the alias is replaced and the old generation's CNAME stays (no record set existed for the old hostname). It points at the switchboard and serves nothing.
- **Raw hostnames in record ids work in every store in the repo.** No adapter derives a physical name or comment from the id. The local and bucket state stores replace `/` with `__` in file names, so dots are fine; the HTTP store URL-encodes. The second `requiredRecords` call in `websiteDomain` declares the same id with the same type and props, which `Resource` treats as a repeated reference. The one gap is a hostname that is not a hostname (F60).
- **The TXT check now keeps a failed lookup `unknown`.** `serversOf: to` with the `name` search finds the hostname's own zone; a hostname with a CNAME skips its own NS lookup, and the TXT name sits in the parent's zone, which is the right zone. Two new unit cases cover a failed NS lookup and a TXT found through the hostname's servers.
- **`internal/RoutingUrlTakeover.ts` holds one rule for both resources.** `ownRow` takes over a row only when no RoutingUrl manages it; `CustomDomain`'s delete skips a row a RoutingUrl manages. Same predicate, no import cycle (the chain to `RoutingUrlRequiredRecords` only imports types from `App` and `Compute`), and the delete has a comment that it relies on removed resources being deleted last.
- **`websiteDomain` turns only `RoutingUrlInvalidHostname` into a defect.** That is the only error `RoutingUrl` can raise while the stack is declared, so `deployWebsite` keeps its `never` error channel without the blanket `Effect.orDie` round 6 flagged.

## Findings

### F52 — The typed refusals match error codes Prisma does not send yet, and the description does not say so

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 382–416; `submodules/distilled` at `625a8ae46` (`packages/prisma/src/services/management.ts` lines 87–132); `pr-bodies/alchemy.md` lines 31, 90 and 96; `wip/u2/project-docs/spec.md` line 29.
- **Issue:** The Distilled draft was generated from a local spec with the codes we asked for (`logical-id-taken`, `invalid-hostname`, `service-not-on-a-branch`, `service-on-another-branch`). `plan.md` says the live spec has none of them, platform slice 8 has not shipped, and the pull requests should open before it does. Today Prisma answers a duplicate `logicalId` with `client-error` and an invalid hostname or a service on another Branch with `validation-error`. With this branch, all three become `RoutingUrlOperationFailed`; only the quota refusal (`quota-exceeded`, already live) stays typed. The old code told them apart by message text, so merging now is a step back for Composer, which needs those tags to tell the user what to fix. The test case "422 validation-error on create becomes RoutingUrlOperationFailed" is exactly what production sends for an invalid hostname today. The description calls the codes "the real code" and lists Distilled as the only dependency; the spec still says errors are matched on Distilled's generic errors. The brief to the platform also left the name for the create's no-Branch refusal open; if the platform reuses `service-on-another-branch` there, create will not match it (the pre-check covers the usual case).
- **Suggestion:** Decide one of two things and write it down. Either the Alchemy pull request does not merge until Prisma sends the codes, and the description says so next to the Distilled dependency. Or the Distilled patch also matches today's responses on the same tags, which the typed error doctrine allows because the matching lives in the SDK: `{ status: 409, body: { "/error/code": "client-error" } }` for `RoutingUrlLogicalIdTaken`, and `{ status: 422, message: { includes: "is not a hostname" } }` and `{ status: 422, message: { includes: "Branch" } }` for the two 422s, removed once the codes ship. Since `plan.md` wants the pull requests open before slice 8, I recommend the second. Then fix the description ("the code Prisma sends") and spec line 29.

### F53 — No test reaches the new no-Branch pre-check, and the description does not mention it

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 341–346 and 376–380; `test/Prisma/fixtures/RoutingUrlCloud.ts` lines 45–57; `pr-bodies/alchemy.md` line 31.
- **Issue:** `serviceOf` now raises `RoutingUrlServiceNotOnABranch` itself whenever the service has no Branch, on every reconcile and on `read`. That is the path a user actually hits; Prisma's 422 is only reached in a race. The fake's `service()` always has `branchId: "br-1"`, so no test reaches it: changing the pre-check to raise `RoutingUrlOperationFailed` fails nothing. The description lists the error only as a 422 on create.
- **Suggestion:** Let the fake return `branchId: null` for one service id (as it does for `svc-no-endpoint`), and add a case: deploy a RoutingUrl for it, expect `RoutingUrlServiceNotOnABranch`, and no `POST`. In the description, say the resource raises it before calling Prisma.

### F54 — Nothing tests that `RemovalPolicy.retain()` on the Website alias lets a later release drop it

- **Location:** `packages/prisma/src/internal/WebsiteDomain.ts` lines 44–58; `test/Prisma/Website/Domain.test.ts`.
- **Issue:** The description and spec give `retain()` one purpose: a later release can stop declaring the alias without deleting the CNAME. Removing `retain()` fails no test, because the fake record set deletes the same CNAME on destroy anyway.
- **Suggestion:** Add a case: deploy `siteDomain({ name, dns })`, then deploy the same stack without the alias (a `RoutingUrl("Url", { app, hostname, dns })` under `Site`, which is what a later release declares), and assert the CNAME is still in the zone and `zone.removed` is empty.

### F55 — The RoutingUrl suite does not check how the TXT check searches for nameservers

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 452–460; `test/Prisma/fixtures/RoutingUrlCloud.ts` lines 480–486.
- **Issue:** Round 6 F44 was fixed by passing `nameservers: "name", serversOf: to`. The unit cases prove the search does the right thing when given those options, but the fake `AuthoritativeRecordCheck` records only the record and `attempts`, so reverting the call to the old parent search fails nothing.
- **Suggestion:** Record the whole options object in the fake (as `checked` does for the switchboard check) and assert it in "with dns, a hostname change goes through because the new hostname's TXT is seen": `{ margin: "if-unseen", nameservers: "name", serversOf: "new.example.com", attempts: "until-seen" }`.

### F56 — The description breaks Alchemy's pull request conventions

- **Location:** `pr-bodies/alchemy.md` lines 92–101.
- **Issue:** `AGENTS.md`: never include a "Test plan" or "Testing" section; when something still needs manual checking, open the pull request as a draft and say what is outstanding in the conversation, not in the description. The description has a `### Tests` section and ends with "None of them has been run". It is also long for the "minimal content" the conventions ask for.
- **Suggestion:** Remove the `### Tests` section. Open the pull request as a draft, and have Will tell the maintainers that the live tests need Prisma and Cloudflare credentials we do not have, naming the two that matter most (the Cloudflare adoption of the second CNAME and the upgrade). Keep the one fact a reviewer needs in the body, if any, as a sentence under the change it concerns.

### F57 — Description claims that are inaccurate or have no test

- **Location:** `pr-bodies/alchemy.md` lines 23, 31, 40 and 96.
- **Issue and suggestion:**
  - Line 23: the `logicalId` "defaults to the resource's name". It defaults to the fully qualified name (a Website's is `Site/Url`), as the JSDoc says. Say "the resource's fully qualified name".
  - Line 31: "Any other 409 or 422 is `RoutingUrlOperationFailed`" is tested on create only. Add the same two cases with `operation: "update"` to `refusalCases`.
  - Line 40: "DNS-only, also when the adapter proxies aliases" has no test. No fake or live case passes an adapter with `proxied: true`. Add `options: { proxied: true }` to the DNS config in one Website fake case and assert the alias was declared without it, or drop "also when the adapter proxies aliases" from the claim.
  - Line 96: "answered with the real code" (see F52).

### F58 — Text that needs rewording

- **Location:** as listed.
- **Issue and suggestion:**
  - `packages/prisma/src/internal/WebsiteDomain.ts` lines 44–46: the comment explains why the alias is declared but not why it has `adopt(true)` and `retain()`. Adopting a DNS record looks dangerous to a reader, and the reason is not visible in the code. Add: "Adopted, because on Cloudflare the record set has already published this CNAME and the alias would otherwise refuse it as someone else's. Retained, so only the record set ever deletes the CNAME."
  - Same file, line 22: "A hostname a RoutingUrl cannot serve is invalid configuration, raised while the stack is built, as `DNS.resolve` does." Suggested: "A hostname a RoutingUrl cannot serve is a mistake in the site's configuration, so it stops the deploy as a defect, as `DNS.resolve` does for a bad DNS configuration."
  - `packages/prisma/src/RoutingUrl.ts` line 90: "The new service is on another Branch than the RoutingUrl." Suggested: "The new service is on a different Branch from the RoutingUrl."
  - `packages/prisma/src/internal/RoutingUrlRequiredRecords.ts` lines 52–53: "from inside the provider so an app id from any source works" is compressed. Suggested: "It reads them in its provider, so the app id can come from any resource's output."
  - Test names, error messages and the other comments in the two commits read plainly on a first read.

### F59 — With `dns`, a service on no Branch gets both records published before the RoutingUrl refuses it

- **Location:** `packages/prisma/src/internal/RoutingUrlRequiredRecords.ts` lines 96–103; `packages/prisma/src/RoutingUrl.ts` lines 297–306.
- **Issue:** `RoutingUrlRequiredRecords` already reads the service but does not check its Branch, so the record set publishes the TXT and CNAME, and only then does the RoutingUrl fail with `RoutingUrlServiceNotOnABranch`. The records stay until the user changes or removes the RoutingUrl, and the CNAME has already replaced whatever served the hostname. This is a refusal Alchemy makes itself and can make first.
- **Suggestion:** In `RoutingUrlRequiredRecords`' reconcile, fail with `RoutingUrlServiceNotOnABranch` when `service.branchId` is null, next to the empty-endpoint check, and extend the "refuses a wildcard or an app with no endpoint before publishing anything" case with a no-Branch service.

### F60 — A hostname that is not a hostname reaches the record resource id and the DNS host

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 291–296; `internal/RoutingUrlRequiredRecords.ts` line 85.
- **Issue:** With `dns`, the only check before publishing is the wildcard check; Prisma validates the hostname only after the records are published. The raw hostname is now part of the resource id, so a typo like `https://api.example.com` adds `/` to the fully qualified name, and a name with `__` is read back from the local and bucket state stores under a different name (`decodeFqn` turns `__` into `/`). Other bad names fail at the DNS host halfway through the deploy.
- **Suggestion:** Refuse anything that is not lowercase letters, digits and hyphens in dot-separated labels (after `normalizeHostname`) with `RoutingUrlInvalidHostname`, next to the wildcard check, and add it to the same test case.

## Deferred (out of scope)

- **Public functions in `Operations.ts` call the routes Prisma deletes about 2026-12-21.** `getCustomDomain`, `deleteCustomDomain`, `retryCustomDomain` and `createAppDomain` (through `Client.ts`, `/v1/domains/{id}` and `/v1/apps/{appId}/domains`) are unchanged by this branch and are exported. The description's "Why now" names only `Prisma.CustomDomain` and `Prisma.Website`. Deprecating them is a change to code this pull request does not touch; worth one line in the description or its own small change.
- **The live tests have never run.** We have no Prisma or Cloudflare test credentials for this repository. Every behaviour above is proved against the fake Management API and an in-memory DNS host. The audit procedure counts fake-cloud tests as not end-to-end; the live cases exist and are skipped. This needs credentials, not code.
- **The temporary Distilled pin** (`bf238ca7db`, which carries only the bot's sign-off) must be replaced by a Distilled `main` commit once the Distilled pull request merges.
- **The platform refusing a hostname change itself**, as recorded in `plan.md`; it would remove the client-side check's blind spot for a RoutingUrl in another workspace.

## Already addressed

| Earlier finding | Status | Where |
| --- | --- | --- |
| F42: the fake's `PATCH` dropped the row's custom domain | Fixed. The `PATCH` keeps `customDomain` unless the hostname changes. Removing `CustomDomain`'s delete skip now fails both upgrade tests on "one row left". A live upgrade case was added (not run). | `0ce9f5db0f` |
| F43: `DomainOwnership.ts` taught `Prisma.CustomDomain` | Fixed. Description and both examples use RoutingUrls and a wildcard, with the exact-hostname warning. The `AuthoritativeDns.ts` comment no longer names it. Only `RoutingUrl.ts`'s migration note, `Providers.ts` and `index.ts` remain. | `0ce9f5db0f` |
| F44 / S17: a failed nameserver lookup reported the TXT `absent` | Fixed in code (`nameservers: "name"`, `serversOf: to`) with two unit cases. The RoutingUrl wiring is not tested (F55). The field is now `ownership`. | `0ce9f5db0f` |
| F45: `site.domain` changed type silently | Fixed in `websites.mdx` and the description. | `0ce9f5db0f` |
| F46: upgrading and changing the hostname in one deploy | Documented in `websites.mdx` and the description. | `0ce9f5db0f` |
| F47: removing `dns` from a Website | Documented in `WebsiteDomain.dns` and `websites.mdx`. | `0ce9f5db0f` |
| F48 / S18: two hostnames mapped to one record id | Fixed. The id is the hostname. "keeps separate records for hostnames that differ only in where a dot and a hyphen are" would fail with the old key. See F60 for names that are not hostnames. | `0ce9f5db0f` |
| F49: the live Website test checked nothing about the domain ownership | Fixed. It asserts the exact-hostname domain ownership is still `verified` after destroy (not run). | `0ce9f5db0f` |
| F50: description contradicted the code | Fixed for the round 6 points. New problems in F52, F56, F57. | description |
| F51: text to reword | Fixed: the alias comment, "until you change or remove the RoutingUrl", the fixture's file comment. | `0ce9f5db0f` |
| S10: a new site with `dns` failed on Cloudflare | Fixed with `adopt(true)`. The fake alias now refuses an existing CNAME like Cloudflare's; removing `adopt(true)` fails two tests. | `0ce9f5db0f` |
| S11: two owners of the CNAME | Mostly fixed: `retain()` added (untested, F54), one value source (`cnameTarget` of the required records), code comment. `plan.md` still does not record when the alias can be removed; the spec's done condition 7 does. | `0ce9f5db0f` |
| S12: the takeover rule written twice | Fixed in `internal/RoutingUrlTakeover.ts`, with the ordering comment on the delete. | `0ce9f5db0f` |
| S13: `recordsPublished` | Renamed `waitForRecords`, documented by what it does. | `0ce9f5db0f` |
| S14: two meanings of "records" | Fixed: `Prisma.RoutingUrlRequiredRecords`, with JSDoc saying why it is separate. | `0ce9f5db0f` |
| S15: three props types | Fixed: `RoutingUrlProps` is the function's parameter; the resource's props are inline. | `0ce9f5db0f` |
| S16: `RoutingUrlResources` | Kept, with the pairing in its JSDoc. | — |
| S19: upgrade tested against a hand copy | Partly. The ids come from shared constants, and a live upgrade case deploys the real `Prisma.Website.StaticSite` (not run). The fake cases still use the hand copy. `websiteDomain` is no longer on a public module path. | `0ce9f5db0f` |
| S20: spec conditions 4 and 7 | Fixed. Spec line 29 is now stale for another reason (F52). | spec |
| S21: jargon | Fixed. | `0ce9f5db0f` |

## Acceptance-criteria verification

Criteria are the description's behavioural claims, grouped, plus the spec's done conditions where they add something.

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: a RoutingUrl with no DNS deploys at once, `pending`, with both records to publish; a redeploy sends no `PATCH`; destroy deletes only the row and sends no domain ownership request | **PASS** | "saves a hostname with no DNS…" asserts `pending`, `firstUnmetCondition`, record types TXT and CNAME, `setupUrl`, the `POST` body, no `PATCH` on redeploy, `DELETE /v1/urls/<id>`, no `domain-ownerships` route, no rows left. |
| AC2: identity by `logicalId`; a row with no `logicalId` on the same service and hostname is taken over; another row with the hostname fails with `RoutingUrlHostnameTaken` naming it | **PASS** | "updates a row found by logicalId in place" (same id, `PATCH`, no `POST`); "adopts a row with no logicalId…" (`PATCH` body `{ logicalId: "Url" }`); "fails, naming the row…" (tag, `url-other`, no `POST`). The default is the fully qualified name, not "the resource's name" (F57). |
| AC3: hostname, service and `logicalId` changes are one `PATCH` | **WEAK** | Hostname and `logicalId` changes are asserted. No test changes the service. |
| AC4: a hostname change on an `active` row is refused before any `PATCH` unless ownership is proved and the hostname points at the switchboard; the error names both hostnames and the records; `ownership` and `switchboardDns` say seen, absent or unknown | **PASS** | Eight cases cover refused (unverified and TXT absent, TXT absent or unknown, DNS unknown, unrouted apex) and allowed (verified exact, verified wildcard, TXT seen, flattened apex), each asserting the `PATCH` count, the fields and the records. The nameserver search the TXT check uses is not checked from this suite (F55). |
| AC5: Prisma's refusals are typed errors by error code; any other 409 or 422 is `RoutingUrlOperationFailed` | **WEAK** | The mapping is right and tested: ten cases, and a wrong mapping fails them. Unknown 409 and 422 are tested on create only (F57). The codes are not sent by Prisma yet, so in production three of the four are `RoutingUrlOperationFailed` today (F52). |
| AC6: a service on no Branch raises `RoutingUrlServiceNotOnABranch` | **NOT VERIFIED** | Only Prisma's 422 on create is tested. The resource's own pre-check, which is the usual path, has no test (F53). |
| AC7: with `dns`, the deploy publishes exactly the TXT and CNAME, from the verification endpoint and switchboard, not from `records`; a redeploy of an `active` row with empty `records` removes nothing; destroy removes both | **PASS** | "with dns, publishes the TXT and CNAME, keeps them once the row is active, and destroy removes them": exact `zone.records`, `removed` empty after the active redeploy, one publish, no `PATCH`, no domain ownership write, empty zone after destroy. |
| AC8: each hostname has its own record set, published before the row is saved; an accepted change removes the old records after the `PATCH`; a refused change keeps them | **PASS** | `zoneAtPatch` holds both hostnames' records at the `PATCH`; old records removed after; refused change keeps both sets and removes nothing; the dot-and-hyphen case keeps two sets. |
| AC9: records are DNS-only, also when the adapter proxies aliases | **NOT VERIFIED** | True by reading (`RecordList` always writes `proxied: false`; the Website strips `proxied` from the alias). No test passes a proxying adapter; the live test checks `proxied !== true` with a default adapter and has not run (F57). |
| AC10: nothing published under `alchemy dev`; a wildcard refused before publishing | **PASS** | "publishes nothing under alchemy dev" (dev id, no publish, no route); "refuses a wildcard or an app with no endpoint before publishing anything" (zero publishes, no `POST`). |
| AC11: the limits (apex, first deploy replaces a CNAME, removing `dns` removes records, a same-value record counts as the resource's) and the two known check limits are in the JSDoc and the Compute guide | **PASS** | All in `RoutingUrl`'s JSDoc and `apps.mdx`. Documentation only. |
| AC12: a hand-built provider list registers the resource with `RoutingUrlResources` and `RoutingUrlProvider()` | **PASS** | `testFor` builds its collection from those public exports and every RoutingUrl and Website case deploys through it; `PublicSurface.test.ts` pins both types. |
| AC13: a Website with `domain` declares one RoutingUrl and passes `dns` through, no CustomDomain or DomainOwnership; DNS not ready deploys `pending` | **PASS** (fake) | Two Website cases assert `pending`, `logicalId` `Site/Url`, both records with `dns`, nothing published without, no `/domains` route, no domain ownership write. They call `websiteDomain` directly; `deployWebsite` calls only that (read). |
| AC14: `site.domain` is the RoutingUrl; the attribute renames are documented | **PASS** | Type in `FrameworkSite.ts`; note in `websites.mdx`. |
| AC15: an upgraded site keeps serving: the row is taken over, `CustomDomain`'s delete skips it, the alias is updated in place under its released id | **PASS** (fake) | Both upgrade cases assert the same row id, one row left, the custom domain kept, no `DELETE`, both records published, nothing removed; removing the skip fails "one row left". The live upgrade case exists and has not run. |
| AC16: the alias has `adopt(true)` because the record set publishes the CNAME first, and `retain()` so a later release can drop it; both take the value from one source | **WEAK** | `adopt(true)` is tested (removing it fails two cases). One value source is true by reading and the exact zone assertions would catch a mismatch. `retain()` has no test (F54). |
| AC17: upgrade first, change the hostname later | **PASS** | Documented in `websites.mdx` and the description; behaviour unchanged by design. |
| AC18: `Prisma.CustomDomain` deprecated with the date; nothing else in `packages/prisma/src` uses it | **PASS** | `@deprecated` with 2026-12-21. Only `Providers.ts`, `index.ts` and `RoutingUrl.ts`'s migration note name it. `Operations.ts` still calls the same routes without the resource (Deferred). |
| AC19: `Prisma.DomainOwnership` proof rules (verified only; TXT at every nameserver or unreachable; bounded verify loop; adoption rules; destroy deletes it) | **PASS** | `DomainOwnership.test.ts`, nine cases, including the six-retry loop at 5 seconds (`DomainOwnershipProof.ts` lines 164–166) and the three adoption cases. "Destroy deletes … its TXT record" is not asserted with `dns`. |
| AC20: `AuthoritativeDns` answers seen, absent or unknown, can be replaced in tests, and each caller states where its search starts | **PASS** | Unit suite, 445 lines, including the two new `serversOf` cases; `AuthoritativeRecordCheck` and `SwitchboardDnsCheck` are `Context.Reference`s; every call site passes `nameservers`. |
| AC21: the guides lead with `Prisma.RoutingUrl`; framework pages no longer name `Prisma.CustomDomain`; no unrelated Cloudflare, email, skills or scripts changes | **PASS** | Only `apps.mdx` and `websites.mdx` name it (as migration text). The diff touches only `packages/prisma`, its tests, the Prisma docs, `dns-adapters.mdx` and the submodule. |
| Spec: released in an Alchemy version Composer can depend on | **NOT VERIFIED** | Not yet released; depends on the Distilled pull request and F52. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 16 | AC1, AC2, AC4, AC7, AC8, AC10, AC11, AC12, AC13, AC14, AC15, AC17, AC18, AC19, AC20, AC21 |
| FAIL | 0 | |
| NOT VERIFIED | 3 | AC6, AC9, spec release condition |
| WEAK | 3 | AC3, AC5, AC16 |
