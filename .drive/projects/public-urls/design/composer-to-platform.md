# Public URLs on Prisma Cloud

How a `publicUrl()` node ([ADR-0060](../../../../docs/design/90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md)) becomes platform state, and what the platform provides for it. The platform side is decided in pdp-control-plane's decision record "a custom hostname is a RoutingUrl record the control plane owns" ([prisma/pdp-control-plane#5795](https://github.com/prisma/pdp-control-plane/pull/5795)); its design is `docs/compute/RoutingUrls.md` and `RoutingUrlLifecycle.md` there, and `projects/routing-urls/` holds the spec and plan.

## The two sides

```ts
// Composer: the author's code
provision(publicUrl({ name: 'site', url, target: web.http }));
```

When `url` names a hostname, the Composer node `shop.site` becomes one RoutingUrl record on the environment's Branch:

| RoutingUrl field | value |
| --- | --- |
| logicalId | `shop.site` |
| hostname | `shop.com` |
| service | the service for `shop.web` |
| conditions | ownership verified, service present, live deployment, DNS points at the switchboard, custom domain bound, certificate active |

One public URL node is one platform record. Its address is its `logicalId`, as for every node with a platform row ([ADR-0057](../../../../docs/design/90-decisions/ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md)). The hostname and the service it points at are properties of the record, so changing either updates the same record.

When `url` is `publicUrl.prismaBuild()`, the node becomes no record in the first step. Every service already has its `<id>.<region>.prisma.build` hostname, and the node says the service is public at it. The deploy output reports that hostname for the node. In the second step the node becomes the platform's RoutingUrl for that hostname.

## What the platform provides

Two entities:

- **RoutingUrl.** A custom hostname mapped to a service. It exists from the moment it is declared and calls no Foundry API on creation. It answers when all of its conditions hold: the hostname is covered by a verified domain ownership claim in the workspace, the service exists, the service has a live deployment, the hostname's DNS points at the service's regional switchboard, a Foundry custom domain exists for it bound to the live deployment's compute version, and that custom domain's certificate is active. The record reports each condition and the first unmet one. The RoutingUrl repository creates the custom domain once the conditions hold, reassigns it across promotes, and recreates it when Foundry has deleted it; a failed Foundry call is retried from a Worker queue, and the user can run the same check from the Console. The record survives its service being deleted. Composer finds it by `logicalId`. Changing its hostname updates the same record; the old hostname's custom domain is deleted and the new one goes through the conditions.
- **Domain ownership claim.** A workspace's claim to a domain, verified or not: an exact hostname (`shop.com`) or an exact wildcard (`*.preview.shop.com`), which covers exactly one label below it. Verification is today's TXT record, unchanged: `_prisma-verification.<domain>` (a wildcard's at its base domain) carrying the workspace's existing value. The claim belongs to the workspace because the check does: the value is a hash of the workspace id. A RoutingUrl is covered when its hostname equals a verified domain or is one label under a verified wildcard. When a workspace claims a domain another workspace's verified claim covers, the platform re-verifies the existing claims first.

And four rules:

- **A hostname serves one RoutingUrl on the whole platform.** Any number of records may name a hostname; at most one is registered with Foundry at a time, across every workspace, project and Branch. A record whose hostname another record serves reports that in its routing-bound condition. This is unrelated to ownership; it is what stops two services from receiving the same traffic.
- **A record exists only because something asked for it.** Composer creates one per `publicUrl()` with a named hostname. A Console user creates one on the service's page. The platform creates none on its own.
- **Both setup orders work.** A user can claim and verify a domain in the Console before any code names a hostname under it, or a deploy can create the RoutingUrl first; its record then shows "ownership not verified" with the TXT record to publish, and when the platform finds that record it creates the workspace's claim, verified, with nothing more asked of the user. Composer never creates a claim: a claim belongs to the workspace and outlives any one project or environment.
- **Finishing DNS never needs a redeploy, and a routing no-op never reissues a certificate.** The control plane checks every condition itself, including the CNAME, calls Foundry only when it knows the call will succeed, and when one record replaces another for the same hostname and service it moves the existing custom domain over instead of deleting it and creating it again.

Previews under a namespace such as `*.preview.shop.com` need one ownership claim for the wildcard and one wildcard DNS record. Foundry issues one certificate per hostname, so each preview hostname gets its own once the wildcard record resolves. A preview's hostname must stay one label under the namespace, and a hostname under the wildcard that no RoutingUrl holds reaches nothing.

## What the platform does today, and why it is not enough

A custom domain exists today only as a Foundry record attached to one deployment. Creating one calls Foundry at once, and Foundry refuses until the hostname's DNS points at it, so a hostname without DNS cannot be stored. Every promote moves each domain to the new deployment on a best-effort basis, and a failure there is only logged. A deploy cannot declare a hostname before the user has finished DNS, and it cannot find "its" domain again on the next deploy.

The `<id>.<region>.prisma.build` hostname every service gets is a separate Foundry record, the service's endpoint, created at promote. Composer's service-to-service connections use it. This decision leaves it as it is.

## How Composer uses it

- **Lowering.** For a named hostname, the Prisma Cloud public URL descriptor declares the upstream RoutingUrl resource with `logicalId` set to the node's address, the resolved hostname, and the service that exposes `target`. A forwarded connection resolves at Load to that service. For `publicUrl.prismaBuild()` it declares nothing in the first step.
- **Adoption.** When no row on the Branch holds the node's `logicalId`, the resource looks for a live row on the same service with the same hostname and no `logicalId`, writes the `logicalId` on it through the update route, and records it in state. A row with a different `logicalId` is never adopted. This is how a backfilled row, made for a domain the user set up before Composer knew about routing records, becomes the node's row with no interruption, and how the second step takes over the `prisma.build` rows.
- **Deploy output.** One `DeployedEntity` per public URL: the hostname, the first unmet condition (ownership claim, DNS, certificate), and, while any is unmet, every record the user still has to publish (the ownership TXT record and the CNAME, with name, type and value, ready to paste into a DNS console), or the live address. The user gets everything needed to finish without opening the Console. Core learns nothing about the platform. The same records are outputs of the Alchemy RoutingUrl resource, so a DNS adapter can publish them later without a platform change.
- **Console** shows each service's custom hostnames with their conditions on the service's page, and the workspace's ownership claims in workspace settings.
- **`prisma dev`.** The local target's stand-in creates nothing and ignores a named hostname.

## Step two, on both sides

- The platform's endpoint becomes an opt-in RoutingUrl, so a service nothing should reach from outside has no public hostname, and `publicUrl.prismaBuild()` lowers to that row. Until then every service is reachable at its platform hostname, and the node records that it is meant to be. The scenarios that step has to satisfy are in [step-two-migration-scenarios.md](step-two-migration-scenarios.md) while the project is open. Composer takes ownership of the rows that exist by the adoption rule above.

## Later, on the platform side

- Re-checking DNS after a hostname is active, so a removed CNAME shows on the record, and re-verifying ownership claims on a schedule.
- The rule that automatic Branch cleanup retains a Branch with a custom domain; unnecessary once the binding is a record, to be removed later.
- Any change to Foundry, including private routing.

## Related

- [ADR-0060](../../../../docs/design/90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md): public URLs in Composer's model.
- [ADR-0062](../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): `resolve()` and per-environment values.
- [ADR-0048](../../../../docs/design/90-decisions/ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md): Prisma Cloud resources come from the upstream provider.
- [public-url-domain-map.md](domain-map.md) and [public-url-scenarios.md](scenarios.md).
- [alchemy-lowering.md](../../../../docs/design/05-prisma-cloud/alchemy-lowering.md): the rest of the Prisma Cloud lowering.
