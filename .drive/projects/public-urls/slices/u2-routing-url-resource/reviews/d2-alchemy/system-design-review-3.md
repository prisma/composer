# System design review, round 3 — D3, `Prisma.RoutingUrl` (alchemy)

Range: `283b8402c..405bd01af`. Expectations: [spec.md](../../spec.md), design note 12, pdp-control-plane `docs/compute/RoutingUrls.md`.

## What is added

A resource over the platform's RoutingUrl routes. It saves a hostname for a service before DNS exists and reports what is missing. Its identity is the `logicalId` on the Branch. It leaves domain ownership entirely to the platform. It adds one guard of its own: a hostname change on a serving row must be able to serve before it is sent.

## Fit with the platform model

- **Status and conditions are read, never derived.** Attributes are copied from the response. The resource does not recompute `status` from conditions, which matches RoutingUrls.md ("every reader reads it as stored").
- **The resource's job and the platform's job are kept apart.** Domain ownership is the platform's (`createDomainOwnership` left at its default). Serving decisions are the platform's. The resource's own checks are only identity (by `logicalId`) and the design-note-12 guard. That is a clean split.
- **Two resources now act on domain ownerships with opposite stances.** `Prisma.DomainOwnership` owns and deletes rows. `Prisma.RoutingUrl` never touches them, and the platform creates one for it. The JSDoc and `apps.mdx` warn against declaring both for one exact hostname. That is the right minimum. The interaction can only be solved by the platform knowing which rows it created for a RoutingUrl, which is out of scope here.

## Identity and adoption

- **The order of identity is right:** stored id, then `logicalId` on the Branch, then a backfilled row (no `logicalId`, same service and hostname). Any other row with the hostname on the Branch is a named conflict. Rows elsewhere are the platform's business (`heldBy`).
- **Adopting rows with no `logicalId` without `--adopt` is a recorded decision** for P3's backfill. Its consequence is not recorded anywhere yet. Once the legacy domain routes become a view over RoutingUrls, "a row with no `logicalId`" also means "a row a `Prisma.CustomDomain` manages". A RoutingUrl then silently shares that row with the CustomDomain, and either one's delete removes it. This needs a written migration order in the docs and in P2/P3's plan; code review F14.

## Design note 12, the hostname-change check

- **It checks what the note asks for:** a covering `verified` domain ownership in the workspace (exact or one-label wildcard, matching the platform's definition of "covers") and the CNAME at every authoritative nameserver. It runs only for a hostname change on an `active` row, as the note says.
- **Two gaps against the note's purpose,** which is to never turn a serving hostname dark:
  - "Could not check" is reported as "publish it" (F15).
  - A new hostname held by a RoutingUrl in another workspace passes both checks and still goes dark (F17).
- **Apex hostnames** cannot satisfy a CNAME check, so the check is stricter than the platform for them (F16).

## Errors

The error types are good: one per refusal the user can act on (`RoutingUrlQuotaExceeded`, `RoutingUrlLogicalIdTaken`, `RoutingUrlHostnameTaken`, `RoutingUrlInvalidHostname`, `RoutingUrlServiceOnAnotherBranch`, `RoutingUrlHostnameChangeRefused`), plus a fallback. How they are recognised is wrong for the long term. The platform's codes do not tell the cases apart (both 422s are `validation-error`, the `logicalId` conflict is the generic `client-error`), so the resource reads English messages. The platform owns the contract and should give each case its own code. Distilled can then type them with an `/error/code` matcher patch, as it already does for `domain-ownership-required`. Code review F13 has the details.

## Naming

- `RoutingUrl`, `logicalId`, `heldBy`, `records`, `conditions` all match the platform's glossary.
- `RoutingUrlHostnameChangeRefused` names what happened, not the mechanism. Good.
- `ensureCanServe` and `ownRow` are local helpers that read correctly.

## Test strategy

Every done condition except the live one is proved by a fake test that drives `stack.deploy` and asserts the requests sent. The DNS check is a replaceable service (`AuthoritativeRecordCheck`), which is what made that possible. Missing from the tests:

- the `unknown` DNS state in the hostname-change check;
- the wildcard-coverage path;
- a pending row's hostname change, which should send a `PATCH` with no check.
