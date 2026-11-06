# System design review — D2, `Prisma.DomainOwnership` with statuses (alchemy)

Range: `origin/main...feat/prisma-domain-ownership-status` at `7e53733ca`. Expectations: [spec.md](../../spec.md), [plan.md](../../plan.md) step D2, `wip/pr-bodies/alchemy.md`, pdp-control-plane `origin/main` `docs/compute/RoutingUrls.md` and ADR-015's routes, alchemy-run/alchemy#2698 and #2701.

## What changes in the system

- A new user-facing resource, `Prisma.DomainOwnership`: a composite that optionally publishes the TXT record through a DNS adapter (`Prisma.DomainVerification` + `dns.records`) and then a provider-backed resource of type `Prisma.DomainOwnership` (implemented as `DomainOwnershipProof`) that proves the domain.
- The invariant it adds: a deploy that declares a `Prisma.DomainOwnership` succeeds only if Prisma reports the row `verified`. This matches the platform's own rule that only `verified` lets a new hostname serve (RoutingUrls.md, "Becoming active needs a covering domain ownership whose status is `verified`").
- `Prisma.CustomDomain` moves from the hand-written `PrismaClient` to the generated distilled client, and takes an optional `ownership` used only to order the create after the proof.
- `Prisma.Website` with a DNS host now proves its hostname in the same deploy.

## Fit with the platform model

The platform's design (RoutingUrls.md) treats a domain ownership as **workspace-level state that many things share**: one row per workspace per domain, created by whoever asks first (the Console, a `POST /domain-ownerships`, or the platform itself on a RoutingUrl create), and covering every hostname under it. Alchemy models it as a resource **one stack owns**: it creates it, deletes it on destroy, and refuses to touch a row it did not record (`Unowned`).

That mismatch is acceptable for a wildcard proved once by a platform team, which is the resource's stated use. It causes the problems in the code review:

- The cleanup rule (delete what this deploy created on failure) assumes the resource can know it created the row. The platform's create is idempotent and returns the existing row with 200, and the client cannot see the status, so ownership is guessed. A shared, idempotent row should not be deleted on a guess. The cleaner shape is #2701's order: create only after the record is visible, so a failed deploy usually leaves nothing to clean up. Code review F01, F02.
- `Prisma.Website` now declares an owned `Prisma.DomainOwnership` for its exact hostname. Any existing workspace row for that hostname, made by hand or by the platform, reads as `Unowned`. Code review F06. This will get more common once D3 lands, because the platform creates an `unverified` exact-hostname row for every RoutingUrl it creates. Worth a sentence in D3's spec.
- The spec for D3 says the RoutingUrl resource "never records, reads into its state, or deletes a domain ownership". D2's resource does all three. Both are consistent only because they are different resources with different jobs: `Prisma.DomainOwnership` is for a user who wants an explicit, owned proof (typically a wildcard); `Prisma.RoutingUrl` leaves ownership to the platform. The docs should say which to use when, once D3 exists.

## Naming and types

- **`DomainOwnershipProof` vs `Prisma.DomainOwnership`.** The provider resource's type string is `Prisma.DomainOwnership`, but its TypeScript name is `DomainOwnershipProof`, and the public `DomainOwnership` type is an alias of it. The word "Proof" names what the resource does (prove), not what it is (a domain ownership). Since the type string is already `Prisma.DomainOwnership`, rename the internal class to `DomainOwnershipResource` or keep it internal under the same name as the type; minor, carried from #2701.
- **`verifiedAt`** names a moment ("when it became verified") but holds `verificationRecordLastSeenAt` ("when DNS last answered"). That is a concept named after a different concept. Drop it (code review F04).
- **`status`** uses the platform's three values unchanged, which is right: no Alchemy-side translation that could drift.
- **`PrismaDomainOwnershipRequired`** is used both for the platform's 422 on `createServiceDomain` and for "this resource could not get `verified`". Same user action (publish this record), same fields, so one error is right.

## Boundaries

- `internal/DomainOwnership.ts`, `internal/DomainVerification.ts`, `internal/AuthoritativeDns.ts` stay internal. `DomainVerification` is registered as a provider but not exported, which is the intended shape.
- The CNAME wait and the TXT wait now share `waitForAuthoritativeRecord`; this removes main's private copy in `CustomDomain.ts`. Good consolidation.
- Status semantics stay on the platform: the resource only reads `status`, never derives it from `verificationRecordPresent` or timestamps. This matches RoutingUrls.md ("Every reader reads it as stored; nothing recalculates it").

## Test strategy at the architectural level

The property to prove is "a deploy reports success only when Prisma says `verified`, and never removes a domain ownership it did not create". The first half is covered by fake tests. The second half is not testable with the current fake, which never returns 200 on create and has no `GET` by id (code review F07). The live test now asserts `status: "verified"` but was not run.

## Out of scope for this pass

Failure modes in detail, the 200-create regression in `CustomDomain`, and AC verification are in [code-review.md](code-review.md).
