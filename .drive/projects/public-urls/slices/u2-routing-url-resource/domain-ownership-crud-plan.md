# Plan: the TXT record belongs to `Prisma.DomainOwnership`, and adoption has no special case

Date: 2026-11-24. Pull request: alchemy-run/alchemy#3529 (branch `feat/prisma-domain-ownership-status`, tip `27f4f54f` when this was written). Clone: `wip/u2/alchemy`. alchemy-run/distilled#1348 and `Prisma.CustomDomain` do not change.

## Why

Will, 2026-11-24, in a design discussion about the Alchemy branch:

- "For Alchemy, we're aiming to model resources in the platform's model, so actually, it may not be appropriate to remove the delete operation. If you want to control whether or not this domain ownership record exists for this particular workspace, Alchemy should be unopinionated and just give you the CRUD operations for you to control."
- "If you're modeling the domain ownership record in Alchemy, you're modeling resources at the workspace level. It's really up to you how that relates between projects in the platform. It's only Composer that decides that Alchemy's scope will be isolated to one project as a container. Alchemy doesn't have that concept."
- On removing the special case that takes an `unverified` row without `--adopt`: "I think that's good. If we're being more consistent with Alchemy's typical model, there's less opinionated stuff for the Alchemy team to complain about."
- "It seems like a bad idea for a routing URL to have DNS if it's actually the domain ownership record that requires the DNS records. Perhaps we should remove this from the routing URL and keep it only on the DO."
- By the end of the RoutingUrl project the platform checks verified domain ownerships again. One whose TXT record is gone becomes `expiring`, and 30 days later `unverified`. Design for that, not for today's cron, which looks only at `expiring` ones.

What this is protecting: Alchemy's maintainers review this pull request, and every behaviour that differs from Alchemy's usual resource model is something they can object to. And a TXT record published by one resource for a row another party owns goes wrong on destroy: today a RoutingUrl's destroy removes the TXT record and leaves the domain ownership, which would then lapse.

Will approved the three changes below on 2026-11-24 ("yep"). The two marked "decided here" are engineering decisions made while writing this plan; reviewers should test them hardest.

## What exists today (read in the clone at `27f4f54f`)

- `packages/prisma/src/internal/DomainOwnershipProof.ts`: `claim` takes an unrecorded row when it is `unverified` or with `--adopt`; `read` returns an unrecorded `unverified` row as owned and any other as `Unowned`; `reconcile` looks for the row, waits for the TXT record, looks again (`foundAfterDnsWait`), then creates; `delete` deletes the row.
- `packages/prisma/src/DomainOwnership.ts`: with `dns`, publishes the TXT record, then declares the proof. Its JSDoc warns against declaring it for a RoutingUrl's hostname.
- `packages/prisma/src/RoutingUrl.ts`: with `dns`, publishes the TXT and the CNAME from `requiredRecords` (`internal/RoutingUrlRequiredRecords.ts`) before the row. `awaitPublishedRecords` waits up to 3 minutes to see both at the authoritative nameservers before a create, a pending row's hostname change, or the single check. The create sends no `createDomainOwnership`, so the platform's default (`true`) applies: Prisma creates an `unverified` exact-hostname domain ownership when no verified one covers the hostname.
- `packages/prisma/src/internal/WebsiteDomain.ts`: a site declares `RoutingUrl("Url", { app, hostname, dns })` and keeps the released `DomainAlias` CNAME alias, adopted and retained.
- Platform, read from `main` on 2026-11-24 (`packages/interactors/src/compute/domainOwnership.ts`): when a domain ownership's status changes, the platform queues a sync of every live RoutingUrl it covers in its workspace. So a RoutingUrl that is waiting becomes `active` after a domain ownership is verified, without another request from the client.

## Decisions

1. **`Prisma.DomainOwnership` is plain create, read, delete over the workspace's row.**
   - A row the stack did not record needs `--adopt` (or `adopt(true)`), whatever its status. `claim` loses the `unverified` branch; `read` returns every unrecorded row as `Unowned`.
   - The second look before the create is removed. Prisma's create is idempotent, so a create returns the row for the domain, and the resource records it. This is what an Alchemy resource over an idempotent create normally does.
   - Destroy still deletes the row and, with `dns`, the TXT record. A user who wants the row to outlive the stack uses `RemovalPolicy.retain()`.
   - Accepted costs (Will: "Yeah, I think that's correct"): two stacks that declare the same domain share one row, and destroying either removes it for both; a deploy that failed after its create and lost its state needs `--adopt`.

2. **`Prisma.RoutingUrl`'s `dns` publishes the CNAME only.** The CNAME is the RoutingUrl's own record. The TXT record proves the domain ownership, and `Prisma.DomainOwnership` with `dns` publishes it. This reverses the decision of 2026-11-20 that the RoutingUrl's `dns` publishes both.
   - `awaitPublishedRecords` waits for the CNAME only: a resource waits for what it published.
   - The wait for `active` is unchanged in length and in when it runs. If ownership is not proved, the deploy waits; a `Prisma.DomainOwnership` verified during the wait makes the platform sync the RoutingUrl (see above). If nobody proves ownership the wait times out with `RoutingUrlNotActive`, which already names the first unmet condition and the TXT record. The message for that case also says to declare a `Prisma.DomainOwnership` with `dns` or publish the record. *(Decided here. The alternative, returning `pending` at once when ownership is the unmet condition, makes a first deploy with both resources finish before the hostname serves.)*
   - `ensureCanServe` (hostname change of an `active` row) still accepts the TXT record seen at every authoritative nameserver as proof. It only reads DNS, so it does not depend on who published the record.

3. **`Prisma.RoutingUrl` gains `createDomainOwnership?: boolean`, default `true`, passed to Prisma's create and update.** *(Decided here.)* Reason: with the default, Prisma creates an `unverified` domain ownership for the exact hostname during the RoutingUrl's create. A `Prisma.DomainOwnership` for that same exact hostname in the same stack would then find a row it did not record and need `--adopt`, or not, depending on which resource ran first. `createDomainOwnership: false` makes that combination work in either order. It is a field of the platform's own route, so it models the platform and adds no opinion. If the SDK's `createServiceUrl` or `updateUrl` input lacks the field, stop and report; do not patch Distilled.
   - On update, send the field only when a change is being sent anyway, so "a redeploy with nothing changed sends no `PATCH`" still holds.

4. **`Prisma.Website` with `dns` publishes the TXT record itself and lets Prisma create the row.** A site declares no `Prisma.DomainOwnership`, so a site deployed with the released Alchemy upgrades with no `--adopt`, and destroying a site never deletes a workspace's domain ownership.
   - The site publishes the TXT record through the adapter as a plain record, under an id of its own, taking the value from the same source as today (the workspace's verification endpoint, the same on every deploy).
   - The RoutingUrl must not be saved before that TXT record is visible at the authoritative nameservers, because Prisma looks it up through a caching resolver when the row is written and looks again only 10 minutes later. So the site's RoutingUrl is ordered after the TXT record, and waits for it as `awaitPublishedRecords` does today. `Prisma.Website` and `Prisma.RoutingUrl` are in one package: use an internal entry point or internal row prop for this, not a public prop.
   - Destroy removes the TXT record and the CNAME and leaves the domain ownership, which then lapses on the platform's schedule. No email is sent, because no serving hostname is covered.
   - The released `DomainAlias` handling does not change.
   - Alternative not taken: the site declares `Prisma.DomainOwnership` with `adopt(true)` and `RemovalPolicy.retain()` and a RoutingUrl with `createDomainOwnership: false`. It reuses more code, but a site would then adopt and keep a workspace-level row, which is an opinion of the kind decision 1 removes.

5. **No force-push, one commit, same pull request.** The description changes; Will edits it on GitHub from `pr-bodies/alchemy.md`. It still does not mention the gap between a look and a create.

## Steps

### A. Set up

1. In `wip/u2/alchemy`: `git fetch` the bot fork and `upstream`; if `upstream/main` has moved and the merge conflicts, follow the handover's conflict procedure. The clone is shallow and its `submodules/distilled` is not checked out: fetch the pinned branch `feat/prisma-routing-urls-on-alchemy-pin` from `wmadden-electric/distilled`, then `pnpm install --frozen-lockfile` and `pnpm ensure:built`.
2. Read Alchemy's `AGENTS.md`: the reconciler doctrine, the typed error doctrine, and the JSDoc rules.

### B. `Prisma.DomainOwnership`

1. `internal/DomainOwnershipProof.ts`: `claim` needs `--adopt` for every unrecorded row, and its error message no longer leads with the status. `read` returns `Unowned` for every unrecorded row. Remove `foundAfterDnsWait`. Remove comments the change makes false.
2. `DomainOwnership.ts` JSDoc: remove the warning against declaring it for a RoutingUrl's hostname. Say instead: the row belongs to the workspace; a row the stack did not create needs `--adopt`; two stacks that declare one domain share the row; destroy deletes it and `RemovalPolicy.retain()` keeps it; for a RoutingUrl's exact hostname, set `createDomainOwnership: false` on the RoutingUrl. Add an example with a RoutingUrl and a domain ownership for the same exact hostname.

### C. `Prisma.RoutingUrl`

1. The `dns` path publishes only the CNAME. Keep the per-hostname record ids so a hostname change still publishes the new record before the old is removed.
2. `awaitPublishedRecords` checks the CNAME only, unless the internal option from decision 4 asks for the TXT record too.
3. Add `createDomainOwnership` (decision 3) to props, create and update.
4. The `timedOut` message for an unproved ownership says how to prove it (decision 2).
5. JSDoc: every sentence that says `dns` publishes the TXT record, the `dns` prop's description, the "Don't also declare a `Prisma.DomainOwnership`" paragraph (replace with how the two combine), and the `createDomainOwnership` prop.
6. `internal/RoutingUrlRequiredRecords.ts`: its doc comment and, if the implementer narrows it, its records. Do not leave a field nothing reads.

### D. `Prisma.Website`

1. `internal/WebsiteDomain.ts` per decision 4. Check that the site's own TXT record resource and the RoutingUrl's internal resources have distinct ids and that no dependency cycle results.
2. JSDoc on `Prisma.Website`'s `domain` option where it describes what `dns` publishes.

### E. Tests (`packages/integration-tests/test/Prisma/`, fake API, as the existing ones)

- `DomainOwnership.test.ts`: an unrecorded `unverified` row is refused without `--adopt` and taken with it (replaces the tests that took it freely); a row that appears during the DNS wait is recorded by the create with no second list request (replaces the second-look tests); `read` reports an unrecorded `unverified` row as unowned; destroy still deletes the row and the record.
- `RoutingUrl.test.ts`: with `dns`, a first deploy publishes exactly the CNAME and destroy removes exactly the CNAME; an absent TXT record no longer raises `RoutingUrlRecordsNotSeen`; an absent CNAME still does; `createDomainOwnership: false` reaches the create request, and the default sends the platform default; a redeploy with nothing changed still sends no `PATCH`; a timed-out wait on unproved ownership names the TXT record and `Prisma.DomainOwnership`; the hostname-change tests that relied on the RoutingUrl publishing the TXT record are restated with the record published by the test.
- One test with both resources for one exact hostname and `createDomainOwnership: false`: deploys with no `--adopt`, and destroy removes the row, the TXT record and the CNAME.
- `Website` tests: a site with `dns` publishes the TXT and the CNAME, saves the RoutingUrl only after the TXT record is seen, declares no `Prisma.DomainOwnership`, and sends no domain ownership request on deploy or destroy; the upgrade test from the released state still passes with no `--adopt`.
- Update every other expectation the change makes false. Do not delete a test whose behaviour still exists.

### F. Docs

The Compute custom-domain guide section and any generated reference: `pnpm docs:check-jsdoc`, then `pnpm docs:gen` if it produces a change.

### G. Checks

`pnpm typecheck`; `pnpm lint:tests`; `pnpm format:check`; `pnpm exec oxlint -c oxlint.config.ts packages/prisma/src`; `pnpm docs:check-jsdoc`; from `packages/integration-tests`: `pnpm exec alchemy-test test/Prisma/AuthoritativeDns.test.ts test/Prisma/CustomDomain.test.ts test/Prisma/DomainOwnership.test.ts test/Prisma/RoutingUrl.test.ts` plus the `Website` test files that cover `domain`. Never a whole suite. Known failures that are not ours are listed in the handover ("Known results on Will's machine").

One manual check against real Prisma, with the deploy credentials (never printed): create a RoutingUrl with `createDomainOwnership: false` for a test hostname, confirm no domain ownership row for that hostname exists, delete the RoutingUrl, and list the workspace's domain ownerships to confirm nothing was left.

### H. Review, push, description

1. `/drive-code-review` (system design pass, then code pass, no walkthrough) on the built commit. Fix findings; a later commit that is not a merge of the base needs a new review.
2. Push to `wmadden-electric/alchemy`, no force.
3. Rewrite the affected parts of `pr-bodies/alchemy.md`, have a reader with no context review the title and description, and give Will the `gh pr edit` command.

### I. Project files

`spec.md` of this slice (the paragraphs on the domain ownership, on declaring both resources, on `dns`, on `Prisma.Website`, and the done conditions), `design-notes.md` (a dated note with Will's words), and the handover's section on how the resources decide a row is theirs.

## Not in this plan

- Any change to Distilled, to Prisma's API or its spec, or to `Prisma.CustomDomain`.
- Composer. It declares no `Prisma.DomainOwnership` and passes no `dns`; its switch to `Prisma.RoutingUrl` is a later slice.
- Any reply on either pull request.
