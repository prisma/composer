# U2 — dispatch plan

U2 produces exactly two upstream pull requests: one on alchemy-run/distilled and one on alchemy-run/alchemy (Will, 2026-11-10: the Alchemy team must not get more). Steps below are build steps, not pull requests.

**Neither pull request is opened until the platform's full API has shipped**, through platform slice 8 (the `prisma.build` endpoint), so the Alchemy team sees one Distilled and one Alchemy pull request for the whole API (Will, 2026-11-10). Until then the branches are built and kept on the bot forks; the Distilled regeneration is redone once, against the final spec, before opening.

Prerequisites: platform slice 3 (prisma/pdp-control-plane#5924) deployed to production (done 2026-11-06); live Prisma credentials for Alchemy's integration tests confirmed before the live tests.

Sam Goodwin's alchemy-run/alchemy#2701 and its base #2698 are replaced by the Alchemy pull request (Will, 2026-11-06). Sam is asked to close both once it is open.

**Agreed with charlemagne-88, 2026-11-11:** the error codes below ship in platform slice 8. Apex hostnames are supported: Foundry accepts a hostname with no CNAME when its A or AAAA records include a switchboard address, so flattening, ALIAS or ANAME works; slice 4 corrects `RoutingUrls.md`. Alchemy accepts a hostname change to an apex whose A/AAAA answers match the switchboard's.

**Platform request before opening:** distinct error codes for the RoutingUrl create and update refusals. Today a duplicate `logicalId` 409 is `client-error`, and an invalid hostname and a service on another Branch are both `validation-error`; only the quota 409 has its own code (`quota-exceeded`). Proposed: `logical-id-taken`, `invalid-hostname`, `service-on-another-branch`. Then the Distilled pull request types the four errors on `/error/code` (as patch 005 does), and Alchemy uses `catchTags` instead of matching message text (U2 review round 3, finding 1).

**Platform doc corrected:** `docs/compute/RoutingUrls.md` now says an apex uses ALIAS, ANAME or a flattened CNAME, and that Foundry uses a hostname's A or AAAA records only when it has no CNAME. Alchemy's check follows the same rule: a nameserver that answers a CNAME that is not the switchboard counts as not pointing at it.

**Platform requests, not scheduled:** Alchemy's check before a hostname change copies Foundry's acceptance rule and cannot see a RoutingUrl in another workspace that holds the new hostname (`heldBy`). Two requests remove the copy: the update route refuses a change that would take a serving hostname out of service, or failing that, a cheap lookup that says whether a hostname is held. Until one ships, the client check is a stopgap and the limit is documented in the resource's JSDoc and guide.

**Before opening, after platform slice 8:** regenerate Distilled against the final spec, add the error-code patch and switch Alchemy to `catchTags`, then run `drive-code-review` on both branches once more. That review covers the apex support and the nameserver lookup fix in Alchemy `47fecd7d3`, which no review has seen yet.

## State on 2026-11-20

- **Platform slice 8 has not shipped.** The platform plan lists it as planned with no spec, and the live spec has none of the three error codes.
- **Both branches are rebased onto upstream `main`.** Distilled `feat/prisma-routing-urls` is at `f3bce8aa6`; the old tips are kept as `archive/` branches on the forks.
- **Upstream Distilled regenerated the Prisma client itself on 2026-11-15**, so it already has the RoutingUrl operations and the domain ownership statuses. Until 2026-11-23 our Distilled branch also added `T.ResponseCode()` in the REST protocol and `httpStatus` on the two creates (patch 006). Both were removed that day: see [remove-http-status-plan.md](remove-http-status-plan.md). The branch now holds patch 005 no longer adding `DomainOwnershipRequired` to `createWorkspaceDomainOwnership`, the error-code patch 007, and the spec update.
- **Alchemy cannot build against Distilled `main` yet.** Alchemy pins Distilled at `63ab82684`, 117 commits behind, and some of those commits are breaking changes Alchemy has not adopted. So the Alchemy branch pins a temporary Distilled branch on the bot's fork, `feat/prisma-routing-urls-on-alchemy-pin`: the same four commits on top of `63ab82684`. Before the Alchemy pull request opens, either upstream Alchemy has moved to a Distilled commit that contains our merged changes, or the Distilled change must be offered on the commit Alchemy pins. Check which when the time comes.
- **Round 4 review** covered the two commits round 3 had not seen (`7de692c41` and `9f6f52c9e` after the rebase) and the fixes that followed. Reviews are in [reviews/d2-alchemy/](reviews/d2-alchemy/).

## Distilled pull request (branch `feat/prisma-routing-urls`)

- **D1.** `@distilled.cloud/prisma` only: typed errors for the five RoutingUrl refusals, `DomainOwnershipRequired` off `createWorkspaceDomainOwnership`, and the spec update. No change to Distilled's core or generator. The earlier `httpStatus` design was rejected by a Distilled maintainer and removed on 2026-11-23.

## Alchemy pull request (branch `feat/prisma-domain-ownership-status`)

- **D2.** `Prisma.DomainOwnership` with statuses, replacing #2698 and #2701. Built and reviewed twice.
- **D3.** `Prisma.RoutingUrl`, as [spec.md](spec.md) describes, on the same branch.
- **Validation** (from the Alchemy repo root):
  - `pnpm test:integration` on the relevant Prisma test files only, with fakes, plus the live RoutingUrl test file alone when credentials exist
  - `pnpm exec tsrs -b`
  - `pnpm exec oxfmt --check` and `pnpm exec oxlint` over the touched files
  - `pnpm docs:check-jsdoc` and `pnpm docs:gen`

## Deadline: Prisma deletes the custom domain routes about 2026-12-21

Will decided on 2026-11-20 that the platform's old custom domain routes (`/v1/services/{id}/domains`, `/v1/domains/{id}`, retry, and the `/v1/apps/{appId}/domains` aliases) are deprecated now and deleted 30 days after the deprecation reaches production, target 2026-12-21. The date moves only if these two switches have not been released by then; callers on old client versions are not waited for. The platform plan records it in pdp-control-plane, `projects/routing-urls/plans/plan.md`, on the branch `feat/routing-urls-hostname-states`.

- **Alchemy:** `Prisma.RoutingUrl` is released, then `Prisma.CustomDomain` is deprecated and removed. Inside Alchemy the only caller of `Prisma.CustomDomain` is `Prisma.Website` (a site with a `domain`), so it must move to `Prisma.RoutingUrl` before the routes go. `Prisma.RoutingUrl` takes a `dns` option for this (Alchemy `8645d9bdb3`, under review).
- **Composer:** a named hostname in `publicUrl()` creates a `Prisma.RoutingUrl` (P2 in the project plan). It needs the Alchemy release first.
- **Not owned by this project:** the `prisma` CLI's `prisma service domain ...` commands call the old routes too.

What can make Alchemy miss the date: the bot cannot open pull requests on alchemy-run, so Will opens them; the Distilled pull request merges first; and Alchemy pins a Distilled commit it cannot simply move forward, which only Alchemy's maintainers can settle. None of these is in our hands, so the pull requests should open as early as possible instead of waiting for the platform's error codes.

**Error codes, approved 2026-11-20 and being built on the platform:** `quota-exceeded` (unchanged), `logical-id-taken`, `invalid-hostname`, `service-on-another-branch` (update), `service-not-on-a-branch` (create). The brief sent to the platform is [platform-error-codes-brief.md](platform-error-codes-brief.md).

## Added 2026-11-20: `dns` on RoutingUrl, and Website off CustomDomain

Two more dispatches on the same Alchemy branch, each reviewed with `drive-code-review` before the next starts. Still one Alchemy pull request.

- **D4. `dns` on `Prisma.RoutingUrl`.** Built as Alchemy `8645d9bdb3`. Under review together with `dcc35d3f4`, the last fix from the fourth review, which no reviewer had seen.
- **D5. `Prisma.Website` uses `Prisma.RoutingUrl`.** `Website/FrameworkSite.ts` declares one RoutingUrl for `domain` and passes `dns` through; no CustomDomain, no DomainOwnership. The upgrade from the released Alchemy keeps the hostname serving (see [spec.md](spec.md)); the mechanism is the implementer's to find, and it stops and reports if the hostname cannot be kept serving without a platform change. `Prisma.CustomDomain` gets a deprecation note. Tests in `test/Prisma/Website/CustomDomainDns.test.ts` and the Website guide are updated.
- **Then:** update `pr-bodies/alchemy.md`, and run the final `drive-code-review` across the whole branch before handing Will the compare links.

**Fifth review, 2026-11-20** ([code](reviews/d2-alchemy/code-review-5.md), [design](reviews/d2-alchemy/system-design-review-5.md)), of the `dns` option and the last fix from the fourth review. Two serious findings, both being fixed: with `dns`, a refused hostname change had already deleted the serving hostname's records; and the check before a hostname change could never pass for an exact hostname (see spec.md for the new rule). Also found: `Prisma.RoutingUrl` as a function can no longer be registered by a consumer that builds its own provider list, which Composer does, so the fix must export what Composer's switch needs.

**Platform request, not scheduled:** a field on the RoutingUrl that lists every DNS record the hostname needs, met or not. `records` lists only those still to publish, so the `dns` option builds the two records itself, which is one more copy of the platform's switchboard rule on the client.

**Sixth review, 2026-11-20** ([code](reviews/d2-alchemy/code-review-6.md), [design](reviews/d2-alchemy/system-design-review-6.md)), of the fixes above and the Website move (Alchemy `f1f2b6d875`, `62df778dd2`, `a3bb2c6d42`). The earlier serious findings are fixed. New, being fixed: a new site with `dns` on Cloudflare is expected to fail its first deploy because its two CNAME resources collide; the record set's id was not unique per hostname; the upgrade test's fake could not fail on its main assertion. The upgrade from the released Alchemy is proved against a fake only, never live.

**Error codes shipped 2026-11-20** (prisma/pdp-control-plane#6111). Alchemy `7208f801b1` catches the typed refusals. The Distilled patch is drafted on a local branch (`draft/routing-url-error-codes`, never pushed) because Distilled may only commit a client generated from its spec mirror, and the mirror refreshes daily at 00:00 UTC; the real Distilled commits and Alchemy's pin follow the first refresh that has the codes. Any line above that says the resource matches Distilled's generic errors is out of date.

**Seventh review, 2026-11-20** ([code](reviews/d2-alchemy/code-review-7.md), [design](reviews/d2-alchemy/system-design-review-7.md)), of the whole Alchemy branch against the pull request description. No serious faults; the public interface was accepted as it stands. Being fixed: missing tests, a hostname with characters that are unsafe in a resource id, and wording. Its first finding, that Prisma does not send the new codes yet, is wrong: they are live.

**How the Alchemy pull request opens.** Alchemy's rules forbid a testing section in a description and say outstanding work goes to a draft pull request and to the person who asked. So it opens as a draft with the title `feat(prisma)!: Prisma.RoutingUrl, and Prisma.Website on it`, and what is outstanding is told to Sam outside the description: no live test has been run (no Prisma or Cloudflare test credentials), and the two places a live run would tell most are a new site with `dns` on Cloudflare and the upgrade of a deployed site. The site's CNAME alias kept for the upgrade can be removed in a release after sites deployed before this one have redeployed.

## D6: wait for `active` with `dns`, and report the certificate limit (2026-11-20)

One implementer dispatch on the Alchemy branch, then both passes of the code review, then fixes, then push and description update. See the spec section "Waiting for the hostname, and Prisma's certificate limit". Open point for the implementer to settle from the control plane code: how a failed certificate and the hourly limit show in the API response without reading message text. If only the text shows it, quote `customDomainSyncError` in the error and record that the platform needs a code.

### Platform request from D6: a structured signal for the hourly certificate limit

The resource recognises the hourly certificate limit by matching the exact sentence the control plane writes into `customDomainSyncError` (`certificateSlotWaitMessage` in `routingUrlConditions.ts`). A reworded sentence turns the clear error into a timeout that quotes the text. Wanted: a field on the RoutingUrl response such as `certificateLimit: { limit, resetAt } | null`, or a `state` value for it. No date; the match works until the wording changes.

## To do with the next push to the Alchemy branch

- **The removal date is not fixed.** Will's decision of 2026-11-20 is: the old custom domain routes are deleted 30 days after their deprecation reaches production, target 2026-12-21. The deprecation (prisma/pdp-control-plane#6113) was merged on 2026-11-23 before Will decided to ship it, published `x-sunset: 2026-12-23`, and is being reverted in prisma/pdp-control-plane#6140. Will decides when it goes in. The Alchemy pull request states "about 2026-12-21" in three places: the description, the `@deprecated` JSDoc in `packages/prisma/src/CustomDomain.ts`, and `website/src/content/docs/prisma/compute/apps.mdx`. Ask Will what they should say before the next push. Also: Distilled's converter drops operations a spec marks deprecated (`skipDeprecated`, default true). Once the deprecation is published and Distilled next updates Prisma's spec, the five custom domain operations leave the SDK, and `Prisma.CustomDomain` in our pull request, which imports them, stops compiling. Alchemy's `main` uses its own client there and is not affected.
- Facts about the current control plane, from the platform session on 2026-11-23 (code read, not sent to production): a custom domain create refused with `400` DNS-not-configured or `422` `domain-ownership-required` leaves nothing that `GET /v1/services/{id}/domains` lists, so `Prisma.CustomDomain`'s look before each attempt cannot find its own half-made row. After a `500` the platform keeps the row and may register the custom domain later by itself; the next deploy then finds it and asks for `--adopt`. The reviews under `reviews/remove-http-status/` reasoned from a control plane checkout of 2026-11-18, which the platform replaced on 2026-11-20.
