# ADR-0060: Traffic from the internet reaches a service only through a public URL the author declares

## Decision

A service is reachable from outside the application only through a **public URL**: a node in the module graph that sends traffic for one hostname to one service. The author provisions it where the hostname is decided, usually the root module.

```ts
// web/src/service.ts — the service exposes an HTTP connection
export default compute({
  name: 'web',
  expose: { http: rawHttpContract },
  build: nextjs({ module: import.meta.url, appDir: '..' }),
});

// module.ts — the app decides that web is public, and at which hostname
import { module } from '@prisma/composer';
import { publicUrl } from '@prisma/composer-prisma-cloud';

export default module('shop', ({ provision }) => {
  const web = provision(webService);
  provision(publicUrl({ name: 'site', url: 'shop.com', target: web.http }));
});
```

The public URL node `shop.site` is wired to the connection `shop.web.http`, which the compute service `shop.web` exposes.

`publicUrl({ name, url, target })` takes three plain parameters:

- `target` is the HTTP connection a service exposes. Anything in the graph that is wired to that connection can send the service requests; a public URL is the internet, wired to it.
- `url` is one of two strategies. `publicUrl.hostname('shop.com')` names the hostname to serve, and a bare string is shorthand for it. `publicUrl.generated()` asks the platform for a hostname under its own domain. Leaving `url` out is an error.
- `name` gives the node its address, `shop.site`, like any other node.

The hostname usually differs per environment, so `url` is usually a `resolve()` value ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)):

```ts
const url = resolve([environment.name], ([name]) =>
  name === 'production' ? 'shop.com'
  : name === 'staging' ? 'staging.shop.com'
  : publicUrl.generated());

provision(publicUrl({ name: 'site', url, target: web.http }));
```

A service with no public URL is reached only by other services in the app.

## Reasoning

**A public URL is a thing of its own, with its own lifecycle.** A custom domain and the `<id>.<region>.prisma.build` address a service gets from the platform are the same kind of thing: a hostname at which the service answers from the internet. One node with two strategies covers both, and the hostname is a property of the node, not a separate kind of object. Adding, changing or removing a hostname is a change to that node and to nothing else.

**The URL points at the service; the service never points at its URL.** Traffic flows from the internet into the service, so the public URL depends on the service's exposed connection and the service knows nothing about it. This is the shape of a load balancer in front of a server, and of Composer's own `cron`, which depends on the worker it calls while the worker knows nothing about the scheduler ([ADR-0020](ADR-0020-scheduled-work-is-a-driver-not-a-resource.md)). Like `cron`, a public URL's result is not captured and not exposed from its module, because nothing inside the graph consumes it.

**The module boundary decides what can be public.** `target` must be a reference to an exposed HTTP connection, and inside a module the only such references are the ones its children expose. So a reusable module decides which of its services *can* be made public, by exposing their HTTP connections, and the application decides which ones *are*, and at which hostname. A forwarded connection resolves at Load to the concrete service that serves it ([module-composition.md](../10-domains/module-composition.md)), so a public URL on a module's exposed connection lands on the right service:

```ts
const identity = provision(auth(), { /* … */ });
provision(publicUrl({ name: 'authUrl', url, target: identity.api }));
```

`identity.admin` is a service RPC connection, not HTTP, so wiring a public URL to it fails the type check.

**Two strategies, no implicit default.** `publicUrl.hostname(…)` and `publicUrl.generated()` are both requests the author makes. What is ruled out is omission: there is no "leave it out and see what happens". A preview environment whose `resolve()` returns `publicUrl.generated()` is reachable with no configuration and no ownership proof; one that names a hostname is reachable once that hostname is proven and set up.

**One hostname per public URL.** Each hostname has its own ownership proof, setup state and certificate on the platform, so `www.shop.com` and `shop.com` are two public URLs wired to the same connection.

**`publicUrl()` says nothing about the graph's structure.** It builds an ordinary node whose edge to `target` sits where every edge sits, and Load reads it like any other. Core can build a node with its edge already set; nothing about that is specific to public URLs.

**On Prisma Cloud, the public URL is one of the service's URLs.** The platform models every hostname a service answers at as a **RoutingUrl**: named by a user or assigned by the platform, public or private, several per service. A `publicUrl()` lowers to a RoutingUrl with public visibility whose identity is the node's address, written as its `logicalId` ([ADR-0057](ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md)). The record exists from the first deploy that declares it, before DNS or ownership proof are done, and it survives the service being deleted, so a hostname's setup is never lost to a service being recreated. A named hostname receives traffic once its conditions hold: among them, that it is covered by a **domain ownership record** the workspace has proven, which happens on the platform, in Console, before or after the deploy that names the hostname. Lowering also declares a private RoutingUrl for every service that another part of the app calls, and creates services with the platform's default URL turned off, so a service that nothing calls has no hostname at all. The platform side is in [public-url.md](../05-prisma-cloud/public-url.md), and the resource comes from the upstream Alchemy Prisma provider ([ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md)).

**Until the platform can address services privately, a private URL is still reachable from the internet.** Everything the platform routes is public, and services call each other over those hostnames. So the model is declared ahead of its enforcement: a service with no public URL is still reachable on its private URL, and the Console shows that rather than presenting it as private. When private addressing arrives, private URLs stop being reachable from outside, and nothing in the author's code or in the records changes.

**A service that needs its own URL gets it through its input.** The RoutingUrl is created before the service's deployment, so its hostname is known in time to be derived, with `resolve()`, into the service's input. `origin()` keeps meaning the platform-assigned origin ([ADR-0039](ADR-0039-a-compute-services-own-origin-is-a-target-resolved-property.md)), and the framework keeps no list of a service's URLs.

## Consequences

- **A deploy never waits for DNS.** A named hostname whose proof or DNS is unfinished deploys with its unmet conditions reported, and the service keeps answering on its private URL.
- **Deploy output reports each public URL through the generic report entries.** The Prisma Cloud descriptor returns one `DeployedEntity` per public URL: the hostname, the first unmet condition (ownership proof, DNS, certificate), and the Console link while any is unmet, or the live address. Core learns nothing about the platform, Console or DNS.
- **Changing a hostname replaces it.** The record keeps its identity and takes the new hostname; the old one stops being served, and the new one serves once proven and set up.
- **A hostname belongs to one public URL on the whole platform.** The platform refuses a second record naming it. A preview whose code names production's hostname is refused, and production is unaffected.
- **Removing a public URL removes its record**, like removing any other node. Asking before an unintended removal is the general concern of not losing data, not something specific to public URLs.
- **`prisma dev` runs the same topology.** The local target gives the public URL a stand-in that binds nothing, through the existing local-target mechanism ([ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)). A named hostname is ignored locally, with one warning per public URL saying so.
- **Routing by path is not part of this.** A public URL takes a hostname. If paths come later, an author declares more public URLs sharing a hostname; a router is never something users declare.
- **Building a hostname from the environment's name is the author's job.** `resolve()` is a general mechanism and knows nothing about URLs. An environment name is not always a valid DNS label (it may contain `_` or exceed 63 characters), so an author deriving `<environment>.preview.shop.com` writes or imports a plain helper that makes a label of it.

## Alternatives considered

- **Hostnames in the Prisma Cloud extension's options in `prisma.config.ts`, keyed by environment and service address.** Rejected: service configuration kept away from the service, naming it by a string nothing keeps in sync with the graph, and application values in a file that only names extensions and the state store ([ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)).
- **The service depends on its domain** (`webService({ domain })`). Rejected: the dependency points from the application to its caller, and every hostname change edits the service.
- **A hostname option on `compute()`.** Rejected: a reusable service would carry one environment's hostname, and every copy would claim it.
- **Exposing the public URL from its module.** Rejected: exposed connections are for consumers inside the graph, and a public URL has none.
- **`origin()` returns the custom hostname.** Rejected: it reverses the service-origin decision and needs a rule for several URLs on one service.
- **One public URL with several hostnames.** Rejected: each hostname has its own proof, state and certificate; two nodes say so plainly.
- **A Composer-owned domain resource.** Rejected: Prisma Cloud resources come from the upstream Alchemy provider, which we extend.
- **Other names.** "Ingress" (Kubernetes vocabulary; no hosting platform uses it), "endpoint" (AWS vocabulary, and what an API offers), "hostname" (wrong once paths exist), "public address" (collides with a node's address), "custom domain" (names only one of the two cases). Users see "domain" and "URL" everywhere; "public URL" fits both cases.

## Related

- [ADR-0020](ADR-0020-scheduled-work-is-a-driver-not-a-resource.md): the driver shape this follows.
- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md) and [module-composition.md](../10-domains/module-composition.md): exposed connections and forwarding.
- [ADR-0054](ADR-0054-raw-http-is-the-untyped-tier-of-service-connections.md): `rawHttpContract`, the connection type a public URL is wired to.
- [ADR-0039](ADR-0039-a-compute-services-own-origin-is-a-target-resolved-property.md): what `origin()` means.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): `resolve()` and per-environment values.
- [public-url.md](../05-prisma-cloud/public-url.md): the Prisma Cloud side.
