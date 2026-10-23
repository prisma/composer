# ADR-0060: Public HTTP traffic reaches a service only through an ingress, a driver on its exposed HTTP port

## Decision

A service is reachable from outside the application only through an **ingress**: a node that routes public HTTP traffic for one hostname to one exposed HTTP port. The author provisions it where the hostname is decided, usually the root:

```ts
// web/src/service.ts — the service declares the port it serves HTTP on
export default compute({
  name: 'web',
  deps: { auth: rpc(authContract) },
  expose: { http: rawHttpContract },
  build: nextjs({ module: import.meta.url, appDir: '..' }),
});

// module.ts
import { ingress } from '@prisma/composer-prisma-cloud';

export default module('shop', { input: type({ 'SITE_HOSTNAME?': 'string' }) },
  ({ input, provision }) => {
    const auth = provision(authModule, {
      input: { signingKey: envSecret('AUTH_SIGNING_SECRET') },
    });
    const web = provision(webService, { deps: { auth: auth.rpc } });
    provision(ingress({ name: 'site', hostname: input.SITE_HOSTNAME, target: web.http }));
  });
```

```
shop.site (ingress)  ──routes to──▶  shop.web.http  (shop.web: a compute service)
```

`ingress({ name, hostname, target })` takes plain parameters. `target` is a reference to an exposed HTTP port. `hostname` is the public hostname on the stage being deployed; it usually comes from the root's per-stage input ([ADR-0062](ADR-0062-stage-configuration-comes-from-providers.md)). When a stage supplies no hostname, the ingress gets the platform's generated hostname, so a new preview stage is reachable without any configuration. Every other service in the graph talks only to other services.

## Reasoning

**Ingress is the word the model already uses.** The glossary defines ingress as "a request/response Output exposed to the public — a real edge at the topology's public boundary". A custom domain is the special case of an ingress whose hostname the author chose. The platform-generated `<id>.<region>.prisma.build` address every compute service gets today is the other case: an ingress whose hostname the platform chose. Modelling both as one thing means a hostname is a property of the ingress, not a separate kind of object.

**An ingress is a driver.** Traffic flows from the outside world into the service, so the ingress depends on the service's exposed port, and the service never depends on its ingress. This is the ports-and-adapters view: an ingress is a driving adapter, like an HTTP route or a load balancer, and a driving adapter depends on the port the application offers. If the service depended on its domain instead, every new hostname would change the service's declaration, and the dependency would point outward. Composer already has a driver with this shape: a `cron` scheduler depends on the endpoint it calls ([ADR-0020](ADR-0020-scheduled-work-is-a-driver-not-a-resource.md)). Like `cron`, an ingress is provisioned and its result is not captured, because nothing in the graph consumes it.

**The module boundary decides what can be public.** An ingress can only target a port its author holds a reference to, and inside a module the only references available are the ports a child exposes. So a reusable module decides which of its services *can* be made public, by exposing their HTTP ports. The application decides which ones *are* public, and on which hostname. A forwarded port resolves at Load to the concrete service that serves it ([module-composition.md](../10-domains/module-composition.md)), so an ingress on a reusable module's exposed port lands on the right service:

```ts
const identity = provision(auth(), { /* … */ });
provision(ingress({ name: 'authDomain', hostname: input.AUTH_HOSTNAME, target: identity.api }));
```

The type of `target` is an HTTP port, so pointing an ingress at a service RPC port, such as `identity.admin`, fails the type check.

**The ingress is not exposed from its module.** An exposed port exists so that an enclosing module can wire it to a sibling. An ingress's consumer is outside the application, so exposing it would give nothing in the graph anything to wire, and a root module cannot expose ports anyway.

**`target` is explicit.** Nothing guesses which port an ingress routes to. On Prisma Cloud a compute service listens on one port, and every port it exposes is served there, so the deployment's single HTTP port mapping serves any target.

**`ingress()`'s parameters say nothing about the graph's structure.** The function builds an ordinary node whose edge to `target` sits where every edge sits, and Load reads it like any other. Today a node's edges are filled in at `provision()`, so supporting a node that arrives with its edge already set is a small, general addition to core, not something specific to ingress.

**Services stay public underneath for now.** Composer's service-to-service connections currently use the producer's public endpoint: lowering writes a service's `appEndpointDomain` into its consumer's environment. So the platform keeps every compute service publicly addressable until it can address services privately. This decision names the model now, without waiting for that. A service with no ingress keeps its generated endpoint for service-to-service calls, and that endpoint is not an ingress in the topology. An ingress without a hostname takes over the service's generated hostname rather than getting a second one. When private addressing arrives, a service's own endpoint becomes private, and an ingress with no hostname gets a public generated hostname of its own.

**A service learns its public hostname from its input.** If a service needs to know the hostname it is served on, the author binds the same value into the service's input that the ingress receives. There is no list of ingresses for a service to read and no preferred hostname. `origin()` keeps meaning the platform-assigned origin ([ADR-0039](ADR-0039-a-compute-services-own-origin-is-a-target-resolved-property.md)).

**The platform holds the ingress as its own record.** On Prisma Cloud, an ingress lowers to the platform's ingress entity: an independent record, connected to a service, whose hostname is a property. It exists from the first deploy that declares it, even before DNS is set up, and Console finishes the setup (ownership proof and routing records). Its identity is the node's address, written as its `logicalId` ([ADR-0057](ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md)), so changing its hostname or its target updates the same record. The platform side is specified separately in pdp-control-plane, and the resource comes from the upstream Alchemy Prisma provider ([ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md)).

## Consequences

- **One hostname per ingress.** Serving `www.example.com` and `example.com` takes two ingresses, each with its own ownership proof, status and quota slot on the platform.
- **A deploy never waits for DNS.** An ingress whose hostname is not yet set up deploys in an unconnected state, and the service keeps serving on its generated hostname.
- **Deploy output reports each ingress through the generic report entries.** The Prisma Cloud ingress descriptor returns one `DeployedEntity` per ingress: the hostname as its `id`, its setup state in `details`, and as its `url` the Console setup link PDP returns while setup is unfinished, or the live address once it is connected. Core learns nothing about PDP, Console or DNS.
- **`prisma dev` runs the same topology.** The local target gives the ingress a stand-in that binds no hostname, through the existing local-target mechanism ([ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)).
- **Removing an ingress removes its record**, like removing any other node. Protecting a deploy against unintended removals is the general concern of asking before losing data, not something specific to ingress.
- **Core gains the ability to build a node with its edge already set.** It is general, and `ingress()` is its first user.

## Alternatives considered

- **Hostnames in the Prisma Cloud extension's options in `prisma.config.ts`, keyed by branch and service address.** Rejected: it keeps service configuration away from the service and names the service by a string nothing keeps in sync with the graph. The config file says which extensions and state store a deploy uses, not application values ([ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)).
- **The service depends on its domain** (`webService({ domain })`). Rejected: the dependency points from the application to its caller, so every hostname change would edit the service's declaration.
- **A hostname option on `compute()`.** Rejected: a reusable service would carry an environment-specific value, and every copy would claim the same hostname.
- **Exposing the ingress from its module.** Rejected: exposed ports are for consumers inside the graph, and an ingress has none.
- **`origin()` returns the custom hostname.** Rejected for now: it reverses the decision that `origin()` is the platform-assigned origin, and it needs a rule for choosing between several ingresses on one service. Binding the configured hostname into the service's input covers the need.
- **A Composer-owned domain resource.** Rejected: Prisma Cloud resources come from the upstream Alchemy provider, which we extend there.

## Related

- [ADR-0020](ADR-0020-scheduled-work-is-a-driver-not-a-resource.md): the driver shape this follows.
- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md) and [module-composition.md](../10-domains/module-composition.md): exposed ports and forwarding.
- [ADR-0054](ADR-0054-raw-http-is-the-untyped-tier-of-service-connections.md): `rawHttpContract`, the port type an ingress targets.
- [ADR-0039](ADR-0039-a-compute-services-own-origin-is-a-target-resolved-property.md): what `origin()` means.
- [ADR-0062](ADR-0062-stage-configuration-comes-from-providers.md): where the per-stage hostname comes from.
- [Glossary: Ingress / Egress](../03-domain-model/glossary.md#ingress--egress).
