# Public URL scenarios

Working draft. For each scenario: what the user wants, the Composer code they write, the topology that produces, and what exists on PDP and Foundry for each environment. Vocabulary is the current design: environments (not stages), `publicUrl({ name, url, target })`, two URL strategies, both constructors on `publicUrl` itself (`publicUrl.hostname('host')` names the hostname; `publicUrl.generated()` asks the platform for one; the exact method names are open), and `resolve(dependencies, fn)` to compute a value from inputs and the environment's name. Nothing about public URLs depends on config adapters; they appear only in scenario 9, as an option for teams that keep hostnames outside the code.

Shared setup for every scenario:

```ts
// web/src/service.ts
export default compute({
  name: 'web',
  deps: { auth: rpc(authContract) },
  expose: { http: rawHttpContract },   // the HTTP connection a publicUrl can be wired to
  build: nextjs({ module: import.meta.url, appDir: '..' }),
});
```

On PDP, every compute service already has an Endpoint and a `*.prisma.build` hostname, whether or not anything is declared. The scenarios below say what a `publicUrl` adds to that.

## 1. One public service, generated URL

**User:** "Only `web` is meant to be reachable from outside. I don't care what the hostname is." (Søren's Web project: only the Gateway should be public.)

```ts
export default module('shop', ({ provision }) => {
  const auth = provision(authModule, { input: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });
  const web = provision(webService, { deps: { auth: auth.rpc } });
  provision(publicUrl({ name: 'site', url: publicUrl.generated(), target: web.http }));
});
```

**Topology:** `shop.auth.service`, `shop.web`, `shop.site`; edge `shop.site → shop.web.http`.

**Every environment:** Branch holds Compute Services `shop.auth.service` and `shop.web`, and a generated Public URL `shop.site` pointing at `shop.web`, which uses `shop.web`'s existing `*.prisma.build` hostname (Foundry: the service's Endpoint). No Domain needed.

**What's different from today:** nothing is reachable differently yet, because every service keeps its Endpoint until the platform can address services privately. What changes is the model: the topology now says `web` is the one public service. Console must still show that the other services are reachable, so the topology never presents an unenforced boundary as private.

## 2. Production on a named hostname, previews generated

**User:** "Production is `shop.com`. Every other environment gets whatever hostname the platform gives it."

```ts
provision(publicUrl({
  name: 'site',
  url: resolve([], (environment) => environment === 'production' ? publicUrl.hostname('shop.com') : publicUrl.generated()),
  target: web.http,
}));
```

**Topology:** identical in every environment (one `shop.site` node). Only the resolved value of `url` differs.

**Production Branch:** named Public URL `shop.site` = `shop.com` → `shop.web`. Receives traffic once the workspace has proven the Domain `shop.com` and DNS points at Foundry (Foundry: a Custom domain). Until then the deploy succeeds and `web` still answers on its `*.prisma.build` hostname. The deploy output says which step is outstanding (ownership proof, DNS, or the certificate) and prints the Console link to finish it. The user can also prove `shop.com` in Console before this deploy ever runs; neither order is required. Finishing DNS never needs another deploy.

**Any other Branch:** generated Public URL `shop.site` on the service's `*.prisma.build` hostname.

## 3. Production, staging and previews, each different

**User:** "`shop.com` for production, `staging.shop.com` for staging, generated for previews."

```ts
url: resolve([], (environment) =>
  environment === 'production' ? publicUrl.hostname('shop.com')
  : environment === 'staging' ? publicUrl.hostname('staging.shop.com')
  : publicUrl.generated()),
```

**PDP:** as scenario 2, with a second named Public URL on the `staging` Branch. One proven Domain, `shop.com`, covers both hostnames if proving a domain covers the names under it (open); otherwise `staging.shop.com` needs its own proof. A team that controls only `staging.shop.com` can prove that subdomain without owning `shop.com`.

## 4. Every preview on its own subdomain

**User (Søren):** "`shop.com` for production, `staging.shop.com` for staging, and every preview at `<environment>.preview.shop.com`."

```ts
url: resolve([], (environment) =>
  environment === 'production' ? publicUrl.hostname('shop.com')
  : environment === 'staging' ? publicUrl.hostname('staging.shop.com')
  : publicUrl.hostname(`${environment}.preview.shop.com`)),
```

**How it runs:** Composer builds the graph with the `resolve()` function unexecuted, disables `provision`, then calls it once for the environment being deployed and validates the result. The graph is the same shape everywhere.

**PDP, `pr-42` Branch:** named Public URL `shop.site` = `pr-42.preview.shop.com` → `shop.web`. For this to work without a person doing DNS per preview, the workspace must have proven `preview.shop.com` once, with proof covering the names under it, and one wildcard DNS record must send `*.preview.shop.com` to Foundry. Certificates need no extra work: Foundry issues one certificate per hostname (ACME HTTP-01), so each new preview hostname gets its own once the wildcard record resolves to Foundry. A preview's hostname must stay one label under the namespace, and a hostname under the wildcard that no Public URL holds must not reach anything.

A preview whose code names `shop.com` is refused, because production holds it, and production is unaffected.

**Open:** an environment name isn't always a valid DNS label (Composer allows `_`; labels are capped at 63 characters). Composer should hand `resolve()` functions a DNS-safe form of the name rather than leave every author to write one.

## 5. Two hostnames, one service

**User:** "`www.shop.com` and `shop.com` both serve `web`."

```ts
provision(publicUrl({ name: 'site', url: resolve([], (environment) => environment === 'production' ? publicUrl.hostname('shop.com') : publicUrl.generated()), target: web.http }));
provision(publicUrl({ name: 'www', url: resolve([], (environment) => environment === 'production' ? publicUrl.hostname('www.shop.com') : publicUrl.generated()), target: web.http }));
```

**Topology:** two nodes, `shop.site` and `shop.www`, both wired to `shop.web.http`.

**Production Branch:** two named Public URLs. Each has its own setup state and certificate. **Any other Branch:** two generated Public URLs on the same service. Both use the service's one `*.prisma.build` hostname today, so they're indistinguishable until the platform gives generated Public URLs hostnames of their own.

## 6. Two services, two hostnames

**User:** "`shop.com` serves `web`, `api.shop.com` serves `api`. Nothing else is public."

```ts
const api = provision(apiService, { deps: { db } });
const web = provision(webService, { deps: { api: api.rpc } });
provision(publicUrl({ name: 'site', url: resolve([], (environment) => environment === 'production' ? publicUrl.hostname('shop.com') : publicUrl.generated()), target: web.http }));
provision(publicUrl({ name: 'apiUrl', url: resolve([], (environment) => environment === 'production' ? publicUrl.hostname('api.shop.com') : publicUrl.generated()), target: api.http }));
```

`web` calls `api` over `api.rpc`, a service-to-service connection, not over `api.shop.com`. The public URL on `api` is for outside callers.

**Production Branch:** two named Public URLs, each pointing at its own Compute Service.

## 7. A public URL on a reusable module's service

**User:** "The auth module from npm should answer at `auth.shop.com`."

```ts
const identity = provision(auth(), { deps: { db, email: mail.send }, input: { baseUrl: ... } });
provision(publicUrl({ name: 'authUrl', url: resolve([], (environment) => environment === 'production' ? publicUrl.hostname('auth.shop.com') : publicUrl.generated()), target: identity.api }));
```

The `auth()` module exposes `api` as a raw HTTP connection. At Load, `identity.api` resolves to the service inside the module (`shop.auth.service`), so the Public URL points at that service's Compute Service. The module decided its `api` could be made public by exposing it; the app decided it is. `identity.admin` is a service RPC connection, so wiring a `publicUrl` to it is a type error.

## 8. A service that needs its own public URL

**User:** "`auth` builds links and redirects, so it needs to know it's served at `auth.shop.com`."

```ts
const authUrl = resolve([], (environment) => environment === 'production' ? publicUrl.hostname('auth.shop.com') : publicUrl.generated());
const baseUrl = resolve([authUrl], (url) => `https://${url.hostname}`);
const identity = provision(auth(), { deps: { db, email: mail.send }, input: { baseUrl } });
provision(publicUrl({ name: 'authUrl', url: authUrl, target: identity.api }));
```

The Public URL's value feeds the service's input through a second `resolve()`, so the service gets a string URL derived from whatever hostname the Public URL ends up with. The framework keeps no list of a service's URLs and `origin()` keeps meaning the platform-assigned hostname. This works for a generated URL too, because the Public URL record is created before the service's deployment, so its hostname is known by the time the service's input is written.

## 9. The hostname comes from outside the code (optional path)

**User:** "Our hostnames live in a file the ops team owns, not in `module.ts`." This is the only scenario that uses config adapters; every other scenario expresses the URL policy in code.

```ts
// prisma.config.ts
composer({ extensions: [...], state: prismaState(), config: [dotenv()] })
// .env.production: SITE_HOSTNAME=shop.com
// module.ts
export default module('shop', { input: type({ 'SITE_HOSTNAME?': 'string' }) }, ({ input, provision }) => {
  const web = provision(webService, { deps: { auth: auth.rpc } });
  const url = resolve([input.SITE_HOSTNAME], (hostname) =>
    hostname === undefined ? publicUrl.generated() : publicUrl.hostname(hostname));
  provision(publicUrl({ name: 'site', url, target: web.http }));
});
```

`dotenv()` receives the environment's name, reads `.env` and `.env.production`, and the result fills the root's input. The `resolve()` turns the string into a strategy. The key is optional in the schema, so an environment with no `SITE_HOSTNAME` reaches the function as `undefined` and gets a generated URL; making the key required would fail that deploy instead.

## 10. Changing a hostname

**User:** "Production moves from `shop.com` to `theshop.com`."

The code changes `publicUrl.hostname('shop.com')` to `publicUrl.hostname('theshop.com')`. `shop.site` keeps its node address, so PDP updates the same Public URL record: its hostname is now `theshop.com`, and `shop.com` stops being served by it. `theshop.com` receives traffic once it is proven and its DNS is set up; until then the record is pending, exactly as for a new hostname. No node is deleted and no consent is involved.

## 11. Removing a public URL

**User:** "`web` should no longer be reachable from outside."

The `publicUrl` line is deleted. The deploy plan deletes `shop.site`, which removes the Public URL record and its Foundry Custom domain. This is an ordinary topology removal, covered by the general "ask before losing something" work, not by anything specific to URLs. The proven Domain is untouched.

## 12. Local development

**User:** runs `prisma dev module.ts`.

The environment is `dev`. Every `resolve()` function receives `'dev'`. The local target gives `shop.site` a stand-in that creates nothing: there is no Branch and no Foundry. `prisma dev url site` can print the local URL of the service it's wired to. If the resolved value names a hostname, local dev ignores it; whether it should warn is open. Nothing in local dev keys on the name `dev` itself: a function receives whatever environment name the user passed, and the local target ignores hostnames regardless.

## 13. A service with no public URL

**User:** "`worker` consumes a queue. Nothing outside should reach it."

No `publicUrl` is declared for it. Today it still has an Endpoint and a `*.prisma.build` hostname, because service-to-service connections use it and the platform can't yet address services privately. The topology says it isn't public; the platform doesn't enforce that yet. When private addressing arrives, a service with no Public URL stops being reachable from outside, and nothing in the user's code changes.

## What the scenarios need from each side

| Need | Where |
| --- | --- |
| `publicUrl` node with its two strategy constructors; `resolve(deps, fn)` producing a `ResolvedValue`, run after the graph is built with `provision` disabled; a DNS-safe form of the environment name | Composer core |
| Module and root `input` as one schema; config adapters (separate work; only scenario 9 uses them) | Composer core |
| Public URL record on a Branch, found by `logicalId`, created before DNS and before the service's deployment, pointing at a service, surviving promotes; a hostname change replaces the old hostname | PDP |
| Deploy output and Console distinguish: deployed, generated URL ready, awaiting ownership proof, awaiting DNS, certificate pending; Console shows each service's actual exposure | PDP and Composer |
| Workspace-proven Domain; whether proof covers names under it; proving a delegated subdomain; both Console-first and code-first setup | PDP |
| Refusing a second Public URL that names a hostname another Public URL holds | PDP |
| Public URL resource replacing `Prisma.CustomDomain` | upstream Alchemy provider |
| Private addressing between services, so "no public URL" becomes enforced | platform, later |
