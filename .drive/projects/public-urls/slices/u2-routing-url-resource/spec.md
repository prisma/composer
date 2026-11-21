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

**Over the platform's RoutingUrl routes.** Create with `POST /v1/services/{id}/urls` (`hostname`, `logicalId`, `createDomainOwnership`). Read with `GET /v1/urls/{id}`. Change the hostname, service or `logicalId` with `PATCH /v1/urls/{id}`; a request that changes nothing changes nothing on the platform too. Delete with `DELETE /v1/urls/{id}`. Find with `GET /v1/projects/{id}/branches/{id}/urls?logicalId=`. Reads return stored state and call neither DNS nor Foundry; `POST /v1/urls/{id}/check` refreshes it, and the resource does not call it.

**Attributes come from the response:** `routingUrlId`, `serviceId`, `hostname`, `logicalId`, `status`, `conditions`, `firstUnmetCondition`, `records` (each with its condition, type, name, value and ttl), `ownershipExpiry`, `heldBy`, `customDomainSyncError` and `setupUrl`. Composer's P2 prints `firstUnmetCondition`, `records` and `setupUrl`.

**Prisma's refusals are typed errors.** Since 2026-11-20 the create and update routes give each refusal its own `error.code` (`quota-exceeded`, `logical-id-taken`, `invalid-hostname`, `service-not-on-a-branch` on create, `service-on-another-branch` on update). A Distilled patch types the five, and the resource catches them by tag and raises its own error of the same name with a message that says what to do. Any other 409 or 422 becomes `RoutingUrlOperationFailed`. Nothing matches on message text.

**The domain ownership is the platform's job.** Create and update leave `createDomainOwnership` at its default, `true`. The platform then creates an `unverified` exact-hostname domain ownership when no verified one covers the hostname. The resource never records, reads into its state, or deletes a domain ownership. Deleting a RoutingUrl leaves the domain ownership in place, because it belongs to the workspace and may cover other hostnames.

**Identity is the `logicalId`.** With no stored row id, `read` looks the row up by Branch and `logicalId`. A row on the same service with the same hostname and no `logicalId` is adopted: the resource writes its `logicalId` with `PATCH` and takes it over. This is how P3 takes over the rows the platform's backfill made for existing custom domains. Any other row on the Branch with the same hostname is a conflict, and the resource fails with an error that names it. A row in another workspace that holds the hostname is not a conflict for the resource: the platform saves the row and reports the holder in `heldBy`.

**Changing the hostname of a serving row is checked here** (design note 12). The platform accepts any hostname change: it removes the old custom domain at once and holds the new hostname `pending`. So before it sends a hostname change for a row whose status is `active`, the resource checks that the new hostname can serve: its ownership is proved, and the hostname points at the regional switchboard at every authoritative nameserver. A nameserver passes when it answers the CNAME to the switchboard, or, for a hostname with no CNAME (an apex behind ALIAS, ANAME or CNAME flattening), A or AAAA answers that include a switchboard address. If not, or if DNS could not be checked from the deploying machine, it fails before changing anything, with an error that names both hostnames and the records to publish and carries a field that tells "not published" from "could not check". The check cannot see a RoutingUrl in another workspace that holds the new hostname; that limit is documented, and [plan.md](plan.md) records the platform request that would remove it. A pending row, a service change, and a removal are not checked.

**What counts as ownership proved in that check** (changed 2026-11-20, after the fifth review). Either a covering domain ownership in the workspace has status `verified`, or the hostname's TXT record with the workspace's verification value is seen at every authoritative nameserver. The first rule alone could never pass for an exact hostname: Prisma creates that hostname's domain ownership only during the update the check guards, so "publish the record and redeploy" did not work. The TXT record at the authoritative nameservers is the same evidence Prisma's own verification reads, and `Prisma.DomainOwnership` already uses it as its precondition. The resource still creates, verifies and deletes no domain ownership.

**Reuse #2701.** alchemy-run/alchemy#2701 (Sam Goodwin, paused) has the pieces this needs: `DomainVerification` to read the TXT record, `AuthoritativeDns` to wait on authoritative nameservers, and the `DomainOwnership` resource. #2701 expects create to fail with `DomainOwnershipRequired` until the record resolves. The platform now creates the domain ownership `unverified` and returns it, so #2701 would treat an unverified one as proved. We replace #2701 and its base #2698 with our own pull request that carries their Prisma parts, waits on `status`, and carries `status` and `expiresAt` in its attributes (Will, 2026-11-06). Sam is asked to close his two.

**Don't declare both resources for one exact hostname.** D2's `Prisma.DomainOwnership` takes over an `unverified` row it finds by domain without `--adopt`, and deletes it on destroy. The platform creates exactly that row for a RoutingUrl. So a stack that declares both a `Prisma.RoutingUrl` and a `Prisma.DomainOwnership` for the same exact hostname can delete the row the RoutingUrl relies on. D3's JSDoc and guide say so.

**`Prisma.CustomDomain` is deprecated, and nothing in Alchemy uses it** (Will, 2026-11-20). The platform deletes `/v1/services/{id}/domains` and its sibling routes about 2026-12-21. `Prisma.CustomDomain` keeps working until then and carries a deprecation note that names `Prisma.RoutingUrl`. Its removal from Alchemy is a later change. Composer switches in P2.

**`Prisma.RoutingUrl` takes an optional `dns`** (Will, 2026-11-20; this brings forward what design note 8 left as a follow-on, on the Alchemy side only). With a DNS adapter, the deploy publishes the TXT record that proves ownership and the CNAME to the switchboard. It publishes those two records and does nothing else: Prisma creates the domain ownership itself, so no `Prisma.DomainOwnership` is declared. The published records come from sources that are the same on every deploy (the workspace's verification endpoint and the service's switchboard address), never from the RoutingUrl's `records` attribute, which lists only records still to publish and would make the adapter delete a record in use. The records are published before the RoutingUrl is reconciled, so a hostname change with `dns` passes the check above in the same deploy. The deploy does not wait for `active`.

**`Prisma.Website` attaches its hostname with `Prisma.RoutingUrl`** (Will, 2026-11-20). A site with `domain` declares one RoutingUrl for the hostname and passes its `dns` through. It declares no `Prisma.CustomDomain` and no `Prisma.DomainOwnership`. Two behaviours change, and the guide says so: a site whose DNS is not ready now deploys and reports `pending` where it used to fail, and its `url` is the hostname's URL from the first deploy. A site deployed with the released Alchemy (a CNAME published through the adapter and a `Prisma.CustomDomain`) must keep serving through the upgrade deploy: the RoutingUrl takes over the row Prisma recorded for the custom domain, and removing the old `Prisma.CustomDomain` and the old DNS records must not delete that row or the records the hostname now relies on.

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
- With `dns`, a first deploy publishes exactly the TXT and the CNAME; a redeploy after the row is `active` with an empty `records` list removes nothing; destroy removes both records and sends no domain ownership request.
- A `Prisma.Website` with a `domain` declares a RoutingUrl and no CustomDomain or DomainOwnership; with DNS not ready it deploys and reports `pending`. With `dns` it also keeps the CNAME resource the released Alchemy declared, under its released id, so an upgraded site's CNAME is updated in place and not deleted; that resource can be dropped once sites deployed before this release have redeployed.
- A `Prisma.Website` state written by the released Alchemy redeploys with one row for the hostname left on the platform and its DNS records still published, and a test proves no delete was sent for that row.
- No source file in `packages/prisma/src` other than `CustomDomain.ts` and the exports refers to `Prisma.CustomDomain`.
- Released in an Alchemy version Composer can depend on.

## Waiting for the hostname, and Prisma's certificate limit (added 2026-11-20)

Will, relayed by the session coordinating the control plane's hostname routes: handling Prisma's rate limits and waits is the resource's job, not something Alchemy's team does in its test setup. "this is something that either WE do in our Alchemy PRs or nobody does. we are not telling their team to do it." What went wrong: the live DNS tests looped on `POST /v1/urls/{id}/check` every 10 seconds while a certificate order hung in Foundry. Each check on a failed certificate orders a new one, and a workspace may order 10 an hour.

Facts from the control plane (`packages/interactors/src/compute/syncRoutingUrl.ts`, `routingUrl.ts`, `domainCreationRateLimit.ts`):

- A certificate normally takes about 20 seconds. After it is issued the control plane rechecks only every 180 seconds, so `active` can lag by 3 minutes. `POST /v1/urls/{id}/check` syncs at once and costs nothing while the certificate is being issued.
- 10 new certificates per workspace per hour. Every new RoutingUrl counts, and so does each `/check` on a failed certificate. At the limit, creating a RoutingUrl still succeeds; it stays `pending` and `customDomainSyncError` reads "The workspace has reached its hourly limit of 10 new certificates. The limit resets at <ISO time>." The control plane continues on its own at that time. `/check` answers `429` with `Retry-After` when the certificate has failed and the limit is used.

Decisions:

- With `dns`, the deploy waits for the hostname to become `active`, because the resource published the records and nothing else is needed. Without `dns` it still returns `pending` at once: a person has to publish the records, and deploying before DNS exists is the point of the resource.
- The wait has a fixed limit long enough for a normal certificate plus the 180-second recheck. When it runs out the deploy fails with a typed error that names the first unmet condition and quotes `customDomainSyncError`.
- When Prisma reports the hourly certificate limit, the deploy fails with an error that says so and when the limit resets, and says that Prisma continues on its own and a redeploy after that time picks the hostname up.
- A failed wait never creates the RoutingUrl again: the next deploy finds the saved row. The resource calls `/check` only where the control plane code shows it cannot order a certificate, and never in a loop on a failed certificate.
- Every call obeys `429` and `Retry-After`.
- The live tests stop calling `/check` in a loop; they read `active` from the deploy.
- The docs say what Will is telling Alchemy's team: a workspace can add about 10 custom hostnames an hour; every RoutingUrl a test creates counts, also one created again after deletion; count CI reruns and parallel jobs.

Done when: the above is built and covered by tests, the docs and the pull request description say it, and the Prisma test files, `tsrs -b`, format and lint pass.

Decisions added after the eighth and ninth reviews (2026-11-21):

- Prisma looks at a hostname's DNS only when the RoutingUrl is written or checked, never when it is read. So with `dns` the resource first sees both records at the authoritative nameservers. If one is still absent it fails before it writes anything (`RoutingUrlRecordsNotSeen`), which also avoids spending one of the hourly certificate orders on a hostname that does not point at Prisma yet.
- The resource calls `/check` at most once per deploy, with no resend, and only when the row has no custom domain and Prisma's `state` is `not_verified` or `waiting_for_dns`. In that case the call cannot retry a certificate, because none exists.
- The wait ends at once, with the reason, when waiting cannot help: a failed certificate (read from the custom domain's status, because `state` shows `certificate_failed` only when no earlier state applies), a hostname in use by another RoutingUrl (`state` is `in_use_elsewhere`), or the hourly limit. A failed certificate is retried by a person, in the Console or with one check call; the resource never retries it.
- The wait runs when the resource has no stored output, when the hostname changed, or when `dns` was just added. A hostname that served and later stops does not fail later deploys.
- A create whose reply was lost is refused when resent. The resource then lists the Branch's RoutingUrls again and continues with its own: same service, `logicalId` and hostname.
- The resource reports Prisma's `state` next to `status`. `status` records that the hostname went live; `state` says what it is doing now.
