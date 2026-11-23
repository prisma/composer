# Architect review: remove the HTTP status from the Distilled and Alchemy pull requests

Date: 2026-11-23. Subject: `remove-http-status-plan.md` in this slice.

What I read:

- The plan, in full.
- Distilled clone `wip/u2/distilled`, branch `feat/prisma-routing-urls`: `CLAUDE.md` (contributor rules 1 to 18), `git diff upstream/main...HEAD --stat`, the full diff of `packages/core`, `packages/dev`, patches 005 and 006, `packages/prisma/src/retry.ts`, `packages/core/src/retry.ts` (the default policy), `packages/core/src/api.ts` (`applyRetry`), `packages/core/src/category.ts` (`isTransientError`), and the pinned branch `origin/feat/prisma-routing-urls-on-alchemy-pin` against `f0b37d720`.
- The Prisma spec in the mirror, `specs/openapi.json`: the `POST` on `/v1/workspaces/{workspaceId}/domain-ownerships` and on `/v1/services/{serviceId}/domains`, with every response description.
- Alchemy clone `wip/u2/alchemy`, branch `feat/prisma-domain-ownership-status`: `AGENTS.md` (concepts, reconciler doctrine, Typed Error Doctrine, testing conventions, pull request conventions), `internal/DomainOwnershipProof.ts`, `internal/DomainOwnership.ts`, `CustomDomain.ts`, `DomainOwnership.ts`, `internal/AuthoritativeDns.ts` (the wait before a create), `Providers.ts` (which retry policy is installed), `alchemy/src/DeployRetry.ts`, `Client.ts` (`createAppDomain`, `retryTransient`, `isRetryablePost`), `Types.ts` (`CustomDomainCreateResult`), `Operations.ts`, and `upstream/main:packages/prisma/src/CustomDomain.ts`.
- Alchemy tests: `test/Prisma/CustomDomain.test.ts` and `test/Prisma/DomainOwnership.test.ts` in full for the race and retry cases; a search of every Prisma test and the website docs for the status, `201` and `withoutRetriedCreate`.
- Both pull request descriptions, and the live ones on GitHub (`gh pr view`); they match the local copies except for a trailing newline.
- The slice `spec.md` and the project's `design-notes.md` (adoption and ownership), `handover.md` and the slice `plan.md` (search for the removed pieces).
- To settle the plan's open point on what a resent create does, the control plane's handlers in the local checkout `/Users/wmadden/Projects/prisma/pdp-control-plane` at `236c1e63e` (2026-11-18): `services/management-api/routes/v1/services.ts` (custom domain create), `routes/v1/workspaces/domain-ownerships.ts`, `packages/interactors/src/compute/domainOwnership.ts` and `packages/repositories/src/compute/domainOwnership.repository.pn.ts`. This is not necessarily what runs in production today.

## Findings

### A01. Decision 2 rests on a false premise: a domain ownership another stack creates is usually already `verified`

Where: decision 2, "With the status, that case went through `claim`, which accepts a row that is `unverified`, as a seconds-old row is. So the outcome changes only if the row is already `verified` or `expiring` at that moment."

What is wrong: a new domain ownership is not necessarily `unverified`. Prisma's create looks the TXT record up and returns the row verified when the record is there. Every `Prisma.DomainOwnership` deploy waits until the record resolves at the authoritative nameservers before it creates. The record's name and value are the same for every stack in the workspace. So a row another stack creates is normally `verified` from its first second. The case the plan calls the exception is the usual case.

The window is also not seconds. The look happens before the DNS check, and the DNS check with `margin: "always"` sleeps 10 seconds after it sees the record, or waits up to a minute and then 10 seconds when it does not.

Evidence:

- Spec, `POST /v1/workspaces/{workspaceId}/domain-ownerships`: "returns the domain ownership, verified when the record carries the workspace's value and unverified otherwise", and `201` "The domain ownership was created, verified or unverified."
- Control plane `createDomainOwnership`: both the existing and the new row go through `syncAndRead`, which looks the record up before the response.
- `DomainOwnershipProof.ts:219-246`: look (`findOwnership`), then `checkRecord(..., { margin: "always" })`, then `createOwnership`.
- `AuthoritativeDns.ts:234` (`waitFor` one minute) and `:250` (`Effect.sleep("10 seconds")` once the record is seen).

Change to the plan: rewrite decision 2. Say that the change is in exactly the case `claim` exists for: a `verified` row that this resource did not see before its create. State the window as "from the look until the create, at least 10 seconds and up to about 70".

### A02. The ownership cases before and after, and what `destroy` does

The plan does not list them. Here they are, from the code.

Alchemy has no ownership marker on these rows (no tags, no `logicalId`). The only evidence that a row is a stack's own is that the stack's state records its ID. `read` returns `Unowned` for a `verified` or `expiring` domain ownership it finds, and for any custom domain it finds. `claim` applies the same rule inside `reconcile`.

`Prisma.DomainOwnership`, a row created by someone else between this deploy's look and its create:

| Who created it | Before | After |
| --- | --- | --- |
| Another stack's `Prisma.DomainOwnership` for the same domain | `200` → `claim` → refused without `--adopt` (the row is `verified`, see A01) | Both stacks record the same `domainOwnershipId` |
| A person in the Console | Same as above | Same as above |
| Prisma itself, for a `Prisma.RoutingUrl` with that exact hostname in either stack | Refused once that row is `verified` | Taken; the slice spec's warning ("Don't declare both resources for one exact hostname") now covers the `verified` row too |
| Both creates truly at the same moment | Both get `201` and both own it (see A15) | Same |

When both own it, `destroy` of either stack calls `deleteDomainOwnership` on the shared ID (`DomainOwnershipProof.ts:260-265`) and, with `dns`, removes the TXT record. Every hostname that row covered for the other stack loses its proof until that stack redeploys and recreates it. This is the outcome the Alchemy description's own alternatives section rejects for the RoutingUrl ("a preview's destroy could remove production's proof").

`Prisma.CustomDomain`, a custom domain registered between the look and the create:

- `200` means the hostname is already on this same app (spec: "Custom domain already registered on this service"; the control plane returns `200` only for a domain in `listFoundryDomainsForApp(appId)`). A domain on another app is `409`, which still fails with "appeared after the adoption check".
- The app belongs to the stack, so the other actor is a person in the Console, or a `Prisma.RoutingUrl` for the same hostname. After the change the CustomDomain records the row. Removing the CustomDomain deletes it, unless a RoutingUrl with a `logicalId` holds the hostname (`CustomDomain.ts:380-387` guards that). Destroying the stack deletes the app anyway.
- So the harm in `Prisma.CustomDomain` is small; the harm in `Prisma.DomainOwnership` is not, because its row is workspace-wide and shared across stacks and stages.

Is "a successful create means the row is mine" coherent with Alchemy's model? Partly. The reconciler doctrine says a create race (`AlreadyExists`) is caught and the flow continues, which supports the plan. The adoption gate (`Unowned`, `--adopt`) is in `read` and `claim`, which apply to rows observed before the create. After the change the resource has two rules for the same row in the same state: refused when seen by the look, taken when returned by the create. Will's recorded decision is narrower than the plan's: "the row I asked for exists" is a statement about existence. Decision 2 turns it into ownership.

Change to the plan: record this table (or its substance) in decision 2 and 3. Take A03, or state plainly in the Alchemy description that a domain ownership another stack creates during the deploy is taken, and that destroying either stack then removes it.

### A03. A third option the plan missed: look again just before the create

Neither the status nor a second client is needed to keep almost all of the protection. Move the observation to just before the create:

- `Prisma.DomainOwnership`: when the first look found nothing, run `findOwnership` again after `checkRecord`, and send what it finds through `claim`. Only then create.
- `Prisma.CustomDomain`: when the first look found nothing, run `findDomain` again after the CNAME check, and fail with the existing `adoptionRequiredError(..., "appeared after the adoption check")` if it finds one.

This is one extra list call, only on the first create. It is a look before the create, not the "second lookup after the create" decision 1 rejects. It follows the reconciler doctrine (observe, then ensure). It keeps `claim` the one ownership rule, except for the time of one request. That residual is what the platform already gives two exactly simultaneous creates (A15), so the resource would be about as safe as it was with the status. For `Prisma.CustomDomain` the outer retry on `DomainDnsNotConfigured` and `DomainOwnershipRequired` (6 × 5 seconds) is a second window the re-look does not cover; say so in the description.

Change to the plan: I recommend this for `Prisma.DomainOwnership`, where the row is shared across stacks. It is optional for `Prisma.CustomDomain`, where A02 shows the harm is small; if it is taken there too, decision 3 no longer weakens `main` in any practical case. Either way, the plan should name this option and say why it is taken or not.

### A04. Decision 3's rejected alternative is right, for a stronger reason than the plan gives

Keeping the custom domain create on Alchemy's own client would need the resource to recognise `domain-ownership-required` by reading the body or status of an untyped `PrismaApiError`. Alchemy's Typed Error Doctrine forbids exactly that ("catching the catch-all HTTP error by status" is a listed forbidden pattern; the fix is always a Distilled patch). It would also leave one resource on two clients for one API. The rejection stands.

Change to the plan: cite the doctrine as the reason. Also drop the plan's promise that the description "will mention" `createAppDomain`: it is not dead code. It is the public operation `Prisma.createAppDomain` (`Operations.ts:163`, listed in `PublicSurface.test.ts:212`), and deleting it would be a breaking change unrelated to this pull request.

### A05. The retry policy is Alchemy's deploy policy, not "the default"

Where: decision 4 ("both creates use the default retry policy") and step E4 ("retried by the default policy").

What is wrong: Alchemy installs `DeployRetry.policy` on the Prisma SDK (`packages/prisma/src/Providers.ts:55` and `:91`). Distilled's own default (`core/src/retry.ts`, `defaultOptions`) is never used here. A Distilled maintainer reading "the default policy" will think of the latter, which retries far less.

What `DeployRetry.policy` retries (`alchemy/src/DeployRetry.ts`): any error marked retryable (`429`, `500`, `502`, `503`, `504` in core's error classes), the server, network, timeout and locked categories, and transport failures (a dropped connection). Up to 8 retries, about 20 seconds of backoff.

Is every such retry safe for these two creates? From the control plane source:

- Domain ownership: the create looks up `findLive(workspaceId, domain)` first and, if found, re-runs the DNS lookup and returns the row with `200`. The spec's own `503` response says "Retry the request; it returns the domain ownership with 200." Safe, and in fact the spec asks for it; today's `withoutRetriedCreate` goes against that instruction.
- Custom domain: the `200` path is a read. It lists the app's domains and returns before the quota check, the ownership check, the hourly creation reservation and `registerDomain` (`services.ts:1630-1650`). A resent create therefore does not register the hostname again or order a second certificate. This answers the plan's open point.

Change to the plan: say "Alchemy's deploy retry policy (`DeployRetry`)" in decision 4 and in the description, and record the evidence above.

### A06. Decision 4 is also a change from `main` for `Prisma.CustomDomain`, and the plan does not say so

On `main`, Alchemy's own client never resends `POST /v1/apps/{id}/domains`: `retryTransient` retries a `POST` only when the path ends in `/start`, `/stop`, `/promote` or `/rollback` (`Client.ts:484-503`). After the change the create is resent up to 8 times. That is an improvement (a lost reply no longer fails the deploy and then demands `--adopt` for the stack's own row), but it is a behaviour change in a resource Sam maintains.

Removing `withoutRetriedCreate` is part of this change, not a separate one: its one stated reason is the status, its comment would be false, and the spec tells callers to retry the domain ownership create.

Change to the plan: put this beside decision 3 in the Alchemy description, as one sentence: the custom domain create is now resent after a `5xx` or a dropped connection, which `main` never did.

### A07. `claim`'s doc comment becomes false, and step C7's filter misses it

`DomainOwnershipProof.ts:137-140`: "A domain ownership this resource did not record is taken only while it is `unverified`, which grants nothing, or with `--adopt`." After the change the create path takes a `verified` row it did not record. Step C7 only corrects sentences "that mention the status or the 200/201 distinction", and this one mentions neither.

Change to the plan: name this comment in step C3. If A03 is taken, the sentence stays true except for the one-request window; say "found before the create". If not, rewrite it to say the rule applies to rows found before the create.

### A08. Description sentences the plan would leave false or does not list

Alchemy description:

- "Prisma now creates it as `unverified` at once." This is false today and stays false (A01): the create returns it verified when the record resolves. Rewrite: "Prisma now creates it at once, `verified` only when its TXT record already resolves."
- "One it did not create needs `--adopt` once it is `verified`". The plan's rewrite ("holds for a row found before the create") is right; add what happens to one created during the deploy (A02), unless A03 is taken.
- The new `Prisma.CustomDomain` sentence must cover both changes from `main`: the `200` race (decision 3) and the resend (A06).

Distilled description, beyond the plan's list in step E2:

- The first sentence, "Two things a caller of Prisma's hostname API could not tell … whether a create made the resource or found it, and which refusal it got." It must be rewritten to the one remaining thing.
- "The core change breaks nothing." at the end of the breaking-change paragraph. Remove it.
- The heading "Alternatives considered" goes with its three bullets.
- "Evidence for all three" should read "Evidence for both".

Change to the plan: add these to steps E2 and E4.

### A09. The contributor note in Distilled's rule 17 must end the text, and the plan does not give its values

Rule 17 requires the body to end with the fixed note, with the person's GitHub username, the model and the harness version, every other character unchanged. Will's own rule puts `Agent: <name>` directly above the closing attribution line. Both hold with this order: description, `Agent: prospero-20`, the "Generated with Claude Code" line, then the note.

Change to the plan: state that order in step E3, and fill `model:` and `harness:` from the session (the model name and `claude --version`), not from a guess.

### A10. The new Distilled title leaves out half of what the pull request breaks

The plan's title, `feat(prisma)!: typed errors for the RoutingUrl refusals`, names one of the two changes. The other is the spec update to 2026-11-21, which removes `DomainOwnershipRequired` from `createWorkspaceDomainOwnership`, adds `Conflict` to `createWorkspace` and adds `state` to RoutingUrl outputs. The `!` is there partly for that. A title such as `feat(prisma)!: the 2026-11-21 spec, and typed errors for the RoutingUrl refusals` tells a reader what the `!` covers. Minor.

### A11. Project documents that become false

- `.drive/projects/public-urls/handover.md:40` describes the Distilled branch as filling `T.ResponseCode()` and adding `httpStatus`.
- `slices/u2-routing-url-resource/plan.md:25` and `:31` describe D1 as the `T.ResponseCode()` change and patch 006.
- `slices/u2-routing-url-resource/spec.md:41` describes the hazard of declaring a RoutingUrl and a DomainOwnership for one exact hostname only for an `unverified` row. After the change (without A03) it also covers a `verified` row the create returns.

Change to the plan: add a step that updates these three, and records the decision with Will's words and date.

### A12. Between the push and the description edit, both pull requests describe code that is gone

Step D pushes, and step E edits the descriptions afterwards, after a code review. Neither pull request is a draft, and Distilled's reports `MERGEABLE`. A maintainer who looks or merges in between sees an `httpStatus` example that no longer exists. Will's rule on this: a pull request whose state is not what its description says is marked draft until it is.

Change to the plan: edit each description in the same step as its push, right after it. If the gap cannot be avoided, mark the pull request draft before the push and ready after the edit. The owner's decision forbids replies; a description edit and a draft toggle are not replies, but confirm that reading with the orchestrator if in doubt.

### A13. Two checks in the steps are weaker than they look

- Step A5, `git diff upstream/main HEAD --stat`, compares two trees. `upstream/main` has already moved 10 commits past the branch; today that command lists 202 files. It is right only immediately after merging `upstream/main`. Use `git diff upstream/main...HEAD --stat`, which compares against the merge base and lists the branch's own changes.
- Step B1 regenerates the Prisma SDK on the pinned branch only on a conflict. A `management.ts` produced by `upstream/main`'s generator can cherry-pick cleanly and still differ from what `f0b37d720`'s generator emits. Regenerate on branch B every time, and check that the regenerated file equals the committed one.

### A14. The tests should keep the case that changes visible

Step C6 merges "accepts an unverified domain ownership the create returns with 200" and "refuses a verified domain ownership the create returns with 200" into one test that the resource owns what the create returns. The `verified` row is exactly the behaviour that changes. Keep a test with a `verified` row returned by the create, asserting the new outcome: owned (plan as written), or refused at the second look (A03). With A03, also add a test that a row appearing between the first look and the second is refused without `--adopt`, and that no create is sent.

"resends a create Prisma throttled, and owns the row it then creates" stays valid unchanged: `DeployRetry` retries `429` too. The plan does not mention it; say it stays.

### A15. The status never meant "this call created it" for a domain ownership

This supports Will's decision and may help his reply. In the control plane, the domain ownership repository's `create` catches the unique-constraint violation of a concurrent insert and returns the existing row, and the interactor reports it as created: "True when this call created the domain ownership, or lost a race to a concurrent create of the same one." So two exactly simultaneous creates both get `201`. The custom domain route has the mirror case: when Foundry answers `409` because a concurrent request registered the hostname, the loser gets `200`. The current Distilled description's claim that the status tells "whether a create made the resource or found it" was already imprecise.

Not caused by this change, and for the platform team rather than this plan: the custom domain `200` path returns before `recordCreatedCustomDomain`. If a first create registered the hostname in Foundry and then failed while recording it, a resend returns `200` and the platform's RoutingUrl row is never written. Before the change the same state was reached through `--adopt`, which also never records it.

### A16. Distilled contributor rules after the plan

Checked against the planned end state:

- Rule 10 (one change per pull request, no spec fix mixed with a runtime change): met once `packages/core` and `packages/dev` are back to `upstream/main`. What remains is the spec update and two patches, all in `packages/prisma`.
- Rule 9 (no tests for patches; ask before testing new runtime behaviour): met; the three core tests go with the runtime change.
- Rule 7 (evidence per patch): patch 005's description and patch 007 cite the published spec, which the rule accepts as "the provider's docs". The description says no live account was used; a reviewer may still ask for a real response for the five codes. Not changed by this plan.
- Rule 11 (`!`): justified, see A10.
- Rule 12 (stamp): `pnpm generate prisma` stamps `generatedAt`; commit it on both branches.
- Rule 17: see A09.

Alchemy's pull request conventions (no `#` or `##` headings, no test plan, minimal prose) are met by the planned edits, provided the added sentences stay to one each.

## Verdict

Build with these changes.

Required:

1. Rewrite decisions 2 and 3 with the correct premise and the ownership cases (A01, A02).
2. Name the retry policy correctly and record the evidence that both resends are safe (A05).
3. Disclose in the Alchemy description that the custom domain create is now resent, a change from `main` (A06).
4. Correct `claim`'s doc comment (A07).
5. Add the missing description corrections (A08), the rule 17 note order and values (A09).
6. Update `handover.md`, the slice `plan.md` and `spec.md` (A11).
7. Edit each description right after its push, or keep the pull request in draft in between (A12).
8. Use the three-dot diff in A5 and always regenerate on branch B (A13).
9. Keep a test for the `verified` row returned by the create (A14).

Recommended:

10. Look again just before the create in `Prisma.DomainOwnership`, and optionally in `Prisma.CustomDomain` (A03).
11. Cite the Typed Error Doctrine as the reason decision 3's alternative is rejected, and do not mention `createAppDomain` in the description (A04).
12. Name the spec update in the Distilled title (A10).
