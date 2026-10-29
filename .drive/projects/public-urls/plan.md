# Public URLs — plan

**Spec:** [spec.md](spec.md) · **Decisions:** ADR-0059 to ADR-0062, `.drive/projects/public-urls/design/composer-to-platform.md`, pdp-control-plane ADR 015 and the data-plane consistency proposal · **Execution decisions:** [design-notes.md](design-notes.md)

Four increments, each something a user can do that they could not before, across four repositories. Each increment carries the internal work it needs; nothing ships as foundation alone. Will and this session drive all of it: the platform increments may be split off to another agent or run as sessions this one starts in the platform clone. Will tracks the work outside Linear.

Already done or running: the upstream Alchemy fix that lets a custom domain attach on any Branch (merged); the environment decision record (prisma/composer#385, merged); the two slices that rename stage to environment, C2 and C3, in their own sessions.

## Increment 1. An author declares in code which service is public, and at which hostname in each environment

`publicUrl()` with a named hostname or `publicUrl.prismaBuild()`, and `resolve()` over the environment name so the hostname differs per environment. A named hostname still needs its DNS and ownership records in place before the deploy, as today.

- **C1. Values, `resolve()` and the second evaluation pass.** `resolve(deps, fn)` returning `Value<T>`, accepted wherever a `T` is; `fn` receives the dependencies' values as one tuple; dependencies are `environment.name` and other values. Values run dependency-first and a cycle is an error. After Load's first pass, `provision` is disabled, every value runs and is checked, and only the resolved graph reaches lowering. A resource may be constructed with its edge already set and with options. Builds on nothing; starts now.
- **P1. `publicUrl()` with both strategies.** `publicUrl({ name, url, target })`, a bare string as shorthand for a named hostname, an error when `url` is omitted. `prismaBuild()` lowers to nothing and reports the service's existing `*.prisma.build` URL. A named hostname lowers to `Prisma.CustomDomain`; a hostname whose DNS or ownership record is missing fails the deploy naming the hostname and the missing record. One `DeployedEntity` per public URL with the node's address as its `logicalId`. The local target's stand-in creates nothing and warns once. Builds on C1.
- **Demo:** the test app deploys with one public service on production and on a preview; the topology names only that service as public; `prisma dev` warns once and runs.

## Increment 2. A Console user adds a hostname before its DNS exists, is told what is missing, and it goes live with no further action from us

The platform's own project, `projects/routing-urls/` in pdp-control-plane, slices 0 to 3: the consistency proposal as a decision record; the RoutingUrl and domain ownership records, routes and backfill; the mechanism's shared parts with RoutingUrl as the first kind on them; the Console's hostnames section and Domains page, with the old domain paths retired. A promote, rollback or stop re-points every hostname or shows the failure on the hostname.

- **Demo:** in the Console, add `shop.com` before DNS and see "DNS is the next step"; add the record, press check, watch it go active; force a re-point failure and see it on the hostname and repaired on retry.
- Builds on nothing; starts now, in parallel with increment 1.

## Increment 3. A Composer author deploys before DNS, finishes DNS later, and never redeploys for it

- **U2. The Alchemy RoutingUrl resource.** Create with no DNS, read conditions, update hostname or service, delete; found by `logicalId`; adopts a live row on the same service with the same hostname and no `logicalId` by writing the `logicalId` on it. Written to Alchemy's own testing conventions with live credentials confirmed before dispatch, and released. Builds on the platform's slice 1 deployed.
- **P2. Pending hostnames.** A named hostname lowers to `Prisma.RoutingUrl`; the deploy output names the first unmet condition and prints every record still to publish, with name, type and value; the Alchemy RoutingUrl resource exposes the same records as outputs; `origin()` is unchanged. Builds on P1 and U2.
- **Demo:** the spec's example app deploys production before `shop.com`'s DNS exists and succeeds; the hostname goes active after DNS and one press of the Console's check button, with no further deploy.

## Increment 4. A service nobody declared public has no public hostname

- **Platform slice 4.** The `prisma.build` endpoint becomes a RoutingUrl a service can lack, with the backfill of existing endpoints into rows with no `logicalId`.
- **P3. `publicUrl.prismaBuild()` lowers to that RoutingUrl**, and U2's adoption takes over the row the backfill made for an existing service. Specified against [step-two-migration-scenarios.md](../../../.drive/projects/public-urls/design/step-two-migration-scenarios.md) once increment 2 has landed.
- **Demo:** a new service with no `publicUrl()` answers on no hostname; an existing app's services keep their addresses through the upgrade; every migration scenario holds against a real Branch.

## Enablers, not increments

- The requests to the Metal team: creates that take the control plane's id or an idempotency key, and list routes. Will opens the conversation; the design does not wait for them.
- A second kind of object on the consistency mechanism is the first follow-on project, not part of this one.

## Order

| Work | Starts when |
| --- | --- |
| C1, platform slices 0 and 1 | now |
| P1 | C1 has merged |
| platform slice 2 | slice 1 has merged |
| U2 | platform slice 1 is deployed |
| platform slice 3 | slice 2 has merged |
| P2 | P1 and U2 have merged |
| platform slice 4, then P3 | increment 2 has landed |

## Close-out

- [ ] Verify every Project DoD condition in [spec.md](spec.md).
- [ ] Long-lived content is already in `docs/design/` and pdp-control-plane `docs/` from each slice; confirm nothing in this folder is still needed, and move anything that is.
- [ ] Remove references to `.drive/projects/public-urls/` elsewhere in the repo.
- [ ] Delete `.drive/projects/public-urls/`.
