# System design review, round 8 — waiting for the hostname, and Prisma's certificate limit

Range: `3dcb62ba5d..d73ba5db9c` on `feat/prisma-domain-ownership-status` in the Alchemy clone. One commit: `d73ba5db9c` "feat(prisma): with dns, RoutingUrl waits for the hostname to serve".

What I read: the spec section "Waiting for the hostname, and Prisma's certificate limit (added 2026-11-20)" in `spec.md`; the round 7 system design review; `pr-bodies/alchemy.md`; the platform design `design/platform-routing-urls.md` (the six conditions, the rules, the Management API); Alchemy's `AGENTS.md` (Reconciler doctrine, Typed Error Doctrine, speed doctrine). Code: the whole of `packages/prisma/src/RoutingUrl.ts`, `internal/RoutingUrl.ts`, `internal/WebsiteDomain.ts`, `Website/FrameworkSite.ts`, the commit's test and fixture changes (`RoutingUrl.test.ts`, `Website/Domain.test.ts`, `PublicSurface.test.ts`, `fixtures/RoutingUrlCloud.ts`), and the two docs pages. For comparison: `packages/aws/src/ACM/Certificate.ts` and `ACM/CertificateValidation.ts` (the closest existing resource that waits for a certificate), `packages/cloudflare/src/CustomHostname/CustomHostname.ts` (does not wait), and the names of every readiness error in `packages/*/src`. In the control plane (`pdp-control-plane` at `236c1e63e`): `syncRoutingUrl.ts`, `routingUrl.ts` (`checkRoutingUrl`), `domainOwnership.ts`, `domainCreationRateLimit.ts`.

No tests were run in this pass.

## What the commit adds, in system terms

Before this commit, a `Prisma.RoutingUrl` deploy returned as soon as Prisma had saved the row, `pending` or not. Now, when `dns` is set, the composite function passes `recordsPublished: true` to the row resource, and the row's provider does two waits around the save: before Prisma first looks at a new hostname, it waits up to about a minute for the published `TXT` and `CNAME` to appear at the hostname's authoritative nameservers; after the save, it reads the row every 10 seconds, for up to 6 minutes, until it is `active`. Without `dns`, nothing changes.

Two new public errors end the wait:

- `RoutingUrlNotActive`: the 6 minutes ran out, or another RoutingUrl holds the hostname (`heldBy`), which ends the wait at once.
- `RoutingUrlCertificateLimitReached`: Prisma's `customDomainSyncError` says the workspace reached its hourly limit of new certificates; ends the wait at once, with `limit` and `resetAt`.

The resource never calls `POST /v1/urls/{id}/check`. The live tests now read `active` from the deploy, and the one that publishes records by hand calls `/check` once and then only reads.

## Answers to the five questions

**1. Is "wait only with `dns`" predictable, and is it in the right place?** Yes to both, with one change to when the wait runs (S35). The rule matches the closest precedent in the repository: `AWS.ACM.Certificate` waits for issuance when it publishes the validation records itself (Route 53) and returns pending with `dnsValidation: "external"`, where the user publishes them. "We published the records, so we wait; you publish them, so you wait" is easy to predict. The composite function is the right place to decide, because only it knows `dns` was given and that the records resource is upstream of the row; the provider is the right place to wait, because the wait has to follow the save and has to run again on a redeploy. ACM carries the same decision as a prop (`dnsValidation`), so a prop on the row is the usual shape. I considered a separate internal waiter resource, as `AWS.ACM.CertificateValidation` is for ACM: it would keep the flag off the row's props, but it adds a type string to every user's state, and the row is already found again by `logicalId` after a failed wait, so it buys nothing here. Keep the prop.

On state and diffs: `recordsPublished` is stored in state with the other props. The row has no `diff`, so the engine's default applies: a changed prop is an update, never a replacement. Adding or removing `dns` therefore reconciles the row in place, which is what should happen. Nothing in the row's identity depends on it, so it causes no replacement and no update on its own. A later rename would cost every `dns` user one update, which returns at once for an `active` row. The rename from `waitForRecords` costs nothing today because the resource is not yet released.

**2. Failing the deploy versus returning `pending`.** Failing fits the repository. ACM fails with `CertificateNotReady` after 10 minutes of polling; this resource fails after 6 (plus up to about a minute for the records). Since the caller asked the resource to publish the records, "the deploy finished" should mean "the hostname serves"; returning `pending` would make every `dns` user write the poll the live tests used to have. With ten hostnames in one stack in a fresh workspace, all ten wait in parallel and succeed. An eleventh in the same hour is saved, its records are published, and its reconcile fails at once with `RoutingUrlCertificateLimitReached` naming the reset time; the other ten finish and are saved. A redeploy before the reset fails the same way at once; a redeploy after it finds the saved row and waits for it. That is a fair experience, provided the wait can actually succeed on a redeploy, which today it cannot for every condition (S31).

**3. Names.** `RoutingUrlNotActive` is accepted: it names Prisma's own status value, `active`, and `TableNotActive` already exists beside the more common `<Resource>NotReady`. But it currently covers two different situations (S32). `RoutingUrlCertificateLimitReached` is accepted: its sibling `RoutingUrlQuotaExceeded` is a lasting plan cap, this is an hourly one, so different words mark a real difference; the docs should use the same word (S36). `recordsPublished` reads wrong cold (S34).

**4. Ending the wait at once when `heldBy` is set.** Right behaviour. The platform design says a hostname passes to another row only when the holder's custom domain is deleted, and the control plane then syncs the waiting rows itself (`queueOthersNamingHostname` in `syncRoutingUrl.ts`). Six minutes of polling would not change that. The error is the right class but carries the wrong advice and leaves out the holder (S32).

**5. Docs.** They state the rule and the limit, and a reader can act on most of it. Three statements are not true as written: "redeploy to wait again" (S31), "every RoutingUrl counts" (S36), and the `heldBy` paragraph (S32). The pull request description does not mention the wait at all (S36).

## Findings

### S31 — The wait reads a row that a read never moves on; a hostname whose records Prisma missed cannot become active in the wait, and redeploying does not help

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 540–562 (`untilActive`), 646–666 (`awaitPublishedRecords`), 521–524 (the message "Prisma keeps working on it; redeploy to wait again"), 297–309 (resource JSDoc); `website/src/content/docs/prisma/compute/apps.mdx`, first bullet under "With `dns`, the deploy waits"; `packages/integration-tests/test/Prisma/fixtures/RoutingUrlCloud.ts`, `servesWhenPublished` and `progressed` on `GET`.
- **What happens today:** the control plane looks the hostname's DNS up only when the row is written and when `/check` is called. In `syncRoutingUrl.ts`, a pending row whose ownership is not met is saved and nothing is queued (`if (current.status === "pending" && ownership !== "met")`). A register Foundry refuses for DNS reasons (`case 400: refuseDns(...)`) is recorded and nothing is queued. The only automatic second look is the domain ownership's own lookup 10 minutes later (`LOOK_UP_AGAIN_AFTER_SECONDS = 600` in `domainOwnership.ts`), and nothing at all for the `CNAME`. `GET /v1/urls/{id}` only reads.
- **So:** the 6-minute poll can only succeed for a row whose remaining work is the certificate, which the control plane follows on its own queue. If Prisma did not see the records when the row was created or changed, the poll is certain to run out. `awaitPublishedRecords` is meant to prevent that, but it discards what `checkRecord` and `checkSwitchboardDns` return, so when the records are still not visible after about a minute it saves the row anyway, and the deploy then waits 6 minutes for something nothing will do. A redeploy with unchanged props does not write the row (`save` returns `observed` when there is no change), so it waits 6 minutes again and fails again, for the `CNAME` indefinitely. The error text tells the user the opposite.
- **Why the tests do not show it:** the fixture's default `progress` makes a pending row `active` on any `GET` once the zone holds both records. That models a Prisma that looks DNS up on read, which the control plane does not do. The "next deploy finds the same row" test passes only because of that.
- **Suggestion:** the spec allows `/check` "only where the control plane code shows it cannot order a certificate". `checkRoutingUrl` orders a certificate only when the custom domain's status is `failed`; when the row holds no custom domain, or its first unmet condition is `ownershipVerified` or `dnsPointsAtSwitchboard`, a check only looks DNS up. So:
  1. In `untilActive`, when the first unmet condition is `ownershipVerified` or `dnsPointsAtSwitchboard` and the row's custom domain is absent or not `failed`, call `/check` instead of `GET`, at most a small fixed number of times per deploy (for example once at the start of the wait and once half-way). Say in a comment which control-plane rule makes it safe, so a later reader does not "fix" it back into a loop.
  2. Make the fixture match the control plane: move a row past `ownershipVerified` and `dnsPointsAtSwitchboard` only on create, update or `/check`; move it past `certificateActive` on reads after some polls. Then the redeploy test exercises a real path.
  3. Make `RoutingUrlNotActive`'s message depend on the first unmet condition: for the certificate, "Prisma keeps working on it; redeploy to wait again" is true; for ownership or DNS it should name the records that Prisma has not seen.
  If calling `/check` is not wanted, the alternative is to fail at once when `awaitPublishedRecords` does not see the records, with a message saying so, and to stop saying a redeploy will help for those two conditions. That is worse for the user, since the records usually appear a minute later.

### S32 — `RoutingUrlNotActive` covers a held hostname without saying who holds it, and gives advice that is wrong for that case

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 139–152 (class and JSDoc), 508–532 (`notActive`); `apps.mdx`, the last paragraph of the Routing URLs section ("then the change goes through, and the new hostname stays `pending` with `heldBy` set").
- **What happens:** one class reports two situations. In one, time may fix it; in the other, only the holder can. The class JSDoc says "Prisma keeps working on it; redeploy to wait again" for both. The message for the held case is right, but a program matching the error cannot tell the cases apart: the error has `firstUnmetCondition` and `customDomainSyncError` but not `heldBy`, which the row's attributes already carry. The guide still says a hostname change onto a held hostname "goes through and stays `pending`"; with `dns` it now fails the deploy.
- **Suggestion:** keep one class (minimal surface), add `readonly heldBy: ApiRoutingUrl["heldBy"]`, and make the JSDoc say "With `dns`, the hostname did not serve within 6 minutes, or another RoutingUrl holds it (`heldBy`), which waiting does not change." Add "With `dns`, the deploy then fails with `RoutingUrlNotActive`, which names the holder" to the guide's `heldBy` sentence and the matching sentence in the resource JSDoc (lines 269–271).

### S33 — The certificate limit is recognised by matching Prisma's English sentence

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 496–506 (`CERTIFICATE_LIMIT`, `certificateLimitOf`); the control plane builds the sentence in `waitForCertificateSlot` in `syncRoutingUrl.ts`.
- **What happens:** a public error class with typed fields (`limit`, `resetAt`) rests on an anchored regular expression over a free-text field. If the control plane rewords the sentence, changes the number format, or reports a limit other than the hourly one (it already writes `limited.message` for any other feature), the resource silently falls back to a 6-minute timeout and `RoutingUrlNotActive`. The Typed Error Doctrine exists to stop exactly this kind of matching on text, though here the text arrives in a 200 response rather than an error, so a Distilled patch cannot fix it.
- **Why it matters:** Prisma owns both sides, so this is a contract between two of our systems kept only by the wording of a message.
- **Suggestion:** keep the match for now, but add a platform request to `plan.md` next to the existing two: the RoutingUrl response carries the limit as data (for example `certificateLimit: { limit, resetAt } | null`). Name the control-plane function that writes the sentence in the comment above `CERTIFICATE_LIMIT`, so whoever changes one can find the other.

### S34 — `recordsPublished` reads as a fact about DNS, not about this deploy, and reverses the round 6 rename without saying why

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 210–216 (prop and JSDoc), 366, 576, 598, 694, 711–714, 749.
- **What the name says, read cold:** "the hostname's records are published". That is also true when the user published them by hand, yet then the provider does not wait at all. The prop really means "this deploy publishes the records through `dns`, so the provider is responsible for getting the hostname to serve".
- **History:** round 6 (S13) found `recordsPublished` named for the caller, and it became `waitForRecords`. This commit renames it back because the flag now controls two waits, and `waitForRecords` would undersell the second. That reason is sound, but it is not written anywhere a reader of the code will find it.
- **Suggestion:** name it for what the deploy does: `publishesRecords`, with the JSDoc "This deploy publishes the hostname's records through `dns`. The provider then waits for them to appear before Prisma first looks at a new hostname, and waits for the RoutingUrl to become `active`." Present tense on the deploy separates it from the state of DNS.

### S35 — The wait runs on every reconcile with `dns`, so a hostname that stops serving later can block unrelated app deploys

- **Where:** `packages/prisma/src/RoutingUrl.ts` line 749 (`news.recordsPublished === true ? yield* untilActive(saved) : saved`); `internal/WebsiteDomain.ts` lines 46–50 (`app: compute`).
- **What happens:** `Prisma.Website` passes the whole Compute resource as `app`, and Compute's attributes include `deploymentId`, which changes on every code deploy. So, very likely (the code-review pass should confirm it against the engine's default diff), every Website deploy reconciles the row and runs `untilActive`. For a serving row that returns at once. But the control plane moves a row from `active` back to `pending` when it removes the custom domain: the workspace loses ownership (another workspace published its TXT value), or the service is deleted and recreated. From then on every code deploy of the site waits 6 minutes and fails, including the deploy someone is running to fix something else.
- **Precedent:** ACM's `Certificate` waits only while the certificate is not yet `ISSUED`; it does not re-wait on every update.
- **Suggestion:** state the rule as "With `dns`, the deploy waits until this hostname has served once", and wait only when the stored output is missing, names a different hostname, or was not `active`. A failed wait commits no output, so a redeploy after a failed wait still waits, and the documented redeploy advice keeps working. A row that regresses later then reports `pending` in its attributes without failing unrelated deploys. If the operator prefers that a regressed hostname fails every deploy, keep the current behaviour but say so in the JSDoc and the guide, since a reader would not guess it.

### S36 — The docs count the hourly limit per RoutingUrl, but Prisma counts certificate orders; and the pull request description is now wrong

- **Where:** `RoutingUrl.ts` lines 311–313; `apps.mdx`, section "How many hostnames you can add"; `websites.mdx` line 202; `pr-bodies/alchemy.md` lines 1–14.
- **What is not accurate:**
  1. "Each new RoutingUrl counts." In the control plane the slot is taken when Prisma registers a custom domain (`reserveCustomDomainCreation` in `register`), which happens once ownership is met and a deployment is live. So a hostname change counts too, and so does a certificate Prisma orders again after a stuck or failed one; a RoutingUrl whose records are never published does not count. The section heading talks about hostnames, the error talks about certificates.
  2. `websites.mdx` says the deploy "waits up to 6 minutes"; with the records wait it is up to about 7. `apps.mdx` gets this right.
  3. The description's first example says `url.status: "pending", then "active" once Prisma has found both records` for the `dns` case; with `dns` the deploy now returns `active`. It does not mention the wait, the two new errors or the hourly limit. The spec's done condition requires the description to say it.
- **Suggestion:** rename the section to "How many new certificates a workspace can order" (or keep the heading and say it in the first sentence), and write: "Prisma orders a certificate for each new hostname once its records are published, for each hostname change, and again when an order fails. A workspace may order 10 an hour; a RoutingUrl created again after it was deleted counts again." Use "about 7 minutes" in `websites.mdx`. In the description, change the `dns` example's comment to `// with dns: url.status is "active" when the deploy finishes`, and add one bullet to "How a RoutingUrl works": "With `dns`, the deploy waits for the hostname to serve, up to about 7 minutes, and fails with `RoutingUrlNotActive` or `RoutingUrlCertificateLimitReached`; a workspace can order 10 new certificates an hour."

## Earlier findings touched by this commit

| Finding | Status |
| --- | --- |
| Round 6 S13: the prop named for the caller | Reopened by the rename back to `recordsPublished`; see S34. |
| Round 7 S29: `AuthoritativeDns` named for waiting | Unchanged. The new `awaitPublishedRecords` is the first caller that really is a wait, which makes S29's point sharper: the module's functions are checks, and this helper is the one place that should say "await". |
| Round 7 S23: description leaves out contract | Grows: the two new errors and the wait are also missing (S36). |

## Out of scope for this pass (for the code-review pass)

- Whether the engine's default diff really reconciles the row on every Compute deploy (S35 depends on it).
- Whether production deploys provide Distilled's `Retry.Retry` with `DeployRetry.policy`, as the fixture now does explicitly; the spec requires every call to obey `429` and `Retry-After`.
- What the engine does with sibling resources when one reconcile fails, and whether ten parallel polls of 36 reads each stay within Prisma's request rate.
- Whether a wait of 6 minutes per RoutingUrl, inside a deploy that also builds and promotes an app, hits any outer deploy timeout.

## Could not check

- Real Prisma: no live tests were run. The control-plane behaviour in S31 is read from source at `236c1e63e`; whether deployed Prisma matches that commit was not checked.
