# Code review: remove the HTTP status (round 1)

Date: 2026-11-23. Pass: code review (principal engineer). No system-design pass, walkthrough or synthesis in this file.

Under review:

- Alchemy clone `wip/u2/alchemy`, branch `feat/prisma-domain-ownership-status`, tip `4cf818dc0e` (alchemy-run/alchemy#3529). Range `upstream/main...HEAD`, limited to `packages/prisma/`, `packages/integration-tests/test/Prisma/`, `submodules/distilled` and their docs. New since the last round: the merge `3d11bdd848` (touches nothing in scope) and `4cf818dc0e`.
- Distilled clone `wip/u2/distilled`, branch `feat/prisma-routing-urls`, tip `749d8b146` (alchemy-run/distilled#1348). Range `upstream/main...HEAD`. New: the merge `bde39bdad` (touches nothing under `packages/prisma`), `cf9d76cc8` and `749d8b146`.
- Distilled branch `feat/prisma-routing-urls-on-alchemy-pin`, tip `58f840de1`, base `f0b37d720` (the commit Alchemy's `main` pins).

Expectation sources: `remove-http-status-plan.md` (decisions, steps A to C, the three constraints from Will's reply), its two reviews (`architect.md`, `principal-engineer.md`), `wip/u2/distilled/CLAUDE.md`, `wip/u2/alchemy/AGENTS.md`.

## Summary

The code does what the plan says. Both Distilled branches drop the status cleanly, and both resources now look again just before the create and own what a successful create returns. Four gaps remain: a race window that is wider than "one request" and is described as one request, two kept behaviours with no test, one path of the new second look with no test, and description text (patch 005, both pull request bodies) that still states the false "created as unverified" premise or the removed status.

## What looks solid

- `reconcile` in `internal/DomainOwnershipProof.ts` is still one observe, ensure, sync flow. `claimUnrecorded` gives both looks one ownership rule, so the first look's behaviour is unchanged and the second look cannot drift from it.
- Every path through the two looks behaves as the plan states. Walked through the code:

  | Starting point | First look | Second look | Create | Result |
  |---|---|---|---|---|
  | No state, nothing in Prisma | none | none | sent | owned, whatever status it returns |
  | No state, row exists | found, through `claim` | skipped | not sent | `unverified` taken; `verified` or `expiring` refused without `--adopt` (in practice `read` returns `Unowned` first) |
  | Recorded id exists, same domain | `recorded`, id matches, no `claim` | skipped | not sent | as before |
  | Recorded id gone | `findOwnership`, through `claim` | only if the first found nothing | only if both found nothing | as before, plus the second look |
  | Recorded id, row has another domain | `findOwnership`, through `claim` | as above | as above | as before |
  | Row appears during the DNS wait, `unverified` | none | found, `claim` takes it | not sent | owned, then verified |
  | Row appears during the DNS wait, `verified` | none | found, `claim` refuses | not sent | fails naming `--adopt`; with `--adopt`, owned |
  | Row appears during the DNS wait, `expiring` | none | found, `claim` refuses | not sent | fails naming `--adopt`; with `--adopt`, owned, then the verify loop |
  | Nameservers cannot be found (`unknown`) | as above | runs at once | as above | Prisma's lookup decides, as before |
  | Record `absent` | as above | not reached | not sent | `PrismaDomainOwnershipRequired`, as before |

- `Prisma.CustomDomain`: the first look, `identityMatches`, the recorded-id path, `createDomainRetry` for a failed row, the `Conflict` refusal and the delete guard for a RoutingUrl `logicalId` are unchanged. The second `findDomain` searches the same app only, so a row on another app still reaches the create and gets `409`, which still maps to "appeared after the adoption check". With a recorded id whose row is gone, the second look now refuses a same-hostname row before any create is sent; before, the create was sent and its `200` was refused. Same outcome, one request fewer.
- Retries, as built:
  - Domain ownership create: Alchemy's deploy policy (`Providers.ts:55` and `:91`, `DeployRetry.policy`). It resends anything marked retryable (`429`, `500`, `502`, `503`, `504`), the throttling, server, network, timeout and locked categories, and transport failures. Up to 8 resends (9 attempts), 250 ms doubling to a 5 s cap, about 20 s in all; a `Retry-After` hint replaces one delay, capped at 60 s.
  - Custom domain create: `withoutRetriedCreate`, now local to `CustomDomain.ts`, resends only throttled requests: up to 8 times, 1 s doubling to 5 s, with server hints. It sits inside the unchanged outer retry on `DomainDnsNotConfigured` and `DomainOwnershipRequired` (7 attempts, 5 s apart). A `503` or a dropped connection is not resent, as on `main`.
- Distilled branch A: `git diff upstream/main...HEAD` lists five files, all under `packages/prisma/`, and contains no `httpStatus` or `ResponseCode`. The diff of `management.ts` from `bde39bdad` (before the removal) to `749d8b146` is the two `httpStatus` members and the generator's schema renumbering, nothing else. Rerunning `pnpm generate prisma` on the tip reproduces the committed files exactly. `pnpm patches:audit prisma` reports 5 patches, all needed; `pnpm vitest run packages/prisma` passes.
- The four shared files are back to `upstream/main` on A and to `f0b37d720` on B: neither branch differs from its base under `packages/core` or `packages/dev`. Patches and the spec mirror pointer are byte-identical between `749d8b146` and `58f840de1`.
- The submodule points at `58f840de1`. Both `src/services/management.ts` and the built `lib/services/management.d.ts` have no `httpStatus`, and both carry the five `RoutingUrl…` error classes and `DomainOwnershipRequired` on `createServiceDomain` only.
- All three branches move forward from their `origin` heads (fast-forward), so no force-push is needed.
- `oxlint` on `packages/prisma/src`, `oxfmt --check` on the five changed files and `tsrs -b` on the Prisma and integration-test projects are clean.
- The new tests can fail. Seven of the nine breaks below were caught by a named test.

## Findings

### F01. The race window is wider than "one request", and the commit and the planned description say one request

- **Location:** `packages/prisma/src/CustomDomain.ts` lines 334–367; `packages/prisma/src/internal/DomainOwnershipProof.ts` lines 149–152 and 246–250; commit message of `4cf818dc0e`; plan decisions 2 and 3, which the description will copy.
- **Issue:** The second look runs once, before the create. After it:
  - In `Prisma.CustomDomain`, a create refused with `DomainDnsNotConfigured` or `DomainOwnershipRequired` is sent again up to 6 times, 5 s apart. Prisma registers nothing on those refusals. If someone registers the hostname on the same app in those 30 seconds, the next attempt gets `200` with their row, and the resource owns it and deletes it on destroy. This is the window the architect's review (A03) asked to be named; the plan and the commit call the remainder a "one-request window".
  - In `Prisma.DomainOwnership`, the create is now resent by the deploy policy after a `5xx`, `429` or dropped connection: up to 8 times over about 20 s, and up to 60 s per resend when Prisma sends `Retry-After`. A row another stack creates between two attempts comes back from the resend and is owned without `--adopt`. That is accepted by decision 4, but the window is "the create and its resends", not one request.
- **Suggestion:**
  - `Prisma.CustomDomain`: put the second look inside the outer retry, so each attempt is preceded by `findDomain` and its refusal. That is safe there because a refused attempt created nothing. Keep `withoutRetriedCreate` around the create alone.
    ```ts
    : yield* Effect.gen(function* () {
        if (yield* findDomain(appId, hostname)) {
          return yield* adoptionRequiredError(hostname, appId, "already exists");
        }
        return yield* withoutRetriedCreate(createServiceDomain({ serviceId: appId, hostname }));
      }).pipe(Effect.retry({ while: (e) => e._tag === "DomainDnsNotConfigured" || e._tag === "DomainOwnershipRequired", ... }), ...)
    ```
    If that is not taken, say "the create and its retries while Prisma cannot see the DNS records, about 30 seconds" in the description.
  - `Prisma.DomainOwnership`: do not look again before a resend. After a `503` the row is this stack's own and usually `verified`, and `claim` would refuse it. State the window honestly in the description instead: "a row another stack creates while this deploy is sending its create, including its resends after a `5xx`, `429` or dropped connection".

### F02. The custom domain create's throttled resend has no test

- **Location:** `packages/prisma/src/CustomDomain.ts` lines 221–228; `packages/integration-tests/test/Prisma/CustomDomain.test.ts`.
- **Issue:** The plan keeps "the custom domain create is not resent, except when throttled". Only the first half is tested ("does not resend a create Prisma may have processed"). Before this commit, the shared `withoutRetriedCreate` was exercised through the domain ownership's throttled test. Now `CustomDomain.ts` has its own copy and no test reaches its throttled branch. Break 5 below (the policy resends nothing) passed every test.
- **Suggestion:** Add "resends a create Prisma throttled" to `CustomDomain.test.ts`, under `DeployRetry.policy` as in the lost-reply test: the fake answers `429` once without registering, then `201` with the row. Assert two `POST`s, the owned `customDomainId` and the `DELETE` on destroy.

### F03. A row that appears during the DNS wait as `unverified` is taken without a test

- **Location:** `packages/prisma/src/internal/DomainOwnershipProof.ts` lines 246–250; `packages/integration-tests/test/Prisma/DomainOwnership.test.ts` lines 276–319.
- **Issue:** Decision 2 says a row found by the second look is "taken when `unverified`, refused without `--adopt` otherwise". The tests cover only a `verified` row. Break 8 below (the second look refuses an `unverified` row) passed every test.
- **Suggestion:** Add "takes over an unverified domain ownership that appears during the DNS wait, and sends no create": `createdDuringDnsWait: ownership("do-raced", "unverified")`, no `--adopt`. Assert the owned id `do-raced`, no `CREATE`, one `POST /v1/domain-ownerships/do-raced/verify`, and the `DELETE` on destroy.

### F04. "A custom domain found before the create needs `--adopt`" lost its last test

- **Location:** `packages/prisma/src/CustomDomain.ts` lines 300–314 (`read` returns `Unowned`) and 331–333 (the first look's refusal); `packages/integration-tests/test/Prisma/CustomDomain.test.ts`.
- **Issue:** The removed race test ended with a redeploy that asserted `OwnedBySomeoneElse`. That was the only remaining test of `read` returning `Unowned` for a custom domain the stack did not record; `main`'s "refuses to claim an existing custom domain during reconcile" was removed earlier in this pull request. The plan (step C.6 and the principal engineer's P03.3) removed the assertion because the redeploy now succeeds, but the behaviour it covered stays. Break 9 below (`read` returns plain attributes, so a foreign domain is taken silently) passed every test.
- **Suggestion:** Add "refuses a custom domain registered before the deploy, without `--adopt`": the fake lists `raced` from the start; deploy fails with `Cannot adopt resource` (or `OwnedBySomeoneElse`) and sends no `POST`. Optionally the `--adopt` counterpart: it takes the row, and destroy deletes it.

### F05. Patch 005's description states the false "created as `unverified`" premise

- **Location:** Distilled `packages/prisma/patches/005-type-domain-ownership-required.patch.json`, `description` (identical on both branches).
- **Issue:** It says that since 2026-11-06 the create "saves the domain ownership with status `unverified` and returns it". The spec in the pinned mirror says the create "returns the domain ownership, verified when the record carries the workspace's value and unverified otherwise". This is the premise both plan reviews found false (architect A01 and A08, principal engineer P01). The patch description is part of the Distilled pull request and is read by its maintainer.
- **Suggestion:** "Since 2026-11-06 the create no longer returns this 422: it saves the domain ownership and returns it, `verified` when its TXT record already resolves and `unverified` otherwise." Change it on both branches in the same words, so the patches stay byte-identical, and regenerate.

### F06. Both pull request bodies and three project files still describe the old design

- **Location:** `pr-bodies/distilled.md`, `pr-bodies/alchemy.md`; `.drive/projects/public-urls/handover.md` line 40; slice `plan.md` lines 25 and 31; slice `spec.md` (how `Prisma.DomainOwnership` takes a row).
- **Issue:** The plan makes these edits at push time (steps D.2, E and F), and none is done yet. Items that the code in this round makes concrete:
  - Distilled body: the whole body is built around `httpStatus` (the opening sentence, the first example, "A create that answers 201 or 200", the core and generator bullets, patch 006, the paragraph on the last attempt's status, "The core change breaks nothing.", the three core tests, "Alternatives considered", "Evidence for all three"). Its paragraph on `DomainOwnershipRequired` repeats the false premise in F05.
  - Alchemy body: "Prisma now creates it as `unverified` at once" is false; "One it did not create needs `--adopt` once it is `verified`" no longer describes the rule; nothing says that `Prisma.CustomDomain` no longer fails a create that answers `200`; the retry sentence is missing; the window must be stated as in F01.
- **Suggestion:** Apply plan steps E.1 to E.5 and F with the F01 and F05 wording, in the same step as each push.

## Deferred (out of scope)

- **The `409 Conflict` path of the custom domain create ("appeared after the adoption check") has no test.** It is unchanged by this pull request and was untested on `main` too. `Prisma.CustomDomain` is deprecated and its routes go about 2026-12-21. If F01's first suggestion is taken, the same test fake can cover it cheaply; otherwise leave it.
- **The domain ownership fake creates rows `unverified` even when the record is visible.** The real create returns them `verified`. "creates the domain ownership once the record is seen and verifies it" therefore asserts a verify call the real API would not need. The new "owns a verified domain ownership the create returns" covers the realistic case, so nothing is untested. Making the fake realistic would rewrite several unchanged tests; it belongs with the next change to that fixture.
- **`Client.ts` `createAppDomain`, its `{ status: 200 | 201 }` type in `Types.ts` and its test in `Client.test.ts`.** They are Alchemy `main` code and a public operation; the plan excludes them.
- **The custom domain `200` path in the control plane does not write its RoutingUrl record** (architect A15). A platform issue, not caused by this change.

## Already addressed

Findings from the two reviews of the plan, as they stand at `4cf818dc0e` / `749d8b146` / `58f840de1`.

| Finding | What was asked | Where it is fixed |
|---|---|---|
| P01, A01, A03 | Look again before the create in both resources | `4cf818dc0e`: `DomainOwnershipProof.ts` 246–250, `CustomDomain.ts` 339–342 |
| P02, A05 | Deploy policy on the domain ownership create; throttling-only policy kept on the custom domain create, with a true reason | `4cf818dc0e`: `createOwnership`; `withoutRetriedCreate` in `CustomDomain.ts` 221–228 |
| A07 | `claim`'s doc comment | `4cf818dc0e`: "finds before its create" |
| A14, P03.1 | Keep a test of a `verified` row from the create | `4cf818dc0e`: "owns a verified domain ownership the create returns" |
| P03.2, P03.3 | Custom domain fake gains `GET`, `GET`, `DELETE`; redeploy assertion removed; `DELETE` asserted | `4cf818dc0e` |
| P03.5, P03.6 | Two `POST`s and the `DELETE` asserted on the lost reply; stale comment in `DomainOwnership.test.ts` fixed | `4cf818dc0e` (the custom domain comment stays true, since that create is still not resent) |
| P05, A13 | Restore from the merge base; three-dot diff; review the regenerated `management.ts` | `cf9d76cc8`, `749d8b146` (checked in this review) |
| P06 | On B, check out the base's four files and regenerate; identical patches | `58f840de1` (checked in this review) |
| P07 | `src/` and `lib/` agree | checked in this review |
| P08 | `pnpm lint` | `oxlint` clean in this review |

## Acceptance-criteria verification

Breaks run for this review (each restored with `git checkout`; `git status` clean afterwards in both clones). Command, from `packages/integration-tests`: `pnpm exec alchemy-test --retry 0 test/Prisma/CustomDomain.test.ts test/Prisma/DomainOwnership.test.ts`. Baseline: 16 passed, 1 failed (the live test, `CredentialsRequired`, expected). Logs are in `wip/u2/review-logs/`.

| Break | Tests that failed (besides the live one) |
|---|---|
| B1. No second look in `Prisma.DomainOwnership` | "refuses a verified domain ownership that appears during the DNS wait, and sends no create"; "with --adopt, takes over a verified domain ownership that appears during the DNS wait" |
| B2. No second look in `Prisma.CustomDomain` | "refuses a custom domain registered during the DNS wait, and sends no create" |
| B3. The created row goes through `claim` | "owns a verified domain ownership the create returns" |
| B4. The second look takes what it finds without `claim` | "refuses a verified domain ownership that appears during the DNS wait, and sends no create" |
| B5. The custom domain create's policy resends nothing, not even a `429` | none (F02) |
| B6. The custom domain create uses the deploy policy | "does not resend a create Prisma may have processed" |
| B7. A throttling-only policy on the domain ownership create | "resends a create whose reply was lost, and owns the row the resend returns" |
| B8. The second look refuses an `unverified` row | none (F03) |
| B9. `CustomDomain.read` no longer returns `Unowned` | none (F04) |

| AC | Verdict | Detail |
|---|---|---|
| W1a: The Distilled diff has no `httpStatus`, no `ResponseCode`, no file outside `packages/prisma/` | **PASS** | `git diff upstream/main...749d8b146` greps to 0 and lists 5 files under `packages/prisma/`. Same for `f0b37d720...58f840de1`. |
| W1b: The Distilled title and description do not mention a status member | **FAIL** | `pr-bodies/distilled.md` is built around `httpStatus` (F06). The plan edits it at push. The live title was not read (no credentials used). |
| W1c: The typed errors stay | **PASS** | Both SDKs carry the five `RoutingUrl…` classes on `createServiceUrl` and `updateUrl` and `DomainOwnershipRequired` on `createServiceDomain`; patch 007 is unchanged. Distilled has no tests for patches by rule 9; Alchemy's `RoutingUrl.test.ts` catches the tags (not re-run here; untouched this round). |
| W2: No commit adds a field, header or annotation to Prisma's spec; no patch adds a member the spec lacks | **PASS** | Patch 006 is deleted. Patches 005 and 007 add error shapes only. The mirror pointer moved to the published `e48eb8d` in an earlier round, not by annotation. |
| W3: Alchemy does not learn "created or already existed" from a create by any route | **PASS** | By reading the code: no `createAppDomain`, raw response or status read in either resource; the only looks are before the create; after it, only `identityMatches`, the domain check and the verify loop. Absence cannot be shown by a test. |
| D1: Remove, do not replace | **PASS** | Same evidence as W3. |
| D2a: `Prisma.DomainOwnership` looks again after the wait, before the create; a `verified` row found there is refused without `--adopt` and taken with it; no create is sent | **PASS** | `DomainOwnershipProof.ts` 246–250. Tests assert the failure names `--adopt`, no `CREATE`, nothing deleted; and with `--adopt`, id `do-raced`, no `CREATE`, `DELETE` on destroy. B1 and B4 fail them. |
| D2b: An `unverified` row found by the second look is taken | **NOT VERIFIED** | The code does it (`claim`), but no test; B8 passed everything (F03). |
| D2c: A row the create returns is owned | **PASS** | "owns a verified domain ownership the create returns": the create returns a `verified` row with `200`; asserts id `do-raced`, a `CREATE` and the `DELETE` on destroy. B3 fails it. |
| D2d: The remaining window is stated honestly | **FAIL** | It is the create plus its resends, not one request (F01). |
| D3a: `Prisma.CustomDomain` looks again after the CNAME check and refuses a row found there as "already exists", sending no create | **PASS** | `CustomDomain.ts` 339–342. Test asserts failure with "already exists" and "explicit adoption" and no `POST`. B2 fails it. |
| D3b: The "was returned as already registered" branch is gone; the resource owns what the create returns | **PASS** | Code maps to `response.data`. "owns the custom domain the create returns": the fake answers `200`; asserts the id, the CNAME check options, and `DELETE /v1/domains/domain-raced` on destroy. |
| D3c: The `Conflict` refusal stays | **NOT VERIFIED** | Code unchanged; no test before or after (Deferred). |
| D3d: Only an actor on the same app can hit the remaining window, and it is one request | **WEAK** | The same-app part holds (`findDomain` is per app; another app answers `409`). The one-request part does not: the outer retry adds about 30 s (F01). |
| D4a: The domain ownership create is resent by the deploy policy | **PASS** | No local policy in `createOwnership`; `Providers.ts` installs `DeployRetry.policy`. Test: `503` once, then the row; asserts two `CREATE`s, id `do-created`, `verified`, and the `DELETE`. B7 fails it. The test installs the policy itself, so it does not prove `Providers.ts` installs it; that wiring is unchanged and was read. |
| D4b: The custom domain create is not resent after a `503` | **PASS** | "does not resend a create Prisma may have processed": `503` on every `POST` under `DeployRetry.policy`; asserts exactly one `POST`. B6 fails it. |
| D4c: The custom domain create is resent when throttled | **NOT VERIFIED** | No test; B5 passed everything (F02). |
| D4d: `withoutRetriedCreate` lives in `CustomDomain.ts` with the new reason; `internal/DomainOwnership.ts` loses it and only what became unused | **PASS** | Read the diff: the policy, `isThrottling` and `Retry` imports leave `internal/DomainOwnership.ts`; nothing else changes there. `oxlint` clean. |
| D5: The pinned branch is rebuilt, not cherry-picked | **PASS** | `58f840de1` is one commit on `0e9c3d485`; `git diff f0b37d720 58f840de1` lists only `packages/prisma/` files; patches identical to A. Not verified: that rerunning the generator on B reproduces its `management.ts` (needs a branch switch and reinstall). |
| D6: No force-push to either pull request branch | **PASS** | Each `origin` head is an ancestor of its local tip (both Distilled branches and Alchemy). Nothing pushed yet. |
| A.1–A.4: Merge, restore the four files from the merge base, delete patch 006, regenerate; `management.ts` changes only by the `httpStatus` members | **PASS** | `bde39bdad` → `749d8b146` diff of `management.ts` is the two members plus renumbering (two outputs now reuse a structurally identical schema, as the generator does elsewhere). Regenerating reproduces it byte for byte. |
| A.5: Three-dot diff lists only `packages/prisma/`; no status | **PASS** | As W1a. |
| A.6: Distilled checks pass | **WEAK** | Ran `pnpm patches:audit prisma` (5 needed) and `pnpm vitest run packages/prisma` (5 passed). Did not run `typecheck:ci`, `format:check`, `lint`, `specs:check`. |
| A.7: Commits `revert(core): …` and `feat(prisma)!: …` | **PASS** | `cf9d76cc8` and `749d8b146`. Note: `revert` appears nowhere in upstream's recent history and the `!` on `749d8b146` is relative to the branch, not to `main`; both are moot under a squash merge, where the pull request title governs. |
| B.1–B.3: B on the pinned commit, four files from it, patch 006 gone, regenerated, patches identical, no `httpStatus` | **PASS** | As D5. `git diff 749d8b146 58f840de1 -- packages/prisma/patches packages/prisma/specs` is empty. |
| C.1–C.2: Base merged; submodule at B's tip; `lib/` and `src/` lack `httpStatus` | **PASS** | Submodule `58f840de1`; both files grep to 0 and agree on the error classes. |
| C.3: `DomainOwnershipProof.ts` second look and `claim`; returns `created.data`; deploy policy; `claim`'s comment corrected | **PASS** | See D2 and D4a. |
| C.4: `CustomDomain.ts` second look; maps to `response.data`; branch gone; local policy | **PASS** | See D3 and D4. |
| C.5: `internal/DomainOwnership.ts` | **PASS** | See D4d. |
| C.6: Tests replaced as specified; throttled and look-first `--adopt` tests unchanged; fake keeps answering `200` | **WEAK** | Replacements exist and fail when broken (B1–B4, B6, B7). The look-first `DomainOwnership` tests are unchanged. But removing the custom domain redeploy assertion left `read`'s `Unowned` untested (F04), and no custom domain throttled test exists (F02). |
| C.7: JSDoc corrected; `docs:check-jsdoc`; `docs:gen` if changed | **PASS** | No public JSDoc changed; the resource JSDoc in `DomainOwnership.ts` and `CustomDomain.ts` has no sentence the change makes false. `docs:check-jsdoc` not run, since no JSDoc changed. |
| C.8: Type check, lint, format, the four test files without credentials; one manual live check | **WEAK** | Type check, `oxlint`, format and the two changed test files pass here. `AuthoritativeDns.test.ts` and `RoutingUrl.test.ts` not run (untouched this round). The manual live check (create twice, same id, delete) has no recorded result in the project files I searched, and I did not run it (no credentials). |

### Summary

| Result | Count | ACs |
|---|---|---|
| PASS | 23 | W1a, W1c, W2, W3, D1, D2a, D2c, D3a, D3b, D4a, D4b, D4d, D5, D6, A.1–A.4, A.5, A.7, B.1–B.3, C.1–C.2, C.3, C.4, C.5, C.7 |
| FAIL | 2 | W1b, D2d |
| NOT VERIFIED | 3 | D2b, D3c, D4c |
| WEAK | 4 | D3d, A.6, C.6, C.8 |

## Leftovers searched for

Searched both repositories for `httpStatus`, `ResponseCode`, `201`, `already registered`, `withoutRetriedCreate` and "with 200" in source, tests, generated docs and hand-written docs. What remains:

- Alchemy: `Client.ts`, `Types.ts` and `Client.test.ts` (`createAppDomain`, excluded by the plan); test fakes that answer `200` or `201`, which the plan keeps; the `CustomDomain.test.ts` fake comment "The create answers 200, as it does for a hostname another actor registered the moment before", which is true of the API. No resource JSDoc, error message, generated page or test name mentions the status.
- Distilled: `packages/prisma/src/traits.ts` re-exports `ResponseCode`, unchanged from `upstream/main`. Patch 005's description has the false premise (F05).
- Pull request bodies and project files: see F06.
