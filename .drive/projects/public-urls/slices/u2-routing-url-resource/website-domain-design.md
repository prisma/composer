# Design: a Prisma site's custom domain and its domain ownership

Status: version 3, 2026-11-25, revised after two rounds of architect and principal engineer reviews in [reviews/website-domain/](reviews/website-domain/). Replaces decision 5 and correction 8 of [domain-ownership-crud-plan.md](domain-ownership-crud-plan.md) for `Prisma.Website`. Everything else in that plan stands.

Two behaviours were added during the code reviews, after version 3, and Will accepted both on 2026-11-25 ("Accept both"): a domain ownership declared in the stack logs a warning about itself while it is `unverified` or `expiring`, and an unverified one is read again on every deploy, so `alchemy plan` lists it as an update until Prisma verifies it (step 4 of "With ownership", and the revision after it).

## What Will asked for

- "Let's aim for consistency with Alchemy's existing solutions."
- "I suspect the team's expectation is that a user can deploy a whole site, completely, from a single Alchemy stack."
- "Prisma's model is that you can deploy a service and its routingurl independently of its DO. Everything will work, but it won't receive traffic."
- "In the case you're deploying a single thing, you probably want to also include your DO."
- "If you're deploying multiple sites or apps under one domain, you need to ensure you have a DO, but you don't want it owned by a single site/app."
- "yes, drop adopt(true) and follow the existing patterns Alchemy uses as closely as possible."

## At a glance

```ts
const dns = Cloudflare.DNS.Adapter();

// One site: the site declares its own domain ownership for its hostname.
yield* Prisma.Vite("Web", { project, domain: { name: "www.example.com", dns } });

// Several sites under one domain: one domain ownership, declared once, used by each site.
const example = yield* Prisma.DomainOwnership("Example", { project, domain: "*.example.com", dns });
yield* Prisma.Vite("Web", { project, domain: { name: "www.example.com", dns, ownership: example } });
yield* Prisma.Vite("Docs", { project, domain: { name: "docs.example.com", dns, ownership: example } });

// A domain ownership this stack does not manage: made in the Console or by another stack.
const shared = Prisma.DomainOwnership.lookup({ project, domain: "*.example.com" });
yield* Prisma.Vite("Web", { project, domain: { name: "www.example.com", dns, ownership: shared } });
```

## The Alchemy patterns this follows

- **The AWS site's standalone domain** (`packages/aws/src/Website/shared.ts`, `WebsiteStandaloneDomainProps`; `SsrSite.ts`). The site creates what its hostname needs, an ACM certificate, and returns it as an output. It takes an existing certificate through `cert` to skip creating one. Our default is the same: the site creates the domain ownership for its own hostname and returns it.
- **Passing the resource itself.** Alchemy props that depend on another resource take that resource: the Hetzner site's `zone`, Cloudflare's `X.ref(...)`, and in this package `Prisma.CustomDomain`'s `ownership` (`CustomDomain.ts:69-75`), which is the same name for the same concept. `domain.ownership` takes a `Prisma.DomainOwnership`.
- **`Resource.lookup`** (`AGENTS.md`, `Resource.ts`). Alchemy's way to use a resource the stack does not manage. This package implements it on Project, App, Database, Branch and Bucket, and `Project.ts:181-192` documents the same case: a resource "created in the Prisma Console or by another stack". `Prisma.DomainOwnership.lookup({ project, domain })` is added for this.
- **Adoption** (`AGENTS.md`, `AdoptPolicy.ts`). A resource that exists but is not in the stack's state is refused unless the user passes `--adopt` or pipes `adopt(true)`. The site does not pipe `adopt(true)` into the domain ownership it declares. It keeps the one exception it already has, `DomainAlias` (`WebsiteDomain.ts:75`): that alias is retained, so adopting it never leads to a delete, and it exists only to carry the CNAME of sites deployed with the released Alchemy through their upgrade.

## The design

### The type

```ts
export type WebsiteDomain =
  | string
  | {
      name: string;
      dns?: DNS.DnsConfig;
      /**
       * A domain ownership that covers `name` and is managed outside this
       * site: one declared in this stack, or `Prisma.DomainOwnership.lookup`
       * for one made in the Console or by another stack. The site declares
       * no domain ownership and leaves this one when it is destroyed.
       * Omitted: the site declares one for `name`.
       */
      ownership?: DomainOwnership;
    };
```

A plain string hostname behaves like `{ name }`.

### Without `ownership`: the site declares its own

1. The site declares `Prisma.DomainOwnership("DomainOwnership", { project, domain: name, dns })`, with the site's project and `domain.dns`. With `dns`, the TXT record is published and the deploy waits for it before Prisma creates the row, as the domain ownership already does.
2. The site declares its RoutingUrl (`Url`, unchanged) with `createDomainOwnership` left at `false`, saved after the domain ownership (see "Order" below). With `dns`, the RoutingUrl publishes only the CNAME, as today.
3. Destroying the site deletes the domain ownership and, with `dns`, both records.

The id is fixed (`DomainOwnership`). A hostname change changes `domain`, which replaces the domain ownership. Alchemy replaces by creating the new generation first and deletes old generations only after every update (`Apply.ts:1240-1243`), so the new row and TXT exist when the RoutingUrl is updated, and the old ones are removed after. The TXT record set is keyed by the record's domain, so the two generations' records are separate. Correction 8 put the hostname in the id to get this; the create-first replace and the record set key give it without that. `AGENTS.md` records an engine deadlock when a deploy replaces a resource while removing its old dependency; a hostname change has that shape, so the hostname change test must confirm it does not occur.

### With `ownership`: the site uses one managed elsewhere

1. The site declares no domain ownership and publishes no TXT record.
2. The RoutingUrl's `createDomainOwnership` stays `false`, and it is saved after the domain ownership.
3. The site checks that `ownership`'s `domain` attribute covers `name`: the same hostname, or a wildcard one label above it. If not, it stops the deploy as a configuration error, as `FrameworkSite.ts:214-223` already does inside an Output. The check runs inside the ordered `app` Output (see "Order"), because `ownership.domain` is an Output: for a lookup it resolves while the deploy is planned, so the check runs before the site's domain resources are written (on a first deploy, Compute may already be written); for a domain ownership created in the same deploy it resolves once that row exists, so the check runs before the site's CNAME and RoutingUrl are written. This catches the apex case below.
4. When a domain ownership the site uses is not `verified`, one warning per deploy says so (who logs it is below), worded by status: `unverified` means the hostname does not serve until Prisma verifies it; `expiring` means a hostname that already serves keeps serving until Prisma lapses the row after `expiresAt` (at the latest at its next daily lookup), and no new hostname starts serving, unless the TXT is published. A looked-up row's status is read while the deploy is planned. A row declared in the stack reads its status again on every deploy while the saved status is not `verified` (code reviews of `7f8db33c`: a stale `expiring` warning after the user had published the TXT, cleared only by `alchemy deploy --force`, which reruns every resource and Action). Alchemy has no mechanism for re-reading a resource that has not converged (the engine reads only a resource without state, and drift detection is an opt-in `--detect-drift` that reads every resource), so the row's `diff` asks for an update while its saved status is not `verified` (so `alchemy plan` lists it as an update until Prisma verifies it), as `Prisma.Deployment` already replaces a deployment saved as `failed`. On that update the row reads itself with a `GET`, checks its TXT once at the domain's authoritative nameservers without waiting, and, when the record is seen there, waits the same 10-second margin the create uses and sends one verify request, so the deploy converges once the record is published. A verify request is sent only once the record is seen, which avoids almost every cached miss; the margin covers an anycast edge that has not caught up yet (`AuthoritativeDns.ts` 220-226). `domainOwnershipId` is not stable on that update, because a row an Admin deleted is replaced by the one found by domain or a new one (code reviews of `c8472a6e`).

Revised after the code reviews of `c8472a6e`: the site's ordered `app` depends on the domain ownership's stable `domain`, not its `status`, so the RoutingUrl and record sets are not re-reconciled while the row is updated (on Route 53 that sent an `UPSERT` every deploy). Warnings sit where the status is current: a row declared in the stack logs one warning at the end of its own reconcile when it is `unverified` or `expiring`, worded about the domain ownership; the site warns only for a looked-up `ownership`, whose status is read while planning. This replaces the earlier rule that a site's own `unverified` row does not warn: the row now says so itself. This matters most when a serving site switches to `ownership` (see "Cases the docs must cover").
5. Destroying the site leaves the domain ownership and its record.

### Order

The RoutingUrl is saved after the domain ownership. Prisma accepts the rows in either order, so this is not needed for correctness. It is needed for a hostname change of a serving site: the RoutingUrl refuses the change unless the new hostname's TXT is seen or its domain ownership is verified (`ensureCanServe`, `RoutingUrl.ts`). With the order, the new domain ownership and its TXT exist first, so the change succeeds in one deploy when Prisma verifies the new row or one lookup sees its TXT record.

The order goes through the RoutingUrl's `app`, which is an `Input` (`RoutingUrl.ts:166`) that the row resolves only to a service id when it runs (`RoutingUrl.ts:796`): the site passes the Compute app as an Output that also depends on the domain ownership and runs the coverage check. The hostname cannot carry it, because with `dns` the RoutingUrl requires a plain-string hostname (`RoutingUrl.ts:431-436`). This adds no public option to `RoutingUrl`, and Will settled that it gets none.

- One named internal helper in `internal/WebsiteDomain.ts` builds this ordered `app`, so a reader sees why it exists.
- The same ordered `app` goes to every resource the site declares for the hostname, including `requiredRecords` for `DomainAlias` (`WebsiteDomain.ts:53-57`). Today that call declares `Url/RequiredRecords-<hostname>` a second time with plain `compute`; it works only because the first registration wins (`Resource.ts:515`, `TODO(sam): check if props are different and die`).
- The CNAME and `DomainAlias` therefore also wait for the domain ownership. That is intended. With `dns`, the waits for the TXT, the verify requests and the CNAME check run one after another, about 6.5 minutes at worst.
- A redeploy with nothing changed still resolves `app` while planning, because Compute's `appId` is stable (`Compute.ts:2153`), and sends no request (`RoutingUrl.ts:834-841`).

### `Prisma.DomainOwnership.lookup({ project, domain })`

- Finds the workspace's domain ownership for exactly `domain` while the deploy is planned. It writes no state. Like `Project.lookup` (`Project.ts:191`), it is an expression, not an Effect: it is passed without `yield*`.
- When no such row exists, the deploy fails with Alchemy's `LookupNotFoundError` (`Resource.ts:407-415`), so a site never falls back to declaring its own by accident.
- A row this stack manages fails with `LookupOfManagedResourceError`. The engine finds managed rows through the provider's `stables` and skips providers that list none (`Plan.ts:1239-1249`); `DomainOwnershipRow` lists none today (`DomainOwnershipRow.ts:159`). So the row's `stables` become `["workspaceId", "domain"]`. Neither changes in an update: a domain change replaces the row, and a workspace move is refused. `domainOwnershipId` stays out, because a replacement changes it.
- It always asks live Prisma, also under `alchemy dev` (`Resource.ts:396-398`).
- It needs `workspaceManage` access to the workspace, as every domain ownership route does.
- `Prisma.DomainOwnership` is a function that declares several resources, so `lookup` is attached to it and delegates to the row resource's `lookup`. `Resource.lookup` works per resource type (`Resource.ts:390-419`). `DomainOwnershipRow` gains its sixth type parameter, `Lookup`, as `{ project, domain }`.

### Outputs

The site gains `domainOwnership: DomainOwnership | undefined`: the one it declared, or the one passed as `ownership`; undefined without a domain or under `alchemy dev`. The AWS and Fly sites return the certificate they use the same way. `Website.domain` stays the RoutingUrl.

### Cases the docs must cover

- **An apex site next to a wildcard domain ownership.** Prisma names the TXT of `*.example.com` and `example.com` the same (`internal/DomainOwnership.ts:117-121`), and a wildcard does not cover its apex. A standalone apex site would publish, and on destroy delete, the TXT the wildcard depends on. The docs say: declare a domain ownership for the apex without `dns` and pass it as `ownership`, so the wildcard's record set alone publishes the shared TXT.
- **A hostname a wildcard already covers.** Without `ownership`, the site still declares an exact domain ownership for its hostname, next to the wildcard. That is harmless but redundant; the docs say to pass the wildcard as `ownership`.
- **Switching a serving site to `ownership`.** The site's own domain ownership is then no longer declared, and the deploy deletes it after the updates. If the passed one is not yet verified, the hostname stops serving; the deploy log warns. The docs say: pass `ownership` once that domain ownership is verified.
- **Moving a site's own domain ownership out of the site.** A lookup of it is refused, because the stack manages it. Declaring it at stack level with `--adopt` in the same deploy also fails: the engine then deletes the site's old resource, which holds the same Prisma row, after adopting it. The implementer checks whether piping `RemovalPolicy.retain()` onto the site call for one deploy keeps the row through the switch. If it does, the docs give that two-step move. If not, the docs say the row cannot be moved and is deleted and recreated.
- **A deployer with a token limited to one project, or without `workspaceManage` access.** Every domain ownership route needs `workspaceManage` access (on control plane `main`, `services/management-api/routes/v1/workspaces/domain-ownerships.ts`, lines 72 and 365). Such a deployer cannot deploy a site with a domain. The docs say so. See "Not in this design".

### Upgrading a site deployed with the released Alchemy

A released site's state has `Domain` (`Prisma.CustomDomain`) and, with `dns`, `DomainAlias`. The released site published no TXT record, so nothing collides in DNS. Its workspace usually has a domain ownership for the hostname, made by Prisma's backfill or the Console.

- Without `ownership`, the deploy is refused while it is planned, before anything is written. The refusal names the domain ownership, or, with `dns`, `Prisma.DomainVerification`, and says to re-run with `--adopt`. The engine's message cannot be changed per resource, so the docs and JSDoc give the fixes, chosen by who should own the row (code review of `2b5268d3`, F01):
  - **The site should own it** (one site on its hostname, the usual case): pipe `adopt(true)` onto that site's call for one deploy, after reading the plan. With `dns`, the site then publishes the TXT and Prisma verifies the row. It adopts every resource of the site, not only the domain ownership: for example, a RoutingUrl that another stage on the same branch uses with the same `logicalId` is reported as not ours (`RoutingUrl.ts:882-883`), and adopting it moves it to this site's service (`RoutingUrl.ts:836`, `847`). `--adopt` is wider still: it adopts everything in the deploy.
  - **It is managed elsewhere** (shared by several sites, or by an Admin): pass `ownership: Prisma.DomainOwnership.lookup({ project, domain })`. The site then publishes no TXT. A row Prisma's backfill made is `expiring`: a hostname it covers that already serves keeps serving until Prisma lapses it after its `expiresAt`, about 30 days after the backfill, and no new hostname starts serving, unless whoever manages it publishes its TXT. The docs say this, and the site's warning says it for an `expiring` row.
- After adoption, the site owns that row and deletes it when the site is destroyed.
- `DomainAlias` stays declared, adopted and retained, so the CNAME survives the upgrade. `Domain` is no longer declared and is deleted by the engine, as the plan already describes.

### Dev mode

Under `alchemy dev`, a site returns before it declares Compute, so it declares no domain ownership and no RoutingUrl. A site under `Alchemy.remote()` deploys live in dev, including its domain ownership, the same as a deploy. `Prisma.DomainOwnership.lookup` asks live Prisma in dev too.

## What changes in the code

- `Website/FrameworkSite.ts`: the `WebsiteDomain` type; the JSDoc of `domain` (it still says the deploy waits for the hostname to serve) and of `WebsiteDomain.dns` (lines 50-56, which say `dns` publishes the TXT); the `domainOwnership` output.
- `internal/WebsiteDomain.ts`: declare the domain ownership when `ownership` is absent; one helper that builds the ordered `app` and checks coverage; pass that `app` to the RoutingUrl and to `requiredRecords`; warn when `ownership` is not verified.
- `DomainOwnership.ts` and `internal/DomainOwnershipRow.ts`: the `lookup`, the `Lookup` type parameter, and `stables: ["workspaceId", "domain"]`.
- `RoutingUrl.ts`: the hostname-change refusal's advice (around line 700) names `Prisma.DomainOwnership` and `createDomainOwnership`; for a site it should also name `domain.ownership`. Change the wording only if one message can serve both.
- `website/src/content/docs/prisma/compute/apps.mdx`: the site's custom domain section, with the one-site and several-sites examples, the lookup, the upgrade, the cases above, and what destroying the site deletes.

## Tests

In `packages/integration-tests/test/Prisma/Website/Domain.test.ts` and the domain ownership tests, against the fake Prisma API.

The fake needs:
- domain ownerships seeded into its `ownerships` map, so GET and DELETE by id work for adopted rows (the current seed returns 404, so an adopt-then-destroy test would check nothing);
- RoutingUrls re-evaluated when a domain ownership is deleted.

Tests:
- A site with `domain` and `dns` declares a domain ownership and a RoutingUrl, publishes the TXT and the CNAME, and creates the domain ownership before it creates the RoutingUrl (checked by the order of requests).
- A site with `domain` and no `dns` declares both and publishes nothing.
- A site with `ownership` from the stack declares no domain ownership of its own, publishes no TXT, and saves its RoutingUrl after the domain ownership.
- A site with `ownership` from `lookup` declares none and leaves the row when destroyed.
- A site whose `ownership` does not cover `name` stops: with a lookup, before any write; with a domain ownership from the stack, before its CNAME and RoutingUrl are written.
- An apex site with an apex domain ownership declared without `dns`, next to a wildcard with `dns`, publishes the shared TXT once, and destroying the apex site leaves it.
- An unverified domain ownership warns once per deploy: from its own reconcile when declared in the stack, from the site when looked up, never from both.
- A serving site switched to `ownership` and back: the rows and records left afterwards are the expected ones.
- A site deployed from a released site's state, with an existing row, is refused while planning; it deploys with `ownership` from `lookup`, and separately with `adopt(true)` on the site; destroying the adopted one deletes the row.
- A serving site's hostname change passes in one deploy, without the engine deadlock; the old row and TXT are deleted after the RoutingUrl update; the new TXT is in the zone at that update.
- Destroying a site deletes its own domain ownership; destroying one with `ownership` leaves it.
- `lookup` returns a Console-made row, fails with `LookupNotFoundError` for a missing one, and fails with `LookupOfManagedResourceError` for a row the stack manages.

## Not in this design

- A cross-stack `Prisma.DomainOwnership.ref(...)`. `lookup` covers a domain ownership managed by another stack.
- **Sites deployed with a token limited to one project.** The released site worked for such a deployer, because its custom domain route was per service. An `ownership: false` form, where the RoutingUrl sends `createDomainOwnership: true`, was considered and is not enough on its own: with `dns`, the RoutingUrl reads the TXT from `GET /v1/workspaces/{id}/domain-ownerships/verification`, and a hostname change of a serving RoutingUrl lists the workspace's domain ownerships. Both routes need `workspaceManage` access. Supporting such deployers needs those reads to tolerate a refusal, or Prisma to open them to project tokens. Recorded in `deferred.md`. Will, 2026-11-26: "we don't need to support it yet".

## Alternatives considered

- **The site declares nothing and asks Prisma to create the row** by default. Rejected: a stack then cannot deploy one complete site whose domain ownership it manages, unlike the AWS site, which creates what its hostname needs.
- **The site adopts an existing row without a flag** (`adopt(true)`, the plan's decision 5). Rejected by Will: it silently takes over, and later deletes, a row that an Admin or another stack may rely on.
- **`ownership: DomainOwnership | { domainOwnershipId }`** (version 1). Rejected after the architect's review: a structural id is not how Alchemy uses an unmanaged resource; `lookup` is. A literal id would also never be read or checked.
- **Ordering through an Output of the hostname** (version 1). Rejected: with `dns`, `RoutingUrl` requires a plain-string hostname, so every site with `dns` would fail.
- **An internal RoutingUrl entry point for the order** (correction 8). Not needed: `app` already carries the dependency without changing `RoutingUrl`.
