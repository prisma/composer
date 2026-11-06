# Code review, round 2 — D1, distilled core change and Prisma regeneration

Two branches:

- `feat/core-rest-response-code` at `44663aaba` against `origin/main`: `packages/core/src/protocol-rest.ts` and its test. PR body `wip/pr-bodies/distilled-core.md`.
- `feat/prisma-routing-urls` at `958e84988`, rebased on the core branch: the round 1 regeneration (`db208d779`) plus patch 006, a `scripts/generate.ts` trait binding, and the regenerated `management.ts`. PR body `wip/pr-bodies/distilled.md`.

Tests run: `vitest run test/protocol-rest.test.ts` in `packages/core`, 60 passed; `pnpm test` in `packages/prisma`, 5 passed.

## Summary

The core change is small, opt-in and safe for other REST clients. Only an output member carrying `T.ResponseCode()` is affected, and today only the two Prisma creates have one. Patch 006 matches the platform's documented 201 and 200. The spec mirror pin is still stale, and the typed RoutingUrl errors are deferred to D3 by decision.

## The core change and every REST client

Checked:

- **Who is affected.** `withResponseCode` changes the value only when the output schema has a member annotated `responseCodeSymbol`. A search of every package's `src/` finds `T.ResponseCode()` in generated code only in `packages/prisma/src/services/management.ts` (two members). The Cloudflare protocol has its own reader and does not use `makeRestProtocol`'s decode path for this. No other REST package's generator binds `smithy.api#httpResponseCode`, so a regeneration of another package does not start emitting it by accident.
- **Cost.** The member lookup is in the per-output-schema decode plan, cached in a `WeakMap`, so it runs once per operation, not per response.
- **Shapes it skips.** Arrays, `null` and non-object bodies are passed through unchanged. An empty body becomes `{}` earlier (`json ?? {}`), so a 201 or 200 with no body still gets the member.
- **Order.** The status is written after key mapping and after response headers, before strict-mode validation, so strict mode checks it against the member's `S.Number`.
- **Error path.** Untouched; error statuses still go through the error matchers.

## Round 1 findings

| Finding | Status | Evidence |
| --- | --- | --- |
| F01 RoutingUrl 409/422 not typed | **Not fixed, deferred to D3** (coordinator's decision) | `createServiceUrl` and `updateUrl` still list generic `Conflict` / `UnprocessableEntity`. D3's spec should carry the patch. |
| F02 creates cannot tell created from existing | **Fixed** | Core reads `T.ResponseCode()`; patch 006 adds `httpStatus` with `smithy.api#httpResponseCode` to both create responses; `generate.ts` maps the trait; `management.ts` lines 7325 and 7588 carry `httpStatus: S.optional(S.Number.pipe(T.ResponseCode()))`. Core tests assert 201 and 200 reach the member and that an output without it is unchanged. |
| F03 spec mirror pin still 2026-10-29 | **Not fixed** | `package.json` still has `specUpdatedAt: "2026-10-29"`. Expected; the PR stays a draft until the mirror updates. |
| F04 `createUrlCheck` 429 untyped | **Not fixed, deferred** with F01. |

## Findings

### F05 — The core test does not cover the raw-body member path or a non-object body

- **Location:** `packages/core/test/protocol-rest.test.ts` lines 923–961; `packages/core/src/protocol-rest.ts` lines 311–315 and 491–496.
- **Issue:** The two new tests cover a plain object body. `withResponseCode` also runs after the `T.RawResponse` member path (`{ [bodyMember]: ... }`) and silently skips arrays and scalars. Neither branch is tested. A future change could break the raw-body case without a failing test.
- **Suggestion:** Add one case with a `T.RawResponse` member plus a `T.ResponseCode()` member, and one with an array body, asserting the array comes back unchanged.

### F06 — `httpStatus` is optional, so a missing status reads as "not 201"

- **Location:** `packages/prisma/src/services/management.ts` lines 7325 and 7588; consumers in alchemy `CustomDomain.ts` line 353 and `DomainOwnershipProof.ts` line 131.
- **Issue:** The member is `S.optional`. Through `makeRestProtocol` it is always set, but any other path that builds this output (a test fake that bypasses the protocol, or a future protocol) leaves it `undefined`. Alchemy's `CustomDomain` then treats a real 201 as "already registered". This is low risk because the only protocol fills it.
- **Suggestion:** None needed in distilled. Note in the core PR that the member is always set by `makeRestProtocol`, so consumers may rely on it.

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: RoutingUrl operations exist | **PASS** | Unchanged from round 1. |
| AC2: Domain ownership `status` and `expiresAt` exist | **PASS** | Unchanged from round 1. |
| AC3: RoutingUrl errors are typed | **Deferred to D3** | Coordinator's decision. |
| AC4: Generated from the deployed spec through the normal pipeline | **NOT VERIFIED** | Mirror not updated (F03). |
| AC5: Package scripts pass | **PASS** | Prisma tests 5/5, core REST tests 60/60 here. |
| AC6 (new): Create responses expose 201 vs 200 | **PASS** | Core tests assert both statuses reach the member; alchemy's restored `CustomDomain` race test asserts a 200 from the fake API fails through the real protocol. |

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 4 | AC1, AC2, AC5, AC6 |
| NOT VERIFIED | 1 | AC4 |
| Deferred | 1 | AC3 |
