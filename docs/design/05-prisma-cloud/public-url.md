# Public URLs on Prisma Cloud

How a `publicUrl()` node ([ADR-0060](../90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md)) becomes platform state, and what the platform must provide for it. The platform side is proposed in pdp-control-plane as [ADR 015](https://github.com/prisma/pdp-control-plane/pull/5795).

## The two sides

```ts
// Composer: the author's code
provision(publicUrl({ name: 'site', url, target: web.http }));
```

```
Composer node            Prisma Cloud record (on the environment's Branch)
───────────────────────  ──────────────────────────────────────────────────────────
shop.site (public URL)   Public URL  logicalId "shop.site"
                                     hostname  "shop.com" on production; generated on pr-42
                                     service   → the Compute Service for shop.web
                                     state     pending → … → active
```

One public URL node is one platform record. Its address is its `logicalId`, as for every node with a platform row ([ADR-0057](../90-decisions/ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md)). The hostname and the service it points at are properties of the record, so changing either updates the same record.

## What the platform does today, and why it is not enough

A custom domain exists today only as a Foundry record attached to one deployment. Creating one calls Foundry at once, and Foundry refuses until the hostname's DNS points at it, so a hostname without DNS cannot be stored. Every promote moves each domain to the new deployment, and a failure there is only logged. A deploy cannot declare a hostname before the user has finished DNS, and it cannot find "its" domain again on the next deploy.

The generated `<id>.<region>.prisma.build` address is a separate Foundry record, the service's endpoint, and Composer's service-to-service connections use it.

## What the platform needs to provide

Two entities:

- **Public URL.** A record on a Branch that receives traffic for one hostname and sends it to one service, whichever of the service's deployments is live. Its hostname is either one the user names or one the platform generates. It exists as soon as a deploy declares it, before DNS or ownership proof, and is created before the service's deployment. Until a named hostname is proven and its DNS is set up it receives no traffic, and the deploy still succeeds. It survives its service being deleted. Found by `logicalId`. Changing its hostname replaces the old hostname; the record keeps its identity.
- **Domain.** A domain a workspace has proven it owns. Today's ownership proof is already per workspace: a TXT record carrying a workspace-specific value (prisma/pdp-control-plane#5785). A named Public URL receives traffic once its hostname is under a proven Domain. The platform owns `prisma.build`, so generated URLs need no proof. A team that controls only a subdomain can prove that subdomain.

And three rules:

- **A hostname belongs to one Public URL only**, across every environment of a project and every project sharing the Domain. PDP refuses a second record naming it when the record is created, not when it is later attached to routing.
- **Both setup orders work.** A user can prove a domain in Console before any code names it, or a deploy can name a hostname first and create the pending record. Neither is a prerequisite.
- **Finishing DNS never needs a redeploy.** The platform observes DNS, issues the certificate and attaches routing on its own.

Previews under a namespace such as `*.preview.shop.com` need one wildcard DNS record and one proof for the namespace. Foundry issues one certificate per hostname (ACME HTTP-01), so each preview hostname gets its own once the wildcard record resolves to Foundry. A preview's hostname must stay one label under the namespace, and a hostname under the wildcard that no Public URL holds must not reach anything.

## How Composer uses it

- **Lowering.** The Prisma Cloud public URL descriptor declares the upstream Public URL resource with `logicalId` set to the node's address, the resolved `url` strategy, and the Compute Service of the service that exposes `target`. A forwarded connection resolves at Load to that service.
- **`publicUrl.generated()`** uses the service's existing `*.prisma.build` endpoint while every service is still publicly reachable; it gets a hostname of its own once services can be private.
- **Deploy output.** One `DeployedEntity` per public URL: the hostname, which step is outstanding (ownership proof, DNS, certificate), and the setup link or the live address. Core learns nothing about the platform.
- **Console** shows each service's actual exposure during the transition.
- **`prisma dev`.** The local target's stand-in creates nothing and ignores a named hostname.

## Open questions on the platform side

- Whether a project ever needs to own a domain apart from its workspace, and whether proving `shop.com` covers the names under it.
- Whether Foundry can route a hostname to a service instead of to one compute version, so promotes need no per-hostname work.
- What a deploy does when its public URL names a hostname another Public URL holds.

## Related

- [ADR-0060](../90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md): public URLs in Composer's model.
- [ADR-0062](../90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): `resolve()` and per-environment values.
- [ADR-0048](../90-decisions/ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md): Prisma Cloud resources come from the upstream provider.
- [alchemy-lowering.md](alchemy-lowering.md): the rest of the Prisma Cloud lowering.
