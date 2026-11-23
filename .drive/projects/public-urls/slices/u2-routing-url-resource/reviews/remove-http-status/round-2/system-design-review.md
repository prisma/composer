# System design review: remove the HTTP status (round 2)

Date: 2026-11-23. Pass: system design (architect). It checks the round-1 findings and the rewritten texts. The round-1 review is `../round-1/system-design-review.md`.

## What is under review

| Repository | Branch | Tip | New since round 1 |
| --- | --- | --- | --- |
| Distilled, alchemy-run/distilled#1348 | `feat/prisma-routing-urls` | `a1303d00f` | patch 005's description |
| Distilled, the branch Alchemy pins | `feat/prisma-routing-urls-on-alchemy-pin` | `bede8e687` | the same patch 005 description |
| Alchemy, alchemy-run/alchemy#3529 | `feat/prisma-domain-ownership-status` | `27f4f54f87` | `CustomDomain.ts`, `DomainOwnershipProof.ts`, two test files, submodule pin to `bede8e687` |

Texts, local only: `pr-bodies/distilled.md`, `pr-bodies/alchemy.md`, `handover.md`, the slice `plan.md` and `spec.md`. New Distilled title: `feat(prisma)!: type the RoutingUrl refusals, on the 2026-11-21 spec`.

## What I read

- `git show 27f4f54f87` in full; `git diff 4cf818dc0e 27f4f54f87 --stat`.
- `git diff 749d8b146 a1303d00f` (patch 005's description only). Patch 005's matchers, to check the description's "as patch 005 does" (it matches on `/error/code`).
- The three constraint checks again at the new tips (below).
- Alchemy `main`'s `CustomDomain.ts` create call and `Client.ts` retry rules (`retryTransient`, `isRetryablePost`, `isRetryableStatus`), to check what the descriptions say about `main`.
- The control plane's custom domain create handler at `236c1e63e` (`services/management-api/routes/v1/services.ts` around lines 1625 to 1790), to check that a create refused for DNS or ownership registers nothing. It does: the ownership check comes before registration, and "DNS is not configured" is Foundry's `400` from `registerDomain`, which registers nothing.
- Both rewritten descriptions line by line; `handover.md` lines 24, 40 and 41; the slice `plan.md` lines 25 and 31; the slice `spec.md` line 41; the plan's decisions 2 and 3 and "What Will told the maintainer".
- Distilled `CLAUDE.md` rule 17 for the agent note.

## Round-1 findings

| Finding | Status |
| --- | --- |
| S01, the window | Fixed for `Prisma.CustomDomain` as I meant. Fixed differently for `Prisma.DomainOwnership`: no code change, the window is stated. I agree with that. The `Prisma.CustomDomain` description still understates its window (S08). The plan's decisions 2 and 3 still say "one request"; that is an internal document, so it does not block the push. |
| S02, `registeredDuringDnsWait` | Fixed as I meant: `foundAfterDnsWait` in both resources. |
| S03, `withoutRetriedCreate` | Fixed: renamed `resendOnlyThrottled`, and the comment now gives the real reason, that Alchemy's own client never resent this create. The comment still says "harmless" without naming the risk. That is acceptable. |
| S04, description sentences | The listed sentences are fixed. The rewrite added three new problems: S08, S09, S10. |
| S05, "was not created by this resource" | Fixed as I meant: "is not recorded by this resource". |
| S06, project files | Fixed. `handover.md` lines 24, 40 and 41, `plan.md` lines 25 and 31, and `spec.md` line 41 are now true of the code. |
| S07 | Deferred, unchanged. |

### S01 for `Prisma.DomainOwnership`: I agree with no code change

The resends are inside one SDK call (Alchemy's deploy retry policy), so no look can be placed between them without taking resending away from the SDK. Even if one could, a look before a resend after the spec's `503` ("saved with its status… Retry the request") would find the stack's own `verified` row, and `claim` would refuse it. That would bring back the defect the plan removed when it dropped the no-resend policy from this create. Stating the window is the right answer. `alchemy.md` line 84 states it correctly: "between the second look and the end of the create, including resends after a `5xx`".

### S01 for `Prisma.CustomDomain`: the fix

`createUnlessFound` (`CustomDomain.ts` lines 341 to 347) looks for the hostname and refuses a row it finds, then creates. The outer `Effect.retry` on `DomainDnsNotConfigured` and `DomainOwnershipRequired` now repeats both, so every attempt is preceded by a look. A refused attempt registers nothing (control plane, above), so the look before the next attempt cannot find the stack's own row. The retry's `while` names only those two errors, so the new refusal and the list errors are not retried. What remains is the time from a look to its attempt's answer, including `resendOnlyThrottled`'s resends after a `429`. A `429` registers nothing either.

## The fix commit at the design level

No new problems.

- **Placement.** The look is now in the step the retry repeats, which is where a guarantee about "before the create" has to live. The CNAME check stays in `if (!domain)` and runs once. `createUnlessFound` is defined unconditionally but is only run in the `!domain` branch, because an Effect is lazy. This follows the reconciler doctrine's "observe, then ensure".
- **Naming.** `foundAfterDnsWait` is true in both resources: every look in `createUnlessFound` runs after the CNAME wait, including the looks on later attempts. It names the look, not where the row came from, so it stays true when a recorded custom domain has disappeared. `createUnlessFound` says what it does. `resendOnlyThrottled` says what it does.
- **One ownership rule per resource.** Unchanged from round 1. `Prisma.DomainOwnership`: a row found by any look goes through `claim`, and a row the create returns is owned. `Prisma.CustomDomain`: a row found by any look in `reconcile` is refused, adoption goes through `read` on the next deploy, and a row the create returns is owned.
- **Tests.** The new tests prove four properties: the look before the second attempt refuses a row registered after the first; a throttled create is resent and owned; a row registered before the deploy needs `--adopt` through `read`; and an `unverified` row found at the second look is taken without `--adopt`. Together with the round-1 tests, every row of the round-1 ownership tables now has a test, except the case where a recorded custom domain has disappeared.

## The three constraints at the new tips

- **No HTTP status handling in the Distilled pull request.** Met. `git diff upstream/main...feat/prisma-routing-urls` touches 5 files, all in `packages/prisma/`, with 0 matches for `httpStatus` or `ResponseCode`. The pinned branch: 5 files, 0 matches, and patches identical to branch A. The new description and title do not mention a status member, except the sentence that says it was removed.
- **No API or spec change.** Met. The only new Distilled change is patch 005's description text. It now says the create returns the row `verified` or `unverified`, which matches the published spec.
- **The information is dropped, not fetched another way.** Met. No resource code in Alchemy uses `httpStatus`, calls `createAppDomain` or reads a raw response. The new look follows a refused attempt and precedes the next create. It does not tell "created" from "already existed" for a successful create, so it is not the "lookup after the create" that decision 1 rejects.

## Findings

### S08. `alchemy.md` line 70 says the throttling resend is "as on `main`", and calls the window "one request"

In scope. Must be fixed before the description is posted.

Text: "A row that another actor on the same app registers during that one request is taken as the resource's own. As on `main`, the create is resent only when Prisma throttled it."

What is wrong:

- On `main` this create is never resent, not even after a `429`. `main`'s `Client.ts` retries a `POST` only when the path ends in `/start`, `/stop`, `/promote` or `/rollback` (`isRetryablePost`), and `main`'s `CustomDomain.ts` retries only on DNS not configured. The code's own comment on `resendOnlyThrottled` says this correctly ("Alchemy's own client never resent this create"). So resending after a `429` is a second change from `main`, and the sentence says the opposite.
- Because of those resends, the window is not "that one request". It runs from the look to the create's answer, including up to 8 resends after throttling.

Change: replace the two sentences with something like: "A row that another actor on the same app registers between that look and the create's answer is taken as the resource's own. On `main` the create is never resent; it is now resent when Prisma throttles it, which saves nothing, and those resends are part of that window."

### S09. `alchemy.md` line 70 implies `--adopt` lets the look take the row

In scope.

Text: "…looks for the hostname again directly before each create attempt and refuses a row it finds without `--adopt`."

What is wrong: `reconcile` refuses a row its look finds whether or not `--adopt` is set. Adoption for `Prisma.CustomDomain` happens only in `read`, on a later deploy: `read` returns the row as `Unowned`, and the engine takes it when `--adopt` is set. A reader of "refuses a row it finds without `--adopt`" expects a deploy run with `--adopt` to take the row at once. It does not. That differs from `Prisma.DomainOwnership`, whose looks do honour `--adopt`, so the same wording in the two paragraphs means two different things.

Change: "…refuses a row it finds as already existing; a later deploy with `--adopt` takes it over."

### S10. `distilled.md` line 44 points at a discussion that is not in the description

In scope.

Text: "That is removed, as discussed below."

What is wrong: nothing below line 44 discusses the removal. Only the checks, the agent line and the note follow. The discussion is in the pull request's comments. A maintainer reading the description finds nothing "below".

Change: "That is removed, as discussed in this pull request's comments." Or end the sentence at "That is removed." The rest of the sentence matches Will's reply: the handling is removed and nothing replaces it.

## Line-by-line check of the rewritten descriptions

### `distilled.md`

- Line 1 and the example (lines 3 to 14): true. The example shows four of the five errors; the fifth (`RoutingUrlServiceOnAnotherBranch`) is on `updateUrl`, which the example does not call. Fine.
- Line 16: true as a description of the Alchemy pull request's contents.
- Lines 20 to 28: true; the table matches patch 007's matchers and the spec.
- Line 30: true. It now matches the spec: the create returns the row `verified` or `unverified`.
- Line 32: "Evidence for both": true.
- Lines 36 to 40: true. Patch 005 does match on `/error/code`, so "as patch 005 does" holds. The diff touches only `packages/prisma`.
- Line 42 (breaking): true. `!` is still justified.
- Line 44: S10. Otherwise consistent with Will's reply.
- Line 46 (checks): a claim about runs this pass does not check.
- Lines 48 to 57: the order (agent line, Claude Code line, then the note) puts the note last, as rule 17 requires. The note's fixed text matches the rule's template character for character, with `@wmadden` in both places. `model: fable 5.2` matches the `Co-Authored-By` of the commits. I could not check the harness version (`Claude Agent SDK 0.3.330`): there is no `claude` command on this machine's path.

### `alchemy.md`

- Lines 1 to 57 (RoutingUrl, Website): not touched by this change. Nothing in them depends on the status. Line 21's "the resource never creates or deletes one" is about `Prisma.RoutingUrl` and stays true.
- Line 68: true.
- Line 70: S08 and S09. The rest is true: the resource reads no status, no longer refuses a `200`, and only an actor on the same app can be inside the window, because another app gets `409`, which is still refused.
- Line 82: true of Prisma. The resource itself creates only after the record resolves, as its JSDoc says.
- Line 84: true at the tip. It states both looks, the rule for a found row, the window including resends after a `5xx`, and the shared-row consequence. "Which grants nothing" repeats the premise of S07, which is deferred.
- Line 86: true.
- Line 88: true. The submodule pin `bede8e687` is the pinned branch's tip, built on `f0b37d720`, which is what Alchemy's `main` pins.
- Lines 90 to 95 (alternatives): true. Line 93's harm ("a preview's destroy could remove production's proof") can still happen for `Prisma.DomainOwnership` inside its window, and line 84 now says so.

## Verdict

The code is ready to push. The Distilled description is ready once S10 is fixed. The Alchemy description must have S08 and S09 fixed before it is posted, because both describe behaviour the code does not have, and S08 contradicts the code's own comment. All three are text changes. None needs another code review.

## What I could not verify

- The harness version in the Distilled agent note.
- That production's control plane matches the local checkout at `236c1e63e`. The claim that a refused custom domain create registers nothing rests on it.
- No checks or tests were run in this pass.
- The live GitHub texts, since no credentials were used. I reviewed the local files that will be posted.
