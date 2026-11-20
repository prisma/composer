Adds `Prisma.RoutingUrl`, a hostname that serves a Prisma app and can be saved before its DNS exists, moves `Prisma.Website` onto it, and deprecates `Prisma.CustomDomain`.

```ts
const url = yield* Prisma.RoutingUrl("api", {
  app: api,
  hostname: "api.example.com",
  dns: Cloudflare.DNS.Adapter(),
});
// publishes TXT _prisma-verification.api.example.com and CNAME api.example.com -> switchboard.{region}.prisma.build
// url.status: "pending", then "active" once Prisma has found both records
```

Without `dns` the deploy still succeeds, and `url.records` lists what to publish by hand.

Why now: Prisma has deprecated its custom domain routes (`/v1/services/{id}/domains`, `/v1/domains/{id}` and the `/v1/apps/{appId}/domains` aliases) and deletes them about 2026-12-21. `Prisma.CustomDomain` and every `Prisma.Website` with a `domain` call them today.

This replaces #2698 and #2701. Both were written when Prisma refused to create a domain ownership until its TXT record resolved, so they treat a successful create as proof. Prisma now always creates it as `unverified`, so that code would report an unproved domain as proved.

### `Prisma.RoutingUrl`

The deploy creates the row in Prisma at once and succeeds. Prisma makes the row `active` once the TXT record and the CNAME resolve. Prisma also creates the domain ownership for the exact hostname; the resource never creates, verifies or deletes one. That is the per-hostname TXT record, with no shared ownership for stacks to fight over.

1. **Identity is the `logicalId`**, which defaults to the resource's fully qualified name (`Site/Url` for a `Url` declared inside `Site`). With no stored id, the row with that `logicalId` on the service's Branch is this resource's. A row for the same service and hostname with no `logicalId` is taken over by writing its `logicalId`; Prisma recorded every existing custom domain as such a row on 2026-11-17.
2. **Another row on the Branch with the hostname** fails the deploy with `RoutingUrlHostnameTaken`, which names it.
3. **Changes** to the hostname, the service or the `logicalId` are sent as one `PATCH`. A redeploy with nothing changed sends none.
4. **A hostname change on an `active` row is checked first.** Prisma itself would accept the change and stop serving the old hostname at once, so the resource refuses it, before any `PATCH`, with `RoutingUrlHostnameChangeRefused`, unless the new hostname can serve:
   - its ownership is proved: a `verified` domain ownership covers it (exact or wildcard), or its TXT record is seen at every authoritative nameserver, which is the evidence Prisma's own verification reads; and
   - it points at the switchboard at every authoritative nameserver: a CNAME to the switchboard, or, for a hostname with no CNAME (an apex behind CNAME flattening, ALIAS or ANAME), A or AAAA answers that include a switchboard address. A CNAME to any other name does not pass.

   The error names both hostnames and the records to publish. Its `ownership` and `switchboardDns` fields say whether each was seen, absent, or could not be checked from this machine, so a caller need not read the message.
5. **Prisma's refusals are typed errors**, caught by the tag Distilled generates from the code in the response: `RoutingUrlQuotaExceeded` and `RoutingUrlLogicalIdTaken` (409), `RoutingUrlInvalidHostname`, `RoutingUrlServiceNotOnABranch` (create) and `RoutingUrlServiceOnAnotherBranch` (update) (422). Any other 409 or 422 is `RoutingUrlOperationFailed`. The resource also raises `RoutingUrlServiceNotOnABranch` itself, before any request, when it reads a service with no Branch. These errors keep Distilled's names because each is the same refusal with a message that says what to do; `PrismaDomainOwnershipRequired` keeps its prefix because #2698 introduced it under that name.
6. **Destroy** deletes the row and sends no domain ownership request.

#### `dns`

With a DNS adapter, the deploy publishes the two records and nothing else.

- The records come from the workspace's verification endpoint and the service's switchboard address, which are the same on every deploy. They do not come from the row's `records` attribute: that lists only records still to publish, so a record would leave the list once Prisma saw it and the adapter would delete it.
- Each hostname has its own record set, published before the row is saved. On a hostname change the new hostname's records exist when the check above runs, and the old hostname's records are removed only after the change is saved. A refused change leaves them published.
- Both records are published DNS-only, also when the adapter proxies aliases, so Prisma can see the CNAME.
- Nothing is published under `alchemy dev`.
- A wildcard hostname is refused before anything is published.
- Limits, all in the JSDoc and the Compute guide: a zone apex needs a DNS host that flattens a CNAME at the apex; the first deploy replaces an existing CNAME at the hostname without waiting for `active`, so a hostname moving from another host stops serving there first; removing `dns` removes the records; a record already published with the same value is treated as the resource's own and removed on destroy.

A caller that builds its own provider list registers the resource with `Prisma.RoutingUrlResources` and `Prisma.RoutingUrlProvider()`. `Prisma.RoutingUrl` is a function, so it has no `.ref` or `.Provider`. Two read-only resource types now appear in a stack's state: `Prisma.RoutingUrlRequiredRecords` (the two records a hostname needs, with `dns`) and `Prisma.DomainVerification` (the workspace's TXT record, for `Prisma.DomainOwnership`). Neither creates anything in Prisma.

Two known limits of the hostname-change check. A RoutingUrl in another workspace that holds the new hostname is not seen, so the change goes through and the new hostname stays `pending` behind `heldBy`. And the check does not cover the certificate, so the new hostname can be without TLS for a short time after an allowed change.

### `Prisma.Website`

A site with a `domain` declares one `Prisma.RoutingUrl` and passes `dns` through. It no longer declares a `Prisma.CustomDomain`.

- **A site whose DNS is not ready now deploys** and reports `pending`, where it used to fail. The deploy does not wait for `active`.
- **Breaking: `site.domain` is the RoutingUrl.** `records` replaces `dnsRecords`, `status` and `firstUnmetCondition` replace `foundryStatus` and `failureReason`, and `routingUrlId` replaces `customDomainId`.
- **Upgrading a deployed site keeps it serving.** The RoutingUrl takes over the row Prisma recorded for the site's custom domain, and `Prisma.CustomDomain`'s delete now skips a row a RoutingUrl has taken over. With `dns`, the site still declares the CNAME alias the released version declared, under its released id, so the upgrade updates that record in place; removing it would delete the CNAME on Cloudflare. It is declared with `adopt(true)`, because the RoutingUrl's record set publishes the same CNAME first, and with `RemovalPolicy.retain()`, so a later release can drop it. Both take the value from one source.
- **Upgrade first, change the hostname in a later deploy.** Doing both at once creates a new row and deletes the old custom domain, with no check.

### `Prisma.CustomDomain`

Marked `@deprecated` with the date. Its other changes keep it working until the routes go: it moves to Distilled's `/v1/services` routes, reads the create's status from Distilled's new `httpStatus`, takes an optional `ownership` so it can be ordered after a `Prisma.DomainOwnership`, fails with `PrismaDomainOwnershipRequired` (which names the TXT record) when Prisma refuses the hostname for want of proof, and its delete skips a row taken over by a RoutingUrl. To replace one with a RoutingUrl for the same hostname, do it in one deploy. Nothing else in `packages/prisma/src` uses it.

### `Prisma.DomainOwnership`

Proves a wildcard once, so RoutingUrls under it need no TXT record each.

```ts
yield* Prisma.DomainOwnership("example.com", {
  project,
  domain: "*.example.com",
  dns: Cloudflare.DNS.Adapter(),
});
```

Carried over from #2701, with the proof corrected for how Prisma behaves now:

1. Look the domain ownership up, by stored id or by domain. Only `verified` counts as proved; `unverified` and `expiring` do not.
2. Read the TXT record from `GET /v1/workspaces/{id}/domain-ownerships/verification` and ask every authoritative nameserver for it. If a nameserver answers without it, fail with `PrismaDomainOwnershipRequired`, which names the record, and create nothing.
3. If the record is seen, or no nameserver could be reached, create the domain ownership if there is none and call verify until Prisma reports `verified`, up to 6 more times, 5 seconds apart. When DNS could not be checked from this machine, Prisma's own lookup decides.

A domain ownership the resource did not record needs `--adopt` when it is `verified` or `expiring`, since it may keep someone's hostnames serving. An `unverified` one is taken over without `--adopt`, which also lets a deploy that failed after the create succeed on the next run. No failure deletes anything. Destroy deletes the domain ownership and its TXT record.

Don't declare one for the same exact hostname as a `Prisma.RoutingUrl`: it would take over the domain ownership Prisma created for the RoutingUrl and delete it on destroy.

### Also in this pull request

- `internal/AuthoritativeDns`, from #2701, now answers `seen`, `absent` or `unknown`, can be replaced in tests, and each caller states where its nameserver search starts.
- The Compute guide and the Website guide lead with `Prisma.RoutingUrl`; the framework pages no longer name `Prisma.CustomDomain`.
- The Cloudflare, email, skills and scripts changes that reached #2701 through merges from main are not included.

Depends on the alchemy-run/distilled pull request from `feat/prisma-routing-urls` (the HTTP status on creates and the typed RoutingUrl refusals). `submodules/distilled` must be pinned to a Distilled commit that contains it. The branch currently pins the same Distilled commits rebuilt on the commit Alchemy pins today, because Alchemy does not build against Distilled `main`.

Agent: prospero-20

🤖 Generated with [Claude Code](https://claude.com/claude-code)
