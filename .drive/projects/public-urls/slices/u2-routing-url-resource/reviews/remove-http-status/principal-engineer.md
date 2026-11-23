# Principal engineer review: remove the HTTP status from the Distilled and Alchemy pull requests

Date: 2026-11-23. Subject: `remove-http-status-plan.md` in this slice.

What I read: the plan; Distilled `CLAUDE.md`; `git diff upstream/main...HEAD` on `feat/prisma-routing-urls` (core, dev and patches in full); `git diff f0b37d720 feat/prisma-routing-urls-on-alchemy-pin --stat`; Distilled `packages/core/src/retry.ts`, `category.ts`, `errors.ts` on both bases; Distilled `packages/prisma/src/retry.ts` and `errors.ts`; the Prisma spec (`specs/spec-mirror-prisma-postgres/specs/openapi.json`, both create routes); Alchemy `AGENTS.md` (reconciler doctrine, testing conventions, documentation generation); Alchemy `packages/prisma/src/internal/DomainOwnership.ts`, `internal/DomainOwnershipProof.ts`, `CustomDomain.ts`, `DomainOwnership.ts`, `Providers.ts`, `Client.ts` (retry rules), `internal/AuthoritativeDns.ts` (wait loop), `packages/alchemy/src/DeployRetry.ts`; `upstream/main:packages/prisma/src/CustomDomain.ts`; the two Prisma tests and their fake; both pull request descriptions; the pull requests' state on GitHub (read only).

The direction is sound. Removing the core and generator changes makes the Distilled pull request a patch-only change, which is what Distilled's rules 1, 6 and 10 ask for. Removing `withoutRetriedCreate` for `Prisma.DomainOwnership` fixes a real defect, and the spec backs it. The problems are in the reasoning the plan gives for decision 2, an unverified claim about retries in decision 4, and several steps that cannot be carried out exactly as written.

## Failure sequences, before and after

"Owned" means the resource records the row's ID, so a later `destroy` deletes that row.

### `Prisma.DomainOwnership`

The spec says the create "looks up its verification record, and returns the domain ownership, verified when the record carries the workspace's value". The resource only creates after every authoritative nameserver returns the record. So a row this resource creates is normally `verified` the moment it exists.

| Sequence | Before | After | Change |
|---|---|---|---|
| (a) create succeeds | `201`, owned; destroy deletes it | owned; destroy deletes it | same |
| (b) row saved, reply lost (transport error, or the spec's documented `503` "saved with its status… Retry the request; it returns the domain ownership with 200") | no resend; deploy fails. Next deploy's look finds the row, already `verified`, and `claim` refuses it: "was not created by this resource. Redeploy with --adopt". The message is false and the stack is stuck on its own row | resent by the deploy retry policy; `200`; owned | better |
| (b) same, but all 9 attempts fail | as above | as before: next deploy refuses its own `verified` row | same |
| (c) `5xx` before anything is saved | deploy fails; next deploy creates | resent; `201`; owned | better |
| (d) `429` | resent up to 8 times (throttling-only policy) | resent up to 8 times (deploy policy) | same |
| (e) another actor creates the row between the look and the create | `200`; `claim`: accepted if `unverified`, refused if `verified` | owned whatever its status; this stack's destroy deletes it | worse (see P01) |
| (f) stack state lost, row exists | `read` finds it by domain: `unverified` is taken, `verified` needs `--adopt` | unchanged | same |
| (g) two stacks deploy the same domain in one workspace at once | the second to create gets `200` with a `verified` row and fails with `--adopt` | both record the same ID; the first destroy deletes the proof the other relies on | worse (see P01) |

### `Prisma.CustomDomain`

The spec's `200` is "Custom domain already registered on this service". A hostname on another service answers `409`, which the resource still refuses. So in (e) and (g) the other actor must be acting on the same app.

| Sequence | Before (and Alchemy `main`) | After | Change |
|---|---|---|---|
| (a) create succeeds | owned | owned | same |
| (b) reply lost after processing | no resend; deploy fails. Next deploy's look finds the row and refuses it ("already exists"); only `--adopt` gets the stack its own row back | resent; `200`; owned | better, if a resend has no other effect (see P02) |
| (c) `503` "DNS ownership verification is temporarily unavailable" | deploy fails; next deploy creates | resent; owned | better |
| (d) `429` (the spec uses it for both rate limit and "domain quota exceeded") | resent up to 8 times, about 20 seconds, then fails | the same | same |
| (e) another actor registers the hostname on the same app in the window | fails with "was returned as already registered by the create request" | owned; destroy deletes it, unless a RoutingUrl has set a `logicalId` on the hostname (`CustomDomain.ts:387`) | worse, narrow |
| (f) stack state lost, row exists | `read` returns it as unowned; needs `--adopt` | unchanged | same |
| (g) two deploys of the same app and hostname at once | the second fails | both own it. When both runs are the same stage they share state and the same ID, so nothing is lost. Two different stacks targeting one app is unusual | worse, narrow |

## Findings

### P01. Decision 2's reasoning is wrong; the outcome it calls rare is the usual one in a race

Where: plan, decision 2; Alchemy description, "One it did not create needs `--adopt` once it is `verified`".

What is wrong: the plan says a row another actor creates between the look and the create is taken only if it is "already `verified` or `expiring` at that moment", and implies that is rare because "a seconds-old row is `unverified`". Both halves are wrong.

- The create verifies the row when it is made, if the record is visible. Spec, `POST /v1/workspaces/{workspaceId}/domain-ownerships`: "returns the domain ownership, verified when the record carries the workspace's value and unverified otherwise." Another stack running this resource only creates after it has seen the record at every authoritative nameserver, so its row is `verified` from birth.
- The window is not seconds. Between the look (`DomainOwnershipProof.ts:222`) and the create (`:246`) the resource calls `checkRecord` with `margin: "always"` (`:235-238`), which sleeps 10 seconds once the record is seen and polls for up to a minute while it is absent (`AuthoritativeDns.ts:227-250`). The window is 10 to 70 seconds.

So when the race happens, the row is usually `verified`, and that is exactly the case where behaviour changes. The realistic trigger is several stages in one workspace declaring the same wildcard, as the resource's own JSDoc example does (`DomainOwnership.ts`, "Prove a wildcard"), deploying for the first time in parallel. After the change, both record the same ID, and the first destroy (a preview's teardown) deletes the wildcard proof the others rely on. That is the harm the Alchemy description's own alternatives section names: "a preview's destroy could remove production's proof".

The test fake hides this: it creates rows `unverified` even when the record is visible (`DomainOwnership.test.ts`, `makeOwnershipCloud`, the `POST` branch).

The mechanism is still the only one available. Without the status, `claim` cannot be applied to the create's result, because this stack's own fresh row is also `verified`, so `claim` would refuse every successful create. Decision 2 is forced by removing the status; it is the stated reasoning that must change.

Change to the plan:

1. Rewrite decision 2: "A row another stack creates in the 10 to 70 seconds between the look and the create is normally already `verified`, because the create verifies it, and is now taken without `--adopt`. Both stacks then record it, and the first destroy deletes it." State that this is accepted, and why.
2. The Alchemy description must say the same in one sentence, in place of "One it did not create needs `--adopt` once it is `verified`": "One found before the create needs `--adopt` once it is `verified`. One another stack creates while this deploy is creating it is taken without `--adopt`."
3. Optional, for Will to decide: the cheapest mitigation is to repeat the look immediately before the create, when the first look found nothing. That is one extra `GET`, and it shrinks the window from tens of seconds to one round trip. It is not a replacement for the status and does not touch decision 1's rejected list (that list rejects a lookup after the create). The same applies to `Prisma.CustomDomain`, whose look comes before a CNAME wait of up to 70 seconds and the outer DNS retry of up to 30 seconds.

### P02. Decision 4 names the wrong retry policy, and the custom domain resend is not shown to be harmless

Where: plan, decision 4 and step C.5; Alchemy description addition in E.4.

What is wrong: the plan says "both creates use the default retry policy". Distilled's default (`core/src/retry.ts`, `defaultOptions`: 2 retries, retry budget) does not apply. Alchemy installs its own deploy policy on every Prisma call: `Layer.succeed(Retry.Retry, DeployRetry.policy)` (`Providers.ts:55` and `:91`). `DeployRetry.policy` (`packages/alchemy/src/DeployRetry.ts`) retries anything marked retryable plus the `ServerError`, `ThrottlingError`, `NetworkError`, `TimeoutError` and `LockedError` categories and transport failures. For Prisma that is `429`, `500`, `502`, `503`, `504`, `408`, `423`, socket resets and connect timeouts (`core/src/errors.ts`, each class's `withRetryable()`). It allows 8 retries, with delays of 250 ms doubling to a 5 second cap, about 23 seconds in all, and each `Retry-After` hint can stretch one delay to 60 seconds. On `Prisma.CustomDomain` this sits inside the existing outer retry on `DomainDnsNotConfigured` and `DomainOwnershipRequired` (7 attempts, 5 seconds apart, `CustomDomain.ts:336-342`).

Domain ownership: safe, and the spec asks for it. The `503` is documented as "saved with its status… Retry the request; it returns the domain ownership with 200", and "A domain the workspace already holds is checked again and returned". The only effect of a resend is another DNS lookup, which also refreshes other ownerships with the same record name. That is the intended behaviour.

Custom domain: not established. The spec's `200` says only "Custom domain already registered on this service". It does not say whether the `200` path re-runs DNS verification or certificate work. Since the backfill, a custom domain is a RoutingUrl row, and the RoutingUrl code already records that resending `/check` "can find the certificate the first one ordered failed, and retry it" (`RoutingUrl.ts:631-634`). A certificate order counts against the workspace's limit of about 10 an hour. Alchemy `main` has never resent this create: its own client retries a `POST` only for `/start`, `/stop`, `/promote` and `/rollback` (`Client.ts:484-494`). So removing the policy here is also a behaviour change from `main` that the plan does not mention.

Change to the plan:

1. Split decision 4. Remove `withoutRetriedCreate` from the domain ownership create, citing the spec's `503` text.
2. For the custom domain create, keep a throttling-only policy, local to `CustomDomain.ts`, with a correct reason: "Prisma does not say whether a resent create starts certificate work again; Alchemy `main` never resends it." The alternative is to read the create handler in Prisma's own API source (we own it) and confirm the `200` path has no side effect, then remove it. Keeping the policy costs nothing against `main`, whose lost-reply behaviour is the same, and the resource is deprecated with four weeks left.
3. In E.4, say "Alchemy's deploy retry policy (up to 8 retries on 5xx, timeouts and dropped connections)", not "the default policy", and say it applies to the domain ownership create.

### P03. The replacement tests need specifics, or some will prove nothing and two will fail at teardown

Where: plan, step C.6; `packages/integration-tests/test/Prisma/CustomDomain.test.ts` and `DomainOwnership.test.ts`.

1. The domain ownership replacement ("the resource owns the row the create returns") must have the create return a `verified` row. An `unverified` row passes `claim` both before and after the change, so a test with one cannot fail if someone reintroduces `claim` on the create path. The current `racedVerified` setup (`unlisted: ownership("do-raced", "verified")`) is the right input; only the expectation flips. Assert the ID, and that `destroy` sends `DELETE /v1/domain-ownerships/do-raced`.
2. The custom domain fakes handle only `GET` and `POST` on `/v1/services/service-1/domains`. Today the final `stack.destroy()` deletes nothing, because the deploy failed. After the change the resource owns `domain-raced`, so `destroy` calls `GET /v1/domains/domain-raced`, `GET /v1/services/service-1/urls` and `DELETE /v1/domains/domain-raced` (`CustomDomain.ts:370-390`). Each reaches `unhandled(request)`, and the test fails at teardown. Add the three routes, and assert the `DELETE`: what a destroy deletes is the real consequence of owning the row.
3. The race test's redeploy assertion (`"OwnedBySomeoneElse"`, `CustomDomain.test.ts:102-106`) must go; the redeploy now succeeds.
4. The custom domain lost-reply fake answers `503` on every `POST` (`CustomDomain.test.ts:119-121`). With the deploy policy that is 9 attempts and about 23 seconds, then a failure. The new test needs `503` once, then `200` with the row. Assert exactly two `POST`s, the owned ID and the `DELETE` on destroy. (Moot for this resource if P02's step 2 is taken; then the existing test stays, with its reason corrected.)
5. The domain ownership lost-reply test already injects `503` once and then serves the saved row. Assert two `POST`s, the owned ID `do-created` and the `DELETE`.
6. Two comments become false and the plan does not list them: "the create must still not be sent twice" at `CustomDomain.test.ts:134-135` and `DomainOwnership.test.ts:170-171`.
7. Keeping the fake's `200` for an existing row: harmless, and right for realism, but it no longer exercises anything. The code cannot see the status, so a `201` would pass identically. What the tests now prove is "a create that returns an existing row", so name the tests that way, not after the status.
8. The `throttled` test ("resends a create Prisma throttled") stays and still means something. No other behaviour is left untested once items 1 to 5 are in.

### P04. The live run does not test the change, and the assumption everything rests on is never checked live

Where: plan, step C.8.

The four files' live tests do not reach the changed code. `CustomDomain.test.ts` has no live test (both are tagged `local`). `DomainOwnership.test.ts` has one live test, which never calls the create and fails on this machine anyway. `RoutingUrl.test.ts`'s live tests do not touch either create, and they order certificates against the workspace's hourly limit.

The whole change rests on one assumption: a resent domain ownership create returns the same row and does not fail. The fakes assume it; the spec says it; nothing has observed it.

Change to the plan: replace the credentialed run of the four files with one manual live check using the deploy credentials. Create a domain ownership for a test-owned hostname with no TXT record, twice, through `@distilled.cloud/prisma`. Expect the same ID both times and `unverified`. Delete it, and list the workspace's ownerships to confirm none is left. This costs seconds and no certificates. Run the RoutingUrl live tests only if the regenerated SDK changes something they use; it should not (see P05, item 4).

### P05. Branch A mechanics: the upstream merge is not conditional, and two commands use a moving reference

Where: plan, steps A.1, A.2, A.5.

1. Both upstreams have moved. `git rev-list --count HEAD..upstream/main` is 10 in the Distilled clone and 15 in the Alchemy clone. Steps A.1 and C.1 will run; say so. The 10 Distilled commits touch none of the four files; one changes `packages/dev/src/codegen/openapi.ts`, so the regeneration may change `management.ts` beyond the `httpStatus` lines.
2. "Restore … to their `upstream/main` content": if anyone fetches between the merge and the restore, `upstream/main` points past the merge, and the restore pulls unrelated upstream changes into four files. Use the merge base: `git checkout $(git merge-base HEAD upstream/main) -- <the four files>`.
3. A.5's `git diff upstream/main HEAD --stat` is a two-dot diff and shows upstream's new commits as differences once `upstream/main` moves. Use `git diff upstream/main...HEAD --stat`.
4. Add a check on the regenerated `management.ts`: diff it against the commit before the removal. The only changes should be the `httpStatus` members, their documentation and schema entries, and the `generatedAt` stamp in `package.json`. Anything else came from the upstream merge, and needs a look before it reaches Alchemy.
5. The order "merge upstream first, then remove" is right. The restore then reproduces exactly the upstream content the pull request is compared against, and the merge cannot conflict in files the removal is about to restore.

### P06. Branch B mechanics: cherry-picking is the wrong tool for both commits

Where: plan, step B.1.

`f0b37d720` is 115 commits behind `upstream/main`. Between them, `protocol-rest.ts`, `protocol-http.ts`, `protocol-rest.test.ts` and `generator.ts` differ by 922 added and 302 deleted lines, and the lockfile by about 750 lines.

1. The "restore" commit from A, cherry-picked, is a three-way merge of A's restore onto files with different surroundings. It will either conflict or apply. Applying cleanly does not prove the result equals `f0b37d720`. Use `git checkout f0b37d720 -- <the four files>`, and check `git diff f0b37d720 HEAD -- <the four files>` is empty.
2. The second commit carries `management.ts` generated by a newer generator. Do not cherry-pick generated output. Always regenerate on B, not only "on conflict".
3. Run `pnpm install --frozen-lockfile` after switching to B, before generating, and again after switching back to A. The generator's dependencies differ between the two bases.
4. Add a check that B carries the same patches Distilled reviews: `git diff <A tip> <B tip> -- packages/prisma/patches` is empty, and the spec mirror pointer is the same commit on both. Otherwise Alchemy tests a different SDK from the one under review.
5. On B, also run `pnpm patches:audit prisma` and `pnpm vitest run packages/prisma`. B is not a pull request head, so no CI checks it, and it is the SDK Alchemy actually consumes.

### P07. Alchemy's type check and tests can read two different SDKs

Where: plan, steps C.2 and C.8.

Distilled's Prisma package exports types from `lib/*.d.ts` and, under Bun, source from `src/` (`submodules/distilled/packages/prisma/package.json`, `exports`). Alchemy's type check uses `lib/`; `alchemy-test` runs under Bun and uses `src/`. Right now they disagree: `src/services/management.ts` has 4 `httpStatus` lines and `lib/services/management.d.ts`, built today at 15:45, has none. So a passing type check and a passing test run can be checks of different SDKs.

Change to the plan: after C.2, run `pnpm ensure:built`. Confirm `grep -c httpStatus` is 0 in both `src/services/management.ts` and `lib/services/management.d.ts`, and that both contain the `RoutingUrl…` error classes. If `lib/` disagrees, delete the Prisma package's `lib/` and run `pnpm ensure:built` again.

### P08. The check list misses unused imports

Where: plan, step C.8.

Step C.5 removes imports (`isThrottling` and `Retry` in `internal/DomainOwnership.ts`, `withoutRetriedCreate` in two files). TypeScript will not report an unused import here: `tsconfig.base.json:52` sets `noUnusedLocals: false`. Only `oxlint.config.ts` (`no-unused-vars`) does, and the plan runs only `pnpm lint:tests`, which uses the tests config.

Change to the plan: run `pnpm lint` (oxlint on everything, then the tests config; it is fast), or at least `pnpm exec oxlint -c oxlint.config.ts packages/prisma/src`.

The rest of C.8 is enough for this change:

- `pnpm docs:gen` will not change anything. No resource JSDoc mentions the status or the `200`/`201` split. The internal comment on `withoutRetriedCreate` does not reach the docs. The hand-written `website/src/content/docs/prisma/compute/apps.mdx` says nothing about it either.
- The Cloudflare DNS tests do not matter here. The DNS publishing path in `DomainOwnership.ts` (`publishVerificationRecord`) is untouched.

### P09. Push order is right; leaving the pull requests "ready" during the change is not

Where: plan, decision 6 and steps C.1, D.2, E.

1. The order A, B, C is right. B moves forward with new commits, so the commit Alchemy's current head pins (`0e9c3d485`) stays reachable while C is unpushed. No reviewer can see a broken state. GitHub reports no checks on the Alchemy pull request (`gh pr checks 3529`: "no checks reported"), so no CI run can be caught in between either. The submodule URL is `alchemy-run/distilled` and B lives on the fork; that already works through the fork network and the plan does not change it.
2. Older Alchemy commits on the branch already pin B tips that no branch holds any more (`df61e289e0` pins `2fb446d57`, `603b96448d` pins `1235bd25c`), left by earlier rebuilds of B. That is harmless for a squash merge. Force-pushing B now would make the current head's pin unreachable until C is pushed, so not force-pushing is the better choice.
3. C.1 contradicts decision 6: "If its Distilled pin moved, rebuild branch B on the new pin" is a rewrite of B, so a force-push. Say so, and push C straight after B in that case. Today Alchemy `main` still pins `f0b37d720`, so the case does not arise yet.
4. Both pull requests are open and marked ready (`isDraft: false` for alchemy-run/alchemy#3529 and alchemy-run/distilled#1348). Between D.2 and E the code no longer has `httpStatus` while the descriptions still advertise it. Will's standing rule is to convert a pull request to a draft while fixes are in progress (`gh pr ready <n> --undo`). Changing the draft state is not a reply, so it does not conflict with "no agent replies". Add: convert both to drafts before step A, and mark them ready after step E.

### P10. Text in the descriptions that the plan would leave false or unclear

Where: plan, step E; `pr-bodies/distilled.md`, `pr-bodies/alchemy.md`.

Distilled:

- The opening sentence ("Two things … whether a create made the resource or found it, and which refusal it got") is not in E.2's removal list. It must go.
- "The core change breaks nothing." in the breaking-change paragraph must go. There is no core change any more.
- Rule 17 requires the note to be the end of the text. The body currently ends with `Agent: prospero-20` and the Claude Code line. Put the note after both, so it is last.

Alchemy:

- See P01, item 2, for the `--adopt` sentence.
- See P02, item 3, for the retry sentence. If P02's step 2 is taken, say that the custom domain create is still not resent.
- Decision 3 has a stronger argument than "the resource is deprecated", and Sam should get it. The spec's `200` means "already registered on this service"; a hostname on another service answers `409`, which is still refused. So the weakened check only matters when another actor registers the same hostname on the same app within the window. Also, the delete guard (`CustomDomain.ts:387`) already protects a row a RoutingUrl has taken over.

### P11. Files the plan forgot

Where: plan, steps E and "Not in this plan".

- `.drive/projects/public-urls/handover.md:40` describes the Distilled branch as filling `T.ResponseCode()` with `httpStatus` on two creates.
- `.drive/projects/public-urls/slices/u2-routing-url-resource/plan.md:25` and `:31` (decision D1) describe the same. Update both after step E, or they will mislead the next agent.
- The Alchemy branch has 34 commits, and some messages name `httpStatus`. If the repository's squash message lists the commits, they reach `main`'s history. That is minor, and the pull request title and description are what matter. It needs no action beyond knowing it.

### The questions the plan asks reviewers

- **Decision 3, weakening `main`'s check in `Prisma.CustomDomain`.** Acceptable, for the narrower reason in P10: only an actor on the same app can trigger it. There is no smaller status-free way to keep the check, except repeating the look just before the create (P01, item 3).
- **Decision 4, removing `withoutRetriedCreate`.** In scope and safe for the domain ownership create, which the spec tells clients to retry. Not established for the custom domain create; keep a throttling-only policy there (P02).
- **Other dependencies on `httpStatus`, `T.ResponseCode()` or the generator binding.** None. `git grep` in Alchemy outside `submodules/` finds the status only in `CustomDomain.ts:352` and `DomainOwnershipProof.ts:154`, and the policy only at its two call sites and the two test comments. In Distilled it appears only in the four files, patch 006 and the generated `management.ts`. Only these two call sites call either create.
- **A stack with several of these resources.**
  - A wildcard `Prisma.DomainOwnership` beside a `Prisma.RoutingUrl`: different rows, unaffected.
  - An exact-hostname `Prisma.DomainOwnership` on a RoutingUrl's hostname is the misuse the JSDoc and `apps.mdx` already warn against. Deployed together, the RoutingUrl's create can make the row inside the ownership's window. Before the change it was taken if `unverified`; after, also if `verified`. That is one more timing for a documented misuse, not a new kind of harm.
  - `Prisma.CustomDomain` beside a RoutingUrl on the same hostname: the delete guard keeps the row.
  - `Prisma.CustomDomain` beside a `Prisma.DomainOwnership`: different rows.
- **Anything in the descriptions left false.** See P10.

## Verdict

Build with these changes:

1. Rewrite decision 2's reasoning and the Alchemy description sentence to say that a row another stack creates during the window is normally `verified` and is now taken. Decide whether to add the look just before the create (P01).
2. Keep a throttling-only retry policy on the custom domain create, with a true reason, unless Prisma's handler is read and the `200` path has no side effect. Remove it from the domain ownership create. Name Alchemy's deploy retry policy correctly (P02).
3. Specify the tests (P03):
   - a `verified` row from the domain ownership create;
   - `GET`, `GET` and `DELETE` routes in the custom domain fakes, with an assertion on the `DELETE`;
   - `503` once, then the row;
   - two `POST`s asserted;
   - the stale comments fixed;
   - the redeploy assertion removed.
4. Replace the credentialed test run with one live check that a resent domain ownership create returns the same row (P04).
5. Restore from the merge base, diff with three dots, and review the regenerated `management.ts` (P05).
6. On B: check out `f0b37d720`'s four files rather than cherry-picking them, always regenerate, install dependencies, and check that A's and B's patches are identical. Run the audit and the Prisma tests (P06).
7. After moving the submodule, confirm the type check reads the same SDK as the tests (P07).
8. Run `pnpm lint`, not only `pnpm lint:tests` (P08).
9. Convert both pull requests to drafts during the change. Say that C.1's rebuild case is a force-push (P09).
10. Fix the description text in P10, and update `handover.md` and the slice `plan.md` (P11).
