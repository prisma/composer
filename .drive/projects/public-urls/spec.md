# Purpose

Let an author say, in code, which services receive traffic from the internet and at which URL, with the URL differing per environment, and never have a deploy fail because a hostname's DNS isn't ready yet. Today every compute service is public on a generated address, a custom domain can only be added by hand after the deploy, and nothing in the code records which services are meant to be public.

# At a glance

```ts
// module.ts
export default module('shop', ({ provision }) => {
  const auth = provision(authModule, { input: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });
  const web = provision(webService, { deps: { auth: auth.rpc } });

  const url = resolve([], (environment) =>
    environment === 'production' ? 'shop.com'
    : environment === 'staging' ? 'staging.shop.com'
    : publicUrl.generated());

  provision(publicUrl({ name: 'site', url, target: web.http }));
});
```

```sh
prisma deploy                          # production: shop.com
prisma deploy --environment pr-42      # a preview: a hostname the platform generates
prisma dev                             # the environment dev, on this machine
```

Under the hood, `publicUrl` is a node that depends on the HTTP connection a service exposes. `resolve()` is a general mechanism for computing any value after the graph is built, with `provision` disabled, so the graph's structure is the same in every environment. On Prisma Cloud a public URL becomes a record on the environment's Branch that exists before DNS does; a named hostname is allowed by a Domain the workspace has proven.

# Decisions

Recorded in prisma/composer#386 (ADR-0060 public URL, ADR-0061 module input, ADR-0062 `resolve()` and config adapters, `docs/design/05-prisma-cloud/public-url.md` with its domain map and scenarios), prisma/composer#385 (ADR-0059, the term is environment) and prisma/pdp-control-plane#5795 (ADR 015, Public URL and Domain records).

# In scope

- `resolve()` in core, with the second evaluation pass.
- `publicUrl()` in the Prisma Cloud extension, both strategies.
- The rename from stage to environment on every public surface.
- Upstream Alchemy: lift `Prisma.CustomDomain`'s default-Branch rule now; a Public URL resource later.
- PDP: the Public URL and Domain records, their routes, promote re-pointing, backfill, Console status.
- Module `input` (after a spike), `resolve()` dependencies on inputs, and config adapters with `dotenv()`.

# Out of scope

Routing by path, private addressing between services, secrets adapters, the reference-based `serviceOrigin`, and any Foundry change. Each is recorded as later work in the ADRs.
