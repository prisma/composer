# ADR-0060: Traffic from the internet reaches a service only through a public URL the author declares

## Decision

A service is reachable from outside the application only through a **public URL**: a node in the module graph that sends traffic for one URL to one service. The author provisions it where the URL is decided, usually the root module.

```ts
// web/src/service.ts — the service exposes the HTTP connection a public URL can be wired to
export default compute({
  name: 'web',
  deps: { auth: rpc(authContract) },
  expose: { http: rawHttpContract },
  build: nextjs({ module: import.meta.url, appDir: '..' }),
});

// module.ts
import { module, resolve } from '@prisma/composer';
import { publicUrl } from '@prisma/composer-prisma-cloud';

export default module('shop', ({ environment, provision }) => {
  const auth = provision(authModule, { input: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });
  const web = provision(webService, { deps: { auth: auth.rpc } });

  const url = resolve([environment.name], ([name]) =>
    name === 'production' ? publicUrl.hostname('shop.com')
    : name === 'staging' ? publicUrl.hostname('staging.shop.com')
    : publicUrl.generated());

  provision(publicUrl({ name: 'site', url, target: web.http }));
});
```

```
shop.site (public URL)  ──is wired to──▶  shop.web.http  ──exposed by──▶  shop.web (compute service)
```

`publicUrl({ name, url, target })` takes plain parameters. `target` is a reference to the HTTP connection a service exposes. `url` is one of two strategies: `publicUrl.hostname('shop.com')` names the hostname to serve, and `publicUrl.generated()` asks the platform for a hostname under its own domain. A bare string is shorthand for `publicUrl.hostname(...)`, since a string can only mean a named hostname. Leaving `url` out is an error. It usually differs per environment, so it is written as a `resolve()` value ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). Every other service in the graph is reached only by other services.

## Reasoning

**A public URL is a thing of its own, with its own lifecycle.** The glossary already names the public boundary of the topology **ingress**: "a request/response Output exposed to the public". What has been missing is a node for it. A custom domain is one case of that node, a public URL whose hostname the author chose. The `<id>.<region>.prisma.build` address every compute service gets today is the other case, a public URL whose hostname the platform chose. One node with two strategies covers both, and the hostname is a property of the node, not a separate kind of object.

**The URL points at the service; the service never points at its URL.** Traffic flows from the internet into the service, so the public URL depends on the service's exposed HTTP connection and the service knows nothing about it. This is the shape of a load balancer and a server, and of Composer's own `cron`, which depends on the worker it calls while the worker knows nothing about the scheduler ([ADR-0020](ADR-0020-scheduled-work-is-a-driver-not-a-resource.md)). Adding, changing or removing a hostname never touches the service's code. Like `cron`, a public URL's result isn't captured and it isn't exposed from its module, because nothing inside the graph consumes it.

**The module boundary decides what can be public.** `target` must be a reference to an exposed HTTP connection, and inside a module the only such references are the ones its children expose. So a reusable module decides which of its services *can* be made public, by exposing their HTTP connections, and the application decides which ones *are*, and at which URL. A forwarded connection resolves at Load to the concrete service that serves it ([module-composition.md](../10-domains/module-composition.md)), so a public URL on a module's exposed connection lands on the right service:

```ts
const identity = provision(auth(), { /* … */ });
provision(publicUrl({ name: 'authUrl', url, target: identity.api }));
```

`identity.admin` is a service RPC connection, not HTTP, so wiring a public URL to it fails the type check.

**`publicUrl()`'s parameters say nothing about the graph's structure.** The function builds an ordinary node whose edge to `target` sits where every edge sits, and Load reads it like any other. Today a node's edges are filled in at `provision()`, so a node that arrives with its edge already set is a small, general addition to core, not something specific to public URLs.

**Two strategies, no implicit default.** `publicUrl.hostname(…)` and `publicUrl.generated()` are both requests the author makes, and a bare string is the first of them. What is ruled out is omission: there is no "leave it out and see what happens". A new preview environment whose `resolve()` returns `publicUrl.generated()` is reachable with no configuration and no ownership proof.

**One hostname per public URL.** Each hostname has its own ownership proof, setup state and certificate on the platform, so `www.shop.com` and `shop.com` are two public URLs wired to the same connection.

**The platform holds the public URL as its own record.** On Prisma Cloud a public URL lowers to the platform's Public URL entity: a record on the environment's Branch, pointing at a service and following whichever of its deployments is live. It exists from the first deploy that declares it, before DNS or ownership proof are done, and it survives the service being deleted. Its identity is the node's address, written as its `logicalId` ([ADR-0057](ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md)), so changing its hostname or its target updates the same record. A named hostname receives traffic once it is under a **Domain** the workspace has proven it owns; proving ownership happens on the platform, in Console, before or after the deploy that names the hostname. The platform side is in [public-url.md](../05-prisma-cloud/public-url.md), and the resource comes from the upstream Alchemy Prisma provider ([ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md)).

**Services stay publicly reachable underneath for now.** Composer's service-to-service connections use the producer's `*.prisma.build` endpoint, and the platform cannot yet address services privately. So this decision names the model without waiting for that: a service with no public URL keeps its generated endpoint, and a `publicUrl.generated()` uses that same endpoint rather than getting a second one. When private addressing arrives, a service with no public URL stops being reachable from outside and nothing in the author's code changes.

**A service that needs its own URL gets it through its input.** The Public URL record is created before the service's deployment, so its hostname is known in time to be derived, with `resolve()`, into the service's input. `origin()` keeps meaning the platform-assigned origin ([ADR-0039](ADR-0039-a-compute-services-own-origin-is-a-target-resolved-property.md)), and the framework keeps no list of a service's URLs.

## Consequences

- **A deploy never waits for DNS.** A named hostname whose proof or DNS is unfinished deploys in a pending state, and the service keeps answering on its generated hostname.
- **Deploy output reports each public URL through the generic report entries.** The Prisma Cloud descriptor returns one `DeployedEntity` per public URL: the hostname, which step is outstanding (ownership proof, DNS, certificate), and the Console link PDP returns while setup is unfinished, or the live address once it is connected. Core learns nothing about PDP, Console or DNS.
- **Console must show each service's actual exposure** while every service is still reachable, so the topology never presents an unenforced boundary as private.
- **Changing a hostname replaces it.** The record keeps its identity and takes the new hostname; the old one stops being served, and the new one serves once proven and set up.
- **A hostname belongs to one public URL only**, across every environment of a project and every project sharing the Domain. The platform refuses a second record naming it. A preview whose code names production's hostname is refused, and production is unaffected.
- **Removing a public URL removes its record**, like removing any other node. Protecting a deploy against unintended removals is the general concern of asking before losing data, not something specific to public URLs.
- **`prisma dev` runs the same topology.** The local target gives the public URL a stand-in that binds nothing, through the existing local-target mechanism ([ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)). A named hostname is ignored locally, with one warning per public URL saying so.
- **Routing by path is not part of this.** A public URL takes a hostname. If paths come later, an author declares more public URLs sharing a hostname; a router is never something users declare, and nothing about routing is decided here.
- **Core gains the ability to build a node with its edge already set.** It is general, and `publicUrl()` is its first user.
- **The strategy methods are `publicUrl.hostname()` and `publicUrl.generated()`**, methods on `publicUrl` itself, not free-standing functions.
- **Building a hostname from the environment's name is the author's job.** `resolve()` is a general mechanism and knows nothing about URLs. An environment name is not always a valid DNS label (it may contain `_` or exceed 63 characters), so an author deriving `<environment>.preview.shop.com` writes or imports a plain helper that makes a label of it; such a helper, if Composer ships one, is independent of `resolve()`.

## Alternatives considered

- **Hostnames in the Prisma Cloud extension's options in `prisma.config.ts`, keyed by branch and service address.** Rejected: service configuration kept away from the service, naming it by a string nothing keeps in sync with the graph, and application values in a file that only names extensions and the state store ([ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)).
- **The service depends on its domain** (`webService({ domain })`). Rejected: the dependency points from the application to its caller, and every hostname change edits the service.
- **A hostname option on `compute()`.** Rejected: a reusable service would carry one environment's hostname, and every copy would claim it.
- **Exposing the public URL from its module.** Rejected: exposed connections are for consumers inside the graph, and a public URL has none.
- **`origin()` returns the custom hostname.** Rejected: it reverses the service-origin decision and needs a rule for several URLs on one service.
- **One public URL with several hostnames.** Rejected: each hostname has its own proof, state and certificate; two nodes say so plainly.
- **A Composer-owned domain resource.** Rejected: Prisma Cloud resources come from the upstream Alchemy provider, which we extend.
- **Names.** "Ingress" (no platform in the Vercel, Convex, Cloudflare, AWS, SST, Firebase and Supabase survey uses it), "endpoint" (AWS-only, and what an API offers), "hostname" (wrong once paths exist), "public address" (collides with a node's address), "custom domain" (names only one case). Users see "domain" and "URL" everywhere; "public URL" fits both cases.

## Related

- [ADR-0020](ADR-0020-scheduled-work-is-a-driver-not-a-resource.md): the driver shape this follows.
- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md) and [module-composition.md](../10-domains/module-composition.md): exposed connections and forwarding.
- [ADR-0054](ADR-0054-raw-http-is-the-untyped-tier-of-service-connections.md): `rawHttpContract`, the connection type a public URL is wired to.
- [ADR-0039](ADR-0039-a-compute-services-own-origin-is-a-target-resolved-property.md): what `origin()` means.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): `resolve()` and per-environment values.
- [public-url.md](../05-prisma-cloud/public-url.md): the Prisma Cloud side.
- [Glossary: Ingress / Egress](../03-domain-model/glossary.md#ingress--egress).
