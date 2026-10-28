# Public URLs

## What we are deciding

Today every Compute service is reachable from the internet at an address the platform gives it, and a custom domain such as `shop.com` can only be attached by hand, in the Console, after the service is deployed, and only once its DNS already works. Nothing in an application's code says which services are meant to be public or at which hostname.

This proposal changes both sides. In Composer, the author writes in the module code which services receive traffic from the internet and at which hostname, and the hostname can differ per environment. On Prisma Cloud, every custom hostname becomes a record the control plane owns. Because the record exists independently of DNS and of the service, a hostname can be declared before its DNS is set up, it stays when its service is deleted and recreated, and the platform keeps it routed to whichever version of the service is live without anyone redeploying.

## The author's side

This is what the code looks like. The service `web` is public. In production it answers at `shop.com`, in staging at `staging.shop.com`, and in every other environment at the address the platform gives it.

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
prisma deploy                        # deploys the environment "production": shop.com
prisma deploy --environment pr-42    # deploys a preview: web's prisma.build URL
prisma dev                           # runs the environment "dev" on this machine
```

### The public URL node

`publicUrl({ name, url, target })` is a node in the module graph, like a service or a database. `target` is the HTTP connection that a service exposes, written `web.http`. The service itself knows nothing about the URLs that point at it. `name` gives the node its address in the graph, `shop.site`, in the same way every node gets one.

`url` says which hostname the node serves. It is one of two things. It can be a hostname the author names, such as `'shop.com'`. Or it can be `publicUrl.prismaBuild()`, which means the service is public at the `prisma.build` URL the platform gives every service. Leaving `url` out is an error. One node serves one hostname, so `www.shop.com` is a second node pointed at the same connection.

### Values that differ per environment

The hostname differs per environment, but the shape of the application must not. Composer enforces that with `resolve()`.

`resolve(dependencies, fn)` names what a value depends on and returns a placeholder for it. In the example, the value depends on the environment's name. The function receives the dependencies' values and returns the value. The module body receives `environment`, which is a set of opaque references such as `environment.name`. The body can list such a reference as a dependency, but it cannot read it, so it cannot branch on the environment.

Composer runs the module code and builds the graph with every `resolve()` function still unexecuted. It then disables `provision`, runs each function for the environment being deployed, and validates each result. So the graph has the same nodes and edges in every environment, and only values differ. A resolved value can be used anywhere a value is accepted, such as a hostname or a service's configuration. It cannot be used for a node's `name` or `id`, for its dependencies, or for a public URL's `target`, because those decide the shape of the graph. A `resolve()` function sees inputs and environment facts; it never sees a result of the deploy, such as a hostname the platform assigns.

### Environments

Every environment has a name, and none is special. `prisma deploy` deploys the environment `production` unless `--environment` says otherwise. `prisma dev` runs the environment `dev` unless told otherwise. `destroy` has no default and must be given an environment. On Prisma Cloud, `production` is the Project's default Branch. Every other environment name is the Branch with that git name, created if it does not exist.

### Module input

A module can declare the configuration it needs as one schema called `input`, in the same way a service does. For the root module, the values come from config adapters listed in `prisma.config.ts`. This is recorded as a decision, but it is a follow-on project. The public-URL work only needs `resolve()` over the environment's name.

## The platform's side

The control plane gains two tables. Foundry, the routing layer that terminates TLS and routes a hostname to a running version, is not changed.

### The RoutingUrl table

A row is one custom hostname and the service it reaches.

| Column | What it holds |
| --- | --- |
| `branchId` | the Branch that owns the row. The row lives as long as the Branch does |
| `appId` | the service the hostname reaches. It becomes null when the service is deleted, and the row stays |
| `hostname` | the hostname, in canonical form: lowercase, no trailing dot, international labels in punycode |
| `logicalId` | an identifier a deploy tool writes so it can find the row again. Composer writes the node's address, `shop.site` |
| `foundryDomainId` | the id Foundry gave the hostname's registration, once the platform has registered it |
| `registeredAt` | set while this row is the one that holds the hostname's registration |
| `dnsCheckedAt`, `certificateIssuedAt`, `routingBoundAt` | when the platform last saw each of three things to be true: the hostname's DNS points at the platform, the certificate is issued, and routing is bound to the live version |

### The DomainOwnership table

A row is a workspace's claim that it owns a domain. `domain` is either an exact hostname, such as `shop.com`, or a wildcard one label deep, such as `*.preview.shop.com`. `verifiedAt` is set once the platform has seen the workspace's TXT record under that domain, and is null until then.

### The six conditions

A hostname serves traffic only when all six of these are true:

1. The workspace has a verified claim that covers the hostname.
2. The service exists.
3. The service has a live version.
4. The hostname's DNS points at the platform's regional entry point.
5. The certificate is issued.
6. This row holds the hostname's registration, and Foundry routes it to the live version.

There is no single status field, because each of these can become true or false on its own and in any order. A service can be deleted while a certificate is being issued. A CNAME can be removed years after setup. The row reports all six, and it reports the first one that is not met as the next thing the user has to do, together with the exact DNS record to publish.

### The rules

1. **The platform creates no rows on its own.** A deploy creates one row for each hostname the code declares. A Console user creates one on the service's page.
2. **A row exists before its DNS does.** Creating a row stores it and calls nothing in Foundry.
3. **One row serves a hostname.** Any number of rows may name the same hostname. Only one of them holds the hostname's registration at a time, anywhere on the platform. A database index enforces that. A row that cannot take the registration reports which workspace, project and service hold it, if the caller can access that workspace, and otherwise reports only that another workspace holds it.
4. **Ownership is a claim, and the workspace's existing TXT record verifies it.** When a workspace claims a domain that another workspace already holds a verified claim for, the platform re-verifies the existing claims first. Claims are not re-verified on a schedule.
5. **The control plane keeps Foundry in step with the rows.** When a version is promoted or rolled back, or a service is stopped or deleted, the platform does what it can at that moment and writes any failure to the row. One reconciler runs every minute, and after each of those events, and repairs whatever is left. It never runs twice at once for the same project.
6. **A change that leaves the routing table the same never touches a certificate.** When one row replaces another for the same hostname and service, the registration is handed from one to the other.
7. **A row outlives its service.** Deleting the service detaches the row and releases the registration. Stopping the service keeps the registration. Deleting the Branch deletes the row.
8. **Existing custom domains are migrated as rows.** Each one holds its registration and has a verified claim, and none has a `logicalId`, because no code declared it.

### The Console

The service page lists the service's rows with their six conditions and the next step for each. Workspace settings gains a Domains page where the user can claim a domain, see its TXT record, and re-check it.

## How the two sides meet

A `publicUrl()` node with a named hostname becomes one RoutingUrl row, with the node's address written as the row's `logicalId`. On the next deploy, Composer finds the row by that `logicalId`.

A `publicUrl()` node with `publicUrl.prismaBuild()` creates no row in the first step of this work. The service's `prisma.build` hostname exists whether or not the code mentions it. The node records that the service is meant to be public at that hostname.

When Composer declares a row and no row on the Branch carries the node's `logicalId`, it looks for an existing row on the same service with the same hostname and no `logicalId`. If it finds one, it writes the node's `logicalId` on that row and treats it as its own from then on. This is called adoption, and it is how a domain a user set up in the Console before this work becomes the node's row without any interruption. The platform plays no part in adoption other than allowing the `logicalId` to be set.

A deploy never waits for DNS. If a hostname's conditions are not all met, the deploy still succeeds, and its output names the first unmet condition and gives a link to the Console page where the user can finish setup.

## The second step

In the first step, every service stays reachable at its `prisma.build` hostname, whether or not the code says so. The second step makes that hostname a RoutingUrl row too, created only when something asks for it, so that a service nothing should reach from outside has no public hostname at all. `publicUrl.prismaBuild()` then creates that row, and adoption takes over the rows the platform migrates for services that already exist. The scenarios the second step has to satisfy are written. Its detailed requirements are written once the first step's records and reconciler have landed.

## What this proposal does not cover

Private routing between services. Routing by path. Any change to Foundry. Re-checking DNS or ownership on a schedule.

## The detail

Composer:

1. [ADR-0060](../../90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md): the public URL node, and the alternatives considered.
2. [ADR-0062](../../90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): `resolve()`, environments and config adapters.
3. [ADR-0061](../../90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): module input.
4. [composer-to-platform.md](composer-to-platform.md): how a node becomes platform state. [scenarios.md](scenarios.md): thirteen worked scenarios. [domain-map.md](domain-map.md): which concept lives in which system.
5. [step-two-migration-scenarios.md](step-two-migration-scenarios.md): the twelve scenarios the second step must satisfy. The project's spec and plan are in [`.drive/projects/public-urls/`](../../../../.drive/projects/public-urls/).

Prisma Cloud (the platform team maintains these in prisma/pdp-control-plane under `docs/compute/`, on the branch of prisma/pdp-control-plane#5795):

1. [platform-routing-urls.md](platform-routing-urls.md): the records, conditions, rules, routes and Console.
2. [platform-routing-url-lifecycle.md](platform-routing-url-lifecycle.md): every operation and lifecycle event, and the reconciler.
3. [ADR 015](https://github.com/prisma/pdp-control-plane/blob/chore/adr-ingress-entity/docs/architecture/adrs/ADR-015-routing-urls-and-domain-ownership.md): the decision, why, and the alternatives.
4. [projects/routing-urls](https://github.com/prisma/pdp-control-plane/tree/chore/adr-ingress-entity/projects/routing-urls): the spec, acceptance criteria and the five-slice plan.
