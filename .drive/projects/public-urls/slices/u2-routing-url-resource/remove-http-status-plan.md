# Plan: remove the HTTP status from the Distilled and Alchemy pull requests

Date: 2026-11-23. Pull requests: alchemy-run/distilled#1348 (branch `feat/prisma-routing-urls`) and alchemy-run/alchemy#3529 (branch `feat/prisma-domain-ownership-status`). Clones: `wip/u2/distilled` and `wip/u2/alchemy`.

## Why

Prisma's two create routes for a custom domain (`POST /v1/services/{id}/domains`) and a domain ownership (`POST /v1/workspaces/{id}/domain-ownerships`) are idempotent. They answer `201` when the call created the row and `200` with the same body when the row already existed.

Our Distilled pull request exposes that status to SDK callers as a result member, `httpStatus`. To do so it changes Distilled's shared runtime and shared generator. A Distilled collaborator (Mkassabov) rejected this on 2026-11-21 and again on 2026-11-23: the SDK contains what the provider's spec declares, the AWS status members come from AWS's own spec, and ours comes from a patch. That is accurate. Prisma's spec is OpenAPI, which has no standard way to declare such a member.

Will decided on 2026-11-23:

- Prisma's API stays as it is. The create stays idempotent, and no field or header is added for one consumer.
- `httpStatus` is removed from the SDK.
- Alchemy treats a successful idempotent create as "the row I asked for exists".
- Will replies to Mkassabov himself. No agent posts on either pull request.

## What Will told the maintainer, which the result must match

Will's reply on alchemy-run/distilled#1348, 2026-11-23:

> @Mkassabov ok, I will remove the HTTP status handling from the PR.
>
> We will not change the API's behavior for a single consumer, but I'd be happy to add metadata to the OpenAPI spec, but I can't see a way to express the meaning of the response code in the same way the AWS implementation does, so we'll just drop that information.

What that commits us to, and how to check it at the end:

- **The Distilled pull request has no HTTP status handling.** Its difference from `upstream/main` contains no `httpStatus`, no `ResponseCode`, and no file outside `packages/prisma/`. Its title and description do not mention a status member. The typed errors stay: they are named errors, which is what the maintainer asks for.
- **The API does not change, and neither does its spec.** No commit in either repository adds a field, a header or an annotation to Prisma's spec, and no patch adds a member the spec lacks.
- **The information is dropped, not fetched another way.** Alchemy does not learn "created or already existed" from a create by any route: not through its own Prisma client's `createAppDomain`, not by reading the raw response, not by a second lookup after the create. A review finding that proposes any of these is declined for this reason.

## What exists today (verified in the clones)

Distilled branch, difference from `upstream/main`:

| File | What it is | Fate |
| --- | --- | --- |
| `packages/core/src/protocol-rest.ts` (27 lines) | fills a `T.ResponseCode()` member from the response status | removed |
| `packages/core/src/protocol-http.ts` (19 lines) | helpers `responseCodeKey`, `withResponseCode` | removed |
| `packages/core/test/protocol-rest.test.ts` (60 lines) | three tests for the above | removed |
| `packages/dev/src/codegen/generator.ts` (18 lines) | shared generator binds `smithy.api#httpResponseCode` to `T.ResponseCode()` | removed |
| `packages/prisma/patches/006-expose-create-response-status.patch.json` | adds `httpStatus` to the two create results | deleted |
| `packages/prisma/patches/005-…` | no longer adds `DomainOwnershipRequired` to `createWorkspaceDomainOwnership` | stays |
| `packages/prisma/patches/007-type-routing-url-refusals.patch.json` | the five typed RoutingUrl refusals | stays |
| `packages/prisma/specs/spec-mirror-prisma-postgres` | spec pinned at `e48eb8d` | stays |
| `packages/prisma/package.json`, `src/services/management.ts` | generated | regenerated |

Alchemy branch, the only uses of the status:

- `packages/prisma/src/internal/DomainOwnershipProof.ts:154`: `created.httpStatus === 201 ? created.data : yield* claim(created.data)`.
- `packages/prisma/src/CustomDomain.ts:352`: a create that answers anything but `201` fails with `adoptionRequiredError(… "was returned as already registered by the create request")`.
- `packages/prisma/src/internal/DomainOwnership.ts:86`: `withoutRetriedCreate`, a retry policy that retries only throttled requests. Its doc comment gives its one reason: a retried create answers `200` for the row it made, "which reads as someone else's". Both creates use it.

One fact that shapes the plan: on Alchemy's `main`, `Prisma.CustomDomain` does not use Distilled. It uses Alchemy's own Prisma client (`Client.ts`, `createAppDomain`), which returns `{ status: 200 | 201, domain }`, and `main` already fails a `200` with the same "was returned as already registered by the create request" error. Our pull request moved `Prisma.CustomDomain` onto Distilled, and `httpStatus` existed to keep that check. `Prisma.DomainOwnership` is new in our pull request, so it has no behaviour on `main` to preserve.

## Revised after review

An architect and a principal engineer reviewed the first version of this plan on 2026-11-23: [architect](reviews/remove-http-status/architect.md), [principal engineer](reviews/remove-http-status/principal-engineer.md). Both said "build with these changes". What changed:

- The first version said a row another actor creates between the look and the create is `unverified`, so losing the status rarely changes the outcome. That was wrong. Prisma's create looks the TXT record up at once and returns the row `verified` when the record is there, and the resource creates only after it has seen the record. The gap between the look and the create is the DNS wait, 10 to 70 seconds. So such a row is usually `verified`, the case `claim` refuses. Decision 2 now adds a second look.
- The first version removed the no-resend retry policy from both creates. It now stays on the custom domain create.
- The retry policy that applies is Alchemy's deploy policy (`Providers.ts`), not a Distilled default.
- The mechanics for the two Distilled branches, the test changes, the checks and the description changes are made specific.

## Decisions in this plan

1. **Remove, do not replace.** The create's answer is not used to tell "created" from "already existed", by any route. See the section above.

2. **`Prisma.DomainOwnership` looks again immediately before the create.** Today `reconcile` looks for the row, then waits for the TXT record at the authoritative nameservers, then creates. The plan adds a second `findOwnership` after the wait and directly before the create. A row found there goes through `claim`, exactly as a row found by the first look does: taken when `unverified`, refused without `--adopt` otherwise. A create that then succeeds returns a row the resource owns. This is the existing look-first check done at the moment it matters; it reads no status. What is left undetected is a row another actor creates during the one request between the second look and the create. Two stacks that hit that window both record the row, and destroying either deletes it for both. The description says so.

3. **`Prisma.CustomDomain` gets the same second look, and loses `main`'s check on the create's answer.** On `main` a create that answers `200` fails with "was returned as already registered by the create request". That branch goes. A second `findDomain` directly before the create, after the CNAME check, sends a row that appeared in the gap to the existing "already exists" refusal. The `Conflict` refusal ("appeared after the adoption check") stays. A `200` on this route means the hostname is already registered on the same service (another service answers `409`), so only an actor on the same app can hit the remaining one-request window. The description states this change from `main`. Keeping the one create call on Alchemy's own client was rejected: Alchemy's Typed Error Doctrine forbids recognising the ownership error by reading an untyped error's body, which that client would require.

4. **Retries.** Alchemy installs its own deploy retry policy for Distilled calls (`packages/prisma/src/Providers.ts`): up to 8 resends on 429, 5xx, 408, 423 and dropped connections.
   - **Domain ownership create: the no-resend policy is removed.** Prisma's spec documents a `503` sent after the row is saved and says "Retry the request; it returns the domain ownership with 200". Today a lost reply fails the deploy, and the next deploy refuses the stack's own row with "was not created by this resource", which is false. After the change the resend returns the row and the resource owns it.
   - **Custom domain create: the no-resend policy stays.** Alchemy's `main` never resends this request, the spec does not say a resend is harmless, and the resource is deprecated. `withoutRetriedCreate` moves into `CustomDomain.ts`, its only remaining user, and its doc comment gives this reason instead of the old one.

5. **The pinned Distilled branch is rebuilt, not cherry-picked.** `feat/prisma-routing-urls-on-alchemy-pin` sits on the Distilled commit Alchemy's `main` pins, which is far behind Distilled's `main`; the four shared files differ by about 1,200 lines there. See step B.

6. **No force-push to either pull request branch.** All changes there are new commits. The pinned branch is not a pull request head; it is force-pushed with a lease only when Alchemy's `main` moves its pin, as before.

## Steps

### A. Distilled, branch `feat/prisma-routing-urls`

1. `git fetch upstream`, merge `upstream/main`, `pnpm install --frozen-lockfile`, `pnpm generate prisma`, commit the merge.
2. Restore the four shared files from the merge base: `git checkout $(git merge-base upstream/main HEAD) -- packages/core/src/protocol-rest.ts packages/core/src/protocol-http.ts packages/core/test/protocol-rest.test.ts packages/dev/src/codegen/generator.ts`. After step 1 the merge base is `upstream/main`'s tip.
3. Delete `packages/prisma/patches/006-expose-create-response-status.patch.json`.
4. `pnpm generate prisma`. Read the diff of `management.ts` against the pre-removal version: the only changes are the `httpStatus` members going. It must still contain the five `RoutingUrl…` error classes on `createServiceUrl` and `updateUrl`, `state` on RoutingUrl outputs, and `DomainOwnershipRequired` on `createServiceDomain` and not on `createWorkspaceDomainOwnership`.
5. Result check: `git diff upstream/main...HEAD --stat` (three dots) lists only files under `packages/prisma/`; `git diff upstream/main...HEAD | grep -c -i "httpStatus\|ResponseCode"` is 0.
6. Checks, all must pass: `pnpm typecheck:ci`, `pnpm vitest run packages/core packages/prisma`, `pnpm format:check`, `pnpm lint` (0 errors), `pnpm specs:check`, `pnpm patches:audit prisma` (5 patches, all needed).
7. Commits: `revert(core): …` for step 2 and `feat(prisma)!: …` for steps 3 and 4.

### B. Distilled, branch `feat/prisma-routing-urls-on-alchemy-pin`

1. Find the Distilled commit Alchemy's `main` pins now (`git ls-tree upstream/main submodules/distilled` in the Alchemy clone). If it differs from the branch's base, rebase the branch's commits onto it first, as on earlier merges.
2. On the branch: `git checkout <pin> -- ` the same four files, delete patch 006, `pnpm install --frozen-lockfile`, `pnpm generate prisma`. Always regenerate.
3. Checks: `git diff <pin> HEAD --stat` lists only files under `packages/prisma/`; no `httpStatus` in `management.ts`; `packages/prisma/patches/` is byte-identical to branch A's; `pnpm patches:audit prisma` and `pnpm vitest run packages/prisma` pass.
4. Commit. Return to branch A.

### C. Alchemy, branch `feat/prisma-domain-ownership-status`

1. `git fetch upstream`, merge `upstream/main`. The submodule conflict resolves to the new tip of branch B.
2. Point `submodules/distilled` at the new tip of branch B. `pnpm install --frozen-lockfile`, then `pnpm ensure:built`, and confirm the submodule's built `lib/` and its `src/` both lack `httpStatus` for the Prisma SDK: Alchemy's type check reads `lib/`, its tests read `src/`.
3. `internal/DomainOwnershipProof.ts`: the second look and `claim` before the create, per decision 2; `createOwnership` returns `created.data`; the create uses the deploy policy. Correct `claim`'s doc comment if it no longer describes every caller.
4. `CustomDomain.ts`: the second look before the create, per decision 3; the create maps to `response.data`; the "was returned as already registered" branch goes; `withoutRetriedCreate` is defined here with its new reason.
5. `internal/DomainOwnership.ts`: `withoutRetriedCreate` leaves. Remove what becomes unused, and nothing else.
6. Tests in `packages/integration-tests/test/Prisma/`:
   - **DomainOwnership, replaces "accepts an unverified … with 200" and "refuses a verified … with 200":** (a) a row that appears between the first look and the create, `verified`, is refused without `--adopt` and no create is sent; with `--adopt` it is taken. The fake returns no row to the first list and the row to the second. (b) The resource owns the row the create returns, with the create returning a `verified` row, so the test fails if the code still routed it through `claim`.
   - **DomainOwnership, replaces "does not resend a create Prisma may have processed, and the next deploy finds the row":** the fake answers `503` once and then the row; the deploy succeeds with the row owned, and exactly two creates were sent.
   - **CustomDomain, replaces "routes a 200 custom-domain create race through explicit adoption":** (a) a row that appears between the first look and the create is refused with the "already exists" adoption error and no create is sent; (b) the resource owns what the create returns, keeping the old test's assertion on the CNAME lookup options. The fakes gain `GET /v1/domains/{id}`, `GET /v1/services/{id}/urls` and `DELETE /v1/domains/{id}` so the final destroy works.
   - **CustomDomain "does not resend a create Prisma may have processed":** stays, because the behaviour stays. Its comments are corrected if they give the old reason.
   - The throttled-create tests and every look-first `--adopt` test stay unchanged and pass.
   - The fake keeps answering `200` for an existing row, because the real API does. The code can no longer see it.
7. JSDoc on the two resources: correct any sentence the change makes false, including sentences that do not mention the status. Then `pnpm docs:check-jsdoc`, and `pnpm docs:gen` if JSDoc changed.
8. Checks: `pnpm typecheck`; `pnpm lint` (unused imports are caught only here); `pnpm lint:tests`; the format check; from `packages/integration-tests`, `pnpm exec alchemy-test test/Prisma/AuthoritativeDns.test.ts test/Prisma/CustomDomain.test.ts test/Prisma/DomainOwnership.test.ts test/Prisma/RoutingUrl.test.ts` without credentials. Never the full integration suites.
   - Expected without credentials: the live tests fail with `CredentialsRequired`.
   - No live test reaches the changed code: `Prisma.CustomDomain` has none, and the one for `Prisma.DomainOwnership` stops before the create. So the changed paths are proved by the fake-API tests only. One manual check against real Prisma confirms the premise they rest on: create a domain ownership for a test hostname twice through the API, expect the same row id both times, then delete it and confirm the list is empty.
9. One commit.

### D. Review, then push

1. `/drive-code-review` (system design pass, then code pass; no walkthrough) on each branch's final commit. Fix findings and rerun the affected checks. A later commit other than a merge of the base branch means a new review.
2. Push A, and edit the Distilled title and description in the same step. Push B. Push C, and edit the Alchemy description in the same step. The bot cannot convert an upstream pull request to a draft, so the description is corrected at the moment of each push instead.
3. Confirm GitHub reports both pull requests mergeable.

### E. Pull request titles and descriptions

1. Distilled title: `feat(prisma)!: type the RoutingUrl refusals, on the 2026-11-21 spec`. The `!` stays: `createServiceUrl` and `updateUrl` gain typed errors, `createWorkspaceDomainOwnership` loses one, and the spec update adds `Conflict` to `createWorkspace` and a required `state` to RoutingUrl outputs.
2. Distilled description, rewritten around one thing, the typed refusals. Gone: the opening "Two things…" sentence, the `httpStatus` example, "A create that answers 201 or 200 with the same body", the core and generator bullets, patch 006, the paragraph on the status of the last attempt, "The core change breaks nothing.", the sentence on the three new tests, and the whole "Alternatives considered" section, which is only about the status. "Evidence for all three" becomes "both".
3. Distilled's contributor rule 17: the body ends with the fixed agent note, after the `Agent:` line and the Claude Code line, naming `@wmadden`, the model and the harness.
4. Alchemy description:
   - "Prisma now creates it as `unverified` at once" is false; Prisma returns it `verified` when the TXT record is already published and `unverified` otherwise.
   - "One it did not create needs `--adopt` once it is `verified`" becomes: one it finds, before it creates, needs `--adopt` unless it is `unverified`; and it states the one-request window honestly.
   - Under `Prisma.CustomDomain`: the change from `main` in decision 3.
   - The domain ownership create is resent by Alchemy's deploy retry policy; the custom domain create is not, as on `main`.
   - Nothing about `createAppDomain`: it is a public operation of the package and stays.
5. Keep `pr-bodies/distilled.md` and `pr-bodies/alchemy.md` identical to GitHub.

### F. Project files

Update what the change makes false: `.drive/projects/public-urls/handover.md` (the line on what the Distilled branch adds), this slice's `plan.md` (the state entry and item D1), and this slice's `spec.md` where it describes how `Prisma.DomainOwnership` takes a row.

## Not in this plan

- Any change to Prisma's API or its published spec.
- Any change to Distilled's converter, core or generator.
- Any reply on either pull request.
- `Client.ts`'s `createAppDomain`, its `200`/`201` result type and its test. They are Alchemy `main` code and a public operation.
- A platform gap the architect noticed while reading the control plane: on the custom domain `200` path the platform does not write its RoutingUrl record. It is not caused by this change. It is recorded in the architect's review for Will.
