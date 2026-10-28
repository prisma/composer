# Public URLs

## What we are deciding

An author says in code which services receive traffic from the internet and at which hostname, per environment. The platform stores every custom hostname as a record it owns, so a hostname can be declared before its DNS works, survives its service being replaced, and is kept routed to the live version without anyone redeploying.

## The author's side

```ts
import { module, resolve } from '@prisma/composer';
import { publicUrl } from '@prisma/composer-prisma-cloud';

export default module('shop', ({ environment, provision }) => {
  const web = provision(webService);

  const url = resolve([environment.name], ([name]) =>
    name === 'production' ? 'shop.com'
    : name === 'staging' ? 'staging.shop.com'
    : publicUrl.prismaBuild());

  provision(publicUrl({ name: 'site', url, target: web.http }));
});
```

```sh
prisma deploy                        # production: shop.com
prisma deploy --environment pr-42    # a preview: web's prisma.build URL
prisma dev                           # the environment dev, on this machine
```

- **`publicUrl({ name, url, target })`** is a node. `target` is the HTTP connection the service exposes; a service knows nothing about the URLs pointed at it. `name` gives the node its address, `shop.site`.
- **`url` is one of two things.** A hostname the author names, such as `'shop.com'`. Or `publicUrl.prismaBuild()`, meaning the service is public at the `prisma.build` URL the platform gives every service. Leaving it out is an error. One hostname per node; `www.shop.com` is a second node.
- **A value that differs per environment is computed with `resolve(dependencies, fn)`.** The module body receives `environment`, a set of opaque references such as `environment.name`; a body can list one as a dependency but cannot branch on it. Composer builds the graph with every `resolve()` unexecuted, disables `provision`, then runs each `fn` for the environment being deployed and validates the result. So the graph's structure is the same in every environment and only values differ. A resolved value can go anywhere a value goes, never into a node's `name`, `id`, `deps` or `target`. A `resolve()` sees inputs and environment facts, never a deploy result.
- **Every environment has a name.** `prisma deploy` defaults `--environment` to `production`, `prisma dev` to `dev`, `destroy` has no default. On Prisma Cloud `production` is the Project's default Branch; every other name is a Branch of that git name, created if absent.
- **Module input** is one Standard Schema under `input`, exactly as a service's; the root's input is filled by config adapters named in `prisma.config.ts`. This is recorded but is a follow-on project; the public-URL work needs only `resolve()` over `environment.name`.

## The platform's side

Two records in the control plane. Foundry, the routing layer, is not changed.

**RoutingUrl**: a custom hostname mapped to a service.

| Column | Meaning |
| --- | --- |
| `branchId` | owns the row's lifetime |
| `appId` | the service; null after the service is deleted |
| `hostname` | canonical form |
| `logicalId` | the deploy tool's identifier; Composer writes the node's address |
| `foundryDomainId` | Foundry's id for the registration, once made |
| `registeredAt` | set while this row holds the hostname's registration |
| `dnsCheckedAt`, `certificateIssuedAt`, `routingBoundAt` | the three observed conditions |

**DomainOwnership**: a workspace's claim to one exact domain or one-label wildcard, with `verifiedAt`.

**Six conditions, no status.** A hostname serves when all hold: ownership verified, service present, live version, DNS points at the region, certificate issued, routing bound. The row reports the first unmet one as the next thing to do, with the DNS record to publish.

**The rules.**

1. Nothing is created on its own. A deploy creates a row per declared hostname; a Console user creates one on the service's page.
2. A row exists before its DNS does. Creating one calls no Foundry API.
3. One hostname is served by one row. Any number of rows may name a hostname; one holds the registration, enforced by a partial unique index on rows with `registeredAt`. A row that cannot take it reports who holds it to a caller with access to that workspace, and "held by another workspace" otherwise.
4. Ownership is a claim, verified by the workspace's existing TXT record. When a workspace claims a domain another workspace's verified claim covers, the existing claims are re-verified first. Claims are not re-verified on a schedule.
5. The control plane keeps Foundry in step. Promote, rollback, stop and delete do their inline work and write failures to the row; one reconciler, every minute and after every hook, repairs the rest under the project row lock.
6. A routing no-op never touches a certificate.
7. A row survives its service. Deleting the service detaches it and releases the registration; a stopped service keeps it; deleting the Branch deletes it.
8. Existing custom domains are backfilled as rows holding their registrations, with verified claims, with no `logicalId`.

**Console.** The service page lists the service's rows with their conditions. Workspace settings gains a Domains page for claims.

## How the two sides meet

- A `publicUrl()` with a named hostname lowers to one RoutingUrl whose `logicalId` is the node's address. On the next deploy the row is found by that.
- A `publicUrl()` with `publicUrl.prismaBuild()` lowers to nothing in step one. The service's `prisma.build` hostname exists regardless, and the node records that the service is public at it.
- **Adoption.** When no row holds the node's `logicalId`, the upstream `Prisma.RoutingUrl` resource looks for a live row on the same service with the same hostname and no `logicalId`, writes the `logicalId` on it, and records it in Alchemy state. That is how a domain a user set up in the Console before this work becomes the node's row with no interruption. The platform derives nothing.
- A deploy never waits for DNS. The deploy output names the first unmet condition and the Console link.

## Step two: the prisma.build URL as a record

In step one every service is reachable at its `prisma.build` hostname whether or not the code says so. Step two makes that hostname an opt-in RoutingUrl, created by an operation that takes the hostname from the service, so a service nothing should reach from outside has none. `publicUrl.prismaBuild()` then lowers to that row, and the adoption rule takes over the rows the backfill makes for existing services. The twelve scenarios this step must satisfy are written; its requirements are written when step one's first two slices have landed.

## Not in this proposal

Private routing between services. Routing by path. Any change to Foundry. Re-checking DNS or ownership on a schedule.

## The detail

Composer:

1. [ADR-0060](../../90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md): the public URL node, with alternatives.
2. [ADR-0062](../../90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): `resolve()`, environments and config adapters.
3. [ADR-0061](../../90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): module input.
4. [composer-to-platform.md](composer-to-platform.md): how a node becomes platform state. [scenarios.md](scenarios.md): thirteen worked scenarios. [domain-map.md](domain-map.md): which concept lives in which system.
5. [step-two-migration-scenarios.md](step-two-migration-scenarios.md): the twelve scenarios step two must satisfy. The project's spec and plan are in [`.drive/projects/public-urls/`](../../../../.drive/projects/public-urls/).

Prisma Cloud (maintained in prisma/pdp-control-plane under `docs/compute/`, on the branch of prisma/pdp-control-plane#5795):

1. [platform-routing-urls.md](platform-routing-urls.md): the records, conditions, rules, routes and Console.
2. [platform-routing-url-lifecycle.md](platform-routing-url-lifecycle.md): every operation and lifecycle event, and the reconciler.
3. [ADR 015](https://github.com/prisma/pdp-control-plane/blob/chore/adr-ingress-entity/docs/architecture/adrs/ADR-015-routing-urls-and-domain-ownership.md): the decision, why, and alternatives.
4. [projects/routing-urls](https://github.com/prisma/pdp-control-plane/tree/chore/adr-ingress-entity/projects/routing-urls): spec, acceptance criteria and the five-slice plan.
