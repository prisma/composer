# System design review, round 9 — the wait, the third error, and Prisma's `state`

Range: `3dcb62ba5d..0220ce0077` on `feat/prisma-domain-ownership-status` in the Alchemy clone, with attention to `d73ba5db9c..0220ce0077`: `5e2c7ed0f2` (the wait runs only while the hostname can still serve, and checks once when Prisma missed DNS), `98ab513a18` (the resource reports Prisma's `state`), `0220ce0077` (Distilled pinned to the fork commit with the typed refusals and `state`).

What I read: the spec section "Waiting for the hostname, and Prisma's certificate limit (added 2026-11-20)" and the "Attributes come from the response" paragraph in `spec.md`; round 8 (`system-design-review-8.md`) and the code review of round 8 (`code-review-8.md`, for its answer on when the row is reconciled); `plan.md` (the platform request for a certificate-limit field); `pr-bodies/alchemy.md`; the Alchemy `AGENTS.md` (Reconciler doctrine, Typed Error Doctrine) and `.claude/skills/audit/procedure.md`; the repository's `.drive/CODE-REVIEW.md`. Code: the whole of `packages/prisma/src/RoutingUrl.ts`; the diff of `Website/FrameworkSite.ts`, `PublicSurface.test.ts`, the docs pages `website/src/content/docs/prisma/compute/apps.mdx` (section "Routing URLs" in full) and `prisma/frontend/websites.mdx` (section "Custom domains" in full); the test "with dns, a hostname that served once and reads pending later does not wait or fail a redeploy" in `RoutingUrl.test.ts`; the generated `status` and `state` types and their descriptions in `submodules/distilled/packages/prisma/src/services/management.ts`; the three commit messages.

No tests were run in this pass.

## What changed since round 8, in system terms

With `dns`, a deploy now goes through these steps:

1. Before Prisma first sees a hostname (a create, or a hostname change of a `pending` row), the resource checks for the published `TXT` and `CNAME` at the hostname's authoritative nameservers for up to about a minute. If one is still absent it fails with the new `RoutingUrlRecordsNotSeen` and writes nothing to Prisma.
2. After the save, if the row holds no custom domain and Prisma's `state` is `not_verified` or `waiting_for_dns`, it calls `POST /v1/urls/{id}/check` once.
3. It reads the row every 10 seconds for up to 6 minutes until `status` is `active`. It stops early with `RoutingUrlCertificateLimitReached` (hourly limit, from `customDomainSyncError` text), or with `RoutingUrlNotActive` when `state` is `in_use_elsewhere` or the custom domain's status is `failed`.
4. Steps 2 and 3 run only when there is no stored output, the stored hostname differs, or the stored `status` is not `active`.

`RoutingUrlNotActive` now carries `heldBy` and `certificateFailure`. The resource has a new attribute `state`, Prisma's ten-value summary of what the hostname is doing now. The internal prop is `publishesRecords`. A create refused as `RoutingUrlLogicalIdTaken` lists the Branch again and takes its own row, which is the "catch AlreadyExists as a race and continue" step of the Reconciler doctrine and fits it well.

## Answers to the five questions

**1. Are S31 to S36 resolved?** Five of six, one with a small residue; S36 is not, because the pull request description is unchanged.

| Finding | Status |
| --- | --- |
| S31: the wait reads a row a read never moves on | Resolved. The single `/check` covers Prisma missing the records at the save, `RoutingUrlRecordsNotSeen` covers records not yet visible before it, and the commit message says the fake now looks DNS up only on a write or a check. Residue: the timeout message still says "Prisma keeps working on it" when the wait stopped on `ownershipVerified` or `dnsPointsAtSwitchboard`, which Prisma does not look at again on its own (S43, item 3). |
| S32: held hostname without the holder | Resolved: `heldBy` on the error, JSDoc and guide updated. The error now has three causes, and telling them apart has a new problem (S38). |
| S33: the limit recognised by matching text | Resolved as suggested: the comment names `certificateSlotWaitMessage`, and `plan.md` records the platform request for a `certificateLimit` field or a `state` value. |
| S34: `recordsPublished` | Resolved: `publishesRecords`, with the suggested JSDoc. |
| S35: the wait on every reconcile | Partly. The wait no longer runs when the stored `status` is `active`. But the stored `status` itself goes back to `pending`, so the failure S35 described now arrives one deploy later (S37). |
| S36: docs and description | Docs resolved: the section is now "How many certificates a workspace can order", Prisma counts orders, `websites.mdx` says about 7 minutes. The description in `pr-bodies/alchemy.md` is unchanged: its `dns` example still says `"pending", then "active"`, and it names none of the three wait errors, `state`, or the hourly limit (S43, item 1). |

**2. Is the public surface minimal and coherent?**

The three wait errors are three different situations, and I would keep all three:

- `RoutingUrlRecordsNotSeen` is the only one where Prisma holds no row from this deploy. It has no `routingUrlId`, and the fix is on the DNS side. Merging it into `RoutingUrlNotActive` would make `routingUrlId` optional on that error and mix "we did not write" with "Prisma has it but it does not serve".
- `RoutingUrlCertificateLimitReached` is the only one with a known time when it resolves itself, carried as typed `limit` and `resetAt`. Merged into `RoutingUrlNotActive` it would become two more nullable fields and a fourth cause told apart by which field is set, which is the problem S38 already has with three.
- `RoutingUrlNotActive` keeps the three "Prisma has the row but it does not serve" causes. One class is right; how a program tells the causes apart is not (S38).

The four readiness attributes are all copied straight from Prisma's response, which is how Alchemy resources usually expose a cloud object, and each answers a different question:

- `status`: has the hostname gone live (Prisma resets it only on a hostname change, a deleted service or lapsed ownership). The wait's "served once" rule reads it.
- `state`: what the hostname is doing now. It is the only one that shows `in_use_elsewhere`, `update_failed` and `updating`. Cutting it loses those, and Prisma's API describes it as the field to choose what to show from.
- `conditions`: every condition, each `met`, `unmet` or `unknown`.
- `firstUnmetCondition`: which condition to fix first. Composer's next slice prints it. It can be derived from `conditions` only by knowing Prisma's order.

I would cut none of them. The cost of keeping both `status` and `state` is that they read cold as two names for one thing, and the `status` JSDoc currently describes it as if it tracked the hostname's current condition, which is what `state` does (S39).

**3. Naming probes.**

- `RoutingUrlRecordsNotSeen`: accepted. It names what happened from the deploying machine's side, and its `records` field has the same shape as `RoutingUrlHostnameChangeRefused.records`, which is good symmetry. Two wording problems: "not seen" read cold includes "could not check", but the error is raised only when a nameserver answers without the record, and its JSDoc says "the RoutingUrl was not saved", which is wrong for a `pending` row's hostname change, where the row exists and only the change was not sent (S40).
- `certificateFailure`: the field holds Prisma's `customDomain.failureReason`, a string, and it is also the only way a program can tell that the certificate failed. When Prisma gives no reason the resource fills in the English sentence "Prisma gave no reason", so a program cannot tell a missing reason from a reason. The name reads as an object or a flag. `certificateFailureReason` would say what it holds, once something else says that the certificate failed (S38).
- `publishesRecords`: accepted. Present tense about this deploy; reads true when the user publishes the records by hand and the flag is false.
- `state`: accepted. It is Prisma's own field name, and renaming a passthrough attribute would make the resource disagree with Prisma's API and Console. The pairing with `status` is only safe if both JSDocs say how they differ (S39). The comment on `waitsForActive` uses "state" in Alchemy's sense ("has not served under this state yet"), which now reads as Prisma's `state` (S39).

**4. "Fail before the write when the records are absent" against "saved before its DNS exists".** The rule is coherent. The promise "saved before its DNS exists" is a promise to the user who publishes DNS by hand: without `dns`, the deploy saves at once and reports `records`. With `dns`, the deploy itself published the records seconds earlier, so "the DNS does not exist yet" means propagation is slow or the DNS host failed; saving then would let Prisma look, miss, and (when the `TXT` is visible but the `CNAME` is not) register a custom domain that uses one of the ten hourly certificate orders. Refusing until the deploy can see its own records costs a redeploy and protects the hourly budget. The resource JSDoc states it ("fails with `RoutingUrlRecordsNotSeen`, saving nothing, while one is still absent"), the first JSDoc paragraph qualifies the promise with "without `dns`", and `apps.mdx` opens the same way and states the refusal in the first bullet under "Waiting for the hostname to serve". The rule applies the same way to a create and to a `pending` row's hostname change, and an `active` row's hostname change keeps its stricter check. No finding beyond the wording in S40.

**5. Do the two docs pages read correctly cold?** Mostly. A reader can follow the order of events in "Waiting for the hostname to serve" and act on each bullet. Three statements are not true as written: "A RoutingUrl that served and later reads `pending` ... does not fail later deploys" (S37), the `status` and `state` descriptions (S39), and "Prisma keeps working on the hostname" for the DNS conditions (S43). `websites.mdx` has one circular phrase (S43). For the devrel lens, not this one: the identity and hostname-change paragraph in "Routing URLs" (line 150) is one paragraph of about 220 words covering two unrelated rules.

## Findings

### S37 — "Served once" is read from the last recorded `status`, which Prisma moves back to `pending`; a hostname that stops serving fails the second deploy after it stops

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 626–630 (`waitsForActive`), 322–332 (resource JSDoc, "while it has never been `active`" and "A RoutingUrl that served and later reads `pending` reports it in `status` without failing a deploy"); `apps.mdx` line 160; `packages/integration-tests/test/Prisma/RoutingUrl.test.ts` lines 587–619.
- **What happens today:** `waitsForActive` waits when the stored `output.status` is not `active`. Prisma's own description of `status` says it goes back to `pending` when the hostname changes, its service is deleted, or no domain ownership keeps it verified. The code review of round 8 confirmed by experiment that a `Prisma.Website` reconciles its RoutingUrl on every app deploy, because the app's `deploymentId` changes. So: a site's hostname serves; the workspace loses ownership; the next app deploy reconciles, does not wait (stored `status` is `active`), and stores `status: "pending"`. The deploy after that finds stored `pending`, waits 6 minutes and fails with `RoutingUrlNotActive`, or fails at once when the certificate failed. Every later app deploy of the site does the same. That is the failure S35 described, one deploy later.
- **Why the test does not show it:** it deploys once after the row goes `pending` and asserts that deploy does not wait. It does not deploy a second time.
- **Why it matters for the design:** the documented rule is about the hostname's history ("has served once"), but the code reads a value Prisma overwrites. No value in Prisma's response only ever moves forward, so the rule cannot be read from the last response.
- **Suggestion:** decide from what this resource did, not from Prisma's `status`. Wait when `publishesRecords` is set and one of these holds: there is no stored output (a create, or a retry after a failed create); the stored hostname differs from the new one (a hostname change, or a retry after a failed one, since a failed reconcile commits nothing); or the previous props did not publish records (`olds?.publishesRecords !== true`, which covers `dns` added to an existing row and an adoption). A row that served and later went back to `pending` then never waits again, and reports it in `status` and `state`. The code-review pass should confirm what `olds` and `output` hold on the deploy after a failed wait, since this rule depends on a failed reconcile committing neither. Extend the test to deploy twice after the row goes `pending`. If the operator prefers the current behaviour, say it plainly in the JSDoc and the guide: "With `dns`, a deploy waits whenever the RoutingUrl was `pending` at the previous deploy, so a hostname that stops serving fails every deploy from the second one after."

### S38 — `RoutingUrlNotActive` has three causes, told apart only by which nullable fields are set, and the fields do not separate them

- **Where:** `RoutingUrl.ts` lines 140–159 (class and JSDoc), 552–577 (`notActive`), 604–610 (`untilActive`).
- **What happens:** the JSDoc tells a reader that `heldBy` marks the held case and `certificateFailure` marks the failed-certificate case, otherwise the wait timed out. But `heldBy` is copied from the row unconditionally, and commit `98ab513a18` made a `heldBy` whose holder is being deleted keep waiting; when that wait times out, the error has `heldBy` set and the cause is the timeout. `certificateFailure` is likewise set whenever the custom domain failed, so a held hostname with a failed custom domain has both set. When Prisma gives no reason, `certificateFailure` holds the English text "Prisma gave no reason", so a program cannot tell a missing reason from a real one. A program that matches the error can only guess which of the three situations it is in, and the three need different actions: wait for the holder, retry from the Console, or redeploy.
- **Suggestion:** add one field that names the cause, and keep the details as details: `readonly reason: "held" | "certificateFailed" | "timedOut"`, with `heldBy` documented as "the holder, when `reason` is `held`" and set only then, and `certificateFailure` renamed `certificateFailureReason: string | null`, set only when `reason` is `certificateFailed` and `null` when Prisma gave none. This adds no export. The message already branches on the same three cases, so `reason` is the value the code computes anyway. The alternative of three error classes adds two exports for no gain to a reader.

### S39 — `status` and `state` read cold as synonyms, and the `status` JSDoc describes what `state` does

- **Where:** `RoutingUrl.ts` lines 251–254 (attribute JSDoc), 626 (`waitsForActive` comment, "under this state"); `apps.mdx` lines 124–125; `websites.mdx` line 191.
- **What the surface says:** `status`: "`pending` until every condition is met, then `active`. As last read." A reader takes that to mean `status` follows the conditions, so `status === "active"` means the hostname serves. Prisma's description says the opposite: `status` "records that the hostname went live; `state` says what it does now". An `active` RoutingUrl whose certificate later fails, or whose `CNAME` is removed, stays `active` in `status`. `state`: "What the hostname is doing now ... As last read." Neither says how it differs from the other, and `apps.mdx` shows both as comments with no contrast.
- **Suggestion:** `status`: "`active` once the hostname has gone live. It goes back to `pending` only when the hostname changes, the service is deleted, or the workspace's ownership lapses, so it does not say whether the hostname serves now; `state` does. As last read." `state`: "What the hostname is doing now, such as `waiting_for_dns`, `certificate_failed`, or `active` when it serves. As last read." Use the same two sentences in `apps.mdx`'s code comments and in the `websites.mdx` note. Change the comment on `waitsForActive` to say "deploy" rather than "state", or drop it once S37 changes the rule.

### S40 — `RoutingUrlRecordsNotSeen` says nothing was saved when a hostname change was refused, and does not say an unchecked nameserver does not raise it

- **Where:** `RoutingUrl.ts` lines 161–175 (class JSDoc and field JSDoc), 744–748 (message), 804–805 (the call for a `pending` row's hostname change); `apps.mdx` line 162.
- **What happens:** the error is raised before a create and before a `pending` row's hostname change. In the second case the RoutingUrl already exists in Prisma under its old hostname; the JSDoc's "the RoutingUrl was not saved" and the message's "Nothing was saved in Prisma" read as if Prisma holds no row. Separately, a nameserver this machine cannot query gives `unknown`, which does not raise the error: the deploy saves and relies on Prisma's own lookup and the single check. That is a sensible choice, and different from the hostname-change check of an `active` row, which refuses on `unknown`, but nothing says so.
- **Suggestion:** JSDoc: "With `dns`, a record this deploy published was still missing at an authoritative nameserver after about a minute, so Prisma was not changed: the RoutingUrl was not created, or its hostname not changed, and no certificate was ordered. A nameserver this machine cannot query does not raise this error. Redeploy once the records appear." Message: "Prisma was not changed and no certificate was ordered". Same change in `apps.mdx` line 162.

### S41 — Why the wait reads `state` for one cause and the custom domain for another is recorded only in a commit message

- **Where:** `RoutingUrl.ts` lines 555 and 606 (`url.customDomain?.status === "failed"`), 561 and 605 (`url.state === "in_use_elsewhere"`), 595 (the limit from `customDomainSyncError`), 621–624 (`checkedOnceIfDnsMissed`).
- **What happens:** the resource takes its three early-stop decisions from three different fields: `state` for a held hostname, `customDomain.status` for a failed certificate, and the text of `customDomainSyncError` for the hourly limit. Commit `98ab513a18` gives the reasons: Prisma's `state` shows `certificate_failed` only when none of `not_verified`, `no_service`, `no_live_deployment` and `update_failed` applies, and shows the hourly limit as `updating`. `customDomain` is not an attribute, so a user who reads the attributes after the error sees no field that agrees with "has a failed certificate". A later reader who sees `state` used once will reasonably change the other two to `state === "certificate_failed"` and lose the early stop.
- **Suggestion:** give the failed-certificate test a name, `certificateFailed(url)`, with one sentence: "Prisma's `state` shows `certificate_failed` only when no earlier state applies, so read the custom domain itself." Use it at both places. No other comment is needed; the limit already has its comment.

### S42 — The spec does not record the decisions made in these commits

- **Where:** `spec.md`, the "Attributes come from the response" paragraph (line 27) and the decisions under "Waiting for the hostname, and Prisma's certificate limit".
- **What is missing:** `state` in the attribute list; the refusal before the write (`RoutingUrlRecordsNotSeen`) and why; the single `/check` and the condition that makes it safe (no custom domain, `state` `not_verified` or `waiting_for_dns`); a failed certificate and a held hostname ending the wait at once, and the Console retry; the rule for when the wait runs (S37). The spec's own decisions still describe one timeout error and one limit error.
- **Suggestion:** add these as decisions in that section, each with its reason, and add `state` to the attribute list. The pull request description and the next reviewer read the spec as the statement of intent.

### S43 — The pull request description is unchanged, and three sentences in the docs are wrong or circular

- **Where:** `pr-bodies/alchemy.md` lines 3–14 and 40–48; `websites.mdx` line 202; `RoutingUrl.ts` line 565 and lines 334–336; `apps.mdx` line 163.
- **What is not accurate:**
  1. The description's `dns` example says `url.status: "pending", then "active" once Prisma has found both records`; with `dns` the deploy now returns `active`. It names none of `RoutingUrlRecordsNotSeen`, `RoutingUrlNotActive` or `RoutingUrlCertificateLimitReached`, nor `state` or the hourly limit, and the `site.domain` diff block lacks `state`. The spec's done condition requires the description to say it. This is round 8's S36, item 3, still open.
  2. `websites.mdx`: "Prisma orders a certificate for each new hostname, each hostname change and each certificate ordered again" defines ordering by ordering.
  3. The timeout message and docs say "Prisma keeps working on it; redeploy to wait again" for every unmet condition. For `ownershipVerified` and `dnsPointsAtSwitchboard`, Prisma does not look DNS up again on its own (the `TXT` only after 10 minutes, the `CNAME` never); what helps is the redeploy, whose single check makes Prisma look.
- **Suggestion:**
  1. Change the example's comment to `// with dns: url.status is "active" when the deploy finishes`. Add one item to "How a RoutingUrl works": "With `dns`, the deploy waits for the hostname to serve, up to about 7 minutes. It fails with `RoutingUrlRecordsNotSeen` before saving when a published record is not visible yet, with `RoutingUrlNotActive` when the hostname is held, its certificate failed or the wait ran out, and with `RoutingUrlCertificateLimitReached` when the workspace has ordered its 10 certificates this hour." Add `+site.domain.state` to the diff block.
  2. "Prisma orders a certificate for each new hostname, for each hostname change, and again when an order fails or is stuck", as `apps.mdx` says.
  3. When the wait stopped on `ownershipVerified` or `dnsPointsAtSwitchboard`, say "Prisma looks at the hostname's DNS again when you redeploy"; keep "Prisma keeps working on it" for the other conditions. In the JSDoc and `apps.mdx`, "a redeploy waits again" already holds for all of them.

## Earlier findings touched by these commits

| Finding | Status |
| --- | --- |
| Round 7 S29: `AuthoritativeDns` named for waiting | Unchanged. `awaitPublishedRecords` remains the one caller that waits. |
| Round 7 S23: description leaves out contract | Grows again: the wait, three errors and `state` are missing (S43). |

## Out of scope for this pass (for the code-review pass)

- What `olds` and `output` hold on the reconcile after a failed wait on create and on a hostname change (S37's suggested rule depends on it).
- Whether ending the wait on a failed custom domain is right when `state` shows an earlier problem such as `not_verified`; the message then tells the user to retry the certificate when the ownership is what is missing.
- Whether a create retried by Distilled after a lost reply can also come back as something other than `RoutingUrlLogicalIdTaken` (for example a hostname refusal for the row it just made).
- The audit procedure's rule against fake-cloud tests, as it applies to `fixtures/RoutingUrlCloud.ts`; earlier rounds settled the live coverage, and this commit changes the fake's behaviour.

## Could not check

- Real Prisma: no live tests were run. The meaning of `status` and `state` is taken from the descriptions Prisma publishes in its API spec, as generated into Distilled at `6adb15da9`.
