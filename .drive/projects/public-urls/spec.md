# Purpose

Let an author say, in code, which services receive traffic from the internet and at which URL, with the URL differing per environment, and never have a deploy fail because a hostname's DNS isn't ready yet. Today every compute service is public on its prisma.build address, a custom domain can only be added by hand after the deploy, and nothing in the code records which services are meant to be public.

# At a glance

```ts
// module.ts
export default module('shop', ({ environment, provision }) => {
  const auth = provision(authModule, { secrets: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });
  const web = provision(webService, { deps: { auth: auth.rpc } });

  const url = resolve([environment.name], ([name]) =>
    name === 'production' ? 'shop.com'
    : name === 'staging' ? 'staging.shop.com'
    : publicUrl.prismaBuild());

  provision(publicUrl({ name: 'site', url, target: web.http }));
});
```

```sh
prisma deploy                          # production: shop.com
prisma deploy --environment pr-42      # a preview: a hostname the platform generates
prisma dev                             # the environment dev, on this machine
```

Under the hood, `publicUrl` is a node that is wired to the HTTP connection a service exposes. `resolve()` computes a value after the graph is built, with `provision` disabled, so the graph's structure is the same in every environment. On Prisma Cloud a named hostname becomes a RoutingUrl record on the environment's Branch that exists before DNS does and answers once its conditions hold, among them a domain ownership claim the workspace has verified. A prisma.build URL creates nothing: every service already has that hostname.

The decisions and their reasons are recorded in ADR-0059 to ADR-0062, `docs/design/05-prisma-cloud/public-url.md` (with its domain map and scenarios) and pdp-control-plane ADR 015. Execution decisions that the ADRs don't carry are in [design-notes.md](design-notes.md).

# Non-goals

- Routing by path. Subpaths are several public URLs, each with its own hostname, not a router primitive.
- Private addressing between services. Making the platform's own hostname opt-in is step two of this project (P3 and the platform's fifth slice), with its scenarios in [migration-scenarios.md](migration-scenarios.md).
- Modules declaring `input` (ADR-0061), `resolve()` over module inputs, and config adapters with `dotenv()` (the second half of ADR-0062). They are a follow-on project, `module-input`, recorded in `.drive/deferred.md`. This project ships `resolve()` over `environment.name` and other resolved values only.
- Secrets adapters, and the reference-based `serviceOrigin`.
- Any change to Foundry. The control plane reconciles over Foundry's existing APIs.
- A RoutingUrl for every service. A record exists only because something asked for it: Composer declares one per `publicUrl()` with a named hostname.

# Place in the larger world

The work spans four repositories:

- **prisma/composer**: `resolve()` and the second evaluation pass in core; `publicUrl()` and its two strategies in the Prisma Cloud extension; the rename from stage to environment on every public surface; guides, the agent skill and the examples.
- **alchemy-run/alchemy**, `packages/prisma`: the Prisma provider is ours to change. First lifting `Prisma.CustomDomain`'s rule that a domain attaches only to an app on the default Branch; later a `Prisma.RoutingUrl` resource over the new routes.
- **prisma/pdp-control-plane**: the RoutingUrl records and domain ownership claims, their Management API routes, the reconciler, the backfill of existing custom domains, and the Console's custom hostnames on the service page and its Domains page of ownership claims. Its own project is `projects/routing-urls/` in that repository, with pdp-control-plane's ADR 015.
- **Foundry**: unchanged. The control plane reconciles over its existing endpoint and domain APIs.

Existing custom domains keep working: PDP backfills them into RoutingUrl records with no `logicalId`. A hostname added in Console that the code later declares gets a record of Composer's own, and the platform hands the registration over without reissuing the certificate.

# Cross-cutting requirements

- **The graph's structure is the same whatever inputs Composer is given.** `resolve()` callbacks may compute values, never structure; calling `provision` inside one is an error that names this rule.
- **One hostname per public URL, and a hostname is served by one RoutingUrl on the whole platform.** Several records may name it; the platform registers one at a time and the others report it as in use.
- **A public URL's identity is its node address**, written as `logicalId` on its platform row, as for every other node (ADR-0057). A record created in Console has no `logicalId` and is never touched by a deploy.
- **A hostname whose DNS isn't ready is a normal state, not an error**, once the platform record exists. Until then (see transitional shape) the deploy fails naming the hostname and the DNS step.
- **Recorded decisions are updated before the code that depends on them merges.** prisma/composer#385, #386 and pdp-control-plane#5795 merge before the slices that implement them.
- **The term is environment** on every public surface: flags, types, errors, guides, the agent skill. No public surface says "stage" when this project closes.

# Transitional-shape constraints

- **Day one, a named hostname lowers to `Prisma.CustomDomain`.** DNS must be in place or the deploy fails, as a custom domain does today. The pending state arrives when the PDP record and the Alchemy resource over it ship, and `publicUrl.hostname()` switches to the new resource with no change to the authored code.
- **`publicUrl.prismaBuild()` lowers to nothing on the platform** and reports the service's existing `*.prisma.build` URL. That is its final form for this project; the platform's later step makes the hostname opt-in.
- **The upstream default-Branch rule is lifted before `publicUrl()` ships.** Composer's `publicUrl` waits for the Alchemy release that carries the change; the check is patched out under `patches/` only if that release stalls.
- **The rename to environment ships as one Composer release**, so authors change `--stage` to `--environment` once.
- **Promote re-pointing moves from best-effort to the reconciler** when the RoutingUrl record lands; until then today's `reassignDomains` behaviour stands.

# Project DoD

- A test app with one public service, deployed to production and to a preview environment with the same code, shows that service alone as public in the topology; production serves on the named hostname, the preview on its prisma.build URL.
- The same app deployed to production before `shop.com`'s DNS exists succeeds, the deploy output names the outstanding step and prints the Console link, and the hostname goes active after DNS is added with no further deploy.
- A service input bound to a `resolve()` value differs between two environments of the test app; `provision` inside the callback fails with an error naming the structure rule; a callback returning an invalid value fails the deploy before anything is created.
- A RoutingUrl created without DNS shows its unmet conditions, becomes active once the records are published with no further API call, survives a promote and the deletion of its service, and a second record naming its hostname reports it as in use until the first is deleted.
- The Console page for a service in the test project shows its custom hostnames with their conditions, and the workspace's Domains page shows the ownership claims.
- `prisma deploy --environment <name>` and `prisma dev --environment <name>` work, `--stage` is gone, `destroy` targets an environment by name, and no public surface says "stage".
- `prisma dev` with a named hostname in the code warns once that the hostname is ignored and otherwise runs.
- The design records, glossary and domain docs describe the shipped design, and the scenarios in `docs/design/05-prisma-cloud/public-url-scenarios.md` each name the slice that made them true.

# Open questions

None blocking. The platform questions (Foundry's routing target, where ownership lives, a record per service) were settled on 2026-10-27 and are recorded in pdp-control-plane's ADR 015.

# References

- [design-notes.md](design-notes.md): execution decisions not carried by the ADRs.
- [plan.md](plan.md).
- `docs/design/90-decisions/ADR-0059-a-deployment-environment-is-called-an-environment.md` (prisma/composer#385).
- `docs/design/90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md`, `ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md`, `ADR-0062-environment-values-come-from-resolve-and-config-adapters.md`, and `docs/design/05-prisma-cloud/public-url.md`, `public-url-domain-map.md`, `public-url-scenarios.md` (prisma/composer#386).
- pdp-control-plane `docs/architecture/adrs/ADR-015-routing-urls-and-domain-ownership.md` and `projects/routing-urls/` (prisma/pdp-control-plane#5795).
- Composer core: `packages/0-framework/1-core/core/src/node.ts`, `load-module.ts`; Prisma Cloud extension: `packages/1-prisma-cloud/1-extensions/target/src/descriptors/compute.ts`, `param.ts`; CLI: `packages/0-framework/3-tooling/cli/src/validate-stage.ts`, `run-alchemy.ts`.
- PDP: `packages/interactors/src/compute/domains.ts` (`createCustomDomain`), `service.ts` (`reassignDomains`, `upsertEndpoint`).
- Upstream Alchemy `src/Prisma/CustomDomain.ts` (`ensureDefaultBranchApp`); Composer pins `alchemy@2.0.0-beta.83`.
- prisma/composer#383, the pull request whose motivation this project takes up.
