# System design review, round 10 — confirmation of the round 9 fixes

Range: `3dcb62ba5d..7891d94ef5` on `feat/prisma-domain-ownership-status` in the Alchemy clone. New since round 9: `a2688206ad` (fixes for round 9), the merge `a89273d2d4` of the maintainer's `0bfa1bd40e` (the default `logicalId` uses `.` between name segments), and the Distilled pins `b01447c819` and `7891d94ef5` (both at Distilled `6adb15da9`).

What I read: `spec.md` in full, including the decisions added on 2026-11-21; `system-design-review-9.md`; `pr-bodies/alchemy.md`; the whole of `packages/prisma/src/RoutingUrl.ts`; the diffs of `Website/FrameworkSite.ts`, `internal/AuthoritativeDns.ts` and `PublicSurface.test.ts`; `apps.mdx` section "Routing URLs" in full and `websites.mdx` section "Custom domains" in full; the 12 framework pages under `website/src/content/docs/prisma/frontend/` where they describe `domain`; `dns-adapters.mdx` where it names Prisma; the tests in `RoutingUrl.test.ts` lines 700–863; the update and create paths of `packages/alchemy/src/Apply.ts` (to confirm what a failed reconcile commits); the commit messages of `a2688206ad` and `0bfa1bd40e`.

No tests were run.

## 1. Round 9 findings

| Finding | Verdict |
| --- | --- |
| S37: "served once" read from a `status` Prisma moves back | Resolved. `waitsForActive` now decides from the previous props: it waits when `publishesRecords` is set and the previous props did not publish records or named another hostname. I confirmed in `Apply.ts` that a failed update keeps the `updating` state with the old props (`old: node.state`, and `previousProps` comes from `node.state.old.props`), and a failed create keeps a `creating` state that retries with `olds: undefined`. So a deploy after a failed wait waits again, and a row that served and later reads `pending` never waits. The test now deploys three times after the row goes `pending`. |
| S38: three causes of `RoutingUrlNotActive` not told apart | Resolved: `reason` is `held`, `certificateFailed` or `timedOut`; `heldBy` is set only when `held`; `certificateFailureReason` is `null` when Prisma gave none. |
| S39: `status` and `state` read as synonyms | Resolved in the attribute JSDoc, the `apps.mdx` code comments and the `websites.mdx` note. |
| S40: `RoutingUrlRecordsNotSeen` said nothing was saved | Resolved in the class JSDoc and the message, which now has three versions (create, hostname change, check). Two sentences in `apps.mdx` still do not fit the third case; see S45. |
| S41: why the wait reads three different fields | Resolved: `certificateFailed(url)` with its one-line reason, used in both places. |
| S42: the spec does not record the decisions | Partly resolved. The decisions are added under "Decisions added after the eighth and ninth reviews", but three older paragraphs of the same spec still state the opposite; see S47. |
| S43: description unchanged, docs wrong in three places | Docs resolved: `websites.mdx` no longer defines ordering by ordering, and the timeout message tells the two DNS conditions apart. The description is updated but is now wrong in other places; see S46. The timeout message itself has a new fault; see S44. |

## 2. Findings

### S44 — A timed-out wait tells the user a redeploy asks Prisma to check, when the redeploy will not

- **Where:** `RoutingUrl.ts` lines 611–612 (`notActive`, the `timedOut` message), lines 352–355 (resource JSDoc); `apps.mdx` line 165.
- **What happens:** the timeout message picks its wording with `missesDns(url)` (Prisma's `state` is `not_verified` or `waiting_for_dns`), and then says "Prisma does not look again on its own; a redeploy asks it to check once." But the redeploy sends the check only when `needsCheck(url)` holds, which also requires that Prisma holds no custom domain for the hostname. The test "with dns, does not check a row waiting for DNS that holds a custom domain" (line 737) builds exactly that row and confirms no check is sent. For that row the message is false: every redeploy waits 6 minutes and fails with the same advice. The JSDoc ("a redeploy waits again, and asks Prisma to check once more when it has not seen a record") and `apps.mdx` line 165 make the same promise.
- **Fix:** choose the wording with `needsCheck(url)`, and give the custom-domain case its own sentence. In `notActive`:

  ```ts
  timedOut: !missesDns(url)
    ? `did not become active within ${minutes} minutes: ${unmet}.${reported} Prisma keeps working on it; redeploy to wait again.`
    : needsCheck(url)
      ? `did not become active within ${minutes} minutes: Prisma has not seen ${unseenRecordsOf(url)}.${reported} Prisma does not look again on its own; a redeploy asks it to check once.`
      : `did not become active within ${minutes} minutes: Prisma has not seen ${unseenRecordsOf(url)}.${reported} Prisma already holds a custom domain for the hostname, so a deploy does not ask it to check, because a check can order another certificate. Once the record is published, ask Prisma to check in the Console${url.setupUrl === null ? "" : ` at ${url.setupUrl}`}.`,
  ```

  (`minutes` is `Duration.toMinutes(ACTIVE_WAIT)`, as in the current code. `needsCheck` is declared below `notActive`; it is only called at run time, so the order does not matter, but moving it above reads better.) Add a test that asserts the message of the existing custom-domain case.

  JSDoc, replacing "a redeploy waits again, and asks Prisma to check once more when it has not seen a record":

  > a redeploy waits again, and asks Prisma to check once more when it has not seen a record and holds no certificate for the hostname.

  `apps.mdx` line 165, replacing the sentence that starts "When Prisma has not seen a record":

  > When Prisma has not seen a record, the message names it. Prisma does not look again on its own: when it holds no certificate for the hostname, a redeploy asks it to check once; otherwise ask it to check from the RoutingUrl's `setupUrl` in the Console once the record is published.

### S45 — `apps.mdx` says every deploy that failed while waiting has saved the RoutingUrl

- **Where:** `apps.mdx` lines 164 and 169.
- **What is not true:** line 169, "A deploy that failed while waiting has saved the RoutingUrl", follows a list whose first item, `RoutingUrlRecordsNotSeen` before a create, is a failure while waiting that saved nothing. Line 164 lists what was not done "for a create" and "for a hostname change", but not the third case the message already covers: when `dns` is added to a saved RoutingUrl, or a deploy follows a failed wait, the RoutingUrl is already saved and only the check was not sent.
- **Replacement text.** Line 164, replacing "Prisma was not asked to look at it, so no certificate was ordered: for a create, no RoutingUrl was created; for a hostname change of a RoutingUrl that is not yet `active`, the hostname was not changed.":

  > Prisma was not asked to look at it, so no certificate was ordered: a create was not sent, a hostname change of a RoutingUrl that is not yet `active` was not sent, and a RoutingUrl an earlier deploy saved stays as it was.

  Line 169:

  > After any of these errors except `RoutingUrlRecordsNotSeen`, the RoutingUrl is saved. The next deploy finds it and does not create another.

### S46 — The pull request description no longer matches the code

- **Where:** `pr-bodies/alchemy.md` lines 11, 23, 24, 25.
- **What is not true or missing:**
  1. Line 11: "about 7 minutes at most". The record wait is now up to 3 minutes and the active wait up to 6: about 9.
  2. Line 23: "waits until the hostname has served once" and "A later deploy does not wait again" describe the round 9 rule. The wait now runs on a create, a hostname change, when `dns` is added, and after a failed wait. "It fails at once ... `RoutingUrlRecordsNotSeen` (nothing saved)" is wrong twice: that error comes after up to 3 minutes, and when `dns` is added to a saved RoutingUrl it is saved. `reason` on `RoutingUrlNotActive` is not mentioned, and it is the field a program matches on.
  3. Line 24: "each certificate ordered again counts" is the circular phrase round 9 fixed in `websites.mdx`. "never when a certificate exists" should say what the code tests: Prisma holds a custom domain for the hostname. The check is also never resent, which a reviewer of the certificate budget needs to know.
  4. Line 25: the default `logicalId` is the fully qualified name with `.` in place of `/`. A reviewer comparing against `Prisma.App`, whose default keeps `/`, needs the reason.
- **Replacement text.**

  Line 11:

  ```ts
  // then waits, about 9 minutes at most, until url.status is "active"
  ```

  Item 4 (line 23):

  > 4. **With `dns`, the deploy waits for the hostname to serve when it creates the RoutingUrl, changes its hostname or adds `dns`**, and again after a deploy whose wait failed, because a failed deploy does not save its props. Other deploys do not wait, so a hostname that served and later reads `pending` does not fail them. Before Prisma first looks at the hostname, the deploy waits up to 3 minutes for both records at the authoritative nameservers. After saving, it reads the RoutingUrl every 10 seconds for up to 6 minutes. It fails with:
  >    - `RoutingUrlRecordsNotSeen` when a published record is still missing after 3 minutes. Prisma was not asked to look, so no certificate was ordered: a create or hostname change was not sent, and a RoutingUrl an earlier deploy saved stays as it was.
  >    - `RoutingUrlNotActive`, whose `reason` is `held` (another RoutingUrl holds the hostname; `heldBy` names it), `certificateFailed` (`certificateFailureReason` has Prisma's reason; a redeploy does not retry it) or `timedOut` (names the first unmet condition). The first two fail at once.
  >    - `RoutingUrlCertificateLimitReached`, at once, with `limit` and `resetAt`.
  >
  >    After `RoutingUrlNotActive` or `RoutingUrlCertificateLimitReached` the RoutingUrl is saved, and the next deploy finds it instead of creating a second one.

  Item 5 (line 24):

  > 5. **A workspace can order about 10 certificates an hour.** Prisma orders one for each new hostname once its records are published, for each hostname change, and again when an order fails or is stuck, so tests count their RoutingUrls, CI reruns and parallel jobs. The resource asks Prisma to check a hostname at most once per deploy, never resends that check, and never sends it when Prisma already holds a custom domain for the hostname, because a check on a failed certificate orders another.

  Item 6 (line 25), first sentence:

  > 6. **It finds its own record in Prisma by `logicalId`**, which defaults to the resource's fully qualified name with `.` in place of `/` (`Site.Url` for a RoutingUrl `Url` inside a Website `Site`), because Prisma allows only letters, digits, `.`, `-` and `_` in a `logicalId`.

### S47 — Three older paragraphs of the spec contradict its own decisions

- **Where:** `spec.md` lines 25, 27, 45, and line 106.
- **What is not true:** line 25 ends "`POST /v1/urls/{id}/check` refreshes it, and the resource does not call it"; line 27's attribute list has no `state`; line 45 ends "The deploy does not wait for `active`." All three are reversed by the decisions at lines 91–108. Line 106 says the wait runs "when the resource has no stored output", but the code decides from the previous props, which is what makes a deploy after a failed wait wait again. The pull request and the next reviewer read the spec as the statement of intent.
- **Replacement text.** Line 25, last sentence:

  > Reads return stored state and call neither DNS nor Foundry; `POST /v1/urls/{id}/check` refreshes it, and the resource calls it at most once per deploy, under the rule in "Waiting for the hostname".

  Line 27: insert `state` after `status` in the attribute list.

  Line 45, last sentence:

  > With `dns`, the deploy waits for the hostname to serve, as "Waiting for the hostname" describes.

  Line 106:

  > The wait runs when the previous deploy's props did not publish this hostname's records: a create, a hostname change, `dns` just added, or a deploy after a failed wait, because a failed reconcile does not save its props. A hostname that served and later stops does not fail later deploys.

### S48 — Twelve framework pages say a site's deploy does not wait, also with `dns`

- **Where:** the `domain` paragraph of `website/src/content/docs/prisma/frontend/` `astro.mdx`, `foldkit.mdx`, `nextjs.mdx`, `react-router.mdx`, `solidstart.mdx`, `static-site.mdx`, `sveltekit.mdx`, `tanstack-start.mdx`, `vinext.mdx`, `vite.mdx`, `vocs.mdx` and `waku.mdx`. Written in `5408ff7774`, before this range, and not updated when the wait was added.
- **What is not true:** each reads "The deploy does not wait for DNS: `site.domain.status` is `pending` until the records in `site.domain.records` are published, or pass `dns` to publish them." With `dns` the deploy waits up to about 9 minutes and can fail, which is the opposite of what the sentence tells a reader choosing `dns`.
- **Replacement text** (the same sentence on all twelve pages):

  > `domain` saves the hostname as a `Prisma.RoutingUrl` and makes `site.url` the HTTPS hostname. Without `dns`, the deploy does not wait for DNS: `site.domain.status` is `pending` until the records in `site.domain.records` are published. Pass `dns` to publish them, and the deploy then waits for the hostname to serve. See [Custom domains](/prisma/frontend/websites#custom-domains).

## 3. Docs and doc comments, checked against the code

- `apps.mdx`: correct apart from S44 (line 165) and S45 (lines 164, 169). The default `logicalId` example (`Site.Url`) matches `defaultLogicalId`.
- `websites.mdx`: correct. Line 202 lists four failure causes and leaves out the timeout, but it links the section that lists all of them; not a fault.
- `RoutingUrl.ts` doc comments: correct apart from the JSDoc sentence in S44. The `logicalId` `@default`, the `status` and `state` attributes, the three new error classes and the `publishesRecords` prop all match the code.
- `FrameworkSite.ts` `domain` JSDoc: correct.

## 4. Public surface

The feature exports three error classes (`RoutingUrlRecordsNotSeen`, `RoutingUrlNotActive`, `RoutingUrlCertificateLimitReached`, pinned in `PublicSurface.test.ts`) and adds the attribute `state`. Each error maps to one situation and one action, `reason` separates the causes of `RoutingUrlNotActive`, and the detail fields are set only for their cause. Beyond S44 and S48, I found nothing a user would be misled by.

The `.` in the default `logicalId` makes it differ from `Prisma.App`, `Prisma.Database` and `Prisma.Bucket`, whose defaults keep `/`. That is forced by what Prisma accepts for a RoutingUrl, and the `@default` says it; S46 item 4 puts it in the description.

## Could not check

- Real Prisma: no live tests were run. Whether a real row can be in `waiting_for_dns` or `not_verified` while holding a custom domain that has not failed (the case in S44) is taken from the test fixture at line 737, which models it.
