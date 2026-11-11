Adds `Prisma.RoutingUrl`, a hostname that serves a Prisma app, saved before its DNS exists, and `Prisma.DomainOwnership`, which proves a workspace owns a domain.

```ts
const url = yield* Prisma.RoutingUrl("api", {
  app: api,
  hostname: "api.example.com",
});
// url.status: "pending"
// url.firstUnmetCondition: "ownershipVerified"
// url.records: TXT _prisma-verification.api.example.com, CNAME api.example.com -> switchboard.{region}.prisma.build
// url.setupUrl: the Console page that shows what to do next
```

### `Prisma.RoutingUrl`

The deploy creates the platform row at once, with no DNS, and succeeds. Prisma makes the row `active` once the records resolve. Prisma also creates the `unverified` domain ownership the TXT record proves; the resource never reads, records or deletes it.

1. **Identity is the `logicalId`**, which defaults to the resource's name. With no stored id, the row with that `logicalId` on the service's Branch is this resource's. A row Prisma made for the same service and hostname with no `logicalId` (as Prisma's backfill of existing custom domains does) is taken over by writing its `logicalId`.
2. **Another row on the Branch with the hostname** fails the deploy with `RoutingUrlHostnameTaken`, which names it.
3. **Changes** to the hostname, the service or the `logicalId` are sent with one `PATCH`. A redeploy with nothing changed sends none.
4. **A hostname change on an `active` row** is refused before any `PATCH`, with `RoutingUrlHostnameChangeRefused`, until the new hostname has a verified domain ownership (exact or wildcard) and points at the switchboard at every authoritative nameserver: a CNAME, or, for an apex, A or AAAA answers that include a switchboard address (CNAME flattening, ALIAS or ANAME). The error names both hostnames and the records to publish. When the CNAME could not be checked from this machine, it says so instead of asking to publish it. Prisma itself would accept the change and stop serving the old hostname at once. Known limit: a RoutingUrl in another workspace holding the new hostname is not seen, so the change goes through and the new hostname stays `pending` behind `heldBy`.
5. **Prisma's refusals** become typed errors: `RoutingUrlQuotaExceeded` and `RoutingUrlLogicalIdTaken` (409), `RoutingUrlInvalidHostname` and `RoutingUrlServiceOnAnotherBranch` (422). Distilled maps these to its generic `Conflict` and `UnprocessableEntity`, which keep only the message, and the platform's codes do not tell all four apart, so for now the resource tells them apart by the message. A test pins today's messages. Once the platform gives each case its own code, a Distilled patch types the four errors and the resource catches them by tag.
6. **Destroy** deletes the row and sends no domain ownership request.

Migrating from `Prisma.CustomDomain`: to replace a CustomDomain with a RoutingUrl for the same hostname, keep the CustomDomain with `RemovalPolicy.retain()` or remove it in an earlier deploy. The RoutingUrl takes over the row the CustomDomain made, and the CustomDomain's delete would remove it.

Don't declare a `Prisma.DomainOwnership` for the same exact hostname as a `Prisma.RoutingUrl`: it takes over the domain ownership Prisma created for the RoutingUrl and deletes it on destroy. The JSDoc and the Compute guide say so.

### `Prisma.DomainOwnership`

```ts
const ownership = yield* Prisma.DomainOwnership("example.com", {
  project,
  domain: "*.example.com",
  dns: Cloudflare.DNS.Adapter(),
});
// ownership.status: "verified"; ownership.expiresAt: null
yield* Prisma.CustomDomain("api", { app: api, hostname: "api.example.com", ownership });
```

A deploy counts it as proved only when Prisma reports it `verified`. A `Prisma.Website` with `domain: { name, dns }` proves its own hostname the same way, in the same deploy.

This replaces #2698 and #2701. Both were written before Prisma changed how domain ownerships work:

- Before: `POST /v1/workspaces/{id}/domain-ownerships` refused with a 422 `domain-ownership-required` until the TXT record resolved. #2701 retried the create on that error and treated a successful create as proof.
- Now: the create always saves the domain ownership and returns it with `status: "unverified"` until a DNS lookup finds the record. A successful create proves nothing, so #2701 would report an unverified domain ownership as proved.

How proving works now:

1. Look up the domain ownership: by its stored id, or by domain when there is no stored id or it no longer resolves. A row found by domain is subject to the ownership rules below. If Prisma reports it `verified`, it is proved. `unverified` and `expiring` do not count.
2. Read the TXT record from `GET /v1/workspaces/{id}/domain-ownerships/verification`, and ask every authoritative nameserver for it, as #2701 did. The answer is `seen`, `absent` (a nameserver answered without it; checked again every 3 seconds, up to 20 times) or `unknown` (no nameserver could be found or reached).
3. On `absent`, fail with `PrismaDomainOwnershipRequired`, which names the record to publish. Nothing is created.
4. On `seen` or `unknown`, create the domain ownership if there is none, then call `POST /v1/domain-ownerships/{id}/verify` until it reports `verified`, up to 6 more times, 5 seconds apart. On `unknown`, Prisma's own lookup decides.
5. If it is still not verified, fail with `PrismaDomainOwnershipRequired`. No failure deletes anything.

Who owns what (the same rule in `read`, in `reconcile` and after a create):

- A domain ownership this resource did not record needs `--adopt` when it is `verified` or `expiring`, since it may keep someone's hostnames serving.
- An `unverified` one is taken over without `--adopt`: it grants nothing, so taking it over takes nothing from anyone. This also lets a deploy that failed after creating the row succeed on the next run.
- If the create answers 200 with a row that is not `unverified` (it appeared while the deploy ran), the deploy fails and asks for `--adopt`.
- The domain ownership create and the custom domain create retry only throttled requests. A create whose response was lost and was retried would answer 200 for the row it just made, and the deploy would then refuse its own row.
- Destroy deletes the domain ownership and its TXT record.

Upgrading: a `Prisma.Website` with `domain: { name, dns }` now declares a domain ownership for its hostname. If the workspace already proved that hostname by hand, the first deploy fails with `OwnedBySomeoneElse`. Run that deploy once with `--adopt`.

Attributes add `status` (`unverified`, `verified` or `expiring`) and `expiresAt`. They are what Prisma reported when the deploy last proved the domain; an unchanged redeploy does not check again. #2698's `verifiedAt` is gone: Prisma's response no longer has it, and the closest field (`verificationRecordLastSeenAt`) means something else.

`Prisma.CustomDomain` moves to distilled's `/v1/services` routes, takes an optional `ownership`, and keeps main's guard: a create that answers 200 (the domain was already registered, for example by a race) fails and asks for explicit adoption instead of taking the domain over. It reads the status from the new `httpStatus` member in distilled.

Also carried over from #2698 and #2701: the internal `DomainVerification` and `AuthoritativeDns` helpers and the Prisma docs pages. `AuthoritativeDns` now reports `seen`, `absent` or `unknown`, is a replaceable `Context` reference so tests can stub it, and cancels a timed-out DNS query as main's `CustomDomain` did. The Cloudflare, email, skills and scripts changes that reached #2701 through merges from main are not included.

Depends on the alchemy-run/distilled pull request from `feat/prisma-routing-urls` (the RoutingUrl operations, the domain ownership statuses, and `httpStatus` on the two creates). `submodules/distilled` is pinned to its tip, `6661db7c0`, and must be re-pinned to distilled main once it merges.

Tests, all driven through `stack.deploy` against a fake Management API:

- `test/Prisma/RoutingUrl.test.ts`:
  - a hostname with no DNS is saved `pending` with both records, a redeploy sends no `PATCH`, and destroy deletes only the row;
  - a row found by `logicalId` is updated in place; a backfilled row with no `logicalId` is taken over;
  - another row with the hostname fails and is named;
  - a hostname change on an `active` row is refused with no `PATCH` sent; refused without asking to publish the CNAME when it could not be checked; and allowed once the new hostname has a verified domain ownership (exact or wildcard) and its CNAME;
  - a hostname change on a `pending` row is sent with no check;
  - a flattened apex whose addresses include the switchboard's is accepted, and one whose addresses do not is refused with no `PATCH`;
  - each 409 and 422 refusal becomes its typed error.

- `test/Prisma/DomainOwnership.test.ts`, with the authoritative check stubbed:
  - an `absent` record fails and creates nothing;
  - a `seen` record leads to create (201) and verify until `verified`; so does `unknown`;
  - a create answering 200 with an `unverified` row is accepted, and with a `verified` row fails and asks for `--adopt`;
  - the bounded verify loop ends in `PrismaDomainOwnershipRequired`;
  - an unverified row is taken over without `--adopt`, and a verified one is refused;
  - when the stored id is gone, a verified row found by domain is refused without `--adopt` and taken with it;
  - an `expiring` row is not counted as proved.
  - No failure sends a DELETE.
- `test/Prisma/CustomDomain.test.ts`: "routes a 200 custom-domain create race through explicit adoption", restored from main.

Live tests, gated on `ALCHEMY_RUN_LIVE_PRISMA_TESTS=true`: `test/Prisma/RoutingUrl.test.ts` saves a RoutingUrl for a hostname with no DNS and deletes it; `test/Prisma/Website/CustomDomainDns.test.ts` also checks `status: "verified"`. Neither has been run against production yet.

Agent: u2-domain-ownership

🤖 Generated with [Claude Code](https://claude.com/claude-code)
