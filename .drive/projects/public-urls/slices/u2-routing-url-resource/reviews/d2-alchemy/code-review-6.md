# Code review, round 6 — `dns` fixes and `Prisma.Website` on `Prisma.RoutingUrl` (alchemy)

Range: `8645d9bdb3..HEAD` on `feat/prisma-domain-ownership-status` (fork of alchemy-run/alchemy, no pull request yet). Three commits no reviewer has seen:

- `f1f2b6d875`: one record set per hostname; ownership proved by a verified domain ownership or by the TXT record at every authoritative nameserver; nothing published under `alchemy dev`; `RoutingUrlResources` exported; the read-only resource `Prisma.RoutingUrlDnsRecords`; a wildcard hostname and an empty endpoint domain refused before anything is published.
- `62df778dd2`: the TXT check waits only when this deploy published the records.
- `a3bb2c6d42`: `Prisma.Website` attaches its hostname with `Prisma.RoutingUrl`; `Prisma.CustomDomain` is deprecated, and its delete skips a row a RoutingUrl has taken over.

Expectations: `project-docs/spec.md` (done conditions, updated 2026-11-20), `plan.md`, `design-notes.md`, `RoutingUrls.md`, `platform-routing-urls.md`, the round 5 reviews (`reviews/round-5/`), Alchemy's `AGENTS.md` ("Resource and runtime testing conventions"), `.claude/skills/audit/procedure.md` section 3, and the jargon sweep in `.drive/CODE-REVIEW.md`.

What I ran and read:

- `pnpm test:integration test/Prisma/RoutingUrl.test.ts test/Prisma/Website/Domain.test.ts test/Prisma/CustomDomain.test.ts test/Prisma/PublicSurface.test.ts --retry 0`: 37 passed, 5 skipped (the live cases).
- Four mutations, each restored (the working tree is clean):
  - CustomDomain's delete no longer skips a taken-over row: both upgrade tests fail, but on `domains.has(...)` and `domains.size`, not on "one row left" (see F42).
  - `websiteDomain` no longer declares `DomainAlias`: the upgrade test fails, the CNAME is gone after the upgrade.
  - The wildcard refusal removed: "refuses a wildcard … before publishing anything" fails.
  - `recordsPublished` always false: "a hostname change publishes the new records, passes on the TXT …" fails on `txtAttempts`.
- `test/Prisma/Website/Frameworks.local.test.ts -t nextjs --retry 0`: passed (4.6 s).
- `git show upstream/main:packages/prisma/src/Website/FrameworkSite.ts` (identical to release `v2.0.0-beta.87` apart from a dev-server `runtime` option) and the released `CustomDomain.ts`.
- The `alias` and `records` implementations of every DNS adapter in the repo: Cloudflare (`DNS/Adapter.ts`, `Records.ts`, `RecordList.ts`), Route 53 (`Route53/Adapter.ts`, `Record.ts`, `RecordList.ts`), Hetzner (`DnsAdapter.ts`, `DnsRecordList.ts`), and core `DNS.resolve`.
- Distilled's `getServiceUrls` request and response types.

## Summary

The three commits close every round 5 finding that blocked the `dns` option, and the `Prisma.Website` move works on all three DNS adapters, including the upgrade from the released Alchemy. The main weakness is evidence: the upgrade is proved only against a fake whose `PATCH` drops the row's custom domain, so the "one row left" assertion cannot fail, and no live test covers the upgrade that every released site with a `domain` will go through before 2026-12-21. One done condition fails outright: `DomainOwnership.ts` still documents `Prisma.CustomDomain` in its description and both examples.

## What looks solid

- **The upgrade state in the test matches what the release leaves.** The released `deployWebsite` declares exactly two resources for a domain: the adapter alias at id `DomainAlias` (Cloudflare `Cloudflare.DNS.Records` at `DomainAlias-CNAME`, Route 53 `AWS.Route53.Record` at `DomainAlias`, Hetzner `Hetzner.DNS.RecordList` at `DomainAlias-CNAME`) and `Prisma.CustomDomain` at `Domain`, both under the site's namespace. `releasedSiteDomain` declares the same ids and types (the alias through the test adapter, which mirrors Cloudflare's alias delete), and the branch's `CustomDomain` writes the same eleven attributes the released one does. The two small differences, `app: app.appId` in place of `app: compute` and the test alias type, do not change what the upgrade does.
- **The upgrade works on every adapter in the repo, by reading.** The new code declares the alias at the same id, so it is updated in place, not deleted. The new record list takes over the existing CNAME by value: Cloudflare's `RecordList.read` returns nothing without its own state and `syncGroup` matches by value; Route 53's `RecordList` sees the same value and TTL (300 on both sides) and sends no change; Hetzner merges values in one RRSet. Removing the alias from `websiteDomain` makes the upgrade test fail, so the test does check this.
- **The CNAME written by two resources holds up.** The alias depends on the RoutingUrl, so on a hostname change it moves only after Prisma saves the change, and on a refused change it does not run at all. Destroy deletes the alias first and the record list second; Cloudflare's `removeEntries` ignores `RecordNotFound`, and Route 53's `applyChanges` treats a rejected `DELETE` as done. The alias no longer passes `proxied`, so a released site with `proxied: true` is turned DNS-only by the upgrade, which Prisma needs.
- **CustomDomain's delete skip is right in every state a successful deploy can leave.** A RoutingUrl with a `logicalId` for the same service and hostname is, by `ownRow`, the row the CustomDomain's custom domain made, or the row Prisma reused for it (`RoutingUrls.md`, "On create", step 2). Prisma's delete route soft-deletes the row holding the custom domain id whatever its `logicalId`, so deleting would take the RoutingUrl's hostname down. The case "the user really wants the hostname gone while a RoutingUrl for it exists" is not distinguishable, and the right way to stop serving is to remove the RoutingUrl. A failed read fails the delete, so the deploy fails and retries it next time; a deleted service (`NotFound`) falls through to the delete, which is harmless. The response carries `customDomain.id`, which would make the check exact (skip only when the row holding this custom domain has a `logicalId`); I found no reachable state where the hostname check gives a different answer, so I do not file it.
- **The ownership rule now matches the platform.** A covering `verified` domain ownership, or the TXT at every authoritative nameserver, is the evidence Prisma's own lookup reads. The fake no longer turns a TXT in the zone into a `verified` domain ownership; `fromZone` only drives the DNS answers, and the domain ownership route returns only what `state.ownership` says.
- **The refused change keeps the serving hostname's records.** Each hostname has its own record resources, so a new hostname creates new ones and the old ones are removed only with the other leftovers after the whole deploy succeeds. `zoneAtPatch` shows both hostnames' records at the moment of the `PATCH`, and two refused-change tests (RoutingUrl and Website) assert nothing was removed.
- **A wildcard with `dns` on a Website dying as a defect is acceptable.** It happens while the stack is being declared, not inside a lifecycle operation (the AGENTS.md rule against `Effect.orDie` is about lifecycle operations). `deployWebsite` has no error channel, core `DNS.resolve` already dies on a configuration error at the same point, and `FrameworkSite` dies for a missing build output. The defect carries the typed `RoutingUrlInvalidHostname` and its message.
- **The removed live assertion was right to go.** It checked that destroy removed the site's domain ownership, which was true only while the Website declared a `Prisma.DomainOwnership`. The spec now says the resource never deletes a domain ownership. See F49 for what should replace it.
- **The Next.js local test failure was not caused by this range.** In dev, `makeFrameworkSite` returns before `deployWebsite`; the range changes only `deployWebsite` and adds an import. The file passed on re-run.

## Findings

### F42 — The fake's `PATCH` drops the row's custom domain, so the upgrade's "one row left" check cannot fail, and no live test covers the upgrade

- **Location:** `packages/integration-tests/test/Prisma/fixtures/RoutingUrlCloud.ts` lines 306–321; `packages/integration-tests/test/Prisma/Website/Domain.test.ts` lines 131–183.
- **Issue:** The fake follows the platform docs on create (a custom domain create records an `active` row with no `logicalId` holding the custom domain id) and on delete (deleting the custom domain deletes the row holding its id). Its `PATCH` does not: it rebuilds the row with `routingUrl(...)` and no `customDomainId`, so a `PATCH` that only writes the `logicalId` clears `customDomain`. Prisma's `updateRoutingUrl` changes only the fields it is given. After the takeover, the fake's custom domain delete therefore no longer finds the row. With the skip removed from `CustomDomain`'s delete, `expect(Array.from(upgrade.rows.keys())).toEqual([recorded?.id])` still passes; the tests fail only on `domains.has(...)` and `domains.size`. The tests still catch the regression, through "no `DELETE` sent", but the assertion that reads as the outcome the spec asks for is not checking anything. The audit procedure asks for this to be said plainly: the upgrade, which every released site with a `domain` must go through before Prisma deletes the custom domain routes, is proved only against a fake. The live tests in this file deploy fresh sites; none starts from the released shape.
- **Suggestion:** In the fake's `PATCH`, start from the stored row and overwrite only the fields in the body, keeping `customDomain` (and setting it to null only on a hostname change, as Prisma does). Then the "one row left" assertion fails when the skip is removed. Add one live case to `Domain.test.ts`: deploy `releasedSiteDomain`'s shape with a real `Prisma.Compute`, `Prisma.CustomDomain` and `Cloudflare.DNS.Adapter()`, wait for the custom domain, redeploy as `Prisma.Website.StaticSite`, and assert the row id is unchanged, it is `active`, the custom domain still exists, and the hostname still serves HTTPS. It can run only until 2026-12-21, which is the window that matters.

### F43 — `DomainOwnership.ts` still documents `Prisma.CustomDomain`, including an exact-hostname example the RoutingUrl docs warn against

- **Location:** `packages/prisma/src/DomainOwnership.ts` lines 35–70; `packages/prisma/src/internal/AuthoritativeDns.ts` line 342.
- **Issue:** Done condition: "No source file in `packages/prisma/src` other than `CustomDomain.ts` and the exports refers to `Prisma.CustomDomain`." `DomainOwnership.ts` says "Prisma refuses a `Prisma.CustomDomain` until the workspace owns its hostname", its first example pairs a wildcard domain ownership with two `Prisma.CustomDomain`s, and its second example declares a domain ownership for the exact hostname `app.example.com`, which `RoutingUrl`'s JSDoc and `apps.mdx` say not to do next to a RoutingUrl. It also says Website composites "prove their own hostname", which is no longer how a Website works (Prisma creates the domain ownership; the Website only publishes the TXT). This JSDoc is the generated reference page, so the deprecated resource is still what the docs teach. `AuthoritativeDns.ts` line 342 names `Prisma.CustomDomain` in a comment; `RoutingUrl.ts` line 206 does too, as a migration note, which I read as allowed.
- **Suggestion:** Rewrite the `DomainOwnership` description around RoutingUrl: declare it to prove a wildcard once for many RoutingUrls. Change the first example to `Prisma.RoutingUrl`s, and replace or drop the exact-hostname example, or add the warning. Reword the `AuthoritativeDns.ts` comment to name its callers without the deprecated resource, or accept it as an internal comment and say so in the spec.

### F44 — A failed nameserver lookup in the TXT check is reported as `ownershipDns: "absent"`

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 450–460 and 475–480; `packages/prisma/src/internal/AuthoritativeDns.ts` lines 167–184 (`serversFromParent`).
- **Issue:** The spec says the refusal "carries a field that tells 'not published' from 'could not check'". The TXT check uses `nameservers: "parent"`, whose search turns every failed NS or address lookup into "no servers here" and moves one label up. When the lookup for the new hostname's own zone fails (a timeout, or a delegated subzone whose servers do not answer), the search reaches the parent zone's servers, which do not have the TXT, and the check returns `absent`. The refusal then says "not every authoritative nameserver answers TXT …" and asks the user to publish a record that may already be published. Round 4 F28 fixed exactly this for the switchboard check by making the `name` search end at `unknown` on a failed lookup; the TXT check reintroduces it. The change is still refused, so this fails safe, but the field and message are wrong.
- **Suggestion:** Give the TXT check a search that keeps a failed lookup `unknown`: find the servers from the new hostname with the `name` search (the TXT name is always one label below it, in the same zone unless `_prisma-verification` is delegated), then ask those servers for the TXT. Add a unit case in `AuthoritativeDns.test.ts`: a failed NS lookup at the hostname gives `unknown`, not `absent`.

### F45 — `site.domain` changed type from `CustomDomain` to `RoutingUrl`, and nothing tells the user

- **Location:** `packages/prisma/src/Website/FrameworkSite.ts` line 108; `website/src/content/docs/prisma/frontend/websites.mdx`; the pull request description.
- **Issue:** The released guide told users to "Configure its `dnsRecords` … and inspect `status`, `foundryStatus`, and `failureReason`". Those attributes, and `customDomainId`, no longer exist on `site.domain`; `status` now means `pending | active` instead of the custom domain's status. A stack that reads any of them stops compiling after the upgrade, or, through `Output` mapping, reads `undefined`. The guide's note lists the two behaviour changes the spec names, but not this one.
- **Suggestion:** Add one sentence to the note in `websites.mdx` and to the pull request description: `site.domain` is now the hostname's `Prisma.RoutingUrl`; read `records` in place of `dnsRecords`, and `status` (`pending` or `active`) with `firstUnmetCondition` in place of `foundryStatus` and `failureReason`.

### F46 — Upgrading and changing the hostname in the same deploy takes the old hostname down with no check

- **Location:** `packages/prisma/src/Website/FrameworkSite.ts` lines 180–201; `packages/prisma/src/CustomDomain.ts` delete (lines 389–410).
- **Issue:** A site deployed with the released Alchemy at `www.example.com` is redeployed with the new Alchemy and `domain: "shop.example.com"`. The RoutingUrl finds no row for `shop.example.com`, so it creates one, `pending`; this is a create, so the check before a hostname change does not run. The old `Prisma.CustomDomain` is then deleted as a leftover: no row with a `logicalId` names `www.example.com`, so the skip does not apply, and Prisma stops serving it. With `dns`, the alias also moves and deletes the old CNAME. Design note 12's promise ("a serving hostname is never replaced by one that cannot serve") does not hold on this path. The released guide said a hostname change was rejected, so a user may try it for the first time exactly during the upgrade.
- **Suggestion:** The cheapest fix is a sentence in the upgrade note: "Deploy the upgrade with the same `domain` first; change the hostname in a later deploy, which is checked." A code fix would make `websiteDomain` find the released custom domain's row and change it with the check, which is more than this slice needs.

### F47 — Removing `dns` from a Website removes its records, and the Website docs do not say so

- **Location:** `packages/prisma/src/Website/FrameworkSite.ts` lines 49–56 (`WebsiteDomain.dns` JSDoc); `website/src/content/docs/prisma/frontend/websites.mdx`.
- **Issue:** Round 5 F38 is fixed for `Prisma.RoutingUrl`. On a Website, removing `dns` leaves three resources behind (`Url/RequiredRecords-…`, `Url/Records-…` and the alias), and Alchemy deletes the TXT and the CNAME at the end of a deploy that succeeds, while the RoutingUrl stays `active`. `WebsiteDomain.dns` says "Omitted: publish `domain.records` yourself", but `records` is empty while the row is `active`, so a user who moves record management elsewhere has nothing to copy and the hostname stops serving.
- **Suggestion:** Say in `WebsiteDomain.dns` and in `websites.mdx` that removing `dns` removes the TXT and the CNAME, and that to move them to another tool, publish them there first (`_prisma-verification.<hostname>` with the workspace's value, and the CNAME to the switchboard).

### F48 — Two hostnames can map to the same record resource id

- **Location:** `packages/prisma/src/RoutingUrl.ts` line 259.
- **Issue:** `key` replaces every character other than `a-z`, `0-9` and `-` with `-`, so `a.b-c.example.com` and `a-b.c.example.com` both give `a-b-c-example-com`. A hostname change between two such names updates the same record resource in place, which removes the old hostname's records before the check, the round 5 F32 outage, for this pair of names.
- **Suggestion:** Make the key one-to-one, for example escape `-` as `--` before replacing `.` with `-`, or append a short hash of the hostname. Add a unit-sized case if the key moves into a function.

### F49 — The live Website test no longer checks anything about the domain ownership

- **Location:** `packages/integration-tests/test/Prisma/Website/Domain.test.ts` lines 336–410.
- **Issue:** Removing the "domain ownership deleted on destroy" assertion was a correct behaviour change (see "What looks solid"), but nothing replaced it, so the live test proves neither that Prisma created the domain ownership nor that destroy left it alone. The domain ownership also stays in the shared test workspace after every run; the hostname is fixed, so it does not accumulate, but a reader will think it leaked.
- **Suggestion:** After destroy, assert that the exact-hostname domain ownership still exists and is `verified`, with a one-line comment that Prisma created it and the stack does not own it.

### F50 — The pull request description contradicts the code

- **Location:** `.drive/projects/public-urls/slices/u2-routing-url-resource/pr-bodies/alchemy.md` lines 21, 25, 41 and 64.
- **Issue:** It still says the check needs a verified domain ownership, that replacing a CustomDomain needs `RemovalPolicy.retain()` or an earlier deploy, that a Website "proves its own hostname" with a domain ownership, and that the upgrade may need `--adopt`. All four are now wrong, and it has no `dns` section. `plan.md` lists updating it as the next step; I record it so it is not missed.
- **Suggestion:** Rewrite those paragraphs from `spec.md`, add the `dns` example, the Website change (with F45's type note), and the deprecation.

### F51 — Text that needs rewording

- **Location:** as listed.
- **Issue and suggestion:**
  - `packages/prisma/src/Website/FrameworkSite.ts` lines 187–189: "Keeps the CNAME record a site from an earlier version published …" has to be read twice, and hides that every new site also gets this second CNAME resource. Suggested: "Sites deployed before Alchemy used RoutingUrl published this CNAME at this id. Declaring it keeps the record through the upgrade instead of deleting it at the end of the deploy. It depends on the RoutingUrl, so a hostname change moves it only after Prisma saves the change."
  - `packages/prisma/src/RoutingUrl.ts` lines 222–223 and `apps.mdx`: "A create Prisma refuses leaves both records published until the next deploy or destroy" reads as if the next deploy removes them. It does not while the declaration is unchanged. Suggested: "A create Prisma refuses leaves both records published until you change or remove the RoutingUrl."
  - `packages/integration-tests/test/Prisma/fixtures/RoutingUrlCloud.ts` line 33: the file's description is a doc comment on `HOSTNAME`, so editors show it as the constant's documentation. Make it a plain comment at the top of the file, or move it onto `makeUrlCloud`.
  - Test names, error messages and the other comments in the range read plainly on a first read.

## Deferred (out of scope)

- **Whether Prisma's lookup at the `PATCH` sees the TXT this machine saw.** The new rule counts ownership as proved when every authoritative nameserver answers the TXT, and relies on Prisma's lookup during the update finding it too. If that lookup misses, Prisma has already removed the old hostname's custom domain and the new one stays `pending` until Prisma looks again. This is the same kind of assumption as round 4 F25; the platform request in `plan.md` (refuse such a change on the platform) removes it. It needs the platform, not this branch.
- **The Website's second CNAME resource.** Every site with `dns` now declares the alias only so released sites keep their CNAME. Dropping it needs a later release, once released sites have upgraded.
- **`RecordList` taking over and later deleting records it did not create** (round 5, behind F37's taken-hostname case): a Cloudflare change shared by every adapter user.
- **Typed 409 and 422 errors** (round 3 F13): wait for platform slice 8, as `plan.md` records.

## Already addressed

| Earlier finding | Status | Where |
| --- | --- | --- |
| F32 / S01: a refused change with `dns` removed the serving hostname's records first | Fixed. One record set per hostname; old ones are removed only after the deploy succeeds. Two refused-change tests assert nothing was removed, and `zoneAtPatch` shows both hostnames' records at the `PATCH`. Not fixed for two hostnames that map to one key (F48). | `f1f2b6d875` |
| F33 / S02: an exact hostname could never pass the check; the fake called a TXT in the zone a verified domain ownership | Fixed. The TXT at every authoritative nameserver now counts; the refusal's advice works; the fake returns a domain ownership only when the test sets one. | `f1f2b6d875` |
| F34: `alchemy dev` published live DNS | Fixed. Nothing is published in dev unless the RoutingUrl is `Alchemy.remote()`; "publishes nothing under alchemy dev" asserts no route and no publish. | `f1f2b6d875` |
| F35: Composer could not register the provider | Fixed. `RoutingUrlResources` holds both resources, is in `PublicSurface.test.ts`, and the shared fixture registers from public exports only. The DNS checks are `Context.Reference`s with defaults, so a consumer need not provide them. | `f1f2b6d875` |
| F36: an app id of a declared App failed from the second deploy | Fixed. The app is resolved inside the provider; no `App.lookup` remains. A test deploys twice with the app id taken from another resource. | `f1f2b6d875` |
| F37: records published before a refused create | Fixed for the wildcard (refused before anything is published, tested) and documented for other refusals. The taken-hostname deletion is deferred with `RecordList`. | `f1f2b6d875` |
| F38: removing `dns` deletes the records | Fixed for `Prisma.RoutingUrl` (JSDoc and `apps.mdx`). Not for `Prisma.Website` (F47). | `f1f2b6d875` |
| F39: the app-id cast and the empty endpoint | Fixed. No cast; an empty endpoint fails with `RoutingUrlOperationFailed` naming the app, tested. | `f1f2b6d875` |
| F40: two criteria had no test evidence | Fixed. The `dns` lifecycle test asserts no domain ownership writes during deploy; "adding dns to a deployed RoutingUrl keeps its row" asserts the same id, no `PATCH`, no `POST`, no `DELETE`. | `f1f2b6d875` |
| F41 / S08: spec and pull request description | Spec fixed (scope, decisions, done conditions). Pull request description not yet (F50). | spec 2026-11-20 |
| S03: one CNAME through two adapter methods | Settled for RoutingUrl: records are DNS-only, stated in the JSDoc. The Website now declares both on purpose (see "What looks solid" and Deferred). | `f1f2b6d875`, `a3bb2c6d42` |
| S04: the record set is derived on the client | Recorded as a platform request in `plan.md`. | `plan.md` |
| S05: the RoutingUrl's hostname came from a sibling's attribute | Fixed. The record set maps to the caller's hostname. | `f1f2b6d875` |
| S06: the inner resource's name | Addressed. The internal module is gone; the resource is reached through `RoutingUrlResources`. | `f1f2b6d875` |
| S07: `waitForSwitchboardDns` with `attempts: "once"`; `NameserverSearch` means two things | Not addressed; minor and the architect's call. F44 is a consequence of the second half. | — |
| S09: the first deploy repoints a hostname that serves elsewhere | Documented in the JSDoc and `apps.mdx`. | `f1f2b6d875` |

## Acceptance-criteria verification

Criteria are the spec's done conditions that this range touches, in the wording the dispatch gave.

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: with `dns`, a first deploy publishes exactly the TXT and the CNAME; a redeploy after the row is `active` with empty `records` removes nothing; destroy removes both records and sends no domain ownership request | **PASS** | "with dns, publishes the TXT and CNAME, keeps them once the row is active, and destroy removes them" asserts `zone.records` equals exactly the two records, then sets the row `active` with `records: []`, redeploys and asserts unchanged records, `removed` empty, one publish, no `PATCH`, no domain ownership write; after destroy, `zone.records` empty, `DELETE /v1/urls/<id>`, and no `domain-ownerships` route. |
| AC2: a hostname change on an `active` row is refused with no `PATCH` unless ownership is proved (covering `verified` domain ownership, or TXT at every authoritative nameserver) and the hostname points at the switchboard; a refused change with `dns` leaves the old hostname's records | **PASS** | Refused with no `PATCH`: unverified domain ownership and TXT absent (`refusedChange`), TXT absent or unchecked with the CNAME seen (`txtMissing`), DNS unchecked (`unchecked`), apex with nothing pointing at the switchboard (`unroutedApex`). Allowed: exact domain ownership `verified` (`allowedChange`), wildcard `verified` (`wildcard`), no domain ownership but TXT and CNAME seen (`txtProof`), apex by addresses (`flattenedApex`). Records kept: `dnsRefused` and the Website `siteChange` assert both hostnames' records present and nothing removed. Caveat: F44, a failed lookup reports `absent` instead of `unknown`. |
| AC3: a `Prisma.Website` with a `domain` declares a RoutingUrl and no CustomDomain or DomainOwnership; with DNS not ready it deploys and reports `pending` | **PASS** | `deployWebsite` calls only `websiteDomain`, which declares `RoutingUrl` and, with `dns`, the alias (read). The two fake tests assert `status: "pending"`, `logicalId: "Site/Url"`, no `/domains` route and no domain ownership write. They call `websiteDomain` directly with a stand-in app, so `deployWebsite`'s wiring is checked by reading and by the skipped live test only. |
| AC4: a `Prisma.Website` state written by the released Alchemy redeploys with one row for the hostname left and its DNS records still published, and a test proves no delete was sent for that row | **PASS** (fake only) | The starting state matches the release in ids, types and attributes (see "What looks solid"). Both upgrade tests assert the same row id, no `DELETE` route at all, the custom domain still present, and (with `dns`) both records published and nothing removed; removing the skip or the alias fails them. The "one row left" assertion cannot fail in the fake (F42), and no live test covers the upgrade. |
| AC5: no source file in `packages/prisma/src` other than `CustomDomain.ts` and the exports refers to `Prisma.CustomDomain` | **FAIL** | `DomainOwnership.ts` refers to it in its description and two example lines; `internal/AuthoritativeDns.ts` in a comment (F43). `FrameworkSite.ts` no longer refers to it. `RoutingUrl.ts`'s migration note and `Providers.ts`'s registration I count as allowed. |
| AC6: a consumer that builds its own provider list can register everything `Prisma.RoutingUrl` needs, with and without `dns`, from public exports only | **PASS** | `testFor` builds `Provider.collection([...RoutingUrlResources, CustomDomain])` with `RoutingUrlProvider()` from `@alchemy.run/prisma/RoutingUrl`, and the suite deploys with and without `dns` through it. Its internal imports only replace the DNS checks, which have default implementations. `PublicSurface.test.ts` pins both resource types in `RoutingUrlResources`. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 5 | AC1, AC2, AC3, AC4, AC6 |
| FAIL | 1 | AC5 |
| NOT VERIFIED | 0 | |
| WEAK | 0 | |
