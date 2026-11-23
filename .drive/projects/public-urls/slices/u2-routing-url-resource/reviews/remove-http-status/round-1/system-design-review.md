# System design review: remove the HTTP status (round 1)

Date: 2026-11-23. Pass: system design (architect). Not covered here: the code-review pass, the walkthrough, the synthesis.

## What is under review

| Repository | Branch | Tip | Range |
| --- | --- | --- | --- |
| Distilled (`wip/u2/distilled`), alchemy-run/distilled#1348 | `feat/prisma-routing-urls` | `749d8b146` | `upstream/main...HEAD` (merge base `f93e2d0db`, which is `upstream/main`'s tip) |
| Distilled, the branch Alchemy pins | `feat/prisma-routing-urls-on-alchemy-pin` | `58f840de1` | `f0b37d720..HEAD` |
| Alchemy (`wip/u2/alchemy`), alchemy-run/alchemy#3529 | `feat/prisma-domain-ownership-status` | `4cf818dc0e` | `upstream/main...HEAD`, limited to `packages/prisma/`, `packages/integration-tests/test/Prisma/`, `submodules/distilled` and their docs |

New since the tenth round: Distilled `cf9d76cc8` (core and generator back to `main`) and `749d8b146` (patch 006 deleted, SDK regenerated); pinned branch `58f840de1`; Alchemy `4cf818dc0e` (second look before each create, status checks removed, `withoutRetriedCreate` moved). Each branch also merged its base.

## What I read

- The plan `remove-http-status-plan.md` in full, and both plan reviews (`reviews/remove-http-status/architect.md`, `principal-engineer.md`) in full.
- The slice `spec.md` (searched for domain ownership and adoption statements), `handover.md` and the slice `plan.md` (searched for the removed pieces).
- Distilled `CLAUDE.md` (contributor rules 1 to 18). Alchemy `AGENTS.md` (concepts, reconciler doctrine, Typed Error Doctrine, testing conventions, pull request conventions). The composer repository's `.drive/CODE-REVIEW.md` (jargon sweep), applied to the text in these diffs.
- Distilled: `git diff upstream/main...HEAD --stat` and the full diffs of patch 005, patch 007, `package.json` and the spec mirror pointer; a skim of the generated `management.ts` diff; both new commits; the pinned branch's commit list, its diff stat against `f0b37d720`, its generated `management.ts` (the five RoutingUrl error classes, no `httpStatus`), and a byte comparison of its `patches/` with branch A's (identical) and its spec mirror pointer (identical, `e48eb8d`). Checked that `errorMatchers` with body pointers and `distilled.errors#categories` already exist on `upstream/main` (`core/src/trait.ts`, `dev/src/codegen/generator.ts`, `openapi.ts`).
- The Prisma spec in the mirror: the `POST` on `/v1/services/{serviceId}/domains` and on `/v1/workspaces/{workspaceId}/domain-ownerships`, with every response description.
- Alchemy: the full diff of `4cf818dc0e`; `internal/DomainOwnershipProof.ts` in full; `CustomDomain.ts` from `findDomain` to the end; `DomainOwnership.ts` in full; `submodules/distilled/packages/prisma/src/retry.ts` (`Retry.policy` replaces the ambient policy for the wrapped call only). `git grep` over `packages/prisma`, `packages/integration-tests/test/Prisma` and `website/src/content/docs` for `httpStatus`, `withoutRetriedCreate`, `createAppDomain` and `201`. `grep -c httpStatus` in the submodule's `src/services/management.ts` and `lib/services/management.d.ts` (0 in both).
- Both pull request descriptions as kept locally (`pr-bodies/distilled.md`, `pr-bodies/alchemy.md`).
- The control plane's custom domain create handler, local checkout `/Users/wmadden/Projects/prisma/pdp-control-plane` at `236c1e63e` (2026-11-18), `services/management-api/routes/v1/services.ts` around lines 1600 to 1700, to check the order of the `200` path and the ownership check. This is not necessarily what runs in production.

## What the change does, in system terms

Before: the Distilled SDK carried the create's HTTP status as an output member (`httpStatus`), filled by a new core protocol feature, and Alchemy used it to decide ownership of the row a create returned: `201` meant "mine", `200` meant "found, apply the adoption rule".

After: the concept "the create's status" is gone from both systems. Distilled's change shrinks to a spec update plus two patches in `packages/prisma`. Alchemy replaces "ask the create who made the row" with "look for the row again immediately before the create". The new invariant both resources now state is: a row the resource finds before its create goes through the adoption rule; a row a successful create returns is the resource's own.

No new type, module, prefix or layer is introduced. One helper moves (`withoutRetriedCreate`, from `internal/DomainOwnership.ts` into `CustomDomain.ts`), one closure is added (`claimUnrecorded`), and two local names are added (`createdDuringDnsWait`, `registeredDuringDnsWait`).

## Answers to the five questions

### 1. The ownership rule after the change

Alchemy has no ownership marker on these rows. A row is the stack's own when the stack's state records its ID. The other ways in are:

`Prisma.DomainOwnership`:

| Where the row is met | Rule |
| --- | --- |
| `read`, recorded ID still exists | owned |
| `read`, found by domain | owned if `unverified`; otherwise `Unowned`, so the engine needs `--adopt` |
| `reconcile`, first look (recorded and same domain) | owned |
| `reconcile`, first look by domain, and second look by domain | `claim`: owned if `unverified` or `--adopt`; otherwise refused |
| returned by the create, including after a resend by the deploy retry policy | owned, whatever its status |
| `delete` | deletes the recorded ID |

`Prisma.CustomDomain`:

| Where the row is met | Rule |
| --- | --- |
| `read`, recorded ID | owned |
| `read`, found by hostname | `Unowned`, so the engine needs `--adopt` |
| `reconcile`, first look by recorded ID | owned (identity checked) |
| `reconcile`, first look by hostname, and second look by hostname | refused ("already exists"); adoption goes through `read` on the next deploy |
| returned by the create | owned |
| `delete` | deletes the recorded ID, unless a RoutingUrl has set a `logicalId` on the hostname |

This is one coherent rule per resource: "found" rows go through the adoption rule, a row the create returns is owned. The two resources differ in where adoption happens (in `reconcile` through `claim` for DomainOwnership, in the engine through `read` for CustomDomain). That difference predates this change and is not made worse by it.

Every remaining case where two owners record one row:

1. **The time between the second look and the create's success.** This is not one request (see S01). For CustomDomain it includes the outer retry on `DomainDnsNotConfigured` and `DomainOwnershipRequired` (up to 6 resends, 5 seconds apart) and the throttling resends. For DomainOwnership it includes the deploy retry policy's resends after a `5xx` or a dropped connection.
2. **Two creates at the same moment.** Prisma answers both with `201` (domain ownership repository) or answers the loser with `200` (custom domain, Foundry `409` race). Platform behaviour; unchanged.
3. **An `unverified` domain ownership taken without `--adopt`**, by `read` or by `claim`, which this stack's own verify then turns `verified` while another stack also records it. See S07, deferred.
4. **An explicit `--adopt`** of a row another stack records. By design.
5. **An exact-hostname `Prisma.DomainOwnership` beside a `Prisma.RoutingUrl` for the same hostname.** A documented misuse; the window in item 1 adds one more timing for it.
6. **`Prisma.CustomDomain` beside a `Prisma.RoutingUrl` on the same hostname.** The delete guard keeps the row. Unchanged.

### 2. The second look, its placement and its names

Placement is right in both resources. In `Prisma.DomainOwnership` the second look runs after the record check and only when the first look returned nothing (`existing ? undefined : …`). In `Prisma.CustomDomain` it sits inside `if (!domain)`, after the CNAME check, so it runs only when the first look found nothing. Both are observations before the ensure step, as the reconciler doctrine asks, and neither reads the create's answer, so decision 1 holds.

`claimUnrecorded` reads correctly cold: "apply `claim` to a row this resource has not recorded". It is a closure because it needs the recorded ID, which is reasonable. `claim` itself is a check that may refuse, not an action; the name predates this change and is acceptable.

`createdDuringDnsWait` is accurate in DomainOwnership: the first look always searched by domain, so a row found only by the second look appeared in between. `registeredDuringDnsWait` is not always accurate in CustomDomain; see S02.

### 3. `withoutRetriedCreate` in `CustomDomain.ts`

The placement is right: it has one user, and its old home (`internal/DomainOwnership.ts`) now holds nothing about creates. The stated reason is literally true (the spec's `200` says only "already registered on this service") but it does not name the risk, and it omits the reason the plan actually gives (Alchemy `main` never resends this create). The name also contradicts what it does. See S03.

### 4. Is the Distilled branch exactly a spec fix?

Yes. `git diff upstream/main...HEAD --stat` lists five files, all in `packages/prisma/`: `package.json` (spec date), patches 005 and 007, the spec mirror pointer (`fc91281` to `e48eb8d`), and the generated `management.ts`. `grep -c -i "httpStatus\|ResponseCode"` over that diff is 0. `packages/core` and `packages/dev` equal the merge base. This meets Distilled rule 10 (no runtime change mixed with a spec fix) and rule 9 (the three core tests are gone with the feature).

Neither remaining patch depends on what was removed. Patch 005 now only drops `DomainOwnershipRequired` from `createWorkspaceDomainOwnership`; its description says why. Patch 007 uses status-plus-body error matchers and error categories, which `upstream/main` and `f0b37d720` both support; the pinned branch's generated SDK contains all five RoutingUrl error classes with their categories.

The pinned branch has the same tree in `packages/prisma/patches/` and the same spec mirror commit as branch A, and its diff against `f0b37d720` is also limited to `packages/prisma/`. Its tip commit both reverts core and deletes patch 006 in one commit, which is fine because it is not a pull request head.

The patch numbers now skip 006. `upstream/main` already skips 002, patches apply in filename order, and the audit counts files, so no renumbering is needed.

### 5. The three constraints in "What Will told the maintainer"

- **No HTTP status handling in the Distilled pull request:** met in the code (question 4). Not yet met in the title and description, which still describe `httpStatus` (S04).
- **No API or spec change:** met. No commit edits Prisma's spec; the mirror moves to a newer published commit, as the plan says. No patch adds an output member; patches 005 and 007 only add or remove error shapes.
- **The information is dropped, not fetched another way:** met. Neither resource calls `createAppDomain` (it stays as a public operation in `Client.ts`, unused by the resources), reads a raw response, or looks the row up after the create. The two new looks are before the create, which decision 1 allows. `verifyOwnership` after the create asks about verification status, not about who made the row.

## Findings

### S01. The remaining window is wider than "one request", and part of it can be closed cheaply

In scope.

Where: `packages/prisma/src/CustomDomain.ts` lines 339 to 367 (the second look, then the create with its throttling policy and its outer `Effect.retry`); `packages/prisma/src/internal/DomainOwnershipProof.ts` lines 246 to 250 with the deploy retry policy from `Providers.ts`. Plan decisions 2 and 3, which say "the one request between the second look and the create".

What is wrong: the second look happens once. The create after it can be sent many times:

- CustomDomain: after `DomainDnsNotConfigured` or `DomainOwnershipRequired`, the outer retry sends the create again up to 6 times, 5 seconds apart. In the control plane at `236c1e63e` the `200` path (the hostname is already on this app) runs before the ownership check and before registration, so a hostname another actor registers on the same app during those 30 seconds comes back with `200` and is owned. The throttling policy adds up to 8 more resends.
- DomainOwnership: after a `5xx` or a dropped connection that saved nothing, the deploy retry policy resends for up to about 23 seconds, longer with `Retry-After`. A row another stack creates in that time comes back with `200` and is owned, and that row is normally `verified` (the first plan review's A01). This is the shared-proof harm the Alchemy description's own alternatives section names.

The architect's plan review (A03) pointed out the CustomDomain outer retry window and asked for it to be stated. The revised plan dropped it.

Why it matters to the design: the resource's guarantee is "a row found before the create goes through the adoption rule". The honest statement of the residual is "from the second look until the create succeeds, including its resends", not "one request".

Change:

1. CustomDomain: move the second look into the effect the outer retry repeats, so each attempt is preceded by a look: `findDomain`, refuse if found, else `createServiceDomain`, all inside the `Effect.retry` on `DomainDnsNotConfigured` and `DomainOwnershipRequired`. This closes the 30-second part. It is still a look before the create, so decision 1 holds.
2. For the resends inside one SDK call (throttling for CustomDomain, the deploy policy for DomainOwnership), no look can be put in between. State the window in the plan's decisions 2 and 3, in the Alchemy description, and wherever the window is described: "from the look just before the create until the create succeeds, including the client's own resends".

### S02. `registeredDuringDnsWait` names a history the code does not know

In scope.

Where: `packages/prisma/src/CustomDomain.ts` lines 339 to 342.

What is wrong: when the state records a `customDomainId` whose row is gone, the first look is `getCustomDomain(customDomainId)` and does not search by hostname. The second look then searches by hostname for the first time, so a row it finds may have been registered long before this deploy. The name says it appeared during the DNS wait. In DomainOwnership the same name is true, because its first look falls back to a search by domain. So the two sibling names look symmetric but carry different guarantees.

The behaviour is right in that case (a foreign row is refused as "already exists", which is what `main`'s `200` check did there). Only the name misleads a reader who later reasons about the window.

Change: name what the code knows, the same way in both resources, for example `foundAfterDnsWait` in both, or `foundBeforeCreate`. The test-fake fields of the same names describe what the fake simulates and can stay.

### S03. `withoutRetriedCreate` says the opposite of what it does, and its reason names no risk

In scope.

Where: `packages/prisma/src/CustomDomain.ts` lines 221 to 228.

What is wrong:

- Read cold, `withoutRetriedCreate(createServiceDomain(…))` says "this create is not retried". It is retried, up to 8 times, on throttling. The name was coined when its purpose was "never resend a request Prisma may have processed"; now that the only remaining purpose is to keep `main`'s behaviour, the name is the only description most readers will see.
- The comment's reason is "Prisma's spec does not say a resent create is harmless". It does not say what harm is feared, so a later reader cannot judge when it stops being true. The plan's own reason, and the principal-engineer plan review's suggested text, is that Alchemy `main` never resends this create, the spec does not say whether a resend repeats certificate or registration work, and the resource is deprecated. The first plan review found from the control plane source that the `200` path is a pure read; the comment should not imply a risk that evidence contradicts without saying so.

Change: rename to what it does, for example `resendOnlyThrottled`, and give the reason in one sentence, for example: "Alchemy's own client never resent this create, and Prisma does not say whether a resend repeats certificate work, so only a throttled request, which Prisma refused, is resent." The placement in `CustomDomain.ts` is right; keep it.

### S04. Pull request descriptions: sentences the built code makes false

In scope (plan step E; must be corrected in the same step as each push, per plan D2).

Distilled (`pr-bodies/distilled.md`):

- Line 1: "Two things … whether a create made the resource or found it, and which refusal it got." Only the refusals remain.
- Lines 6 to 8: the `httpStatus` example.
- Line 25: the paragraph "A create that answers 201 or 200 with the same body".
- Line 39: "Evidence for all three" (now two).
- Lines 43 to 45: the `core/protocol-rest`, `dev/codegen` and patch 006 bullets.
- Line 50: the paragraph on the status of the last attempt.
- Line 52: "The core change breaks nothing."
- Line 54: the three new core tests.
- Lines 58 to 62: the whole "Alternatives considered" section, which is only about the status.
- The text does not end with the rule 17 note (plan step E3).
- I could not read the live title (no credentials used). If it still names the status, it needs the plan's E1 title.

Alchemy (`pr-bodies/alchemy.md`):

- Line 80: "One it did not create needs `--adopt` once it is `verified`". The code's rule is: one it finds before its create needs `--adopt` unless it is `unverified` (so `expiring` too); one the create returns is owned. Add the window from S01.
- Line 82: "Prisma now creates it as `unverified` at once." False: the create returns it `verified` when the TXT record already resolves.
- Line 68: true but now incomplete. It should add the change from `main`: a create answering `200` no longer fails; a row found just before the create is refused as "already exists"; and the window that remains (S01).
- Nothing says the domain ownership create is now resent by Alchemy's deploy retry policy, as Prisma's spec asks after a `503`, while the custom domain create is not, as on `main` (plan E4).
- Line 89 (alternatives): the harm it names, "a preview's destroy could remove production's proof", can still happen for `Prisma.DomainOwnership` inside the window. One clause there or under line 80 should say so.

### S05. `claim`'s refusal says "was not created by this resource", which the code cannot know

In scope.

Where: `packages/prisma/src/internal/DomainOwnershipProof.ts` line 145.

What is wrong: the resource does not track who created a row, only whether its state records the ID. The message is false in a case that remains after this change: the create saved the row, every resend of the reply failed, and the next deploy finds its own `verified` row and is told it "was not created by this resource". The doc comment above `claim` was corrected to "finds before its create, and did not record"; the message was not.

Change: say what the code knows, for example "is '<status>' and is not recorded by this resource".

### S06. Project files still describe the status

In scope for this slice, outside both pull requests (plan step F).

- `.drive/projects/public-urls/handover.md:24`: "Create always succeeds and returns the row, `unverified` until DNS lookup finds the TXT record." The create returns it `verified` when the record is found at once.
- `handover.md:40`: the Distilled branch "fills `T.ResponseCode()`" and adds `httpStatus`.
- `handover.md:41`: DomainOwnership "retries creates only on 429". It now uses the deploy retry policy.
- Slice `plan.md:25` and `:31` (D1): `T.ResponseCode()` and patch 006.
- Slice `spec.md:41`: DomainOwnership "takes over an `unverified` row it finds by domain". It also owns any row its create returns, in the window from S01.

### S07. The "an `unverified` row grants nothing" premise ignores what happens next (deferred)

Deferred: this predates the change, and taking an `unverified` row without `--adopt` was Will's decision recorded in `handover.md:41`. Raised so the remaining two-owner cases are complete, not for these pull requests.

Where: `internal/DomainOwnershipProof.ts` lines 136 to 147 (`claim`) and 202 to 207 (`read`).

The rule judges harm by the row's status at the moment it is taken. The harm that matters is on destroy, and it depends on whether another stack also records the row, which status does not show. A row taken while `unverified` is then verified by this deploy, and if another stack also took or created it, the first destroy deletes the proof the other relies on. The cases are narrow (a Console-made row, a create Prisma's resolver missed, the RoutingUrl misuse). Revisit only if Will wants the adoption rule to cover them.

## Jargon sweep (`.drive/CODE-REVIEW.md`)

Text added in this round, in code comments, test names and commit messages, reads plainly. The two issues are the misleading name and comment in S03 and the error text in S05. Test names now describe what happens ("refuses a verified domain ownership that appears during the DNS wait, and sends no create", "owns the custom domain the create returns") rather than the status, as the principal-engineer plan review asked.

## Test strategy at the architectural level

The architectural property is "the same adoption rule applies to a row whatever look finds it, and a row the create returns is owned". The tests prove it: a `verified` row appearing at the second look is refused without `--adopt` and taken with it, with no create sent; a `verified` row returned by the create is owned and deleted on destroy (the case that changed, kept as the first plan review asked); a lost reply is resent and owned. CustomDomain has the matching pair. Two cases are not pinned: the CustomDomain second look after a recorded row has disappeared (S02), and the outer-retry window (S01). If S01's change 1 is made, a test where the row appears between two `DomainDnsNotConfigured` attempts would pin it.

## Verdict

The design is coherent and matches the plan. The Distilled branch is a clean spec fix with nothing left of the runtime or generator change, and all three constraints from Will's reply hold in the code. The second look is in the right place and follows the reconciler doctrine. Fix S01 to S05 before the pushes; S06 with plan step F; S07 is deferred.

## What I could not verify

- The live titles and descriptions on GitHub, since no credentials were used. I reviewed the local copies.
- That production's control plane matches the local checkout at `236c1e63e`, which S01's CustomDomain reasoning relies on.
- No checks or tests were run in this pass.
