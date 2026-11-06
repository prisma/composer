# System design review, round 2 — D2, `Prisma.DomainOwnership` with statuses (alchemy)

Range: `origin/main...feat/prisma-domain-ownership-status` at `103d29148`. Round 1: [system-design-review.md](system-design-review.md).

## What changed since round 1

- The resource no longer guesses whether it created a row. It never deletes on failure, and it creates only after the record is visible. That removes the "cleanup by guess" problem round 1 raised.
- Whether a create created anything is now a fact from the platform (`httpStatus`, from the distilled core change), not a guess. `CustomDomain` and the domain ownership create both use it.
- Ownership of an existing row is now a rule based on its status: an `unverified` row can be taken over freely, while a `verified` or `expiring` row needs `--adopt`. That matches the platform's model: only `verified` or `expiring` rows keep anything serving (RoutingUrls.md, "A domain ownership's status").

## Where the rule is enforced

The rule is right, but it is enforced in one place and needs to be enforced in two. The engine calls `read` only before a first create. `reconcile` looks rows up by domain on its own and does not apply the rule. So the rule is a plan-time check, not an invariant of the resource. Put the status rule in one helper that both `read` and `reconcile` call; code review F09.

## Consequence of taking over `unverified` rows (decision, recorded)

An `unverified` row grants nothing *today*. Once this stack takes it over and proves it, it becomes `verified` and can keep other things serving: for example, a `Prisma.RoutingUrl` in another stack whose platform-created row this was. This stack's destroy then deletes it, and those hostnames lose their proof. That is the same shared-row problem round 1 described, moved from failure time to destroy time. It is acceptable under the stated use of the resource (an explicit, owned proof), but D3's docs should tell users not to mix `Prisma.DomainOwnership` with RoutingUrls for the same exact hostname. No change asked for in D2.

## The authoritative-DNS check changed role

It used to be a best-effort delay ("wait, then proceed regardless"). It is now a check that decides whether to create anything. A check needs to tell "absent" from "could not look". Today it cannot; code review F10.

## Naming

`DomainOwnershipProof` (internal name) versus the `Prisma.DomainOwnership` type string is unchanged from round 1 and still minor. `httpStatus` is a clear, mechanism-level name for a member that carries the HTTP status. It belongs on the distilled response, not on Alchemy attributes, and Alchemy does not copy it into attributes. Good.

## Test strategy

The property "a deploy succeeds only when Prisma says `verified`" is now tested only by its failure side. Every fake test fails or adopts an existing `verified` row, because the authoritative check is hard-wired to real DNS. Making that check a replaceable service is the smallest change that lets the success path be tested without the live API; code review F11.
