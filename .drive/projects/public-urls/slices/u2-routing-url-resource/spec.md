# U2 — the Alchemy `Prisma.RoutingUrl` resource

Repositories: alchemy-run/distilled (the generated client) and alchemy-run/alchemy (the resource). Parent: [project spec](../../spec.md), [plan § U2](../../plan.md), [design note 7](../../design-notes.md), [design note 12](../../design-notes.md). Platform contract: `docs/compute/RoutingUrls.md` and ADR-015 in prisma/pdp-control-plane, as deployed with platform slice 3.

Starts when platform slice 3 is deployed. Written 2026-11-06, before slice 3's pull request exists: check every route and field below against the deployed OpenAPI spec (`GET https://api.prisma.io/v1/doc`) before dispatch, and update this spec where they differ.

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

**Over the platform's RoutingUrl routes.** Create with `POST /v1/services/{id}/urls`. Read with `GET /v1/urls/{id}`. Change the hostname or service with `PATCH /v1/urls/{id}`. Delete with `DELETE /v1/urls/{id}`. Find with `GET /v1/projects/{id}/branches/{id}/urls?logicalId=`.

**The domain ownership is the platform's job.** Create and update leave `createDomainOwnership` at its default, `true`. The platform then creates an `unverified` exact-hostname domain ownership when no verified one covers the hostname. The resource never records, reads into its state, or deletes a domain ownership. Deleting a RoutingUrl leaves the domain ownership in place, because it belongs to the workspace and may cover other hostnames.

**Identity is the `logicalId`.** With no stored row id, `read` looks the row up by Branch and `logicalId`. A row on the same service with the same hostname and no `logicalId` is adopted: the resource writes its `logicalId` with `PATCH` and takes it over. This is how P3 takes over the rows the platform's backfill made for existing custom domains. Any other row with the same hostname is a conflict, and the resource fails with an error that names it.

**Changing the hostname of a serving row is checked here** (design note 12). The platform accepts any hostname change: it removes the old custom domain at once and holds the new hostname `pending`. So before it sends a hostname change for a row whose status is `active`, the resource checks that the new hostname can serve: a covering domain ownership in the workspace has status `verified`, and the CNAME to the regional switchboard resolves at every authoritative nameserver. If not, it fails before changing anything, with an error that names both hostnames and the records to publish. A pending row, a service change, and a removal are not checked.

**Reuse #2701.** alchemy-run/alchemy#2701 (Sam Goodwin, paused) has the pieces this needs: `DomainVerification` to read the TXT record, `AuthoritativeDns` to wait on authoritative nameservers, and the `DomainOwnership` resource. U2 builds on #2701 merged, after #2701 is updated for the platform's domain ownership statuses. Today #2701 expects create to fail with `DomainOwnershipRequired` until the record resolves. The platform now creates the domain ownership `unverified` and returns it, so #2701 would treat an unverified one as proved. It must wait on `status`, and carry `status` and `expiresAt` in its attributes. Will decides who makes that update.

**`Prisma.CustomDomain` stays** for now. The platform keeps `/v1/services/{id}/domains` as a view over RoutingUrls for one deprecation cycle. Composer switches in P2.

## Coherence rationale

One new resource and the client it calls. The Distilled regeneration is a separate pull request in its own repository, merged first, as alchemy-run/distilled#1007 was for #2701.

## Scope

In:
- alchemy-run/distilled: regenerate `@distilled.cloud/prisma` from the deployed spec, so the RoutingUrl operations and their typed errors exist.
- alchemy-run/alchemy `packages/prisma`: `RoutingUrl.ts`, its provider (live and local), its export, and Providers registration.
- Tests in `packages/integration-tests/test/Prisma/`, following Alchemy's own conventions, with a live test against production using credentials confirmed before dispatch.
- The resource's JSDoc and generated reference page; a short section in the Compute custom-domain guide.

Deliberately out:
- Publishing DNS records through a DNS adapter for a RoutingUrl ([design note 8](../../design-notes.md): a follow-on).
- Removing or deprecating `Prisma.CustomDomain`.
- `Prisma.Website`'s `domain` option.
- Any Composer change (P2).

## Done conditions

- A deploy of a `Prisma.RoutingUrl` for a hostname with no DNS records succeeds, and its attributes show `pending`, the unmet conditions and both records to publish.
- A redeploy with nothing changed sends no `PATCH`.
- A row found by `logicalId` is updated in place; a row with no `logicalId` on the same service and hostname is adopted; a conflicting row fails with an error that names it.
- A hostname change on an `active` row whose new hostname has no verified domain ownership fails before any `PATCH`, and a test proves no request was sent.
- Destroy deletes the row and sends no domain ownership request.
- Released in an Alchemy version Composer can depend on.
