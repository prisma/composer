# Public URL scenarios

Working draft. For each scenario: what the user wants, the Composer code they write, the topology that produces, and what exists on PDP and Foundry for each environment. Vocabulary is the current design: environments (not stages), `publicUrl({ name, url, target })`, two URL strategies, both methods on `publicUrl` itself (`publicUrl.hostname('host')` names the hostname, and a bare string is shorthand for it; `publicUrl.prismaBuild()` asks the platform for one), and `resolve(dependencies, fn)` to compute a value from inputs, deploy-time references such as `environment.name`, and other resolved values, which `fn` receives as one tuple. Nothing about public URLs depends on config adapters; they appear only in scenario 9, as an option for teams that keep hostnames outside the code.

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

## 1. One public service, prisma.build URL

**User:** "Only `web` is meant to be reachable from outside. I don't care what the hostname is." (Søren's Web project: only the Gateway should be public.)

```ts
export default module('shop', ({ environment, provision }) => {
  const auth = provision(authModule, { input: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });
  const web = provision(webService, { deps: { auth: auth.rpc } });
  provision(publicUrl({ name: 'site', url: publicUrl.prismaBuild(), target: web.http }));
});
```

**Topology:** `shop.auth.service`, `shop.web`, `shop.site`; edge `shop.site → shop.web.http`.

**Every environment:** Branch holds Compute Services `shop.auth.service` and `shop.web`, each with its `*.prisma.build` hostname (Foundry: an Endpoint per service). `shop.site` creates no platform record; the deploy output reports `web`'s platform hostname for it. No ownership claim needed.

**What's different from today:** nothing is reachable differently. What changes is the model: the topology now says `web` is the one public service. The deploy output says the other services are still reachable at their platform hostnames, until the platform's later step makes those opt-in.

## 2. Production on a named hostname, previews on prisma.build

**User:** "Production is `shop.com`. Every other environment gets whatever hostname the platform gives it."

```ts
provision(publicUrl({
  name: 'site',
  url: resolve([environment.name], ([name]) => name === 'production' ? publicUrl.hostname('shop.com') : publicUrl.prismaBuild()),
  target: web.http,
}));
```

**Topology:** identical in every environment (one `shop.site` node). Only the resolved value of `url` differs.

**Production Branch:** named public RoutingUrl `shop.site` = `shop.com` → `shop.web`. Receives traffic once the workspace has a verified domain ownership claim for `shop.com` and DNS points at the service's region (Foundry: a Custom domain, registered by the control plane once every condition holds). Until then the deploy succeeds and `web` still answers on its `*.prisma.build` hostname. The deploy output says which step is outstanding (ownership claim, DNS, or the certificate) and prints the Console link to finish it. The user can also claim and verify `shop.com` in Console before this deploy ever runs; neither order is required. Finishing DNS never needs another deploy.

**Any other Branch:** no record; `web` answers at its `*.prisma.build` hostname, which the deploy output reports for `shop.site`.

## 3. Production, staging and previews, each different

**User:** "`shop.com` for production, `staging.shop.com` for staging, prisma.build for previews."

```ts
url: resolve([environment.name], ([name]) =>
  name === 'production' ? publicUrl.hostname('shop.com')
  : name === 'staging' ? publicUrl.hostname('staging.shop.com')
  : publicUrl.prismaBuild()),
```

**PDP:** as scenario 2, with a second named RoutingUrl on the `staging` Branch. Ownership is per exact name, so `shop.com` and `staging.shop.com` are two domain ownership claims, each with its own TXT record carrying the same workspace value. A team that controls only `staging.shop.com` can prove that name without owning `shop.com`.

## 4. Every preview on its own subdomain

**User (Søren):** "`shop.com` for production, `staging.shop.com` for staging, and every preview at `<environment>.preview.shop.com`."

```ts
url: resolve([environment.name], ([name]) =>
  name === 'production' ? publicUrl.hostname('shop.com')
  : name === 'staging' ? publicUrl.hostname('staging.shop.com')
  : publicUrl.hostname(`${name}.preview.shop.com`)),
```

**How it runs:** Composer builds the graph with the `resolve()` function unexecuted, disables `provision`, then calls it once with the environment's name and validates the result. The graph is the same shape everywhere.

**PDP, `pr-42` Branch:** named RoutingUrl `shop.site` = `pr-42.preview.shop.com` → `shop.web`. For this to work without a person doing DNS per preview, the workspace must hold a verified domain ownership claim for the wildcard `*.preview.shop.com` (TXT at `_prisma-verification.preview.shop.com`), which covers exactly one label below it, and one wildcard DNS record must send `*.preview.shop.com` to Foundry. Certificates need no extra work: Foundry issues one certificate per hostname (ACME HTTP-01), so each new preview hostname gets its own once the wildcard record resolves to Foundry. A preview's hostname must stay one label under the namespace, and a hostname under the wildcard that no RoutingUrl holds reaches nothing.

A preview whose code names `shop.com` deploys, and its record reports the hostname as in use because production's record serves it; production is unaffected.

An environment name isn't always a valid DNS label (Composer allows `_`; labels are capped at 63 characters), so a real version of this function passes the name through a label helper first, the author's own or one Composer ships. `resolve()` itself knows nothing about URLs.

## 5. Two hostnames, one service

**User:** "`www.shop.com` and `shop.com` both serve `web`."

```ts
provision(publicUrl({ name: 'site', url: resolve([environment.name], ([name]) => name === 'production' ? publicUrl.hostname('shop.com') : publicUrl.prismaBuild()), target: web.http }));
provision(publicUrl({ name: 'www', url: resolve([environment.name], ([name]) => name === 'production' ? publicUrl.hostname('www.shop.com') : publicUrl.prismaBuild()), target: web.http }));
```

**Topology:** two nodes, `shop.site` and `shop.www`, both wired to `shop.web.http`.

**Production Branch:** two named Public URLs. Each has its own setup state and certificate. **Any other Branch:** no records; both nodes report the service's one `*.prisma.build` hostname.

## 6. Two services, two hostnames

**User:** "`shop.com` serves `web`, `api.shop.com` serves `api`. Nothing else is public."

```ts
const api = provision(apiService, { deps: { db } });
const web = provision(webService, { deps: { api: api.rpc } });
provision(publicUrl({ name: 'site', url: resolve([environment.name], ([name]) => name === 'production' ? publicUrl.hostname('shop.com') : publicUrl.prismaBuild()), target: web.http }));
provision(publicUrl({ name: 'apiUrl', url: resolve([environment.name], ([name]) => name === 'production' ? publicUrl.hostname('api.shop.com') : publicUrl.prismaBuild()), target: api.http }));
```

`web` calls `api` over `api.rpc`, a service-to-service connection, not over `api.shop.com`. The public URL on `api` is for outside callers.

**Production Branch:** two named Public URLs, each pointing at its own Compute Service.

## 7. A public URL on a reusable module's service

**User:** "The auth module from npm should answer at `auth.shop.com`."

```ts
const identity = provision(auth(), { deps: { db, email: mail.send }, input: { baseUrl: ... } });
provision(publicUrl({ name: 'authUrl', url: resolve([environment.name], ([name]) => name === 'production' ? publicUrl.hostname('auth.shop.com') : publicUrl.prismaBuild()), target: identity.api }));
```

The `auth()` module exposes `api` as a raw HTTP connection. At Load, `identity.api` resolves to the service inside the module (`shop.auth.service`), so the RoutingUrl points at that service. The module decided its `api` could be made public by exposing it; the app decided it is. `identity.admin` is a service RPC connection, so wiring a `publicUrl` to it is a type error.

## 8. A service that needs its own public URL

**User:** "`auth` builds links and redirects, so it needs to know it's served at `auth.shop.com`."

```ts
const authUrl = resolve([environment.name], ([name]) => name === 'production' ? publicUrl.hostname('auth.shop.com') : publicUrl.prismaBuild());
const baseUrl = resolve([authUrl], ([url]) => `https://${url.hostname}`);
const identity = provision(auth(), { deps: { db, email: mail.send }, input: { baseUrl } });
provision(publicUrl({ name: 'authUrl', url: authUrl, target: identity.api }));
```

The hostname feeds the service's input through a second `resolve()`, so the service gets a string URL derived from the hostname the code named. This works only for a named hostname: a prisma.build URL is the platform's hostname, which is a deploy result that `resolve()` cannot see, so in environments where `authUrl` resolves to `publicUrl.prismaBuild()` the second `resolve()` has no hostname to give and the service learns its own origin through `origin()` instead. The framework keeps no list of a service's URLs.

## 9. The hostname comes from outside the code (optional path)

**User:** "Our hostnames live in a file the ops team owns, not in `module.ts`." This is the only scenario that uses config adapters; every other scenario expresses the URL policy in code.

```ts
// prisma.config.ts
composer({ extensions: [...], state: prismaState(), config: [dotenv()] })
// .env.production: SITE_HOSTNAME=shop.com
// module.ts
export default module('shop', { input: type({ 'SITE_HOSTNAME?': 'string' }) }, ({ input, environment, provision }) => {
  const web = provision(webService, { deps: { auth: auth.rpc } });
  provision(publicUrl({ name: 'site', url: input.SITE_HOSTNAME, target: web.http }));
});
```

`dotenv()` receives the environment's name, reads `.env` and `.env.production`, and the result fills the root's input. A string is shorthand for `publicUrl.hostname(...)`, and an input reference may be passed anywhere a value is accepted, so the input goes straight into `url`. An environment with no `SITE_HOSTNAME` has no value for `url` and fails the deploy; to fall back to a prisma.build URL instead, wrap it in a `resolve()` that returns `publicUrl.prismaBuild()` when the value is absent.

## 10. Changing a hostname

**User:** "Production moves from `shop.com` to `theshop.com`."

The code changes `publicUrl.hostname('shop.com')` to `publicUrl.hostname('theshop.com')`. `shop.site` keeps its node address, so PDP updates the same RoutingUrl record: its hostname is now `theshop.com`, and `shop.com` stops being served by it. `theshop.com` receives traffic once its conditions hold; until then the record shows the first unmet one, exactly as for a new hostname. No node is deleted and no consent is involved.

## 11. Removing a public URL

**User:** "`web` should no longer be reachable from outside."

The `publicUrl` line is deleted. The deploy plan deletes `shop.site`, which removes the RoutingUrl record and its Foundry Custom domain; the service's platform hostname stays. This is an ordinary topology removal, covered by the general "ask before losing something" work, not by anything specific to URLs. The domain ownership claim is untouched.

## 12. Local development

**User:** runs `prisma dev module.ts`.

The environment is `dev`. `environment.name` resolves to `'dev'`. The local target gives `shop.site` a stand-in that creates nothing: there is no Branch and no Foundry. `prisma dev url site` can print the local URL of the service it's wired to. If the resolved value names a hostname, local dev ignores it and prints one warning per public URL saying so. Nothing in local dev keys on the name `dev` itself: `environment.name` is whatever the user passed, and the local target ignores hostnames regardless.

## 13. A service with no public URL

**User:** "`worker` consumes a queue. Nothing outside should reach it."

No `publicUrl` is declared for it, so the topology shows it as not public and Composer creates no RoutingUrl for it. The platform still gives it a `*.prisma.build` hostname, as it gives every service, so `worker` is reachable today; the deploy output says so. Making that hostname opt-in is the platform's later step, and nothing in the user's code changes when it lands.

## What the scenarios need from each side

| Need | Where |
| --- | --- |
| `publicUrl` node with its two strategy constructors; `resolve(deps, fn)` producing a `ResolvedValue`, run after the graph is built with `provision` disabled; the `environment` references handed to the module body | Composer core |
| Module and root `input` as one schema; config adapters (separate work; only scenario 9 uses them) | Composer core |
| RoutingUrl record on a Branch for a custom hostname, found by `logicalId`, created before DNS and before the service's deployment, pointing at a service, kept bound to the live version by a reconciler; a hostname change replaces the old hostname | PDP |
| Deploy output and Console distinguish: deployed, prisma.build URL ready, awaiting ownership claim, awaiting DNS, certificate pending | PDP and Composer |
| Workspace domain ownership claim for an exact hostname or wildcard, verified with today's TXT value and re-verified on conflict; both Console-first and code-first setup | PDP |
| Registering one RoutingUrl per hostname platform-wide, with the others reporting the hostname as in use | PDP |
| RoutingUrl resource replacing `Prisma.CustomDomain` | upstream Alchemy provider |
| The platform's hostname as an opt-in RoutingUrl, so "no public URL" becomes enforced | platform, later |
