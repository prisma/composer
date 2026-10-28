# Public URLs on Prisma Cloud

How a `publicUrl()` node ([ADR-0060](../90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md)) becomes platform state, and what the platform provides for it. The platform side is decided in pdp-control-plane's ADR 015, "a RoutingUrl is a URL at which a service answers; a domain ownership record is a name the workspace has proven" ([prisma/pdp-control-plane#5795](https://github.com/prisma/pdp-control-plane/pull/5795)), and its project folder `projects/routing-urls/` holds the spec and plan.

## The two sides

```ts
// Composer: the author's code
provision(publicUrl({ name: 'site', url, target: web.http }));
```

The Composer node `shop.site` becomes one RoutingUrl record on the environment's Branch:

| RoutingUrl field | value |
| --- | --- |
| logicalId | `shop.site` |
| visibility | public |
| hostname | `shop.com` on production; assigned by the platform on pr-42 |
| service | the service for `shop.web` |
| conditions | ownership proven, service present, live version, DNS points at the region, certificate issued, routing bound |

One public URL node is one platform record. Its address is its `logicalId`, as for every node with a platform row ([ADR-0057](../90-decisions/ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md)). The hostname and the service it points at are properties of the record, so changing either updates the same record.

## What the platform provides

Two entities:

- **RoutingUrl.** A URL at which a service answers. One entity covers internal and external reach: its hostname is either **named** by a user or **assigned** by the platform, its visibility is `public` or `private`, and a service may have several. It exists from the moment it is declared and calls no Foundry API on creation. A named hostname answers when all of its conditions hold: the hostname is covered by a proven domain ownership record in the workspace, the service exists, the service has a live version, the hostname's DNS points at the service's region, the certificate is issued, and Foundry's routing is bound to the live version. The record stores each condition and shows the first unmet one. A reconciler in the control plane keeps Foundry's records bound to the live version across promotes and recovers stuck ones. It survives its service being deleted. Composer finds it by `logicalId`. Changing its hostname updates the same record; the old hostname stops being served and the new one goes through the conditions.
- **Domain ownership record.** A name the workspace has proven it may use: an exact hostname (`shop.com`) or an exact wildcard string (`*.preview.shop.com`), which covers exactly one label below it. The proof is today's TXT record, unchanged: `_prisma-verification.<name>` (a wildcard's at its base name) carrying the workspace's existing value. The record belongs to the workspace because the proof does: the value is a hash of the workspace ID. A named public RoutingUrl is covered when its hostname equals a proven name or is one label under a proven wildcard. The platform owns `prisma.build`, so assigned hostnames need no proof.

And four rules:

- **A hostname belongs to one RoutingUrl on the whole platform**, across every workspace, project and Branch. The platform refuses a second record naming it when the record is created. This is unrelated to ownership; it is what stops two services from receiving the same traffic.
- **A URL exists only because something asked for it.** Nothing is created automatically. Composer creates a public RoutingUrl for each `publicUrl()` and a private one for each service that another part of the app calls; a service nothing calls gets no hostname. Service creation takes a parameter for whether to create the service's default assigned public URL; the Console and raw API keep it true, Composer passes false.
- **Both setup orders work.** A user can prove a name in the Console before any code names it, or a deploy can create the RoutingUrl first; its record then shows "ownership not proven" and links to the workspace's Domains page.
- **Finishing DNS never needs a redeploy.** The control plane checks every condition itself, including the CNAME, calls Foundry only when it knows the call will succeed, and issues the certificate and binds routing on its own.

Previews under a namespace such as `*.preview.shop.com` need one domain ownership record for the wildcard and one wildcard DNS record. Foundry issues one certificate per hostname, so each preview hostname gets its own once the wildcard record resolves. A preview's hostname must stay one label under the namespace, and a hostname under the wildcard that no RoutingUrl holds reaches nothing.

## What the platform does today, and why it is not enough

A custom domain exists today only as a Foundry record attached to one deployment. Creating one calls Foundry at once, and Foundry refuses until the hostname's DNS points at it, so a hostname without DNS cannot be stored. Every promote moves each domain to the new deployment on a best-effort basis, and a failure there is only logged. A deploy cannot declare a hostname before the user has finished DNS, and it cannot find "its" domain again on the next deploy.

The `<id>.<region>.prisma.build` address every service gets is a separate Foundry record, the service's endpoint, created at promote whether anyone asked or not. Composer's service-to-service connections use it.

## The transitional state

Foundry is not changed, and everything Foundry routes is reachable from the public internet; a Composer app's services call each other over those same hostnames. So the platform cannot make a service private yet. A service with no public URL stays reachable on its private RoutingUrl, and the Console says so; nothing is presented as private. When Foundry can route traffic privately, a service's private URLs stop being reachable from outside, and nothing in the author's code or in the records changes.

## How Composer uses it

- **Lowering.** The Prisma Cloud public URL descriptor declares the upstream RoutingUrl resource with `logicalId` set to the node's address, visibility `public`, the resolved `url` strategy (a named hostname, or assigned), and the service that exposes `target`. A forwarded connection resolves at Load to that service. For every service that another node in the app calls, lowering declares a private RoutingUrl, and it creates services with the default-URL parameter off.
- **`publicUrl.generated()`** is an assigned public RoutingUrl. Today the platform assigns the service's existing `*.prisma.build` hostname.
- **Deploy output.** One `DeployedEntity` per public URL: the hostname, the first unmet condition (ownership proof, DNS, certificate), and the Console link while any is unmet, or the live address. Core learns nothing about the platform.
- **Console** shows each service's URLs with their visibility and conditions on the service's page, and the workspace's domain ownership records in workspace settings.
- **`prisma dev`.** The local target's stand-in creates nothing and ignores a named hostname.

## Not in scope on the platform side

- Any change to Foundry, including private addressing and routing a hostname to a service's endpoint rather than a compute version.
- Re-checking DNS after a hostname is active, so a removed CNAME shows on the record; the reconciler's shape allows it later.
- The rule that automatic Branch cleanup retains a Branch with a custom domain; unnecessary once the binding is a record, to be removed later.

## Related

- [ADR-0060](../90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md): public URLs in Composer's model.
- [ADR-0062](../90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): `resolve()` and per-environment values.
- [ADR-0048](../90-decisions/ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md): Prisma Cloud resources come from the upstream provider.
- [public-url-domain-map.md](public-url-domain-map.md) and [public-url-scenarios.md](public-url-scenarios.md).
- [alchemy-lowering.md](alchemy-lowering.md): the rest of the Prisma Cloud lowering.
