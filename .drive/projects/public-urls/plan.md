# Public URLs — plan

**Spec:** [spec.md](spec.md) · **Decisions:** ADR-0059 to ADR-0062, [composer-to-platform.md](design/composer-to-platform.md), pdp-control-plane ADR 015 and the data-plane consistency proposal · **Execution decisions:** [design-notes.md](design-notes.md) · **Platform plan:** `projects/routing-urls/plans/plan.md` in pdp-control-plane

Five increments, each something a user can do that they could not before, across four repositories. The API comes before the Console, because Composer and Alchemy are its users and the Console is a second client of the same interactors. New Console pages are built behind a feature flag and cut over at the end; the existing Console page keeps its appearance throughout while what it calls moves onto the new records. Will and this session drive all of it; the platform increments run in sessions this one starts in the platform clone, and the Console increment is Søren's. Will tracks the work outside Linear.

Already done or running: the upstream Alchemy fix that lets a custom domain attach on any Branch (merged); the environment decision record (prisma/composer#385, merged); the two slices that rename stage to environment, C2 and C3, in their own sessions; the structured verification record in the platform's 422 (prisma/pdp-control-plane#5834, deployed).

## Increment 1. An author declares in code which service is public, and at which hostname in each environment

**Done.** C1 merged in prisma/composer#396 and P1 in prisma/composer#400; both shipped in v0.36.0.

`publicUrl()` with a named hostname or `publicUrl.prismaBuild()`, and `resolve()` over the environment name so the hostname differs per environment. A named hostname still needs its DNS and ownership records in place before the deploy, as today.

- **C1. Values, `resolve()` and the second evaluation pass.** `resolve(deps, fn)` returning `Value<T>`, accepted wherever a `T` is; `fn` receives the dependencies' values as one tuple; dependencies are `environment.name` and other values. Values run dependency-first and a cycle is an error. After Load's first pass, `provision` is disabled, every value runs and is checked, and only the resolved graph reaches lowering. A resource may be constructed with its edge already set and with options. Builds on nothing; starts now.
- **P1. `publicUrl()` with both strategies.** `publicUrl({ name, url, target })`, a bare string as shorthand for a named hostname, an error when `url` is omitted. `prismaBuild()` lowers to nothing and reports the service's existing `*.prisma.build` URL. A named hostname lowers to `Prisma.CustomDomain`; a hostname whose DNS or verification record is missing fails the deploy with the upstream resource's error, which names the record once alchemy-run/alchemy#2698 is released; a change from a serving hostname to one that cannot serve fails and leaves the old one serving (design note 12). One `DeployedEntity` per public URL, reported under the node's address; the platform row gets the address as its `logicalId` only in P2. The local target's stand-in creates nothing and warns once. Builds on C1.
- **Demo:** the test app deploys with one public service on production and on a preview; the topology names only that service as public; `prisma dev` warns once and runs.

## Increment 2. A workspace proves it owns a domain through the API

**Done.** Platform slice 1 merged in prisma/pdp-control-plane#5838 and slice 2 in prisma/pdp-control-plane#5847.

- **Platform slice 1.** The `DomainOwnership` record, its repository, the create and delete interactors, and the `domain-ownerships` routes.
- **Platform slice 2.** DomainOwnership on the platform's spec-and-status pattern. A domain ownership can be created before its TXT record exists. It is pending, and the response carries the record to publish. One sync interactor, `syncDomainOwnership`, looks up DNS and marks it verified once the record is found. A failed lookup is retried from the shared data-plane sync queue, which this slice builds for every later kind of row. Alchemy can publish the record through its DNS adapter and create the domain ownership the day it ships.
- **Demo:** create a domain ownership for `shop.com` with no record and get it back pending with the record to publish; publish it, press check and see it verified; the same for `*.preview.shop.com`.

## Increment 3. A Composer author declares a hostname before DNS, and it goes live on its own

**Started.** The RoutingUrl table and the stored status of RoutingUrls and domain ownerships merged in prisma/pdp-control-plane#5860. The RoutingUrl repository is the draft prisma/pdp-control-plane#5870.

- **Platform slice 3.** The `RoutingUrl` record, its repository, interactors and routes; `syncRoutingUrl` on the sync queue that slice 2 built; the alerts and the backfill; and today's custom-domain interactors, the existing Console page's backend and the old routes moved onto the records without changing what users see. A RoutingUrl is pending until its conditions are met and active once they are. A change of the service's live deployment does not change its status; it only re-points the Foundry custom domain. Nothing is sent to Foundry for a new RoutingUrl until its domain ownership is verified. Custom domains attached before the TXT check shipped on 24 October 2026 get a grandfathered domain ownership and an already-active RoutingUrl, so they keep serving with nothing for the customer to do. A grandfathered domain ownership has no end date. Checks run on it as on any other, but a missing record never revokes it. Only a conflict does: another workspace publishing its own value at the record name. It does not count as verified, so a new or changed hostname under it is not sent to Foundry. When an active RoutingUrl's domain ownership becomes pending, because its record is gone or a grandfathered one lost a conflict, the RoutingUrl goes back to pending and its custom domain is removed.
- **U2. The Alchemy RoutingUrl resource.** Create with no DNS, read conditions and the records to publish, update hostname or service, delete; found by `logicalId`; adopts a live row on the same service with the same hostname and no `logicalId` by writing the `logicalId` on it; refuses to change the hostname of a row that is serving to one that cannot serve yet, naming both hostnames and the records to publish, unless the platform refuses that update itself (design note 12). Written to Alchemy's own testing conventions with live credentials confirmed before dispatch, and released. Builds on platform slice 3 deployed.
- **P2. Pending hostnames.** A named hostname lowers to `Prisma.RoutingUrl`; the deploy output names the first unmet condition and prints every record still to publish, with name, type and value; a deploy declaring a hostname nobody has set up yet succeeds and says how to prove ownership and which CNAME to publish; a change from a serving hostname to one that cannot serve fails the deploy (design note 12), switching a public URL from `Prisma.CustomDomain` to `Prisma.RoutingUrl` drops the custom domain from Alchemy state without calling its delete, because the delete would remove the platform row the RoutingUrl has just adopted and take the hostname out of service, with a test that proves no delete is sent; the RoutingUrl's Alchemy resource id is the node's address alone, not the address plus the hostname as in P1; `prisma deploy list` shows each public URL's hostname and platform id, joining the RoutingUrl row by its `logicalId`, which a P1 custom domain row lacks; `origin()` is unchanged. Builds on P1 and U2.
- **Demo:** the spec's example app deploys production before `shop.com`'s DNS exists and succeeds; the author publishes the two records printed by the deploy; the hostname goes active with no further deploy and no Console.

## Increment 4. A Console user proves a domain and manages hostnames, behind a feature flag, then the old page goes

The platform's slice 4, owned by Søren from the platform's Console brief: the Domains page in workspace settings and the service page's hostname section, built in Storybook from the start and wired to the slice 2 and slice 3 interactors when they exist; then the cutover that removes the existing domains page and deprecates the old routes.

- **Demo:** prove `shop.com` from the Domains page and watch it appear once the record is found; add a hostname on the service page before DNS, see the records to publish, and watch it go active after one press of check.

## Increment 5. A service nobody declared public has no public hostname

- **Platform slice 5.** The `prisma.build` endpoint becomes a RoutingUrl a service can lack, with the backfill of existing endpoints into rows with no `logicalId`.
- **P3. `publicUrl.prismaBuild()` lowers to that RoutingUrl**, and U2's adoption takes over the row the backfill made for an existing service. The deploy output names every service that has no public URL, saying whether it is still reachable at its platform hostname (ADR-0060 asks for this; P1 left it out because until P3 every service is reachable and the message would change). Specified against [step-two-migration-scenarios.md](design/step-two-migration-scenarios.md) once increment 3 has landed.
- **Demo:** a new service with no `publicUrl()` answers on no hostname; an existing app's services keep their addresses through the upgrade; every migration scenario holds against a real Branch.

## Enablers, not increments

- The consistency proposal as a decision record in the platform repository (the platform's slice 0, merged).
- The requests to the Metal team: creates that take the control plane's id or an idempotency key, and list routes. Will opens the conversation; the design does not wait for them.

## Later, recorded in `.drive/deferred.md` and the platform plan

- A pending domain ownership the platform polls for, so the user can close the Domains page.
- Composer publishing a hostname's records through a DNS adapter.
- A third kind of object on the consistency mechanism.

## Order

| Work | Starts when |
| --- | --- |
| C1, P1, platform slices 0, 1 and 2 | merged |
| platform slice 3 | started |
| Søren's Storybook views | now |
| U2 | platform slice 3 is deployed |
| P2 | P1 and U2 have merged |
| the Console wiring and cutover | slices 2 and 3 have merged |
| platform slice 5, then P3 | increment 3 has landed |

## Close-out

- [ ] Verify every Project DoD condition in [spec.md](spec.md).
- [ ] Move what is long-lived from `design/` into `docs/design/`, and confirm nothing else in this folder is still needed.
- [ ] Remove references to `.drive/projects/public-urls/` elsewhere in the repo.
- [ ] Delete `.drive/projects/public-urls/`.
