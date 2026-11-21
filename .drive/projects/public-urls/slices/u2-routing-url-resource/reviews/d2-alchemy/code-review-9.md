# Code review, round 9 — the round 8 fixes, the `state` attribute, and the Distilled pin

Range: `d73ba5db9c..0220ce0077` in the Alchemy clone (`wip/u2/alchemy`, branch `feat/prisma-domain-ownership-status`), read together with `d73ba5db9c`, so the change under review is `3dcb62ba5d..0220ce0077`:

- `d73ba5db9c` feat(prisma): with dns, RoutingUrl waits for the hostname to serve
- `5e2c7ed0f2` fix(prisma): RoutingUrl waits only while the hostname can still serve, and checks once when Prisma missed DNS
- `98ab513a18` feat(prisma): RoutingUrl reports Prisma's state, and reads it for a held hostname and the single check
- `0220ce0077` chore: pin distilled to the fork commit with the typed RoutingUrl refusals

Acceptance criteria: the section "Waiting for the hostname, and Prisma's certificate limit (added 2026-11-20)" in `../../spec.md`, and the decisions listed in this round's brief. Round 8 findings: `code-review-8.md` (F61–F68) and `system-design-review-8.md` (S31–S36). Conventions: the clone's `AGENTS.md` and `.claude/skills/audit/procedure.md`.

Control plane, read only, at `origin/main` `0605abe6a` of `pdp-control-plane`: `packages/interactors/src/compute/routingUrl.ts` (`createRoutingUrl`, `checkRoutingUrl`), `syncRoutingUrl.ts`, `routingUrlConditions.ts` (`routingUrlState`, `isOutOfSync`, `certificateSlotWaitMessage`), `domainCreationRateLimit.ts`, and `packages/repositories/src/compute/routingUrl.repository.pn.ts` (`create`). The generated client: `submodules/distilled` at `6adb15da9`, `packages/prisma/src/services/management.ts` (`state`, `customDomain`).

What I ran: nothing. The brief forbids running tests and changing files in the clone, because another process is running tests in the same working tree. Every statement below comes from reading the code at `0220ce0077` and the control plane source. Where I say a test would pass with a break, that is from reading the test assertions, not from a run.

## Summary

The round 8 findings are fixed in substance: a failed certificate and a held hostname end the wait at once, absent records fail before anything is saved, the single `/check` is made only when the row holds no certificate, a lost create reply continues with its own row, and the live helpers no longer loop. Three things are still wrong. The "wait only until the hostname has served once" rule forgets that the hostname served after one deploy, so the second deploy after a row goes back to `pending` waits 6 minutes and fails (F69). The one `/check` per deploy is sent up to 9 times by the deploy retry policy, including on a failed certificate (F70). And when the row already exists, the `/check` is sent seconds after the records were published, with no wait for them to appear, which is the race the pre-check exists to prevent (F71).

## What looks solid

- **`state` is read the way the control plane computes it.** `routingUrlState` in `routingUrlConditions.ts` returns the first of `not_verified`, `no_service`, `no_live_deployment`, `update_failed`, `in_use_elsewhere`, `waiting_for_dns`, … that applies. The two states the single `/check` uses are exactly the two where Prisma has not seen a record: `not_verified` (ownership not met, including `unknown` while the first lookup has no answer) and `waiting_for_dns` (no custom domain and `switchboardDnsAccepted === false`, which `refuseDns` sets on Foundry's 400 and which stores no `customDomainSyncError`, so it is not `update_failed`). A row waiting for the hourly limit is `updating`, because `certificateSlotWait` excludes the limit sentence from `update_failed`, so it is never checked. That matches the commit message.
- **A held hostname is read from `state === "in_use_elsewhere"`, not `heldBy`.** `liveCustomDomainHolder` ignores a holder whose `deletedAt` is set, so a hostname whose holder is being deleted no longer fails the deploy. `heldBy` is still on the error for the message.
- **The failed certificate is read from `customDomain.status`, not `state`.** `state` shows `certificate_failed` only after the earlier rules, so a failed certificate on a row whose sync also failed reads `update_failed`. Reading `customDomain.status === "failed"` catches both.
- **A `/check` with no custom domain cannot retry a certificate.** In `checkRoutingUrl`, the retry happens only when the stored `customDomainStatus` is `failed`, or when this call's own sync finds it failed. With no custom domain the first branch cannot apply; the second can only follow the register this same call made. So one call orders at most the first certificate plus, if Foundry fails it within the same request, one retry. That is the bound the brief accepted, and the comment above `checkedOnceIfDnsMissed` states the reason.
- **The resent create is refused before Foundry.** `routingUrlRepository.create` runs under the project lock and refuses a taken `logicalId` before inserting, and `createRoutingUrl` calls Foundry only after the insert. A resent create orders no second certificate. A resent `PATCH` is also safe: `updateRoutingUrl` returns early when the hostname, service and `logicalId` already match, so it syncs nothing.
- **The two DNS checks before a create now run together** (`Effect.all` with unbounded concurrency), so "about a minute" is now true for the create and the pending-row hostname change: 20 attempts 3 seconds apart, plus a 10-second margin.
- **The fixture now models Prisma correctly.** `looksOnWrite` moves a row only on a write or a check; `certificateAfterReads` moves only the certificate on reads. The failure tests run on the test clock and end with `expectDestroyed`, so a broken delete after a failed wait is caught.
- **The failure tests assert the absence of requests, not only the error.** The failed-certificate, hourly-limit and held-hostname tests each assert no `GET` poll and no `/check`. Breaking the order of checks in `untilActive`, or widening the `/check` condition to "no custom domain", fails at least one of them.

## Findings

### F69 — "Served once" is forgotten after one deploy, so the second deploy after a row goes back to `pending` waits and fails

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 626–630 (`waitsForActive`) and 838–842 (`reconcile`); test "with dns, a hostname that served once and reads pending later does not wait or fail a redeploy" in `packages/integration-tests/test/Prisma/RoutingUrl.test.ts` line 589.
- **Issue:** `waitsForActive` decides from `output.status`, the status the last reconcile stored. When it decides not to wait, `reconcile` returns `attrsFrom(saved)`, and `saved` is the row as Prisma reads it now. So on the first deploy after the row goes back to `pending`, the deploy does not wait, as intended, but stores `status: "pending"`. On the next deploy that reconciles the row, `output.status !== "active"` and the deploy waits 6 minutes and fails. With `Prisma.Website` the row is reconciled on every app deploy (round 8, F63), so from the second code deploy on, every deploy of the site fails. That is the case S35 and F63 asked to remove: Prisma moves a row back to `pending` when the workspace loses ownership or the service is deleted, and the site owner then cannot deploy an unrelated fix. The test covers only the first redeploy, so it passes. The JSDoc (lines 322–332), `apps.mdx` line 160 ("while it has never been `active`"), and the pull request description point 4 ("A later deploy does not wait again") all state the rule the code does not keep.
- **Suggestion:** Keep the fact that the hostname served in the attributes, independent of the status last read. For example, an attribute `servedHostname: string | null`: set it to `saved.hostname` when `saved.status === "active"`, keep `output.servedHostname` when the hostname did not change, and `null` otherwise. Then `waitsForActive` is `news.publishesRecords === true && normalizeHostname(output?.servedHostname ?? "") !== normalizeHostname(news.hostname)`. A failed wait commits no attributes, so a redeploy after one still waits. Extend the test: after the redeploy that reads `pending`, deploy once more with another changed prop and assert no poll, no `/check`, and `status: "pending"`.

### F70 — The one `/check` per deploy is resent by the deploy retry policy, up to 8 more times, including on a failed certificate

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 615–624 (`checkedOnceIfDnsMissed`); the policy in `packages/prisma/src/Providers.ts` (`DeployRetry.policy` on both management clients) and `packages/alchemy/src/DeployRetry.ts`.
- **Issue:** `createUrlCheck` runs under `DeployRetry.policy`, which resends on throttling, server errors, network errors, timeouts and transport failures, up to 8 times, honouring `Retry-After` up to 60 seconds. The resource's condition (no custom domain, `not_verified` or `waiting_for_dns`) is checked once, against the row before the first call; a resend does not check it again. Two concrete paths:
  1. The first `/check` registers the custom domain (ordering the first certificate), Foundry fails it, and the same call's `retryAndSync` cannot reserve a slot because the workspace is at its hourly limit. `checkRoutingUrl` answers 429 with `Retry-After` set to the reset time. The policy waits 60 seconds (the cap) and sends `/check` again, now on a row whose stored status is `failed`, which goes straight to `retryAndSync`. That repeats up to 8 times: about 8 minutes of `/check` calls on a failed certificate, each of which orders a certificate as soon as a slot frees. The deploy then fails with a generic throttling error, not `RoutingUrlNotActive` with `certificateFailure`. The spec says `/check` is never called in a loop on a failed certificate.
  2. The first `/check` registers and its reply is lost (a proxy 502, a timeout). The resend finds a custom domain that is `provisioning`; its sync reads Foundry, and if Foundry has failed the certificate by then, `checkRoutingUrl` retries it: a second order in the same deploy.
  The spec's "every call obeys 429 and `Retry-After`" does not require resending this call: the wait already reads the row every 10 seconds, and those reads cost nothing.
- **Suggestion:** Send `/check` once, with no resend (for example `Retry.policy({ while: () => false })` applied to that one call, defined beside `withoutRetriedCreate`), and treat any failure of it as "continue": fall through to `getUrl` and `untilActive`, which then fails at once with `certificateFailure`, or with the hourly limit, or keeps polling. Put the reason in the comment above the call. Add a fake test where `/check` answers 429 with `Retry-After: 40` (the fixture's `throttle` already supports it) and the next read shows a failed certificate: assert exactly one `/check` and `RoutingUrlNotActive` with `certificateFailure`. Add one where `/check` answers 502 once: assert one `/check` and that the wait continues with reads.

### F71 — When the row already exists, the `/check` is sent seconds after the records were published, with no wait for them to appear

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 776–806 (`save`: `awaitPublishedRecords` runs only before a create or a pending row's hostname change) and 841 (`reconcile` calls `checkedOnceIfDnsMissed`); test "adding dns to a deployed pending RoutingUrl keeps its row, checks it once and waits for it", `RoutingUrl.test.ts` line 729.
- **Issue:** Adding `dns` to a deployed, pending RoutingUrl publishes the `TXT` and `CNAME` in this deploy, then reconciles the row. The row exists and nothing about it changes, so `save` returns it without waiting for the records, and `reconcile` sends `/check` at once. Prisma looks the records up through a caching resolver; the module's own comment above `waitUntilVisible` says a lookup that races a just-published record caches the miss for 30 minutes on Cloudflare. That is the race `awaitPublishedRecords` was written to prevent, and this path skips it. Prisma then does not look again on its own (the CNAME is never looked up again; the domain ownership only once, 10 minutes later), the 6-minute wait runs out, and a redeploy's single `/check` can hit the same cached miss. The same applies to any deploy where the records resource changed a record of an existing pending row (for example after the switchboard target changed). The fake does not model resolver caching, so the test passes.
- **Suggestion:** Before the `/check`, wait for the hostname's published records at the authoritative nameservers with the same two checks `awaitPublishedRecords` uses. When they were published long ago, the first query sees them and returns at once (the margin is `if-unseen`), so the cost is a few DNS queries. When a record is still absent, skip the `/check` and fail with `RoutingUrlRecordsNotSeen`, with a message that says the RoutingUrl is saved (the current message says "Nothing was saved in Prisma", which is false on this path). In the `addDns` test, assert that the TXT and CNAME checks ran before the `/check` (record `txtChecked.length` at the time of the check, as `txtCheckedAtPatch` does for the `PATCH`).

### F72 — On a timeout with Prisma still missing a record, the error says "Prisma keeps working on it", which is not true

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 552–565 (`notActive`, the last branch); `RoutingUrlNotActive` JSDoc lines 140–146; `apps.mdx`, the second bullet under "Waiting for the hostname to serve".
- **Issue:** S31 point 3 asked for the timeout message to depend on the unmet condition; it still does not. When the wait runs out with `state` `not_verified` or `waiting_for_dns`, Prisma is not working on it: `syncRoutingUrl` saves a pending row whose ownership is not met and queues nothing, and a Foundry DNS refusal queues nothing. What does help is a redeploy, because a redeploy sends one `/check`. The advice "redeploy to wait again" is right; the reason given is wrong, and it hides from the user that the problem is DNS Prisma has not seen.
- **Suggestion:** For `not_verified` and `waiting_for_dns`, say what Prisma has not seen and that a redeploy asks it to look again, for example: "Prisma has not seen its CNAME to `<target>` (Foundry: `<switchboardDns detail>`); it does not look again on its own, and a redeploy asks it to check once." Keep the current text for the certificate states. Assert it in a fake test that times out with `state: "waiting_for_dns"` (see F73).

### F73 — No test has a row in `waiting_for_dns`, so half of the `/check` condition is untested

- **Location:** `packages/prisma/src/RoutingUrl.ts` line 622; `packages/integration-tests/test/Prisma/fixtures/RoutingUrlCloud.ts` (`routingUrl` gives every pending row `state: "not_verified"`).
- **Issue:** No test file under `test/Prisma` contains `waiting_for_dns` as a row state. Every pending row in the fake reads `not_verified`, so removing `|| url.state === "waiting_for_dns"` from `checkedOnceIfDnsMissed` leaves every assertion true. That is the state for the case F62 asked a test for: Foundry refused the register because the CNAME was not visible.
- **Suggestion:** Add a fake test whose first write leaves the row with ownership met, `state: "waiting_for_dns"`, `firstUnmetCondition: "dnsPointsAtSwitchboard"` and no custom domain, and whose `/check` serves it. Assert exactly one `/check`, `status: "active"`, and that no `/check` is sent when the same row holds a custom domain.

### F74 — The lost-create recovery misses a resend refused as quota-exceeded, and does not compare the hostname

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 776–789 (`rowMadeByResentCreate` and the `catchTag("RoutingUrlLogicalIdTaken", …)`); `ownRow` lines 469–481.
- **Issue:**
  1. `routingUrlRepository.create` checks the service's quota (`isAppFull`, at most 3 live RoutingUrls per service) before it checks the `logicalId`. When the lost create added the service's third RoutingUrl, the resend is refused as `quota-exceeded`, not `logical-id-taken`. The user then sees `RoutingUrlQuotaExceeded`: "'<hostname>' was not added", while it was added. A plain redeploy recovers through the `creating` row's recovery read, but the message tells the user to remove a hostname.
  2. The recovery takes `ownRow`'s first match, which is any row on this service with this `logicalId`, whatever its hostname. It cannot take a row of another app or stage, because the service id must match; that answers the brief's question 4. But a resent create always carries the same hostname, so a row with another hostname is not the one this deploy made. It can only come from a concurrent deploy of the same stack with another hostname (two CI runs of different commits). The deploy then reports that row's hostname as its own and waits for it.
- **Suggestion:** Recover on both `RoutingUrlLogicalIdTaken` and `RoutingUrlQuotaExceeded`, and take a row only when service, `logicalId` and normalized hostname all match; otherwise raise the original error. Model the quota in the fake (refuse a create when the service already has 3 rows, before the `logicalId` check, as the repository does) and add a test: two existing rows on the service, a create whose reply is lost, assert one new row and no error.

### F75 — About a minute for records to reach every authoritative nameserver is short for some DNS hosts the docs name

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 709–749 (`awaitPublishedRecords`), and `waitUntilVisible` in `packages/prisma/src/internal/AuthoritativeDns.ts` (20 attempts, 3 seconds apart).
- **Issue:** The decision to fail before the write on absent records is sound: nothing is saved, no certificate is ordered, and a redeploy works. The cost is that every first deploy fails once wherever the DNS host takes longer than about 70 seconds to reach all its authoritative nameservers. Cloudflare does it in seconds. `websites.mdx` names `AWS.Route53.Adapter()` and `Hetzner.DNS.Adapter()` as working the same way; Route 53 usually reports a change in sync within about a minute, which is right at this limit, and I could not find a figure for Hetzner. This is an assumption I did not check against those hosts. A zone not yet delegated to the DNS host (nameservers not switched at the registrar) never shows the records, and the message ("redeploy once it appears") does not mention that cause. At `3dcb62ba5d` such a deploy saved the row and returned `pending`.
- **Suggestion:** Waiting for DNS costs no certificate, so let the record wait use more of the overall budget, for example up to 3 minutes, and shorten the `active` wait by the time spent, keeping "about 7 minutes in all". Add to the `RoutingUrlRecordsNotSeen` message that the DNS host must be the one the domain's registrar delegates to.

### F76 — Docs and description statements that do not match the code

- **Location:** `RoutingUrl.ts` JSDoc lines 322–332; `apps.mdx` lines 158–160 and the second bullet under "Waiting for the hostname to serve"; `RoutingUrlNotActive` message line 564; `pr-bodies/alchemy.md` point 4.
- **Issue:**
  - "while it has never been `active`" and "A later deploy does not wait again": see F69. Fixing F69 makes them true.
  - The JSDoc and `apps.mdx` say the deploy waits about a minute for the new records and fails with `RoutingUrlRecordsNotSeen`. For a hostname change of an `active` row, the check is `ensureCanServe`, which runs the TXT and CNAME checks one after the other (up to about 2.5 minutes) and fails with `RoutingUrlHostnameChangeRefused`. Only a create and a pending row's hostname change behave as described.
  - The failed-certificate message says to retry it in the Console. The API's own description of `certificate_failed` says `POST /v1/urls/{id}/check` retries it, and F61 asked to name both. A user deploying from CI has the API, not necessarily the Console.
- **Suggestion:** After F69, keep the two sentences. Add "for a create, or a hostname change of a RoutingUrl that is not yet `active`" to the record-wait sentence, and point to the hostname-change paragraph for active rows. Add "or with one `POST /v1/urls/{id}/check`" to the failed-certificate message and the guide's bullet.

### F77 — The live helpers call `/check` without the resource's rule, and one live test does not wait for its CNAME first

- **Location:** `packages/integration-tests/test/Prisma/fixtures/Live.ts` lines 98–105 (`checkOnceThenPollUntilActive`); `RoutingUrl.test.ts` around line 1552 (first deploy of the live DNS test); `Website/Domain.test.ts` line 540.
- **Issue:** The helper checks unconditionally. When Prisma already registered the hostname at the create, the `/check` finds a `provisioning` custom domain, syncs it, and retries it if Foundry has just failed it: one extra certificate per test run, on the shared test workspace that the docs warn about. In the live hostname-change test, the `FirstAlias` CNAME and the RoutingUrl are deployed in parallel and the `/check` follows the deploy at once, so Prisma's lookup can race the new CNAME and cache the miss (F71's mechanism); `Domain.test.ts` avoids that with `waitForAuthoritativeCnames` before its check.
- **Suggestion:** Make the helper read the row first and check only when the resource would (`customDomain === null` and `state` `not_verified` or `waiting_for_dns`), and call `waitForAuthoritativeCnames` (moved into `Live.ts`) before it in the `RoutingUrl.test.ts` live test.

## Deferred (out of scope)

- **The Distilled pin points at a fork commit.** `submodules/distilled` is `6adb15da9` on the fork, not Distilled `main`; the audit procedure requires a `main` commit. The description says it moves to `main` when alchemy-run/distilled#1348 merges. That is the merge order already planned, not work for this range.
- **The control plane's own re-register of a stuck certificate** takes a slot with no Alchemy call. Platform behaviour, documented in the limit section.
- **The hourly limit as data (S33).** Recorded as a platform request in `plan.md` ("Platform request from D6").

## Already addressed

| Finding | Status | Commit |
| --- | --- | --- |
| F61 failed certificate waits 6 minutes | Fixed. `untilActive` ends at once on `customDomain.status === "failed"`; the error carries `certificateFailure`; the test asserts no read and no `/check`. Wording residue in F76. | `5e2c7ed0f2` |
| F62 missed DNS at create cannot recover | Fixed. `RoutingUrlRecordsNotSeen` before the create; one `/check` when no custom domain and DNS not seen; the two checks run together; the fixture looks only on write or check. Remaining gaps: F71, F73. | `5e2c7ed0f2`, `98ab513a18` |
| F63 Website waits on every app deploy | Partly fixed: the first deploy after a regression no longer waits, the second does (F69). | `5e2c7ed0f2` |
| F64 resent create advises a new `logicalId` | Fixed for `logical-id-taken`, with a test. Quota path and hostname match: F74. | `5e2c7ed0f2` |
| F65 live tests loop `/check` | Fixed: check once, then poll, from one shared file. Residue: F77. | `5e2c7ed0f2` |
| F66 no test for the pending-row hostname change | Fixed: the test asserts the TXT check ran, `until-seen`, before the `PATCH`. | `5e2c7ed0f2` |
| F67 tests fail only by timeout; destroy not asserted | Fixed: `onTestClock` on all failure tests; `expectDestroyed` after them. | `5e2c7ed0f2` |
| F68 description and docs | Fixed: description points 4 and 5, `apps.mdx` sections, `websites.mdx` "about 7 minutes", held-hostname bullet. Residue: F76. | `5e2c7ed0f2` |
| S31 the wait reads a row nothing moves | Fixed as F62. The condition-dependent message (point 3) is not done: F72. | `5e2c7ed0f2` |
| S32 held hostname not named | Fixed: `heldBy` on the error, JSDoc and guide updated. | `5e2c7ed0f2` |
| S33 limit matched on text | Comment names `certificateSlotWaitMessage`; platform request in `plan.md`. | `5e2c7ed0f2` |
| S34 `recordsPublished` | Renamed `publishesRecords`, JSDoc says what the deploy does. | `5e2c7ed0f2` |
| S35 wait on every reconcile | See F63 and F69. | `5e2c7ed0f2` |
| S36 limit counted per RoutingUrl | Fixed: "How many certificates a workspace can order", certificate orders counted. | `5e2c7ed0f2` |

## Answers to the brief's questions

1. **Round 8 findings:** see the table. F63/S35 is not fully fixed (F69); S31 point 3 is not done (F72).
2. **More than one certificate or `/check` per deploy:** the resource code calls `/check` once, but the retry policy can send it up to 9 times (F70). The accepted edge remains: one `/check` can order the first certificate and, if Foundry fails it within the same request, one retry. The fake tests send at most one `/check` each. The live helpers can order one extra certificate per run (F77).
3. **Failing before the write on absent records:** slow DNS hosts fail the first deploy (F75). A zone apex with a flattened CNAME passes, because `checkSwitchboardDns` accepts A or AAAA answers that include a switchboard address. `Prisma.Website` upgrades take over the row Prisma recorded and change only its `logicalId`, so they never reach the record wait. A hostname change of an `active` row still goes through `ensureCanServe`, not the new check.
4. **`LogicalIdTaken` recovery:** it cannot take another app's or stage's row, because `ownRow` requires the same service. It can take a same-service row with another hostname, and it misses the quota refusal (F74).
5. **Tests assert behaviour:** mostly yes; they assert the error fields, the absence of reads and checks, the row count and the zone after destroy. Gaps: the second redeploy after a regression (F69), `waiting_for_dns` (F73), the order of DNS checks before the `/check` (F71).
6. **Docs match the code:** not fully (F76).

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: with `dns` the deploy waits for `active`; without `dns` it returns `pending` at once | **PASS** | `reconcile` waits only when `publishesRecords`. "polls the RoutingUrl until Prisma serves it" asserts `active` after three reads; the tests without `dns` assert `pending` and `state: "not_verified"`. |
| AC2: a fixed limit; on timeout a typed error naming the first unmet condition and quoting `customDomainSyncError` | **PASS** | The timeout test asserts `RoutingUrlNotActive`, `firstUnmetCondition`, the quoted error, `heldBy: null`, `certificateFailure: null` and exactly 36 reads. The message's reason is wrong for DNS states (F72). |
| AC3: the hourly limit fails with when it resets, that Prisma continues, and that a redeploy after then picks it up | **PASS** | The test asserts `limit`, `resetAt`, "Prisma continues on its own" and "a redeploy after then waits", on the test clock, with no read and no `/check`. |
| AC4: a failed wait never creates again; the next deploy finds the saved row | **PASS** | The timeout test's second deploy asserts the same id, one row, no `POST`, no `PATCH`. The lost-reply test asserts one row. The quota-refused resend is not covered (F74). |
| AC5: `/check` only where the control plane shows it cannot order a certificate; never in a loop on a failed certificate | **FAIL** | The resource's condition is right and tested (no `/check` with a custom domain, a held hostname or the limit). But the retry policy resends it, and on a failed certificate at the limit it is resent up to 8 times (F70). |
| AC6: every call obeys 429 and `Retry-After` | **PASS** | The throttled test asserts the create is resent after `Retry-After: 1` and a poll waits for `Retry-After: 40`. F70 proposes not resending the `/check`, which does not conflict: nothing is sent early. |
| AC7: the live tests stop calling `/check` in a loop and read `active` from the deploy | **PASS** | `checkOnceThenPollUntilActive` checks once; the `dns` Website live test reads `domain.status`. Not run live. F77 covers the unconditional single check. |
| AC8: the docs say about 10 an hour, that recreated ones count, and to count reruns and parallel jobs | **PASS** | `apps.mdx` "How many certificates a workspace can order" and the resource JSDoc say all three, counting certificate orders. |
| AC9: built, tested, documented, in the description; Prisma test files, `tsrs -b`, format and lint pass | **NOT VERIFIED** | Not run in this round (brief). The description states the F69 rule the code does not keep (F76). |
| Brief: the deploy waits only until the hostname has served once | **FAIL** | It waits again on the second deploy after a row reads `pending` (F69). The test covers only the first. |
| Brief: absent records fail before the row is written | **PASS** | The test asserts the error's records, "Nothing was saved in Prisma" and no `POST`, then a deploy with `unknown` visibility goes ahead. Not applied before the `/check` on an existing row (F71). |
| Brief: a create refused as `RoutingUrlLogicalIdTaken` re-lists and takes its own row | **PASS** | The lost-reply test asserts two `POST`s, one row, `active`, and the row's id. F74 covers the quota refusal and the hostname match. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 9 | AC1, AC2, AC3, AC4, AC6, AC7, AC8, records before the write, `LogicalIdTaken` recovery |
| FAIL | 2 | AC5, served once |
| NOT VERIFIED | 1 | AC9 |
| WEAK | 0 | |
