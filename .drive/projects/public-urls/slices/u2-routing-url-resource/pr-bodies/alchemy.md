`Prisma.RoutingUrl` gives a Prisma app a hostname. With `dns` it publishes the records and waits until the hostname serves; without `dns` it deploys before the hostname's DNS exists. `Prisma.Website` now uses it for `domain`.

```ts
const url = yield* Prisma.RoutingUrl("api", {
  app: api,
  hostname: "api.example.com",
  dns: Cloudflare.DNS.Adapter(), // optional
});
// publishes  TXT   _prisma-verification.api.example.com  (proves the workspace owns the hostname)
//            CNAME api.example.com -> switchboard.{region}.prisma.build
// then waits, about 7 minutes at most, until url.status is "active"
```

Without `dns` the deploy succeeds at once with `status: "pending"`, and `url.records` lists the records to publish by hand.

**Why now:** Prisma has deprecated its custom domain routes (`/v1/services/{id}/domains`, `/v1/domains/{id}`) and deletes them about 2026-12-21. A RoutingUrl is their replacement in Prisma's API. `Prisma.CustomDomain` and every `Prisma.Website` with a `domain` call the old routes today.

### How a RoutingUrl works

1. **The deploy saves the hostname first.** Prisma stores it as `pending` and makes it `active` when the TXT record and the CNAME resolve. `Prisma.CustomDomain` failed the deploy until both existed.
2. **Each hostname proves itself.** Prisma creates the domain ownership for that exact hostname when it saves the RoutingUrl. The resource never creates or deletes one, so no stack can remove a proof another stack relies on.
3. **`dns` publishes the two records and nothing else.** They come from the workspace's verification endpoint and the app's switchboard address, which are the same on every deploy. Nothing is published under `alchemy dev`.
4. **With `dns`, the deploy waits until the hostname has served once.** It first sees both records at the authoritative nameservers, then saves the RoutingUrl and reads it every 10 seconds. A later deploy does not wait again. It fails at once, with the reason, when waiting cannot help: `RoutingUrlRecordsNotSeen` (nothing saved), `RoutingUrlNotActive` (the certificate failed, another RoutingUrl holds the hostname, or the wait ran out on a named condition), `RoutingUrlCertificateLimitReached` (says when the limit resets). The next deploy finds the saved RoutingUrl and never creates a second one.
5. **A workspace can order about 10 certificates an hour.** Each new hostname, each hostname change and each certificate ordered again counts, so tests count their RoutingUrls, CI reruns and parallel jobs. The resource asks Prisma to check a hostname at most once per deploy, and never when a certificate exists, because a check on a failed certificate orders another.
6. **It finds its own record in Prisma by `logicalId`**, which defaults to the resource's fully qualified name. With no saved state it takes a record without `--adopt` only when that record is on its own app: one with its `logicalId`, or one with no `logicalId` and its hostname. That second case is how it takes over the record Prisma keeps for an existing custom domain. A matching `logicalId` on another app needs `--adopt`, as `Prisma.App` requires.
7. **Changing the hostname of a serving RoutingUrl is checked first.** Prisma would accept the change and stop serving the old hostname at once. So the resource sends it only when the new hostname's TXT record is proved (a `verified` domain ownership covers it, or every authoritative nameserver answers the record) and the hostname points at the switchboard. Otherwise it fails with `RoutingUrlHostnameChangeRefused` and changes nothing. With `dns`, the new records are published before the check and the old ones are removed after the change is saved.
8. **Prisma's refusals are typed errors**, caught by the tags alchemy-run/distilled#1348 generates: `RoutingUrlQuotaExceeded`, `RoutingUrlLogicalIdTaken`, `RoutingUrlInvalidHostname`, `RoutingUrlServiceNotOnABranch`, `RoutingUrlServiceOnAnotherBranch`.

### `Prisma.Website`

```ts
yield* Prisma.Website.StaticSite("Site", {
  domain: { name: "app.example.com", dns: Cloudflare.DNS.Adapter() },
});
```

- A site with a plain `domain` deploys before its DNS is ready and reports `pending`. It used to fail. With `dns` it waits until the hostname serves.
- A site deployed with the released version keeps serving through the upgrade: its RoutingUrl takes over the record Prisma kept for its custom domain, and its CNAME is updated in place.

**Breaking:** `site.domain` is a RoutingUrl.

```diff
-site.domain.dnsRecords
+site.domain.records
-site.domain.foundryStatus
+site.domain.status              // "pending" | "active"
+site.domain.state               // what the hostname is doing now, e.g. "waiting_for_dns"
+site.domain.firstUnmetCondition
-site.domain.customDomainId
+site.domain.routingUrlId
```

Upgrade with the same `domain` first, and change the hostname in a later deploy.

### `Prisma.CustomDomain` and `Prisma.DomainOwnership`

`Prisma.CustomDomain` is deprecated. Replace it with a RoutingUrl for the same hostname in one deploy:

```diff
-yield* Prisma.CustomDomain("api", { app: api, hostname: "api.example.com" });
+yield* Prisma.RoutingUrl("api", { app: api, hostname: "api.example.com" });
```

Until the routes go it keeps working: it now fails with `PrismaDomainOwnershipRequired`, which names the TXT record, when Prisma refuses a hostname for want of proof.

`Prisma.DomainOwnership` proves a wildcard once, for many hostnames:

```ts
yield* Prisma.DomainOwnership("example.com", {
  project,
  domain: "*.example.com",
  dns: Cloudflare.DNS.Adapter(),
});
```

It counts as proved only when Prisma reports it `verified`. One it did not create needs `--adopt` once it is `verified`, and destroying it removes the domain ownership and its TXT record.

This replaces #2698 and #2701 and keeps their design. Both were written when Prisma refused to create a domain ownership until its TXT record resolved, so they treat a successful create as proof. Prisma now creates it as `unverified` at once.

Depends on alchemy-run/distilled#1348. `submodules/distilled` points at that branch rebuilt on the commit Alchemy pins today, and moves to a Distilled `main` commit when it merges.

### Alternatives considered

- **Feeding the DNS adapter from `url.records`.** That list holds only the records Prisma still wants, so a record would leave it once found and the adapter would delete it.
- **The RoutingUrl owning its domain ownership**, and deleting it on destroy. A domain ownership belongs to the workspace and can cover other hostnames, so a preview's destroy could remove production's proof.
- **Leaving the hostname-change check to Prisma's API.** It belongs there, and we own that API. It is not built, and without the check a deploy can take a serving hostname down.
- **Publishing DNS only in `Prisma.Website`.** A hostname for a plain `Prisma.App` would then need its records published by hand.

Agent: prospero-20

🤖 Generated with [Claude Code](https://claude.com/claude-code)
