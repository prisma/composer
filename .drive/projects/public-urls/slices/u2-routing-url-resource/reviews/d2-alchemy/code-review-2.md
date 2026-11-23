# Code review, round 2 — D2, `Prisma.DomainOwnership` with statuses (alchemy)

Range: `origin/main...feat/prisma-domain-ownership-status` at `103d29148` (two commits; this round reviews `103d29148` on top of `7e53733ca`). `submodules/distilled` is pinned to `958e84988`. Expectations as in [code-review.md](code-review.md), plus the coordinator's decisions for this round:

- no delete on any failure path;
- #2701's order: wait until the record is visible, then create;
- an `unverified` row found by domain is taken over without `--adopt`; a `verified` or `expiring` row needs it;
- main's 200 guard on `CustomDomain` is restored;
- `verifiedAt` is dropped;
- typed RoutingUrl errors are deferred to D3.

Tests run: `pnpm test:integration test/Prisma/DomainOwnership.test.ts test/Prisma/CustomDomain.test.ts test/Prisma/PublicSurface.test.ts`, 14 passed. Live tests not run.

## Summary

Every round 1 finding is fixed except test coverage. One gap remains in the new adoption rule: `reconcile` still takes over a `verified` or `expiring` row it finds by domain, without `--adopt`. The `--adopt` requirement is only enforced by the engine's plan-time `read`, and `reconcile` does a second, unguarded lookup. The authoritative-DNS check now fails the deploy when it cannot reach any nameserver, not only when the record is missing. The success path (create, then verify) has no fake test.

## Round 1 findings

| Finding | Status | Evidence |
| --- | --- | --- |
| F01 failure path deletes a row someone else created | **Fixed** | No `deleteDomainOwnership` call outside `delete`. All five fake tests assert no `DELETE` on failure. |
| F02 create before the record is visible | **Fixed** | `reconcile` reads the record (`getWorkspaceDomainOwnershipsVerification`), waits, and fails without creating when it is not visible. Test "fails with the record to publish and creates nothing" asserts no `POST`. |
| F03 `CustomDomain` adopts a 200 create | **Fixed** | `CustomDomain.ts` lines 352–362 fail unless `httpStatus === 201`. The race test is restored in `test/Prisma/CustomDomain.test.ts` and asserts a redeploy needs adoption. |
| F04 `verifiedAt` | **Fixed** | Removed from attributes, local provider and tests. |
| F05 docs overclaim `status` | **Fixed** | `DomainOwnership.ts` JSDoc, the `status` attribute JSDoc and `apps.mdx` now say it is what Prisma reported at the last proof. |
| F06 Website upgrade needs `--adopt` | **Fixed** | `websites.mdx` and the PR body say so. |
| F07 tests miss the 200 and stored-id-gone paths | **Partly fixed** | Stored-id-gone is tested, but only with `adopt: true` for the whole stack. The domain ownership create answering 200 is not tested, and no test reaches create or verify at all (new F11). |
| F08 tests call lifecycle methods directly; tagged `unit` | **Fixed** | Tests now go through `stack.deploy` and are tagged `local`. |

## Findings

### F09 — `reconcile` takes over a `verified` or `expiring` row without `--adopt`

- **Location:** `packages/prisma/src/internal/DomainOwnershipProof.ts` lines 199–204 (`existing = recorded ... : yield* findOwnership(...)`) and line 204 (`if (existing?.status === "verified") return attrsFrom(existing)`).
- **Issue:** The "needs `--adopt`" rule lives only in `read`, which the engine calls only for a resource with no state (or an interrupted create). `reconcile` looks the row up by domain again and accepts any status. Three ways a foreign `verified` or `expiring` row is taken over without `--adopt`, after which this stack's destroy deletes it:
  - The stored id no longer resolves and the deploy reconciles (any props change, or `--force`). The test "adopts a verified domain ownership, finds it by domain when the stored id is gone" shows exactly this, but runs with `adopt: true`, so it hides that the same thing happens without it.
  - Greenfield: the row appears between the plan-time `read` (which found nothing) and `reconcile`. This window is the whole plan plus the DNS wait, much wider than the find-to-create gap the new 200 guard covers.
  - After the 200 guard fires on a resource that already has state: the next deploy's `findOwnership` finds the row and takes it. So the guard is bypassed on retry.
- **Suggestion:** Apply the same rule in `reconcile`: a row found by domain whose id is not `output.domainOwnershipId` is accepted only when its status is `unverified` or `(yield* AlchemyContext).adopt` is true; otherwise fail with the same `--adopt` message `createOwnership` uses. Add the stored-id-gone test with `adopt: false` and assert it fails.

### F10 — A deploy that cannot reach the authoritative nameservers can never prove a domain

- **Location:** `packages/prisma/src/internal/AuthoritativeDns.ts` lines 28, 45 and 65–68; `packages/prisma/src/internal/DomainOwnershipProof.ts` lines 210–219.
- **Issue:** `waitForAuthoritativeRecord` used to "proceed regardless". It now returns `false` in four different situations, and `reconcile` treats all of them as "the record is missing" and fails:
  - `node:dns` is unavailable;
  - no nameserver was found;
  - the nameservers have only IPv6 addresses (`resolve4` finds nothing);
  - every query timed out, for example on a network that blocks outbound DNS to arbitrary servers.

  In those cases Prisma's own lookup would succeed, but the deploy fails on every run, with a message that says the nameservers "do not return its verification record yet".
- **Suggestion:** Return three states: `seen`, `absent` (every reachable nameserver answered without the record) and `unknown` (no nameservers, no `dns` module, or every query errored or timed out). Fail without creating only on `absent`. On `unknown`, go on to create and verify, as before. With no deletes, an unverified row left behind is taken over by the next deploy anyway.

### F11 — The success path has no fake test

- **Location:** `packages/integration-tests/test/Prisma/DomainOwnership.test.ts` lines 25–27 (HOSTNAME under `.test`, "the verification record never counts as visible").
- **Issue:** Because the record is never visible, no fake test reaches `createOwnership` or `verifyOwnership`. None of these is covered:
  - create answering 201, then verify until `verified`;
  - create answering 200 with an `unverified` row (accepted);
  - create answering 200 with a `verified` row (fails and asks for `--adopt`, the new rule);
  - the bounded verify loop ending in `PrismaDomainOwnershipRequired`.

  Only the live test covers the success path, and it was not run.
- **Suggestion:** Make the authoritative check replaceable in tests, for example a small `Context` service whose live layer wraps `waitForAuthoritativeRecord` and which `DomainOwnershipProofProvider` reads. Then add those four cases against the fake. If the coordinator rejects the service, at least run `CustomDomainDns.test.ts` live once before merge and record it in the PR.

### F12 — A retried create can make the 200 guards refuse this deploy's own row

- **Location:** `packages/prisma/src/internal/DomainOwnershipProof.ts` lines 130–138; `packages/prisma/src/CustomDomain.ts` lines 334–362.
- **Issue:** Distilled's default `Retry` policy retries transient failures on every operation, POST included. If the platform creates the row and the response is lost (a 5xx from a proxy, a dropped connection), the retry answers 200 with the row this deploy just made. `CustomDomain` then fails and the next deploy needs `--adopt` for its own domain. For a domain ownership whose create already synced to `verified`, the same happens. This is rare.
- **Suggestion:** Note it in the PR as a known edge, or run these two creates with retries off (`Prisma.Retry` layer override) so a lost response surfaces as an error instead of a misleading 200.

## Deferred (out of scope)

- Changing `project` to another workspace does not replace the ownership. Unchanged from round 1.
- Taking over an `unverified` row without `--adopt` follows the coordinator's decision. Its consequence is recorded in [system-design-review-2.md](system-design-review-2.md): this stack's destroy can later delete a row it took over that another stack's RoutingUrl relies on.

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: Proving waits for `verified` | **WEAK** | Code requires `verified` (lines 204, 227–233). The only passing case is an already `verified` row (adoption test). No fake test drives create then verify to `verified` (F11). |
| AC2: `expiring` is not proved | **PASS** | Test "does not count an expiring domain ownership as proved" asserts failure and that the row stays `expiring`. |
| AC3: Attributes carry `status` and `expiresAt` | **PASS** | Adoption test asserts `status`; `expiresAt` comes straight from the response. |
| AC4: `verifiedAt` handled | **PASS** | Removed (decision). |
| AC5: Only the Prisma parts of #2698/#2701 | **PASS** | Same file set plus `test/Prisma/CustomDomain.test.ts`. |
| AC6: Carried-over behaviour correct | **PASS** | #2701's order restored; main's 200 guard restored and tested. |
| AC7 (decision): `verified`/`expiring` rows not recorded need `--adopt` | **FAIL** | Enforced in `read` only; `reconcile` takes them over (F09). |
| AC8 (decision): no failure deletes anything | **PASS** | Every failure test asserts no `DELETE`. |
| AC9: Live proof | **NOT VERIFIED** | Not run. |

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 6 | AC2, AC3, AC4, AC5, AC6, AC8 |
| FAIL | 1 | AC7 |
| NOT VERIFIED | 1 | AC9 |
| WEAK | 1 | AC1 |
