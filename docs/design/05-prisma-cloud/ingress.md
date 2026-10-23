# Ingress on Prisma Cloud

How an `ingress()` node ([ADR-0060](../90-decisions/ADR-0060-ingress-is-a-driver-on-an-exposed-http-port.md)) becomes platform state, and what the platform must provide for it. The platform side is proposed in pdp-control-plane as [ADR 015 — an ingress is an independent record with a hostname](https://github.com/prisma/pdp-control-plane/blob/docs/adr-ingress-entity/docs/architecture/adrs/ADR-015-ingress-is-an-independent-entity.md).

## The two sides

```ts
// Composer: the author's code
provision(ingress({ name: 'site', hostname: input.SITE_HOSTNAME, target: web.http }));
```

```
Composer node          Prisma Cloud record (on the stage's Branch)
─────────────────────  ─────────────────────────────────────────────────────────
shop.site (ingress)    Ingress  logicalId "shop.site"
                                hostname  "www.myapp.com" on production, null on pr-42
                                appId     → the App for shop.web
                                state     unconnected → … → active
```

One ingress node is one platform record. Its address is its `logicalId`, as for every node with a platform row ([ADR-0057](../90-decisions/ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md)). The hostname and the service it routes to are properties of the record, so changing either updates the same record.

## What the platform does today, and why it is not enough

A custom domain exists today only as a Foundry row attached to a deployment. Creating one calls Foundry at once, and Foundry refuses until the CNAME points at its switchboard, so a hostname without DNS cannot be stored. Every promote moves each domain to the new deployment, and a failure there is only logged. A deploy cannot declare a hostname before the user has finished DNS, and it cannot find "its" domain again on the next deploy.

The generated `<id>.<region>.prisma.build` endpoint is a separate Foundry record, and Composer's service-to-service connections use it.

## What the platform needs to provide

- **An ingress record that exists without DNS.** Creating it calls no Foundry API. It starts unconnected.
- **An optional hostname.** No hostname means the service's generated hostname, with no ownership proof. A custom hostname needs the workspace's TXT proof and routing DNS before it is connected.
- **Connecting as a separate step.** Console's Verify and connect, a retry, or a reconciler attaches the hostname to routing. The record's `state` reports progress.
- **Ownership by the Branch, not the deployment.** Promotes do not touch the record. Deleting a service disconnects its ingresses instead of deleting them.
- **Lookup by `logicalId`** through the Management API, and a Console setup link in the record while setup is unfinished.
- **A resource in the upstream Alchemy Prisma provider** over those routes, without today's `Prisma.CustomDomain` rule that a domain attaches only to an app on the default Branch.

## How Composer uses it

- **Lowering.** The Prisma Cloud ingress descriptor declares the upstream ingress resource with `logicalId` set to the node's address, `hostname` from the node, and the App of the service that serves `target`. A forwarded port resolves at Load to that service.
- **No hostname on a stage.** The record is created with a null hostname, and the service keeps answering on its generated hostname.
- **Deploy output.** The descriptor returns one `DeployedEntity` per ingress: the hostname, the record's `state`, and the setup link or the live address. Core learns nothing about the platform.
- **A deploy never waits for DNS.** An unconnected ingress is a successful deploy.
- **`prisma dev`.** The local target's stand-in creates nothing.

## Open questions on the platform side

- Whether Foundry can route a custom hostname to the service's endpoint instead of a deployment, so promote needs no per-hostname work.
- The entity's name on the platform.

## Related

- [ADR-0060](../90-decisions/ADR-0060-ingress-is-a-driver-on-an-exposed-http-port.md): ingress in Composer's model.
- [ADR-0062](../90-decisions/ADR-0062-stage-configuration-comes-from-providers.md): where a per-stage hostname comes from.
- [ADR-0048](../90-decisions/ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md): Prisma Cloud resources come from the upstream provider.
- [alchemy-lowering.md](alchemy-lowering.md): the rest of the Prisma Cloud lowering.
