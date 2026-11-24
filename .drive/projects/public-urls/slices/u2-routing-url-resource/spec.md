# U2 — the Alchemy `Prisma.RoutingUrl` resource

Repositories: alchemy-run/distilled (the generated client) and alchemy-run/alchemy (the resource). Parent: [project spec](../../spec.md), [plan § U2](../../plan.md), [design note 7](../../design-notes.md), [design note 12](../../design-notes.md). Platform contract: `docs/compute/RoutingUrls.md` and ADR-015 in prisma/pdp-control-plane, as deployed with platform slice 3.

Starts when platform slice 3 is deployed. Slice 3 is prisma/pdp-control-plane#5924, merged 2026-11-06 as 37658428. The routes and fields below were checked against that commit (`services/management-api/routes/v1/urls.ts`, `routes/v1/services.ts`, `routes/v1/projects/branches/urls.ts`, `models/v1/routing-urls.ts`). Confirm they appear in `GET https://api.prisma.io/v1/doc` before dispatch.

## At a glance

```ts
const url = yield* Prisma.RoutingUrl("api", {
  app: api,
  hostname: "api.example.com",
  logicalId: "my-app/api/public",
});
// url.status: "pending" | "active"
// url.conditions: the six conditions, each met | unmet | unknown
// url.records: the DNS records still to publish (TXT for ownership, CNAME to the switchboard)
```

Before: a hostname can only be attached through `Prisma.CustomDomain`, which fails the deploy until both the TXT and the CNAME record resolve.
After: `Prisma.RoutingUrl` creates the platform row at once, with no DNS. The deploy succeeds and reports what is still to publish. The platform makes the row active once the records are found.

## Chosen design

**Over the platform's RoutingUrl routes.** Create with `POST /v1/services/{id}/urls` (`hostname`, `logicalId`, `createDomainOwnership`). Read with `GET /v1/urls/{id}`. Change the hostname, service or `logicalId` with `PATCH /v1/urls/{id}`; a request that changes nothing changes nothing on the platform too. Delete with `DELETE /v1/urls/{id}`. Find with `GET /v1/projects/{id}/branches/{id}/urls?logicalId=`. Reads return stored state and call neither DNS nor Foundry; `POST /v1/urls/{id}/check` refreshes it, and the resource calls it at most once per deploy, under the rule in "Waiting for the hostname".

**Attributes come from the response:** `routingUrlId`, `serviceId`, `hostname`, `logicalId`, `status`, `state`, `conditions`, `firstUnmetCondition`, `records` (each with its condition, type, name, value and ttl), `ownershipExpiry`, `heldBy`, `customDomainSyncError` and `setupUrl`. Composer's P2 prints `firstUnmetCondition`, `records` and `setupUrl`.

**Prisma's refusals are typed errors.** Since 2026-11-20 the create and update routes give each refusal its own `error.code` (`quota-exceeded`, `logical-id-taken`, `invalid-hostname`, `service-not-on-a-branch` on create, `service-on-another-branch` on update). A Distilled patch types the five, and the resource catches them by tag and raises its own error of the same name with a message that says what to do. Any other 409 or 422 becomes `RoutingUrlOperationFailed`. Nothing matches on message text.

**The domain ownership is declared, not left to the platform** (changed 2026-11-24, [domain-ownership-crud-plan.md](domain-ownership-crud-plan.md)). `Prisma.DomainOwnership` is plain CRUD: it saves its row without DNS, reports `status`, needs `--adopt` for any row the stack did not record, and deletes its row on destroy. With `dns` it publishes its TXT and waits for it before Prisma creates the row. The RoutingUrl sends `createDomainOwnership`, which defaults to `false` on the platform since prisma/pdp-control-plane#6153; `true` asks Prisma to create an exact-hostname row that the stack does not manage. The RoutingUrl never records or deletes a domain ownership. Deleting a RoutingUrl leaves the domain ownership in place.

**Identity is the `logicalId`.** With no stored row id, `read` looks the row up by Branch and `logicalId`. A row on the same service with the same hostname and no `logicalId` is adopted: the resource writes its `logicalId` with `PATCH` and takes it over. This is how P3 takes over the rows the platform's backfill made for existing custom domains. Any other row on the Branch with the same hostname is a conflict, and the resource fails with an error that names it. A row in another workspace that holds the hostname is not a conflict for the resource: the platform saves the row and reports the holder in `heldBy`.

**Changing the hostname of a serving row is checked here** (design note 12). The platform accepts any hostname change: it removes the old custom domain at once and holds the new hostname `pending`. So before it sends a hostname change for a row whose status is `active`, the resource checks that the new hostname can serve: its ownership is proved, and the hostname points at the regional switchboard at every authoritative nameserver. A nameserver passes when it answers the CNAME to the switchboard, or, for a hostname with no CNAME (an apex behind ALIAS, ANAME or CNAME flattening), A or AAAA answers that include a switchboard address. If not, or if DNS could not be checked from the deploying machine, it fails before changing anything, with an error that names both hostnames and the records to publish and carries a field that tells "not published" from "could not check". The check cannot see a RoutingUrl in another workspace that holds the new hostname; that limit is documented, and [plan.md](plan.md) records the platform request that would remove it. A pending row, a service change, and a removal are not checked.

**What counts as ownership proved in that check** (changed 2026-11-20, then 2026-11-24 with correction 7 of [domain-ownership-crud-plan.md](domain-ownership-crud-plan.md)). Either a covering domain ownership in the workspace has status `verified`, or the TXT record of a covering domain ownership of any status is seen at every authoritative nameserver. With `createDomainOwnership: true` and no exact row, the exact hostname's TXT also counts, because Prisma creates that row during the update the check guards. The covering domains are the hostname and the wildcard one label above it. The RoutingUrl still creates, verifies and deletes no domain ownership.

**Reuse #2701.** alchemy-run/alchemy#2701 (Sam Goodwin, paused) has the pieces this needs: `DomainVerification` to read the TXT record, `AuthoritativeDns` to wait on authoritative nameservers, and the `DomainOwnership` resource. #2701 expects create to fail with `DomainOwnershipRequired` until the record resolves. The platform now creates the domain ownership `unverified` and returns it, so #2701 would treat an unverified one as proved. We replace #2701 and its base #2698 with our own pull request that carries their Prisma parts, waits on `status`, and carries `status` and `expiresAt` in its attributes (Will, 2026-11-06). Sam is asked to close his two.

**Declare both resources for a hostname you serve** (changed 2026-11-24). A stack declares a `Prisma.DomainOwnership` that covers the hostname, an exact hostname or a wildcard, next to the `Prisma.RoutingUrl`. Prisma accepts the two in either order.

**`Prisma.CustomDomain` is deprecated, and nothing in Alchemy uses it** (Will, 2026-11-20). The platform deletes `/v1/services/{id}/domains` and its sibling routes about 2026-12-21. `Prisma.CustomDomain` keeps working until then and carries a deprecation note that names `Prisma.RoutingUrl`. Its removal from Alchemy is a later change. Composer switches in P2.

**`Prisma.RoutingUrl` takes an optional `dns`** (Will, 2026-11-20; this brings forward what design note 8 left as a follow-on, on the Alchemy side only). With a DNS adapter, the deploy publishes the CNAME to the switchboard and nothing else (changed 2026-11-24: the TXT belongs to `Prisma.DomainOwnership`'s `dns`). The CNAME comes from the service's switchboard address, which is the same on every deploy, never from the RoutingUrl's `records` attribute, which lists only records still to publish and would make the adapter delete a record in use. The CNAME is published before the RoutingUrl is reconciled. The deploy no longer waits for the hostname to serve (Will, 2026-11-24: "at most it should be opt in"; no opt-in is built).

**`Prisma.Website` attaches its hostname with `Prisma.RoutingUrl` and declares its own `Prisma.DomainOwnership`** (Will, 2026-11-20 and 2026-11-25; [website-domain-design.md](website-domain-design.md)). A site with `domain` declares one RoutingUrl for the hostname, passes its `dns` through, and declares a domain ownership for the hostname, unless `domain.ownership` names one managed elsewhere (in the stack, or found with `Prisma.DomainOwnership.lookup`). It declares no `Prisma.CustomDomain` and adopts nothing on its own. A site whose DNS is not ready deploys and reports `pending` where it used to fail, and its `url` is the hostname's URL from the first deploy. A site deployed with the released Alchemy is refused on its first upgrade deploy when its workspace has a domain ownership for the hostname; the user chooses `adopt(true)` on the site or `ownership` with a lookup, and the docs say which fits when. Its released CNAME resource stays declared, adopted and retained, so the CNAME survives the upgrade.

## Coherence rationale

One new resource and the client it calls. Exactly two upstream pull requests: one on alchemy-run/distilled (the REST status code support and the regeneration together), merged first, and one on alchemy-run/alchemy (`Prisma.DomainOwnership` and `Prisma.RoutingUrl` together).

## Scope

In:
- alchemy-run/distilled: regenerate `@distilled.cloud/prisma` from the deployed spec, so the RoutingUrl operations and their typed errors exist.
- alchemy-run/alchemy `packages/prisma`: `RoutingUrl.ts`, its provider (live and local), its export, and Providers registration.
- Tests in `packages/integration-tests/test/Prisma/`, following Alchemy's own conventions, with a live test against production using credentials confirmed before dispatch.
- The `dns` option on `Prisma.RoutingUrl`; `Prisma.Website`'s `domain` option moved to `Prisma.RoutingUrl`; a deprecation note on `Prisma.CustomDomain`.
- The resource's JSDoc; a short section in the Compute custom-domain guide. (`docs:gen` produces no reference page for any Prisma resource.)

Deliberately out:
- Removing `Prisma.CustomDomain` from Alchemy.
- Composer publishing DNS (design note 8 stays a follow-on for Composer).
- Any Composer change (P2).

## Done conditions

- A deploy of a `Prisma.RoutingUrl` for a hostname with no DNS records succeeds, and its attributes show `pending`, the unmet conditions and both records to publish.
- A redeploy with nothing changed sends no `PATCH`.
- A row found by `logicalId` is updated in place; a row with no `logicalId` on the same service and hostname is adopted; a conflicting row fails with an error that names it.
- A hostname change on an `active` row whose new hostname has no proved ownership (no covering `verified` domain ownership, and its TXT record not seen at every authoritative nameserver) fails before any `PATCH`, and a test proves no request was sent. With `dns`, a refused change leaves the old hostname's records published.
- Destroy deletes the row and sends no domain ownership request.
- With `dns`, a first deploy of a RoutingUrl publishes exactly the CNAME; a redeploy after the row is `active` with an empty `records` list removes nothing; destroy removes the CNAME and sends no domain ownership request.
- A `Prisma.DomainOwnership` saves its row with or without DNS, needs `--adopt` for a row the stack did not record, and deletes its row on destroy. With `dns` it publishes its TXT before Prisma creates the row.
- A `Prisma.Website` with a `domain` declares a RoutingUrl and a DomainOwnership, or only the RoutingUrl when `domain.ownership` is set, and no CustomDomain; with DNS not ready it deploys and reports `pending`. With `dns` it also keeps the CNAME resource the released Alchemy declared, under its released id, so an upgraded site's CNAME is updated in place and not deleted; that resource can be dropped once sites deployed before this release have redeployed.
- A `Prisma.Website` state written by the released Alchemy is refused while planning when the workspace has a domain ownership for the hostname, and redeploys with `adopt(true)` on the site or with `ownership` from a lookup, with its CNAME still published.
- No source file in `packages/prisma/src` other than `CustomDomain.ts` and the exports refers to `Prisma.CustomDomain`.
- Released in an Alchemy version Composer can depend on.

## Waiting for the hostname, and Prisma's certificate limit (added 2026-11-20)

Will, relayed by the session coordinating the control plane's hostname routes: handling Prisma's rate limits and waits is the resource's job, not something Alchemy's team does in its test setup. "this is something that either WE do in our Alchemy PRs or nobody does. we are not telling their team to do it." What went wrong: the live DNS tests looped on `POST /v1/urls/{id}/check` every 10 seconds while a certificate order hung in Foundry. Each check on a failed certificate orders a new one, and a workspace may order 10 an hour.

Facts from the control plane (`packages/interactors/src/compute/syncRoutingUrl.ts`, `routingUrl.ts`, `domainCreationRateLimit.ts`):

- A certificate normally takes about 20 seconds. After it is issued the control plane rechecks only every 180 seconds, so `active` can lag by 3 minutes. `POST /v1/urls/{id}/check` syncs at once and costs nothing while the certificate is being issued.
- 10 new certificates per workspace per hour. Every new RoutingUrl counts, and so does each `/check` on a failed certificate. At the limit, creating a RoutingUrl still succeeds; it stays `pending` and `customDomainSyncError` reads "The workspace has reached its hourly limit of 10 new certificates. The limit resets at <ISO time>." The control plane continues on its own at that time. `/check` answers `429` with `Retry-After` when the certificate has failed and the limit is used.

Decisions as built (2026-11-24: the deploy no longer waits for the hostname to become `active`; the decisions of 2026-11-20 and 2026-11-21 about that wait and its timeout are replaced):

- With or without `dns`, a deploy returns once the row is saved, usually `pending`. A deploy never fails because the hostname is not serving yet.
- With `dns`, before a create, and before a hostname change of a row that is not yet `active`, the resource waits until every authoritative nameserver answers the CNAME it published, and fails with `RoutingUrlRecordsNotSeen` before it writes anything if one still does not. This avoids spending one of the hourly certificate orders on a hostname that does not point at Prisma yet.
- After such a save, the resource calls `/check` at most once, with no resend, and only when the row has no custom domain and its `state` is `waiting_for_dns`. That call cannot order a certificate, because none exists. It never calls `/check` on a failed certificate; a person retries that in the Console or with one check call.
- A create whose reply was lost is refused when resent. The resource then lists the Branch's RoutingUrls again and continues with its own: same service, `logicalId` and hostname.
- Every call obeys `429` and `Retry-After`.
- The resource reports Prisma's `state` next to `status`, and `certificateFailureReason` for a failed certificate.
- The resource does not detect the hourly certificate limit (Will, 2026-11-21): detecting it meant matching the English sentence in `customDomainSyncError`. A hostname at the limit is an ordinary pending hostname. Will's proposal for the platform: answer `429` with `Retry-After` when the limit stops an operation.
- The live tests do not call `/check` in a loop.
- The docs say what Will is telling Alchemy's team: a workspace can add about 10 custom hostnames an hour; every RoutingUrl a test creates counts, also one created again after deletion; count CI reruns and parallel jobs.

Done when: the decisions above are built and covered by tests, the docs and the pull request description say them, and the Prisma test files, `tsrs -b`, format and lint pass.
