# Code review: remove the HTTP status (round 2)

Date: 2026-11-23. Pass: code review (principal engineer). No system-design pass, walkthrough or synthesis in this file. Round 1: [../round-1/code-review.md](../round-1/code-review.md).

Under review, local and not pushed:

- Alchemy `wip/u2/alchemy`, `feat/prisma-domain-ownership-status`, tip `27f4f54f87`. New since round 1: `27f4f54f87` (`CustomDomain.ts`, `internal/DomainOwnershipProof.ts`, the two test files, the submodule pin to `bede8e687`).
- Distilled `wip/u2/distilled`, `feat/prisma-routing-urls`, tip `a1303d00f`; and `feat/prisma-routing-urls-on-alchemy-pin`, tip `bede8e687`. Each new commit changes only patch 005's `description`.
- The rewritten descriptions `pr-bodies/distilled.md` and `pr-bodies/alchemy.md`, and the updated `handover.md`, slice `plan.md` and `spec.md`.

Expectation sources as in round 1: `remove-http-status-plan.md`, its two reviews, Distilled `CLAUDE.md`, Alchemy `AGENTS.md`.

## Summary

Every round-1 code finding is fixed, and each fix is covered by a test that fails when the fix is broken. The code is ready. Both pull request descriptions still have a few false or misleading sentences. The Alchemy one says `main` resent a throttled custom domain create; `main` never resent it. Fix the description text before pushing.

## What looks solid

- `Prisma.CustomDomain` now looks before every create attempt. `createUnlessFound` (`CustomDomain.ts` lines 341–347) is `findDomain`, a refusal if found, then the create with `resendOnlyThrottled`. The outer retry wraps the whole of it. Paths through the outer retry, read from the code:

  | What the attempt gets | What happens |
  |---|---|
  | `findDomain` finds the hostname on the app | fails with `PrismaCustomDomainAdoptionRequired` "already exists". The tag is not in the retry's `while` and not in `catchTags`, so it ends the deploy at once. |
  | `429` | `resendOnlyThrottled` resends the create alone, up to 8 times, 1 s doubling to 5 s, with server hints. No new look before a throttled resend (see F07). |
  | `DomainDnsNotConfigured` (`400` "DNS is not configured") | retried after 5 s, up to 6 times; each retry starts with a new `findDomain`. |
  | `DomainOwnershipRequired` (`422`) | retried the same way; after the last attempt it maps to `PrismaDomainOwnershipRequired`. |
  | `Conflict` (`409`, the hostname is on another app) | not retried; maps to "appeared after the adoption check". |
  | `findDomain` sees two rows for the hostname | `CustomDomainConflict`, not retried. |
  | A transient failure of the `findDomain` `GET` | resent by the deploy policy, which still applies to the `GET` because `resendOnlyThrottled` wraps only the create. |
  | Success (`200` or `201`) | `response.data`, then `identityMatches`, then owned. |

- Nothing else in `reconcile` changed behaviour. `createUnlessFound` is only built as a value; it runs only on the `!domain` branch. A row found by recorded id still goes to `createDomainRetry` when `failed`, or is used as it is.
- The look now also runs when the stack has a recorded id whose row is gone. That was already true at `4cf818dc0e`, where the look sat inside `if (!domain)`. It does not matter. A row for the same hostname is refused as "already exists" without sending a create. On `main` the same case sent the create, got `200`, and was refused with "was returned as already registered". The outcome is the same, with one request fewer.
- `Prisma.DomainOwnership`: the only code change is the renamed variable and the refusal message ("is not recorded by this resource", which is what the code knows). No look before a resend, as advised in round 1.
- Patch 005's description on both branches now says the create returns the row "`verified` when its TXT record already carries the workspace's value and `unverified` otherwise". `git diff a1303d00f bede8e687 -- packages/prisma/patches packages/prisma/specs` is empty. Both commits fast-forward their branches. `pnpm generate prisma` on A leaves the tree unchanged. The three-dot diff from `upstream/main` still lists only five files under `packages/prisma/` and contains no `httpStatus` or `ResponseCode`.
- The submodule is at `bede8e687`, clean, and neither its `src/` nor its built `lib/` has `httpStatus`.
- `oxlint` on `packages/prisma/src`, `oxfmt --check` on the four changed files, and `tsrs -b` on the Prisma and integration-test projects are clean.
- Project files: `handover.md`, the slice `plan.md` and `spec.md` now describe the change correctly. `handover.md` still states that Prisma's create answers `201` or `200`. That is a true fact about the API, not a description of the SDK.

## Status of round-1 findings

| Finding | Status | Evidence |
|---|---|---|
| F01, `Prisma.CustomDomain` | Fixed as suggested | Look inside the outer retry. Test "looks again before each create Prisma refused for DNS…": the first create answers `400` while the hostname is registered; asserts failure "already exists" and exactly one `POST`. Break R1 fails it. |
| F01, `Prisma.DomainOwnership` | Fixed as suggested | No look before a resend. `alchemy.md` states the window as "between the second look and the end of the create, including resends after a `5xx`". |
| F02 | Fixed | Test "resends a create Prisma throttled, and owns the custom domain it then returns": `429` once, then `200`. Asserts the id, two `POST`s and the `DELETE`. Break R2 fails it. |
| F03 | Fixed | Test "takes over an unverified domain ownership that appears during the DNS wait…". Asserts id `do-raced`, `verified`, no `CREATE`, exactly one verify on `do-raced`, and the `DELETE`. Break R4 fails it. |
| F04 | Fixed (refusal only) | Test "refuses a custom domain registered before the deploy, without --adopt…". Asserts "Cannot adopt resource" and no `POST`. Break R3 fails it. The `--adopt` counterpart I called optional was not added; that is acceptable. |
| F05 | Fixed | Both branches, identical text; see above. |
| F06 | Done locally | Descriptions and project files rewritten. Remaining errors are F07 and F08. |

## Findings

### F07. Three sentences in the Alchemy description's `Prisma.CustomDomain` paragraph are false or misleading

- **Location:** `pr-bodies/alchemy.md`, the paragraph that begins "One behaviour changes from `main`."
- **Issue:**
  1. "As on `main`, the create is resent only when Prisma throttled it." This is false. `main`'s client never resends `POST /v1/apps/{id}/domains`, not even after a `429`: `retryTransient` resends a `POST` only for `/start`, `/stop`, `/promote` and `/rollback` (`upstream/main:packages/prisma/src/Client.ts` lines 484–505). The code's own comment on `resendOnlyThrottled` says so: "Alchemy's own client never resent this create". Resending on `429` is new in this pull request.
  2. "A row that another actor on the same app registers during that one request is taken". The window is larger. A throttled create is resent up to 8 times, each wait capped at 5 s, or up to 60 s when Prisma sends `Retry-After`. No new look precedes those resends. A `429` registers nothing, so a row that appears between a `429` and the resend is returned with `200` and owned.
  3. "refuses a row it finds without `--adopt`" suggests `--adopt` changes this deploy. It does not: the refusal in `reconcile` ignores `--adopt`. The deploy fails, and a redeploy takes the row only because `read` then finds it and returns `Unowned`.
- **Suggestion:** Replace the last three sentences with: "Instead it looks for the hostname again directly before each create attempt and refuses a row it finds; a redeploy with `--adopt` takes that row over. A row that another actor on the same app registers during the create, or between its resends after Prisma throttles it, is taken as the resource's own. `main` never resent this create; it is now resent only when Prisma throttles it."

  You could close that window in code instead: a `429` registers nothing, so a look before each throttled resend is safe. But that means replacing `Retry.policy` with an `Effect.retry` on `isThrottling` around `createUnlessFound`. The resource is deprecated, so the wording fix is enough.

### F08. Three small inaccuracies in the Distilled description

- **Location:** `pr-bodies/distilled.md`.
- **Issue:**
  1. "Prisma now always saves the domain ownership and returns it…; the spec lists that 422 on this route for an invalid hostname only." The same sentence says Prisma refuses an invalid hostname, so it does not "always" save.
  2. "the rest of the diff in `management.ts` is the generator renumbering its schema indexes." The diff also carries the spec's rewritten descriptions: the RoutingUrl `status` documentation ("It records that the hostname went live; `state` says what it does now.") and `records` documentation, in every RoutingUrl output.
  3. "That is removed, as discussed below." Nothing below it in the body discusses it. The discussion is in the pull request's comments.
- **Suggestion:** Drop "always". Write "the rest of the diff is the spec's updated descriptions and the generator renumbering its schema indexes". Write "as discussed in the comments" in place of "as discussed below".

### F09. `foundAfterDnsWait` in `Prisma.CustomDomain` is wrong from the second attempt on

- **Location:** `packages/prisma/src/CustomDomain.ts` lines 342–343.
- **Issue:** The look now runs before every attempt. On attempts 2 to 7 it finds a row registered between two create attempts, long after the DNS wait. The name was chosen to match `DomainOwnershipProof.ts`, where it is accurate, so a reader of `CustomDomain.ts` will assume the look runs once.
- **Suggestion:** Rename it to `registered`, or `foundBeforeCreate`. Leave the `DomainOwnershipProof.ts` name as it is.

## Deferred (out of scope)

- **The `409 Conflict` path of the custom domain create has no test.** It is unchanged from `main`, where it was also untested, and the resource is deprecated. The new fake can return a `409` cheaply if anyone wants it.
- **No test checks that the "already exists" refusal is not retried.** Break R5 added the refusal's tag to the retry's `while`. Two tests then took 30 s instead of 0 to 5 s, and both still passed, because the final outcome is the same. The code does not retry it, and the only cost of the defect would be 30 s of waiting. A test of this would assert timing or count `GET`s. It is not worth it.
- Carried from round 1: the domain ownership fake still creates rows `unverified` when the record is visible; `createAppDomain` and its `200 | 201` type; the platform gap the architect's plan review recorded as A15.

## Already addressed

| Finding | Fixed in |
|---|---|
| Round 1 F01 (`Prisma.CustomDomain` code) | `27f4f54f87` |
| Round 1 F01 (`Prisma.DomainOwnership` text) | `pr-bodies/alchemy.md` (local) |
| Round 1 F02, F03, F04 | `27f4f54f87` |
| Round 1 F05 | `a1303d00f`, `bede8e687` |
| Round 1 F06 | local edits to `pr-bodies/*.md`, `handover.md`, slice `plan.md` and `spec.md` |
| Plan reviews P01–P08, A03, A05, A07, A14 | see round 1's table |

## Acceptance-criteria verification

Breaks run this round. Each was restored with `git checkout`, and `git status` was clean afterwards. Command, from `packages/integration-tests`: `pnpm exec alchemy-test --retry 0 test/Prisma/CustomDomain.test.ts test/Prisma/DomainOwnership.test.ts`. Baseline: 20 passed, 1 failed (the live test, `CredentialsRequired`, expected). Logs: `wip/u2/review-logs/r2-*.log`.

| Break | Tests that failed (besides the live one) |
|---|---|
| R1. Look only before the first attempt (the DNS retry moved inside `createUnlessFound`, after the look) | "looks again before each create Prisma refused for DNS, and refuses a custom domain registered in between" |
| R2. `resendOnlyThrottled` resends nothing | "resends a create Prisma throttled, and owns the custom domain it then returns" |
| R3. `CustomDomain.read` no longer returns `Unowned` | "refuses a custom domain registered before the deploy, without --adopt, and sends no create" |
| R4. The domain ownership's second look refuses an `unverified` row | "takes over an unverified domain ownership that appears during the DNS wait, and sends no create" |
| R5. The "already exists" refusal is retried | none; same outcome after 30 s (Deferred) |

Rows that were FAIL, NOT VERIFIED or WEAK in round 1, with their verdicts now. Every other row stays PASS. I rechecked those that `27f4f54f87`, `a1303d00f` or `bede8e687` touch: W1a, W2, W3, D2a, D2c, D3a, D3b, D4a, D4b, D4d, D5, D6, A.5, B.1–B.3 and C.1–C.5.

| AC | Round 1 | Now | Detail |
|---|---|---|---|
| W1b: The Distilled title and description do not mention a status member | FAIL | **PASS** | Title `feat(prisma)!: type the RoutingUrl refusals, on the 2026-11-21 spec`. The body names no member. Its one mention of the earlier design is in the past tense ("An earlier version … also exposed the HTTP status of two creates … That is removed"). Small inaccuracies in F08. |
| D2b: An `unverified` row found by the second look is taken | NOT VERIFIED | **PASS** | New test asserts id, `verified`, no create, one verify, and the `DELETE`. R4 fails it. |
| D2d: The remaining window is stated honestly (`Prisma.DomainOwnership`) | FAIL | **PASS** | `alchemy.md`: "between the second look and the end of the create, including resends after a `5xx`". "The end of the create" covers resends after a `429` or a dropped connection too. |
| D3c: The `Conflict` refusal stays | NOT VERIFIED | **NOT VERIFIED** | Code unchanged and read; no test (Deferred). |
| D3d: Only an actor on the same app can hit the remaining window, and it is stated honestly | WEAK | **WEAK** | The code now looks before each DNS-refused attempt, so the 30 s window is closed (R1). The description still says "that one request", and throttled resends happen without a look (F07). |
| D4c: The custom domain create is resent when throttled | NOT VERIFIED | **PASS** | New test; R2 fails it. |
| A.6: The Distilled checks pass | WEAK | **PASS** | The implementer reports all six passing after the fix (`typecheck:ci`, vitest core and prisma 1026 passed, `format:check`, `lint`, `specs:check`, `patches:audit` 5 needed). I reran `pnpm generate prisma` (no change) and the three-dot result check myself. |
| C.6: Tests replaced as specified, and no kept behaviour left untested | WEAK | **PASS** | Round-1 F02, F03 and F04 each now have a test that fails when broken (R2, R4, R3). |
| C.8: Checks, and the one manual live check | WEAK | **PASS** | Type check, lint, format and the two test files pass here. The coordinator ran the live check against real Prisma: two creates of one test domain ownership answered `201` then `200` with the same row id; after the delete, the workspace lists none. I did not run it. |

### Summary

| Result | Count | ACs |
|---|---|---|
| PASS | 30 | all rows except D3c and D3d |
| FAIL | 0 | |
| NOT VERIFIED | 1 | D3c |
| WEAK | 1 | D3d |

## Leftovers searched for

Searched both repositories' Prisma source, tests, hand-written docs and generated docs. The search covered `httpStatus`, `ResponseCode`, "already registered", "was not created by", "created as unverified", "unverified at once", `withoutRetriedCreate`, and pairs of `201` and `200`. Nothing that describes the removed status or the old premise remains. Hits outside scope: `ORM/Errors.ts` and several website pages use "already registered" in unrelated examples. `Client.ts`, `Types.ts` and `Client.test.ts` are `createAppDomain` on `main`, which the plan excludes. Test fakes still answer `200` or `201`, as the plan intends. Distilled has no hits under `packages/prisma` on either tip.

## Verdict on pushing

The code on all three tips is ready. Before pushing, fix the description text in F07, which states something false about `main`, and in F08. A description-only change needs no new code review. F09 is a code commit, and under the plan's step D.1 any commit after the review needs a new review. Either make the rename and get a short review of that one commit, or leave it.
