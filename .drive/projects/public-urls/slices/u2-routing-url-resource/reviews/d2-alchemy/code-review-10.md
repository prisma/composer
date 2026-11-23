# Code review, round 10: the round 9 fixes and the default `logicalId` merge

Range: `3dcb62ba5d..7891d94ef5` in the Alchemy clone (`wip/u2/alchemy`, branch `feat/prisma-domain-ownership-status`). New since round 9:

- `a2688206ad` fix(prisma): RoutingUrl waits only on deploys that publish new records, and never resends its one check
- `b01447c819`, `7891d94ef5` chore: pin distilled to the fork commit with the typed RoutingUrl refusals
- `a89273d2d4` the merge of the maintainer's `0bfa1bd40e` (default `logicalId` uses `.` between name segments)

Acceptance criteria: `../../spec.md`, section "Waiting for the hostname, and Prisma's certificate limit", including the decisions added on 2026-11-21. Round 9: `code-review-9.md` (F69 to F77) and `system-design-review-9.md` (S37 to S43). Control plane read at `origin/main` `0605abe6a` of `pdp-control-plane`: `packages/interactors/src/compute/routingUrl.ts` (`updateRoutingUrl`, `checkRoutingUrl`) and `services/management-api/models/v1/common.ts` (`ResourceLogicalIdSchema`). Engine: `packages/alchemy/src/Apply.ts` and `Plan.ts`, for what `olds` holds after a failed reconcile.

What I ran:

- `pnpm exec alchemy-test test/Prisma/RoutingUrl.test.ts --tags '!live' --retry 0` from `packages/integration-tests`: 49 passed, 0 failed.
- With `Retry.none` removed from `checkOnce`, the two tests "sends the single /check once even when Prisma answers 429" and "does not resend the single /check after a 502" both fail. Restored.
- A temporary test file (deleted afterwards) for the sequence in F78: deploy with `dns` on `api.example.com` (active), deploy with `new.example.com` (fails at once, failed certificate), deploy with `api.example.com` again. The third deploy sent `PATCH /v1/urls/url-1`, read the row once, sent no `/check`, and succeeded with `status: "pending"`.

`git status` in the clone is clean.

## Summary

Every round 9 finding is fixed, and the default `logicalId` merge is complete and safe for anything already deployed. One fault remains: the wait rule compares the new props with the props of the last deploy that succeeded, not with what is in Prisma, so a deploy that changes the hostname in Prisma back to the committed one, or recreates a row deleted outside Alchemy, does not wait (F78). The live test helper still sends its single `/check` under the retry policy (F79).

## What looks solid

- **The single `/check` cannot be resent.** `checkOnce` applies `Retry.none` to that one call and falls back to a read on any failure. It is the only caller of `createUrlCheck` in the resource. The engine does not rerun a failed reconcile within a deploy, the resource has no precreate, and Plan turns an unchanged resource into a no-op that calls no lifecycle operation. So one deploy sends at most one `/check` per RoutingUrl, and the break test shows the tests catch a resend.
- **No second certificate order per deploy.** A create resent after a lost reply is refused before Foundry and recovered by service, `logicalId` and hostname. A resent `PATCH` changes nothing, because `updateRoutingUrl` returns early when nothing differs. The `/check` is sent only when the row holds no custom domain, after a write that registered none.
- **The served-then-pending case is fixed.** `waitsForActive` no longer reads `output.status`. The test now deploys three times after the row goes back to `pending` and asserts no poll, no `/check` and `pending` each time.
- **A failed wait waits again on the next deploy, as long as Prisma still matches the props.** I confirmed this in the engine: a failed update keeps the row `updating` with `old.props` from the last success, and `Apply.ts` passes `old.props` as `olds`; a failed create keeps the row `creating`, and its retry passes `olds: undefined`.
- **The records check before the `/check` on an existing row** runs only on a deploy that waits, returns at once when both records are already visible, and says the RoutingUrl is saved. The `addDns` test asserts the TXT check ran before the `/check`.
- **`RoutingUrlNotActive.reason`** is computed once and drives both the message and the fields; `heldBy` and `certificateFailureReason` are set only for their reason.

## Findings

### F78 — The wait rule reads the last successful props, so a deploy that changes the hostname in Prisma can skip the wait

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 682–690 (`waitsForActive`) and 932–940 (`reconcile`); the resource JSDoc lines 335–339; `apps.mdx` "Waiting for the hostname to serve", first paragraph; `pr-bodies/alchemy.md` point 4.
- **Issue:** The rule waits when `olds.publishesRecords !== true` or the hostname in `olds` differs from the new one. `olds` is the props of the last deploy that succeeded. But a failed deploy can leave Prisma different from `olds`, because the `PATCH` or create succeeded before the wait failed. Two real sequences:
  1. A site serves `api.example.com` with `dns`. The owner changes it to `new.example.com`; Prisma accepts the `PATCH`, and the wait fails (a failed certificate, the hourly limit, or the 6 minutes). The owner reverts the config to `api.example.com` to get a green deploy. `olds.hostname` is `api.example.com`, so the rule says "no change" and does not wait. But `save` finds the row at `new.example.com` and sends a `PATCH` back, which makes it `pending`, removes its custom domain and orders a new certificate. The deploy succeeds with `status: "pending"`, and no later deploy waits. If that certificate fails, nothing tells the owner. The temporary test reproduced this: one `PATCH`, one read, no `/check`, success with `pending`.
  2. A person deletes the RoutingUrl in the Console. The next deploy that reconciles it (for a `Prisma.Website`, any app deploy) finds no row, creates one and orders a certificate, and does not wait, because `olds` has the same hostname and `publishesRecords`.

  Both contradict what the JSDoc, the guide and the pull request description promise: the deploy waits when it creates the RoutingUrl or changes its hostname, "and again after a deploy whose wait failed".
- **Suggestion:** Also decide from what this reconcile did in Prisma. `save` already knows whether it created the row or sent a hostname change; return that, and wait when `publishesRecords` is set and any of these holds: `olds?.publishesRecords !== true`, the hostname differs from `olds`, `save` created the row, or `save` changed its hostname. Keep the `olds` comparison: after a failed hostname-change wait, a retry with the same new hostname finds Prisma already changed and sends nothing, and only the `olds` comparison makes it wait. Add a fake test for sequence 1, using a failed certificate so it needs no test clock: assert the third deploy fails with `reason: "certificateFailed"`, or, with a row that serves after reads, polls before returning `active`.

### F79 — The live helper's single `/check` is still sent under the retry policy

- **Location:** `packages/integration-tests/test/Prisma/fixtures/Live.ts` lines 107–116 (`checkOnceThenPollUntilActive`).
- **Issue:** The helper now checks only when the resource would (fixed from F77), but its `createUrlCheck` has no `Retry.none`, so a 429 or a lost reply resends it. That is the F70 path the resource now avoids: a resend can find the certificate the first call ordered already failed and order another, on the shared test workspace whose hourly limit the spec is protecting.
- **Suggestion:** Pipe the helper's `createUrlCheck` through `Retry.none` and ignore its failure, as `checkOnce` does, then poll.

## The default `logicalId` merge

- **Every derivation uses the `.` form.** `defaultLogicalId(fqn)` is used in `save` (line 854), which feeds the own-row lookup (`ownRow`), the create, the `PATCH` that writes a `logicalId`, and the lost-create recovery (`rowMadeByResentCreate`); and in `read` (line 921), which feeds the state-less lookup and the `--adopt` check (`branchUrls(service, logicalId)`). `Prisma.Website` passes no `logicalId`, so it gets the default. The JSDoc `@default`, `apps.mdx` (`Site.Url`), the Website tests (`Site.${WEBSITE_ROUTING_URL_ID}`) and the pull request description point 6 all say `.`. `ProviderLocal` still uses the bare `id`, but that value is a dev stub never sent to Prisma.
- **A RoutingUrl deployed with the old `/` default:** none can exist. Prisma's `ResourceLogicalIdSchema` (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) has checked `logicalId` on the RoutingUrl create, update and list routes since those routes were added, so a create or `PATCH` with `Site/Url` was refused and saved nothing. A RoutingUrl declared outside any namespace has no `/` in its name, so its default did not change. The RoutingUrl is not in any released Alchemy (it is not on `upstream/main`). So no deploy loses its row or creates a second one. The only effect is that a namespaced RoutingUrl, including every `Prisma.Website` with a `domain`, now works against real Prisma where it failed before.

## Deferred (out of scope)

- **A service moved to another region keeps `status: "active"` and does not wait.** Prisma registers a new custom domain and certificate for the new region, and the new `CNAME` is published in the same deploy, but the spec's wait rule does not cover a service change and Prisma reports `active` throughout. A change to the spec, not to this range.
- **The Distilled pin points at a fork commit**, to move to Distilled `main` when alchemy-run/distilled#1348 merges. The planned merge order.

## Already addressed

| Finding | Status | Commit |
| --- | --- | --- |
| F69 "served once" forgotten after one deploy | Fixed. The rule reads `olds`, not `output.status`; the test deploys three times after the row goes `pending`. Residue in F78. | `a2688206ad` |
| F70 `/check` resent by the retry policy | Fixed. `Retry.none` on the one call, fallback to a read; 429 and 502 tests; break-checked. | `a2688206ad` |
| F71 `/check` sent before the records appear | Fixed. `awaitPublishedRecords(…, "check")` runs when this deploy has not yet seen the records; refusal test and the `txtCheckedAtCheck` assertion. | `a2688206ad` |
| F72 timeout message wrong for missing DNS | Fixed. For `not_verified` and `waiting_for_dns` the message names the record and says a redeploy asks Prisma to check once; asserted, with "keeps working" asserted absent. | `a2688206ad` |
| F73 no `waiting_for_dns` test | Fixed. One test checks once on `waiting_for_dns`, one sends no check when that row holds a custom domain. | `a2688206ad` |
| F74 lost-create recovery misses quota, ignores hostname | Fixed. Recovers on both refusals; requires service, `logicalId` and hostname; the fake checks the quota before the `logicalId`; tests for both. | `a2688206ad` |
| F75 a minute is short for some DNS hosts | Fixed. `RECORDS_WAIT` is 3 minutes; the message names registrar delegation; docs say about 9 minutes. | `a2688206ad` |
| F76 docs and description mismatches | Fixed: the record-wait cases, the check route in the failed-certificate message and guide. The wait-rule sentences are true except as F78 describes. | `a2688206ad` |
| F77 live helper checks unconditionally; no CNAME wait | Fixed: checks only when the resource would; `waitForAuthoritativeCnames` before it in both live tests. Residue in F79. | `a2688206ad` |
| S37 served-once rule reads overwritten `status` | Fixed as suggested (`olds`). F78 is the case the suggestion did not cover. | `a2688206ad` |
| S38 `RoutingUrlNotActive` causes not separable | Fixed: `reason`, `heldBy` only when held, `certificateFailureReason` null when Prisma gave none. | `a2688206ad` |
| S39 `status` and `state` read as synonyms | Fixed in the attribute JSDoc, `apps.mdx` and `websites.mdx`. | `a2688206ad` |
| S40 `RoutingUrlRecordsNotSeen` wording | Fixed: says what was not changed in each case, and that an unqueried nameserver does not raise it. | `a2688206ad` |
| S41 failed-certificate test unnamed | Fixed: `certificateFailed(url)` with its one-sentence reason. | `a2688206ad` |
| S42 spec missing the decisions | Fixed: `state` in the attribute list; decisions added on 2026-11-21. | spec |
| S43 description and three doc sentences | Fixed: description point 4 lists the wait and its three errors, `state` in the diff block; `websites.mdx` ordering sentence; the condition-dependent timeout message. | `a2688206ad`, `pr-bodies/alchemy.md` |

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: with `dns` the deploy waits for `active`; without `dns` it returns `pending` at once | **PASS** | `reconcile` waits only when `waitsForActive`, which needs `publishesRecords`. "polls the RoutingUrl until Prisma serves it" asserts `active` after reads; the tests without `dns` assert `pending`. |
| AC2: a fixed limit; on timeout a typed error naming the first unmet condition and quoting `customDomainSyncError` | **PASS** | "fails with the first unmet condition…" asserts `reason: "timedOut"`, `firstUnmetCondition`, the quoted error and exactly 36 reads. |
| AC3: the hourly limit fails with its reset time, says Prisma continues and a redeploy after then picks it up | **PASS** | The limit test asserts `limit`, `resetAt` and both sentences, with no read and no `/check`. |
| AC4: a failed wait never creates again; the next deploy finds the saved row | **PASS** | The timeout test's second deploy asserts the same id, one row, no `POST`, no `PATCH`. The engine keeps a failed create `creating` and a failed update `updating`. |
| AC5: `/check` only where the control plane shows it cannot order a certificate, never in a loop on a failed certificate | **PASS** | `needsCheck` requires no custom domain and `not_verified` or `waiting_for_dns`; `Retry.none` stops resends. Tests for 429, 502, `waiting_for_dns`, and a custom domain present; the 429 and 502 tests fail without `Retry.none`. |
| AC6: every call obeys 429 and `Retry-After` | **PASS** | The throttled test asserts the create and a poll wait as asked. The `/check` is never resent, so it sends nothing early. |
| AC7: the live tests stop calling `/check` in a loop and read `active` from the deploy | **PASS** | The helper checks once, only when the resource would, after the CNAME wait. Not run live. F79: the one check can still be resent by the retry policy. |
| AC8: the docs say about 10 an hour, that recreated ones count, and to count reruns and parallel jobs | **PASS** | JSDoc and `apps.mdx` say all three, counting certificate orders. |
| AC9: built, tested, documented, in the description; Prisma test files, `tsrs -b`, format and lint pass | **NOT VERIFIED** | Only `RoutingUrl.test.ts` was run (49 passed). The description and docs state the wait rule F78 breaks. |
| 2026-11-21: absent records fail before anything is written (`RoutingUrlRecordsNotSeen`) | **PASS** | "refuses to save the RoutingUrl while a published record is absent" asserts the records, the message and no `POST`; the existing-row test asserts no `/check`. |
| 2026-11-21: `/check` at most once per deploy, no resend, only with no custom domain and `not_verified` or `waiting_for_dns` | **PASS** | As AC5. |
| 2026-11-21: the wait ends at once on a failed certificate (from the custom domain), `in_use_elsewhere`, or the limit | **PASS** | `untilActive` checks the limit, `isHeld` and `certificateFailed` before polling; each test asserts no read and no `/check`. |
| 2026-11-21: the wait runs with no stored output, a changed hostname, or `dns` just added; a hostname that served and stops does not fail later deploys | **FAIL** | The served-then-pending part passes (three redeploys). But "changed hostname" is judged against the last successful props, not Prisma, so a revert after a failed hostname-change wait, or a row recreated after deletion, changes or creates the hostname in Prisma without waiting (F78, reproduced). |
| 2026-11-21: a refused resent create re-lists and continues with its own row (service, `logicalId`, hostname) | **PASS** | Lost-reply, quota-refused and other-hostname tests assert one row, `active`, or the original refusal. |
| 2026-11-21: `state` reported next to `status` | **PASS** | `attrsFrom` copies `state`; the JSDoc and guides describe both apart. |
| Merge: the default `logicalId` uses `.` everywhere | **PASS** | `save` and `read` both use `defaultLogicalId`; the Website tests assert `Site.<id>`; docs and description agree. No row with the old default can exist, because Prisma refuses `/` in a `logicalId`. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 14 | AC1–AC8, records before the write, single `/check`, early end of the wait, resent-create recovery, `state`, the `logicalId` merge |
| FAIL | 1 | the wait rule (F78) |
| NOT VERIFIED | 1 | AC9 |
| WEAK | 0 | |
