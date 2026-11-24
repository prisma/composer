# Plan: in Alchemy a domain ownership is declared, owns its TXT record, and can be saved before its DNS exists

Date: 2026-11-24, third version. Pull request: alchemy-run/alchemy#3529 (branch `feat/prisma-domain-ownership-status`, tip `27f4f54f` when this was written), now a draft. Clone: `wip/u2/alchemy`. alchemy-run/distilled#1348 is also a draft and changes too (step A). `Prisma.CustomDomain` does not change.

Versions 1 and 2 were reviewed by an architect, a principal engineer and a product manager ([reviews/domain-ownership-crud/](reviews/domain-ownership-crud/)). Will then settled the points version 2 left open, and the platform changed its default. This version replaces both. Read the five earlier reviews for line references before building; where a finding still applies it is cited.

## Why

Will, 2026-11-24:

- "For Alchemy, we're aiming to model resources in the platform's model, so actually, it may not be appropriate to remove the delete operation. If you want to control whether or not this domain ownership record exists for this particular workspace, Alchemy should be unopinionated and just give you the CRUD operations for you to control."
- "If you're modeling the domain ownership record in Alchemy, you're modeling resources at the workspace level. … It's only Composer that decides that Alchemy's scope will be isolated to one project as a container. Alchemy doesn't have that concept."
- On removing the special case that took an `unverified` row without `--adopt`: "I think that's good. If we're being more consistent with Alchemy's typical model, there's less opinionated stuff for the Alchemy team to complain about."
- "It seems like a bad idea for a routing URL to have DNS if it's actually the domain ownership record that requires the DNS records."
- On a deploy that ends with the RoutingUrl `pending` because the domain ownership was not verified yet: "why do we care? they are intended to be able to be persisted out of order by design".
- On the domain ownership failing a deploy when Prisma has not verified it: "the DO is supposed to be able to be persisted with no DNS records at all. its verification can be retried any time by the user, and in the future it will retry automatically peridically."
- "Assume we'll add periodic retries on the palatform side." By the end of the RoutingUrl project the platform also checks `verified` domain ownerships again.
- "if you're using Alchemy and you want to use this DNS property, then you have to specify the domain ownership record as well as the router URL. The alternative route, where you do not specify the domain ownership record, really only exists to enable composer."
- On `createDomainOwnership`: "keep it". On the Alchemy resource defaulting it to `false` and always sending it: "correct."
- On `Prisma.Website` with `domain` declaring its own `Prisma.DomainOwnership`, adopted without a flag: "of course it should!"

What this protects. Alchemy's maintainers review the pull request, and each behaviour that differs from a normal Alchemy resource is something they can object to. Both rows are designed to be saved in any order, before any DNS exists (pdp-control-plane `docs/compute/RoutingUrlLifecycle.md`: "A row exists before its DNS does"), so a resource that fails or waits because the other row or a record is missing works against the platform's design. And a RoutingUrl is a project's record while a domain ownership is the workspace's: writing one should not create the other unless asked.

## What changed on the platform

prisma/pdp-control-plane#6153 (open, a draft, not deployed; Will approved the proposal it implements):

- `createDomainOwnership` defaults to `false` on `POST /v1/services/{id}/urls` and `PATCH /v1/urls/{id}`.
- A new `state`, `no_domain_ownership`, first in the list: no domain ownership covers the hostname, so no TXT record is looked up. `not_verified` now means a domain ownership covers it and is not verified.
- A `PATCH` with only `createDomainOwnership: true` acts: it creates the domain ownership for the exact hostname when no verified one covers it and the exact one does not exist. When there is nothing to create it writes nothing and looks nothing up.

The SDK on our Distilled branch types `state` as a fixed list of the ten old values (`wip/cp/management.ts`, six places), so it must be regenerated from the new spec.

## The workflows this must support

| # | What the user declares | Deploy | Destroy |
| --- | --- | --- | --- |
| 1 | `Prisma.DomainOwnership` with `dns`, and `Prisma.RoutingUrl` with `dns` | The ownership publishes the TXT record and creates its row. The RoutingUrl publishes the CNAME and creates its row. Either may finish first. If the ownership is not verified when the RoutingUrl is saved, the deploy ends with the RoutingUrl `pending`; Prisma makes it `active` on its own once the ownership is verified. | Both rows and both records are removed |
| 2 | A wildcard `Prisma.DomainOwnership` with `dns`, and several RoutingUrls with `dns` | As 1, with one TXT record for all | As 1 |
| 3 | `Prisma.DomainOwnership` without `dns` | Creates the row and returns it `unverified`, with the record to publish in its attributes. No failure. | The row is removed |
| 4 | `Prisma.RoutingUrl` alone, with or without `dns` | Creates the row (and the CNAME with `dns`). No domain ownership exists, so it returns `pending` with `state: "no_domain_ownership"`. | The row (and the CNAME) is removed |
| 5 | `Prisma.RoutingUrl` with `createDomainOwnership: true`, no `dns` (what Composer will do) | Prisma creates the domain ownership. Returns `pending` and lists both records. | The RoutingUrl is removed. Prisma's domain ownership stays. |
| 6 | `Prisma.Website` with `domain`, with or without `dns` | The site declares a `Prisma.DomainOwnership` (adopted without a flag) and a RoutingUrl. With `dns` it publishes both records. A site deployed with the released Alchemy upgrades with no `--adopt`. | Both rows and records are removed |
| 7 | Two stacks that declare the same domain ownership | The second is refused until it passes `--adopt` or `adopt(true)`. Recommended: declare it in one stack, with `RemovalPolicy.retain()` if it must outlive that stack. | Destroying either deletes the row for both (Will: "Yeah, I think that's correct") |

## Decisions

1. **`Prisma.DomainOwnership` is create, read, delete over the workspace's row, and never fails because DNS is missing.**
   - Reconcile: find the row (by recorded id, else by domain); create it if missing; return its attributes with the `status` Prisma reports. No precondition that the TXT record resolves, and no `PrismaDomainOwnershipRequired` from this resource. Keep that export: a test pins it and `Prisma.CustomDomain` may use it.
   - A row the stack has no state for needs `--adopt` or `adopt(true)`, whatever its status. `read` returns every such row as `Unowned`, and the engine makes the decision. Remove `claim` and its use in `reconcile`; that is what makes `adopt(true)` written in code work (principal engineer, first review). Add a test for `adopt(true)`.
   - When the stack has state but the recorded id is gone, the row is found by domain or created, and recorded. A workspace has one row per domain, so the stack's row for that domain is that row. This changes the test "refuses a verified row found by domain when the stored id is gone, without --adopt". Reviewers: say if this is wrong.
   - No second look before the create. Prisma's create is idempotent; the resource records the row it returns.
   - With `dns`: publish the TXT record first, as today. Wait, bounded as `awaitPublishedRecords` does in `RoutingUrl.ts`, for the record at the authoritative nameservers, then create, then ask Prisma to verify for the existing bounded period (6 times, 5 seconds apart). Whatever the result, the deploy succeeds and reports `status`. Errors from the verify calls are caught. If the nameservers never show the record, it still creates the row and reports `unverified`.
   - Without `dns`: create at once, at most one verification request, report `status`. The attributes carry `recordName` and `recordValue`.
   - Destroy deletes the row and, with `dns`, the TXT record. `RemovalPolicy.retain()` keeps them.
   - Accepted cost: a deploy interrupted between the create and the state save needs `--adopt` on the redeploy.

2. **`Prisma.RoutingUrl` gains `createDomainOwnership?: boolean`, default `false`.**
   - Every create and every update the resource sends carries the field explicitly, `true` or `false`, so the resource does not depend on the platform's default.
   - When the option is `true` and the row Prisma returns is in `no_domain_ownership`, the resource sends `PATCH` with `createDomainOwnership: true`. This covers turning the option on for a deployed RoutingUrl, and a domain ownership an Admin deleted. Prisma does not store the option, so it is not in `diff`; a props change still reaches `reconcile`, and the state decides whether a request is sent.
   - The JSDoc says what `true` is for: a stack that should not declare a workspace-level resource. It says that Prisma's domain ownership is not removed with the RoutingUrl.

3. **A RoutingUrl's `dns` publishes the CNAME and nothing else.** A RoutingUrl never publishes a TXT record. The TXT record belongs to `Prisma.DomainOwnership`. This removes the problem both reviewers found in version 2, where two record sets published the same TXT record and one deleted it for the other.
   - `requiredRecords` returns the CNAME only. `awaitPublishedRecords` waits for the CNAME only; `RoutingUrlRecordsNotSeen` can name only a CNAME.
   - After the save, `no_domain_ownership` or `not_verified`: return `pending` at once. No `/check`, no wait, no error. The attributes show `state`, and `records` lists what to publish.
   - `waiting_for_dns` with `dns`: as today, wait for the CNAME at the nameservers, then one `/check`.
   - `ensureCanServe` (a hostname change of an `active` row): ownership is shown by a verified covering domain ownership, or by the TXT record seen at every nameserver together with either a covering domain ownership row of any status or `createDomainOwnership: true` (principal engineer, second review: with no row, Prisma never looks). It checks the TXT record once and never waits for it, because this resource does not publish it.
   - Every place that reads `state` handles `no_domain_ownership`: `missesDns`, `unseenRecordsOf`, `needsCheck`, `notActive`'s messages, the attribute JSDoc.

4. **A RoutingUrl no longer waits for the hostname to serve.** Will, 2026-11-24, on the up-to-6-minute wait he decided on 2026-11-20: "I think at most it should be opt in." This plan removes it and builds no opt-in; one can be added later without breaking anyone. Why: the platform makes the hostname `active` on its own; the wait would run only when ownership happened to be met at save time; and a timeout failed a deploy whose row was saved correctly.
   - The resource returns after the save, and after the one `/check` in `waiting_for_dns` with `dns`. `untilActive`, `ACTIVE_WAIT`, `waitsForActive`, `notActive` and `RoutingUrlNotActive` go, unless a reviewer finds another user of the error type.
   - A held hostname and a failed certificate are reported through the attributes (`state`, `heldBy`, `customDomainSyncError`), not as a failed deploy.
   - The JSDoc says a deploy ends before the hostname serves, and that `state` becomes `active` when it does.

5. **`Prisma.Website` with `domain` declares a `Prisma.DomainOwnership` and a RoutingUrl.**
   - The domain ownership is for the exact hostname, piped through `adopt(true)`, so a site whose row Prisma or an earlier release created deploys with no flag. With `domain.dns` it gets the same `dns`, so the site publishes the TXT record through it.
   - The RoutingUrl keeps the default `false` and, with `dns`, publishes the CNAME.
   - The RoutingUrl is declared so that it is saved after the domain ownership (its hostname is derived from the ownership's output, as `RoutingUrl` already does with its record set at `RoutingUrl.ts:407`). A user's stack needs no such order; a site has it so that a hostname change of a serving site passes `ensureCanServe` in one deploy. Reviewers: say whether this is worth it, given Will's "why do we care" about order.
   - The released `DomainAlias` alias stays as it is.
   - Destroying the site deletes the domain ownership. The docs say to declare a shared or wildcard one outside the site; whether `domain` needs an option to not declare one is for the product manager's review, not assumed.

6. **Docs assume the platform retries.** The JSDoc may say that Prisma picks up a record published later and makes the hostname `active` on its own. It must not describe today's single second look as the design.

7. **No force-push, same pull request, one Distilled pull request.** The descriptions change; Will edits them on GitHub from `pr-bodies/`.

## Corrections from the third reviews

The architect, principal engineer and product manager reviewed this version (`reviews/domain-ownership-crud/architect-3.md`, `principal-engineer-3.md`, `pm-3.md`). These corrections override the decisions above where they differ. The implementer reads all three files; the principal engineer's lists the exact lines, the tests to rewrite and the reconcile shape.

1. **The domain ownership is refused before it touches DNS.** Today the TXT record is published before the row is declared, so an adoption refusal comes after the record set has already taken an existing record with the same value; destroying it then deletes that record for everyone (architect 1). Order: declare the row with plain props first (adoption is checked here), then publish the TXT record from the row's attributes, then the bounded wait and verify as a separate internal resource.
2. **The wait at the nameservers** keeps `nameservers: "parent"` and `margin: "always"` and adds `waitFor` of 3 minutes, because `awaitPublishedRecords`'s options do not work for a wildcard (principal engineer 5). No verify request after an `absent` result, and none after a create without `dns`: Prisma's create already looks once. Keep the look-up by domain, so a `verified` row is not sent through the create again. Remove `domainOwnershipId` from `stables`, since it can change on an update (architect 6). Catch named error tags in the verify loop, not every error.
3. **`alchemy dev` must not publish the TXT record** to real DNS. `Prisma.DomainOwnership` with `dns` gets the same `publishesDns` check `RoutingUrl` has. This bug predates the plan; fix it here.
4. **The RoutingUrl's TXT is dropped where the record set is declared** (`RoutingUrl.ts:403`), by publishing only the CNAME from `required.records`. `RoutingUrlRequiredRecords` keeps its attributes, because it is reconciled only when `app` or `hostname` changes, and the retained `DomainAlias` reads the CNAME from them (principal engineer 2).
5. **The one `/check` keeps its trigger.** `waitsForActive` is renamed for what it decides (send one `/check`: the row was created or its hostname changed, `dns` is set, the CNAME is seen, and the state is `waiting_for_dns`). The rest of decision 4 stands. A failed certificate's reason moves to a new attribute, since it lived only on `RoutingUrlNotActive`. `RoutingUrlNotActive` goes, with its pins in `PublicSurface.test.ts:138`, `RoutingUrl.test.ts` and the guide `apps.mdx`.
6. **`createDomainOwnership` goes into the row's props only when the user sets it**, so existing deployments plan no update. Every create and update request still sends `createDomainOwnership ?? false`. It is passed to `updateUrl` directly, not added to `change`, so it never triggers a `PATCH` by itself. Decision 2's `PATCH` for `no_domain_ownership` runs only on a deploy that reaches `reconcile`; an unchanged redeploy does not, so the docs say "redeploy after a change" or "use Check", not that it heals on its own.
7. **`ensureCanServe` checks each covering row's own record**, the wildcard's for a wildcard row (architect 5). A visible TXT with no covering row and `createDomainOwnership` not set is refused with a new `ownership: "noDomainOwnership"` value. In a user's stack a hostname change of a serving RoutingUrl can take two deploys when its domain ownership is new; the docs say so.
8. **`Prisma.Website`:** the domain ownership's id includes the hostname, so a hostname change does not delete the old TXT before `ensureCanServe` runs. Its `project` is the site's project. The RoutingUrl is ordered after it through an internal entry point under `internal/`, not a public option. The docs say that destroying the site deletes the domain ownership it declared or adopted.
9. **Docs** (product manager 1, 3, 5, 6): `state`, `records` and `dns` JSDoc say what `no_domain_ownership`, `not_verified` and `unverified` mean at the end of a deploy and what to do next; the RoutingUrl docs open with the two-resource example; a deploy ends before the hostname serves, and `site.url` may not serve yet; Check at `setupUrl` or `POST /v1/urls/{id}/check` makes Prisma look now; `createDomainOwnership`'s JSDoc covers its three cases. One warning in the deploy log when a save ends in `no_domain_ownership`, worded so it is not false when the stack declares a domain ownership. Also fix the guide's DNS adapters table and `WebsiteDomain.dns`'s JSDoc.
10. **Stacks deployed from this branch before this change** may lose their TXT record on the upgrade. The branch is unreleased; the handover says so in one sentence and nothing is built for it.
11. **SDK.** A `state` outside the list decodes, because the runtime schema is `S.String` (`management.ts:8125`); only the TypeScript type is fixed. Regeneration is needed for the type only. The spec is a submodule pointing at `distilled-mirror/spec-mirror-prisma-postgres`, refreshed from production daily. Before #6153 deploys, extract the spec from its head (`pnpm --filter management-api extract-openapi`), write it over the submodule's `specs/openapi.json`, run `pnpm convert` and `pnpm generate`, and keep the commits local. After it deploys, pin the first mirror commit that has `no_domain_ownership`, on both Distilled branches.

## Steps

### A. SDK and set-up

1. In a clone of `wmadden-electric/distilled`, on the pull request branch: replace the pinned Prisma spec with the one #6153 produces, regenerate `@distilled.cloud/prisma`, and confirm `state` lists `no_domain_ownership`. Do the same on `feat/prisma-routing-urls-on-alchemy-pin`. Until #6153 is merged and deployed, take the spec from its head commit and keep these commits local; push them only after it is deployed and the spec is published, and regenerate again if it changed in review.
2. Before that, check what the SDK does today with a value outside the list: decode failure or pass-through. It decides how the description words the dependency.
3. In `wip/u2/alchemy`: fetch the bot fork and `upstream`; merge `upstream/main` if it moved. The clone is shallow and `submodules/distilled` is not checked out: point it at the local regenerated pin branch, then `pnpm install --frozen-lockfile` and `pnpm ensure:built`. Read Alchemy's `AGENTS.md`: reconciler doctrine, typed error doctrine, JSDoc rules.

### B. `Prisma.DomainOwnership` (`DomainOwnership.ts`, `internal/DomainOwnershipProof.ts`, `internal/DomainOwnership.ts`)

Decision 1. The proof resource needs an internal prop that says its record was published by this deploy (principal engineer, second review). Remove what becomes unused and comments the change makes false. JSDoc: the row belongs to the workspace; it can be declared before its record exists and reports `status`; with `dns` the record is published for you; a row the stack did not create needs `--adopt`; declare a shared one in one stack; `RemovalPolicy.retain()` keeps it. Examples, in this order (product manager): exact hostname with a RoutingUrl, both with `dns`; wildcard with two RoutingUrls; no `dns`.

### C. `Prisma.RoutingUrl` (`RoutingUrl.ts`, `internal/RoutingUrlRequiredRecords.ts`)

Decisions 2, 3 and 4. JSDoc: the new prop; `dns` publishes the CNAME; a hostname serves only once a domain ownership covers it, with the two-resource example first; remove the "Don't also declare a `Prisma.DomainOwnership`" paragraph.

### D. `Prisma.Website` (`internal/WebsiteDomain.ts`, `Website/FrameworkSite.ts` JSDoc)

Decision 5.

### E. Tests (`packages/integration-tests/test/Prisma/`, the fake API)

- The fake gets a domain-ownership model if it lacks one, the `no_domain_ownership` state, the `false` default, and the `PATCH` with only `true`.
- `DomainOwnership.test.ts`: created with no TXT record anywhere, the deploy succeeds `unverified` with the record in the attributes; with `dns`, the record is published and seen before the create and the deploy succeeds `verified`; with `dns` and Prisma not verifying in time, the deploy succeeds `unverified` and a redeploy needs no `--adopt`; a row with no state is refused without `--adopt`, whatever its status, and taken with the flag and with `adopt(true)`; `read` reports an `unverified` row with no state as unowned; no second list request before the create; destroy deletes the row and the record. Replace the tests of removed behaviour.
- `RoutingUrl.test.ts`: the create request carries `createDomainOwnership: false` by default and `true` when set; with `dns` exactly the CNAME is published and destroy removes exactly the CNAME; `no_domain_ownership` and `not_verified` after the save return `pending` with no `/check` and no further read; option `true` on a deployed row in `no_domain_ownership` sends the `PATCH`, and sends nothing in any other state; a redeploy with nothing changed sends no `PATCH`; `ensureCanServe` with a verified covering row, with an unverified row plus a visible TXT record, and with a visible TXT record but no row. Many existing "with dns" tests assume the RoutingUrl publishes the TXT record; rewrite them, do not delete coverage of the CNAME path.
- Both resources for one hostname, both with `dns`: deploys with no `--adopt`, and destroy removes both rows and both records.
- `Website` tests: a site with `domain` and `dns` declares both, publishes both records, upgrades from a released site's state with no `--adopt`, and a hostname change of a serving site passes in one deploy.

### F. Docs and checks

`pnpm docs:check-jsdoc`, `pnpm docs:gen`; the Compute custom-domain guide section. Then `pnpm typecheck`; `pnpm lint:tests`; `pnpm format:check`; `pnpm exec oxlint -c oxlint.config.ts packages/prisma/src`; from `packages/integration-tests`, only the `Prisma` test files touched and the `Website` files that cover `domain`. Never a whole suite. Known failures that are not ours are in the handover.

Manual check against real Prisma with the deploy credentials (never printed), once #6153 is deployed: a RoutingUrl created with `false` leaves no domain ownership and reports `no_domain_ownership`; a domain ownership for a hostname with no TXT record is returned `unverified`; delete both and list the workspace's domain ownerships to confirm nothing is left. Before it is deployed, only the second and third can be checked.

### G. Review, push, descriptions

`/drive-code-review` (system design pass, then code pass, no walkthrough) on the built commit; fix findings. Push to `wmadden-electric/alchemy`, no force, only after the Distilled branches are pushed. Rewrite `pr-bodies/alchemy.md` (the product manager's review lists where it becomes wrong) and update `pr-bodies/distilled.md` for the new spec; have a reader with no context review each; give Will the `gh pr edit` commands. Both pull requests stay drafts until this is done; only Will can mark them ready.

### H. Project files

This slice's `spec.md`, `design-notes.md` note 13 (add: saved without DNS, default `false`, the site declares its own), the handover, and `plan.md` (Composer's switch passes `createDomainOwnership: true`).

## Not in this plan

- Any option to order a RoutingUrl after a domain ownership in a user's stack. Will: the two are saved out of order by design.
- `Prisma.CustomDomain`, Composer, the `prisma` CLI.
- Any reply on either pull request.
