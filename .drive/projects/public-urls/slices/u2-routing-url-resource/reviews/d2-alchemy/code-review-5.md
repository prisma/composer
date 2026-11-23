# Code review, round 5 — `Prisma.RoutingUrl` fixes and the `dns` option (alchemy)

Range: `8bd86303a7..HEAD` on `feat/prisma-domain-ownership-status` (fork of alchemy-run/alchemy, no pull request yet). Two commits no reviewer has seen:

- `dcc35d3f48`: the hostname-change check counts a CNAME to any other name as `absent`; a failed nameserver lookup on the RoutingUrl search stays `unknown`; an unverified domain ownership makes the check ask once; CustomDomain's DNS wait goes through the replaceable `AuthoritativeRecordCheck`; the live case waits for `active` after the move.
- `8645d9bdb3`: `Prisma.RoutingUrl` takes an optional `dns` (an Alchemy DNS adapter config). With it, the deploy publishes the TXT ownership record and the CNAME to the switchboard through that DNS host, before it saves the RoutingUrl. The resource itself moves to `packages/prisma/src/internal/RoutingUrlResource.ts`, and `Prisma.RoutingUrl` becomes a function that declares it.

Expectations: `spec.md`, `design-notes.md` (notes 7, 8, 12), `plan.md`, `RoutingUrls.md`, `platform-routing-urls.md`, the round 3 and round 4 reviews, the intended pull request description `pr-bodies/alchemy.md` (written before the `dns` commit), the eight acceptance criteria the orchestrator gave the `dns` implementer, Alchemy's `AGENTS.md` ("Resource and runtime testing conventions") and `.claude/skills/audit/procedure.md`. There is no `.drive/CODE-REVIEW.md`.

What I ran:

- `pnpm test:integration test/Prisma/RoutingUrl.test.ts test/Prisma/AuthoritativeDns.test.ts test/Prisma/CustomDomain.test.ts --retry 0`: 35 passed, 2 skipped (the live cases).
- Three mutations, each restored: dropping the TXT from the published set fails both `dns` tests; removing the RoutingUrl's dependency on the records fails the ordering test; undoing the "CNAME to another name" and "failed NS lookup stays unknown" fixes fails the two unit cases written for them.
- Two temporary probe tests in `RoutingUrl.test.ts`, since removed: a refused hostname change with `dns`, and a `dns` deploy under `alchemy dev` (`Test.make({ dev: true, sidecar: false })`). Their output is quoted under F32 and F34.
- Read Cloudflare's `DNS.Adapter` and `DNS.RecordList`, `alchemy/DNS/Adapter`, `Resource.lookup` and the plan's managed-lookup check, and how `Prisma.Website` and `Prisma.DomainOwnership` use DNS adapters.
- Read Composer's `packages/1-prisma-cloud/0-lowering/lowering/src/providers.ts` for how the one consumer registers Prisma providers.

The clone's working tree was left clean.

## Summary

`dcc35d3f48` closes round 4's F26 to F31 properly, each with a unit case that fails when the fix is undone. `8645d9bdb3` publishes the right two records in the right order and leaves the no-`dns` path untouched, but on a hostname change of a serving RoutingUrl it removes the old hostname's CNAME and TXT before the check that may refuse the change, and that check refuses every such change unless a covering domain ownership was already verified, because nothing creates one for the new hostname before the `PATCH`. The test cannot show this: its fake Prisma calls a domain ownership `verified` as soon as the TXT is in the fake zone. Together these turn the feature's main promise around: with `dns`, changing a serving hostname takes it down and the deploy cannot recover by redeploying. Two more problems are serious: `alchemy dev` publishes live DNS with dev placeholder values, and Composer cannot register the RoutingUrl provider any more because the resource class is now internal.

## What looks solid

- **The published set does not depend on what Prisma still lists.** The records come from `DomainVerification` (the workspace's value) and the app's endpoint, not from the RoutingUrl's `records` attribute. The `dns` lifecycle test turns the row `active` with an empty `records` list, redeploys, and asserts nothing was removed and the DNS host was not asked again (`publishes` stays 1).
- **The ordering is real and tested.** The RoutingUrl's `hostname` is an Output that waits on the record resource, so on any deploy the records are published first. Removing that dependency makes "publishes the new hostname's records before the check" fail.
- **Destroy order is right.** The RoutingUrl depends on the records, so destroy deletes the RoutingUrl first and the records second; there is no moment where an `active` row has lost its DNS while it still exists.
- **The no-`dns` path is the old call.** `RoutingUrl(id, props)` without `dns` is `RoutingUrlResource(id, props)` with the same id and type string, so its fully qualified name, default `logicalId` and state rows are unchanged.
- **Round 4's fixes are complete.** A CNAME to another name is `absent` whatever its A answers say, and the fake DNS now answers A queries through an in-zone CNAME the way a real server does, so the case is meaningful. The RoutingUrl search returns `unknown` on any failed CNAME, NS or nameserver address lookup and never climbs to the parent on a failure. The parent search used by DomainOwnership and CustomDomain is back to its first-release behaviour, and a unit case says so. CustomDomain's options are now asserted.
- **It follows the package's existing pattern.** `Prisma.DomainOwnership` already wraps an internal resource and publishes its TXT through `dns.records` in a pushed namespace.

## Findings

### F32 — With `dns`, a refused hostname change has already removed the serving hostname's records

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 225–239 (`RoutingUrl`), 245–274 (`publishRecords`); `packages/cloudflare/src/DNS/RecordList.ts` (`reconcile`, the stale-record removal).
- **Issue:** On a hostname change the record resource is updated in place before the RoutingUrl is reconciled. Cloudflare's `RecordList` (and the test's DNS host) publish the new records and, in the same reconcile, delete the records it no longer lists: the old hostname's CNAME and TXT. Only then does `ensureCanServe` run. If it refuses, the `PATCH` is never sent, Prisma still serves the old hostname, and its CNAME no longer exists. That is the outage design note 12 exists to prevent ("A serving hostname is never replaced by one that cannot serve"). A probe on the fake, with no verified domain ownership for the new hostname:

  ```text
  [Url/Records] updated
  [Url] fail — RoutingUrlHostnameChangeRefused: ... Publish TXT _prisma-verification.new.example.com = ... and CNAME new.example.com = switchboard.us-east-1.prisma.build, then redeploy.
  after records: TXT _prisma-verification.new.example.com, CNAME new.example.com
  after removed: TXT _prisma-verification.api.example.com, CNAME api.example.com
  PATCHes: []
  ```

  The refusal also tells the user to publish two records the deploy has just published. Even when the change is allowed (a verified wildcard covers the new hostname), the old hostname loses its CNAME up to about 70 seconds before the `PATCH`, while the check waits.
- **Suggestion:** Do not remove the old hostname's records until the RoutingUrl change has succeeded. One way that uses the engine as it is: give the record resource an id derived from the hostname (`Records-<hostname>` when the hostname is a plain string). A new hostname then creates a new record resource, and the old one becomes an orphan that Alchemy deletes only after every create and update in the deploy has succeeded, which is the property design note 12 relies on for P1. Add a fake test: a refused change with `dns` leaves the old hostname's records in the zone. Make the refusal message under `dns` name what is actually missing rather than records already published.

### F33 — With `dns`, a hostname change on a serving row can never pass unless a domain ownership was verified beforehand, and the test's fake hides it

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 386–404 (`ensureCanServe`); `packages/integration-tests/test/Prisma/RoutingUrl.test.ts` lines 170–177 (`ownershipOf`) and 459–486 ("publishes the new hostname's records before the check").
- **Issue:** `ensureCanServe` requires a covering domain ownership with status `verified` before it sends the `PATCH`. Prisma creates a domain ownership for a hostname only when asked (Console, `POST /v1/workspaces/{id}/domain-ownerships`) or when a RoutingUrl create or update for that hostname runs with `createDomainOwnership` (platform-routing-urls.md, "Ownership is a DomainOwnership, and DNS proves it"); the verification route `DomainVerification` calls "creates nothing". For a new hostname with no wildcard, nothing has created a row, so `owned` is false and the change is refused, on this deploy and every redeploy. The `dns` option is not allowed to create one (acceptance criterion 3). The test passes only because `makeUrlCloud` reports a domain ownership `verified` as soon as the TXT is in the fake zone (`fromZone`), a row real Prisma does not have. Combined with F32, the first hostname change a `dns` user makes takes the serving hostname down and cannot finish. The same gap exists without `dns`, from round 3: the refusal says "Publish TXT … then redeploy", but publishing the TXT alone never produces a verified domain ownership, so that advice does not work either.
- **Suggestion:** This needs a decision, because criterion 3 and criterion 5 cannot both hold for a hostname no wildcard covers. Options: (a) before the check, have the change path create the exact-hostname domain ownership through the create route, which creates and immediately looks up the row, the same row Prisma's update would create anyway; the resource still never records or deletes it; (b) have the platform refuse a hostname change of an `active` row itself (design note 12's other option); (c) document that a hostname change needs a verified wildcard or a domain ownership created first, and say so in the refusal. Whichever is chosen, make the fake follow Prisma's rule: a domain ownership exists only once something created it, and is `verified` only after a lookup that found the record.

### F34 — `alchemy dev` publishes live DNS records with dev placeholder values

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 225–274.
- **Issue:** `RoutingUrlResource`, `DomainVerification`, `App` and `Compute` have local providers, but the DNS host's record resource (`Cloudflare.DNS.RecordList`) has a single implementation, so under `alchemy dev` it runs against the real DNS host. A probe under `Test.make({ dev: true })` showed the RoutingUrl created locally (`dev:routing-url:Url`) and the DNS host given `TXT _prisma-verification.api.example.com = prisma-verification=dev` plus the CNAME. With an `App` or `Compute` declared in the same stack, the CNAME target comes from the local stub's endpoint (`"localhost"` for App, the local dev URL for Compute). `RecordList` overwrites any existing CNAME at the name, so a dev session for a stack whose hostname is not stage-specific repoints the production hostname. Destroying the dev stage then deletes every record whose value matches, which for an app passed by id is production's own CNAME. `Prisma.Website` avoids all of this by skipping its live path, DNS included, in dev (`packages/prisma/src/Website/FrameworkSite.ts` line 239).
- **Suggestion:** Skip `publishRecords` when `AlchemyContext.dev` is set and the resource is not `Alchemy.remote()`, as FrameworkSite does. Add a fake test with `dev: true` that asserts the DNS host is not asked to publish.

### F35 — Composer can no longer register the RoutingUrl provider

- **Location:** `packages/prisma/src/internal/RoutingUrlResource.ts` lines 1–5; `packages/prisma/src/RoutingUrl.ts` line 225; `packages/prisma/src/Providers.ts`.
- **Issue:** `Prisma.RoutingUrl` used to be a resource class. It is now a plain function, and the class lives under `internal/`, which published packages block from import. Composer does not use `Prisma.providers()`; it builds its own collection from resource classes (`Provider.collection([... Prisma.CustomDomain])` plus `Prisma.CustomDomainProvider()` in Composer's `0-lowering/lowering/src/providers.ts`). P2 replaces CustomDomain with RoutingUrl, so it needs `Provider.collection([... RoutingUrl class])`, and with `dns` also the `DomainVerification` class, which is internal too. Neither is reachable. Also gone from `Prisma.RoutingUrl`: `.ref(id)`, `.Provider` and `.Self`. The branch's own test had to switch to deep relative imports of the internal files to keep working, which is the same thing Composer cannot do.
- **Suggestion:** Export the resource class publicly under a name of its own (for example `RoutingUrlResource` from a non-internal module, or as a property on the `RoutingUrl` function), and do the same for `DomainVerification` or give Composer a provider-collection helper that includes both. Add the names to `PublicSurface.test.ts`. Check with the Composer P2 brief before choosing.

### F36 — With `dns`, an app given as the id of an App declared in the same stack fails from the second deploy on

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 252–254; `packages/alchemy/src/Plan.ts` lines 1242–1272 (`rejectManagedLookup`).
- **Issue:** When `app` is not a resource object, `publishRecords` calls `App.lookup({ appId })` to get the project and endpoint. A lookup that finds a resource this stack manages dies with `LookupOfManagedResourceError`, matched on the provider's `stables` (`["appId"]` for App). So `app: api.appId`, or the literal id of an `App` this stack declares, works on the first deploy (no App row in state yet) and dies on every later one. The same `app` value works without `dns`, so adding `dns` breaks a stack that deployed fine. A `Compute` id does not trigger it, because the check matches rows of type `Prisma.App` only. I found this by reading the code; I did not run it, because the fake Management API cannot create an App.
- **Suggestion:** When `app` is an Output, do not look the app up; either require `App | Compute` when `dns` is set (a type-level overload), or read the endpoint inside a provider (for example have `DomainVerification`, or a small internal resource, call `getService`). Add a fake test that deploys twice with `app` taken from a declared App.

### F37 — Records published before a refused create stay in DNS, including a wildcard CNAME

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 225–239.
- **Issue:** The records are published before the RoutingUrl is created, so every create refusal leaves them in the zone until the stack is destroyed: `RoutingUrlInvalidHostname`, `RoutingUrlHostnameTaken`, `RoutingUrlQuotaExceeded`, `RoutingUrlLogicalIdTaken`, `RoutingUrlServiceOnAnotherBranch`. Two cases do harm. A wildcard hostname (`*.example.com`, which Prisma refuses) publishes a wildcard CNAME to the switchboard, so every name in the zone without its own record now resolves to Prisma. And when another row on the Branch already serves the hostname (`RoutingUrlHostnameTaken`), the CNAME and TXT already exist with the same values; `RecordList` records them as its own because it matches by value, so destroying the failed stack deletes the records the other row serves from.
- **Suggestion:** Refuse a hostname starting with `*.`, or an IP address, before publishing anything when `dns` is set. For the taken-hostname case, at least say in the JSDoc that `dns` takes over existing records with the same value and removes them on destroy; the stronger fix belongs in `RecordList` (only delete records it created) and is outside this pull request.

### F38 — Removing `dns` from a serving RoutingUrl deletes its records in a deploy that succeeds

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 121–127 (the `dns` JSDoc) and 197–201.
- **Issue:** Dropping `dns` from the declaration leaves `Url/Records` and `Url/Verification` orphaned, and Alchemy deletes them at the end of the deploy. The CNAME and TXT disappear while the RoutingUrl stays `active`, and the deploy reports success. "Omitted: publish `records` yourself" reads as if the records stay. A user moving record management to another tool will take their hostname down.
- **Suggestion:** Say in both JSDoc places and in `apps.mdx` that removing `dns` removes the records, and that to hand them over the user should first publish them elsewhere (or keep the record resource with `RemovalPolicy.retain()`, if that is made possible).

### F39 — Small code points in `publishRecords`

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 252–254 and 269.
- **Issue:** The app id is cast to `InputProps<RoutingUrlProps>["hostname"]`, the hostname's type, which reads as a mistake even though the types coincide. The CNAME value is `switchboardTarget(endpoint)`, and `Compute.appEndpointDomain` is `string | undefined`; for `undefined` the value is the empty string, which the DNS host refuses with an error that does not mention the RoutingUrl. A Route 53 host also refuses a CNAME at an apex only at deploy time, after the TXT has been published, since the names are Outputs and the adapter's build-time check cannot see them.
- **Suggestion:** Name the cast for what it is (`Input<string>`), and fail with a `RoutingUrlOperationFailed` that names the app when the endpoint is missing.

### F40 — Two acceptance criteria have no test evidence

- **Location:** `packages/integration-tests/test/Prisma/RoutingUrl.test.ts` lines 424–457.
- **Issue:** Criterion 3: the `dns` test checks for domain ownership requests only during destroy (`captured` is cleared just before it). The deploy sends `GET …/domain-ownerships/verification` and nothing else, which I confirmed by reading, but no assertion would catch a create or verify added there. Criterion 4: no test deploys state written by the previous resource shape (or an unchanged stack after adding `dns`) and checks that the RoutingUrl is updated in place and not replaced. The type string and the name are unchanged, so it holds today by construction, but nothing pins it.
- **Suggestion:** In the `dns` lifecycle test, assert that the deploy's routes contain no `POST` or `DELETE` under `domain-ownerships`. Add a case that deploys without `dns`, then adds `dns`, and asserts the same `routingUrlId`, no `PATCH` and no `DELETE /v1/urls/…`.

### F41 — The spec and the pull request description do not cover `dns`

- **Location:** `spec.md` ("Deliberately out: Publishing DNS records through a DNS adapter for a RoutingUrl"); `pr-bodies/alchemy.md`.
- **Issue:** The spec lists exactly this feature as out of scope (design note 8: a follow-on), and the pull request description, written before the commit, does not mention `dns`, the move to `internal/RoutingUrlResource.ts`, or the new tests. Its test list also predates `dcc35d3f48`'s cases.
- **Suggestion:** Record the scope change and its reason in the spec and design note 8, and update the pull request description once F32 to F36 are settled.

## Deferred (out of scope)

- **`RecordList` deletes records it did not create when their values match** (behind F34 and F37). It is a Cloudflare resource shared by every DNS-adapter user; fixing it belongs in its own change.
- **Typed 409/422 errors** (round 3 F13): waits for platform slice 8 and the Distilled patch, as `plan.md` records.
- **Whether Foundry sees the switchboard's addresses as this machine does** (round 4 F25, second assumption): now stated in a comment; still the orchestrator's to settle with the platform team.

## Already addressed

| Earlier finding | Status | Where |
| --- | --- | --- |
| F26: the address path passed a CNAME to another in-zone name | Fixed. A CNAME that is not the switchboard makes the nameserver `absent`. The fake DNS now follows an in-zone CNAME for A queries; the unit case fails when the fix is undone. | `dcc35d3f48` |
| F27: the live case did not check the moved hostname serves | Fixed. It now runs the check loop after the move and asserts `active` and that DNS is not the unmet condition. Not run (no credentials). | `dcc35d3f48` |
| F28: a failed or slow lookup was treated as "no records" | Fixed for the RoutingUrl search: any failed lookup gives `unknown` and never climbs; a failed switchboard address lookup gives `unknown` unless an answer already matched. The parent search for DomainOwnership and CustomDomain is the first-release one again, without the 3-second limit. Commit message corrected. | `dcc35d3f48` |
| F29: a refusal for missing ownership still waited a minute | Fixed. `attempts: "once"` when not owned; asserted in the refused and allowed fake tests and a unit case. | `dcc35d3f48` |
| F30: the local-resolver query of the new hostname was not explained | Fixed. `serversFromName` says what it caches and why it is accepted. | `dcc35d3f48` |
| F31: no test pinned CustomDomain's starting point | Fixed. CustomDomain calls `AuthoritativeRecordCheck`, and its test asserts `{ margin: "if-unseen", nameservers: "parent" }`. | `dcc35d3f48` |

## Acceptance-criteria verification

Criteria are those given for `8645d9bdb3`.

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: a first deploy with `dns` publishes exactly the TXT with the workspace's value and the CNAME to the regional switchboard, and creates the RoutingUrl | **PASS** | `publishRecords` builds exactly those two records. The `dns` lifecycle test asserts `zone.records` equals `[TXT _prisma-verification.api.example.com = <workspace value>, CNAME api.example.com = switchboard.us-east-1.prisma.build]` and the `POST` body. Dropping the TXT fails it. |
| AC2: the published set is the same on every deploy and does not come from `records`; a redeploy after `active` with empty `records` deletes nothing | **PASS** | Records come from `DomainVerification` and the app's endpoint. The test sets the row `active` with `records: []`, redeploys, and asserts unchanged records, nothing removed, `publishes` still 1, no `PATCH`. |
| AC3: the option declares, creates, verifies and deletes no domain ownership and does not use `Prisma.CustomDomain` | **WEAK** | The code calls only the verification `GET` and never `CustomDomain`. The test asserts no domain ownership route only during destroy (F40). This criterion is also what makes F33 unavoidable. |
| AC4: `logicalId` still defaults to the id, attributes unchanged, state from before still matches | **WEAK** | Same type string and id, attributes unchanged; the test asserts `logicalId: "Url"` and the create body. No test deploys earlier state or adds `dns` to a deployed stack (F40). |
| AC5: on a hostname change with `dns`, new records are published before the check, and the change goes through when DNS is seen | **WEAK** | Ordering is real: removing the dependency fails the test. "Goes through" is shown only against a fake that calls a domain ownership `verified` because the TXT is in the zone; real Prisma has no domain ownership for the new hostname, so the change is refused (F33), after the old records are gone (F32). |
| AC6: the deploy does not wait for `active` | **PASS** | No wait in the create path; the `dns` test's first deploy returns `status: "pending"`. |
| AC7: destroy removes both records and sends no domain ownership request | **PASS** | The test asserts `zone.records` is empty, `DELETE /v1/urls/<id>`, and no `domain-ownerships` route during destroy. The RoutingUrl is deleted before the records. |
| AC8: without `dns`, behaviour is exactly as before | **PASS** | Without `dns` the function returns `RoutingUrlResource(id, props)` unchanged; the no-`dns` lifecycle test asserts `publishes` 0 and no `domain-ownerships` route. Callers that used `RoutingUrl` as a resource class do lose `.ref`, `.Provider` and `Provider.collection` registration (F35). |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 5 | AC1, AC2, AC6, AC7, AC8 |
| FAIL | 0 | |
| NOT VERIFIED | 0 | |
| WEAK | 3 | AC3, AC4, AC5 |
