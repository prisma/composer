Prisma Compute, the hosting service, removes its custom domain API about 2026-12-21. `Prisma.CustomDomain` and every `Prisma.Website` with a `domain` use that API today, so after that date they stop deploying. This pull request moves custom hostnames to the API that replaces it, as two resources:

- **`Prisma.DomainOwnership`** proves that your Prisma workspace owns a domain. It is published as a `TXT` record.
- **`Prisma.RoutingUrl`** sends one hostname to one app. It is published as a `CNAME` record.

Both are deployed without waiting for the hostname to serve. `Prisma.Website` now declares both for its `domain`, and `Prisma.CustomDomain` is deprecated.

```ts
const project = yield* Prisma.Project("App", { createDatabase: false });
const api = yield* Prisma.Compute("Api", { project, path: "./api", entrypoint: "server.ts" });
const dns = Cloudflare.DNS.Adapter(); // publishes the records in your Cloudflare zone

// Publishes TXT _prisma-verification.api.example.com
yield* Prisma.DomainOwnership("ApiDomain", { project, domain: "api.example.com", dns });

// Publishes CNAME api.example.com -> switchboard.{region}.prisma.build
const url = yield* Prisma.RoutingUrl("Api", { app: api, hostname: "api.example.com", dns });
// url.status is "pending" when the deploy ends; Prisma makes it "active" on its own
```

The two resources are not linked by a value. Prisma matches them by hostname: a RoutingUrl serves once a verified domain ownership covers its hostname, either for that exact hostname or for the wildcard one label above it (`*.example.com`). The switchboard is Prisma's regional entry point, which receives a custom hostname's traffic and routes it to the app.

### What users must do

- **A site deployed with the released Alchemy is refused on its first deploy after the upgrade, and its code must change for that deploy.** Details below.
- **The hostname can stop serving about 30 days after Prisma made its domain ownership.** Prisma made one for each older site as `expiring`, and lapses it after its `expiresAt` unless its `TXT` is published. With `dns` and `adopt(true)`, the site publishes the `TXT` for you.
- **Upgrade a site with the same `domain` first, and change the hostname in a later deploy.** A deploy that upgrades and changes the hostname at once stops serving the old hostname without checking that the new one can serve.
- **`site.domain` is now a `Prisma.RoutingUrl`**, and the site gains `site.domainOwnership` (`Prisma.DomainOwnership | undefined`):

  ```diff
  -site.domain.dnsRecords
  +site.domain.records             // the records Prisma has not found yet
  -site.domain.foundryStatus
  +site.domain.status              // "pending" | "active"
  +site.domain.state               // what the hostname waits for, e.g. "waiting_for_dns"
  -site.domain.customDomainId
  +site.domain.routingUrlId
  ```

- **A site whose DNS is not ready now deploys and reports `pending`.** It used to fail. `site.url` is the custom hostname from the first deploy, so a smoke test right after deploy may reach a hostname that does not serve yet.
- **A deployer whose token is limited to one project can no longer deploy a site with a custom domain.** The same applies to a deployer without `workspaceManage`, Prisma's permission to manage a workspace. Every domain ownership request needs that permission, and the released site needed none. We accept this regression for now because no such deployer needs it yet. Fixing it needs Prisma to open two read requests to project tokens.

### Upgrading a site deployed with the released Alchemy

The hostname keeps serving through the upgrade. Prisma already keeps a RoutingUrl record for every older custom domain, on the site's own app, with no identity of its own. The site's new RoutingUrl takes that record over without `--adopt`, because no other stack can have declared it. The site's `CNAME` stays published.

The domain ownership is different. Prisma made one for each older custom domain, so the domain ownership the site now declares already exists and is not in the stack's state. Alchemy does not take over a resource it did not create unless told to, so the deploy stops while it is planned, before anything changes. The refusal names `Prisma.DomainOwnership`, or with `dns` `Prisma.DomainVerification` (an internal resource that checks for an existing domain ownership before the `TXT` is published), and says to re-run with `--adopt`. The user picks one of two fixes for that deploy:

```ts
// The site should own it (one site on its hostname). Read `alchemy plan` first:
// adopt(true) adopts every resource of the site.
yield* Prisma.Website.Vite("Web", { project, domain: { name: "app.example.com", dns } }).pipe(adopt(true));

// It is managed elsewhere, for example shared by several sites:
const ownership = Prisma.DomainOwnership.lookup({ project, domain: "app.example.com" });
yield* Prisma.Website.Vite("Web", { project, domain: { name: "app.example.com", dns, ownership } });
```

The websites guide (`website/src/content/docs/prisma/frontend/websites.mdx`, updated here) says which fix fits when.

### `Prisma.DomainOwnership`

A domain ownership belongs to the whole workspace, and one can cover many hostnames. Prisma gives it one of three statuses:

- `unverified`: Prisma has not found its `TXT`, so it makes no hostname serve.
- `verified`: Prisma has found its `TXT`.
- `expiring`: Prisma can no longer find its `TXT`. It makes no new hostname serve. Hostnames that already serve keep serving until `expiresAt`, when Prisma lapses it back to `unverified`.

The resource is ordinary create, read, update and delete, like any Alchemy resource. Destroying it deletes the domain ownership in Prisma, and with `dns`, its `TXT`. One that the stack did not create needs `--adopt`, whatever its status. Without `dns`, it is saved at once, and you publish `recordName` with `recordValue` yourself. With `dns`, it publishes the `TXT` and waits up to 3 minutes to see it at the domain's authoritative nameservers before Prisma creates the domain ownership. The wait exists because Prisma looks the record up during the create and caches a miss. If the record never appears, the deploy still succeeds, with the domain ownership `unverified`.

Prisma changes the status on its own, so a deployed domain ownership that is not `verified` logs a warning naming its `TXT`, and is read again on every deploy. `alchemy plan` therefore lists it as an update until Prisma verifies it. Alchemy has no other way to refresh one resource: it re-reads only resources it has no state for, and drift detection reads every resource. `Prisma.Deployment` does the same for a failed deployment. That update does not wait: it looks for the `TXT` once, and only if it is there, about 10 seconds later asks Prisma to verify.

`Prisma.DomainOwnership.lookup({ project, domain })` uses a domain ownership the stack does not manage, such as one made in the Prisma Console. It is read while the deploy is planned and is never changed.

A domain ownership's `domain` can be a wildcard; a RoutingUrl's `hostname` and a site's `domain.name` cannot.

### `Prisma.RoutingUrl`

The deploy ends once Prisma has saved the RoutingUrl, usually as `pending`. Prisma makes it `active` a few minutes later, once a verified domain ownership covers the hostname, the `CNAME` points at the switchboard, and the TLS certificate is issued.

With `dns`, it waits up to 3 minutes before Prisma first looks at a new hostname, until every authoritative nameserver answers the `CNAME` it just published. If it never appears, usually because the domain is not delegated to that DNS host, it fails with `RoutingUrlRecordsNotSeen` before writing anything. Apart from the hostname-change check below, this is the only case where DNS that is not ready fails a deploy. The wait exists because a workspace may order only 10 TLS certificates an hour, every new hostname and hostname change orders one (CI reruns and parallel tests included), and a hostname not yet pointing at Prisma would waste one. For the same reason the resource asks Prisma to look at a hostname's DNS at most once per deploy: asking again on a failed certificate orders another. At the limit the hostname stays `pending`, and its `customDomainSyncError` (Prisma's last error setting up the certificate) says when the limit resets.

Prisma accepts a hostname change on a RoutingUrl that serves, and stops serving the old hostname at once. So for an `active` RoutingUrl, the resource first checks two things. The workspace must own the new hostname: a verified domain ownership covers it, or every authoritative nameserver answers the `TXT` of one that does. The new hostname must also point at the switchboard. If either is missing, it fails with `RoutingUrlHostnameChangeRefused`, which names the records to publish, and nothing changes. A `pending` RoutingUrl serves nothing, so its hostname change is not checked. With `dns`, it waits for the new `CNAME` as a create does.

Instead of declaring a `Prisma.DomainOwnership`, a stack that should not manage a workspace-wide resource can set `createDomainOwnership: true`. Prisma then creates one for the exact hostname, which the stack does not track and which stays when the RoutingUrl is destroyed. Use one or the other for a hostname: with both, the `Prisma.DomainOwnership` can need `--adopt`. With no domain ownership at all, the RoutingUrl stays `pending` with `state: "no_domain_ownership"`, and the deploy warns.

Prisma's refusals are typed errors, such as `RoutingUrlQuotaExceeded` and `RoutingUrlLogicalIdTaken`.

### `Prisma.Website`

A site with `domain` declares a RoutingUrl and a domain ownership for its exact hostname, so one stack deploys a complete site:

```ts
const site = yield* Prisma.Website.Vite("Web", { project, domain: { name: "www.example.com", dns } });
// site.domain: the RoutingUrl; site.domainOwnership: the domain ownership the site declared
```

Destroying the site deletes both. That is safe where a RoutingUrl deleting its domain ownership would not be (see the alternatives), because the user chooses it: the site's own domain ownership covers only its exact hostname, which only this site serves, and a domain ownership that other hostnames rely on is passed as `domain.ownership` and left in place.

Several sites under one domain share one domain ownership through `domain.ownership`, declared in the stack or found with `lookup`. A site given `ownership` declares none of its own and leaves that one in place when destroyed. If `ownership` does not cover the site's hostname, the deploy stops before the hostname is saved.

```ts
const example = yield* Prisma.DomainOwnership("Example", { project, domain: "*.example.com", dns });
yield* Prisma.Website.Vite("Web", { project, domain: { name: "www.example.com", dns, ownership: example } });
yield* Prisma.Website.Vite("Docs", { project, domain: { name: "docs.example.com", dns, ownership: example } });
```

### `Prisma.CustomDomain`

It is deprecated, and nothing else in Alchemy uses it now. It keeps working until Prisma removes the API. When Prisma refuses a hostname because the workspace has not proved it owns it, it now fails with `PrismaDomainOwnershipRequired`, which names the `TXT` to publish. It also retries a create that Prisma refused for too many requests.

To move a hostname, replace it with a RoutingUrl for the same app and hostname in one deploy. The hostname keeps serving, because the RoutingUrl takes over Prisma's record of the custom domain. In the same deploy, declare a `Prisma.DomainOwnership` for the hostname with `dns`, and with `adopt(true)` for that one deploy, because Prisma already made one. Without it, the domain ownership Prisma made is `expiring`, as described above.

```diff
-yield* Prisma.CustomDomain("Api", { app: api, hostname: "api.example.com" });
+yield* Prisma.RoutingUrl("Api", { app: api, hostname: "api.example.com", dns });
+yield* Prisma.DomainOwnership("ApiDomain", { project, domain: "api.example.com", dns }).pipe(adopt(true));
```

### Distilled, and the submodule

This change needs two Distilled changes to the generated Prisma SDK:

- alchemy-run/distilled#1348, merged, types the RoutingUrl refusals.
- alchemy-run/distilled#1508 regenerates the SDK from Prisma's 2026-11-26 spec, which adds the `no_domain_ownership` state.

Alchemy `main` pins a Distilled commit (`f0b37d720d`) that is 127 commits behind #1348. Moving the pin that far is a separate change. So **`submodules/distilled` points at a branch on the wmadden-electric fork** (`feat/prisma-routing-urls-on-alchemy-pin`), which has both changes rebuilt on the pinned commit. Once the second Distilled pull request merges, maintainers should move the submodule to a Distilled `main` commit before or when this merges.

This supersedes Sam Goodwin's closed #2701 (`Prisma.DomainOwnership`, proved automatically for site domains) and its base #2698 (a typed error for the missing `TXT`). It carries their DNS-checking parts.

### Limitation

The check before a hostname change belongs in Prisma's API, and runs here until Prisma has it. From the deploying machine it cannot see a RoutingUrl in another workspace that holds the new hostname; the change then goes through, and the new hostname stays `pending` with `state: "in_use_elsewhere"`.

### Alternatives considered

- **The RoutingUrl's `dns` also publishes the `TXT`.** The `TXT` proves the domain ownership, not the RoutingUrl, and one `TXT` can prove many hostnames. So the domain ownership publishes it.
- **The deploy waits until the hostname serves.** Prisma makes the hostname `active` on its own. Waiting made deploys take several minutes, and they could fail on a certificate that Prisma would issue anyway.
- **A RoutingUrl that creates and deletes its domain ownership itself.** A domain ownership can cover other hostnames, so destroying a preview could remove production's proof. A separate resource lets the stack decide its lifetime.
- **Taking over an existing domain ownership without `--adopt`**, in the resource or in the site. No other Alchemy resource does that, and the stack would later delete a domain ownership that someone else relies on.
- **A site that sets `createDomainOwnership: true` instead of declaring a domain ownership.** The stack would then not manage the domain ownership its site depends on, so it could not deploy a complete site.

Agent: lassie-43
