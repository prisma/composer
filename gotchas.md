# Gotchas

A running log of surprises, workarounds, and undocumented behaviour hit while
_consuming_ **Prisma Next**, **Prisma Compute**, or **Prisma Postgres** in this
project. Each entry captures friction a real user of these products would also hit.

Each entry is also filed as a Triage-state Linear ticket in the matching gotchas
project so the team can pick it up:

- Prisma Next → [`pn-gotchas`](https://linear.app/prisma-company/project/pn-gotchas-a6f6f5157a5c/overview)
- Prisma Compute → [`compute-gotchas`](https://linear.app/prisma-company/project/compute-gotchas-dd3ac34b5ad4/overview)
- Prisma Postgres → [`ppg-gotchas`](https://linear.app/prisma-company/project/ppg-gotchas-afe77336f696/overview)

The capture workflow is the Ignite `product-record-gotcha` skill.

---

## Contents

- [compute-services create returns a placeholder-region serviceEndpointDomain that 404s until a version is promoted](#compute-services-create-returns-a-placeholder-region-serviceendpointdomain-that-404s-until-a-version-is-promoted)
- [app build --build-type nextjs yields a boot-crashing standalone for pnpm projects](#app-build---build-type-nextjs-yields-a-boot-crashing-standalone-for-pnpm-projects)
- [Idle direct-connection close crashes a persistent Bun.SQL client into a 502 loop on scale-to-zero Compute](#idle-direct-connection-close-crashes-a-persistent-bunsql-client-into-a-502-loop-on-scale-to-zero-compute)
- [Creating a database with isDefault:true fails — a project already auto-provisions a default database](#creating-a-database-with-isdefaulttrue-fails--a-project-already-auto-provisions-a-default-database)
- [Next.js on Compute ignores runtime env vars unless the route is force-dynamic](#nextjs-on-compute-ignores-runtime-env-vars-unless-the-route-is-force-dynamic)
- [Connection create/read response buries the real Postgres DSN under endpoints.*; `url` is an API self-link](#connection-createread-response-buries-the-real-postgres-dsn-under-endpoints-url-is-an-api-self-link)
- [Compute's bun auto-installs at runtime — masks incomplete artifacts and cross-platform native binaries as an ENOSPC crash loop](#computes-bun-auto-installs-at-runtime--masks-incomplete-artifacts-and-cross-platform-native-binaries-as-an-enospc-crash-loop)
- [Branch create has no idempotency — a duplicate gitName 409s, with no create-or-return](#branch-create-has-no-idempotency--a-duplicate-gitname-409s-with-no-create-or-return)
- [A project-scoped compute-service create lands on the default branch — and collides with production](#a-project-scoped-compute-service-create-lands-on-the-default-branch--and-collides-with-production)
- [First connection to a freshly-provisioned Postgres is rejected while the upstream is cold — breaks deploy-time migrations](#first-connection-to-a-freshly-provisioned-postgres-is-rejected-while-the-upstream-is-cold--breaks-deploy-time-migrations)
- [Idle direct-connection close kills pooled node-postgres clients — first query after idle 500s with "Connection terminated unexpectedly"](#idle-direct-connection-close-kills-pooled-node-postgres-clients--first-query-after-idle-500s-with-connection-terminated-unexpectedly)
- [Service-to-service HTTP gets ECONNRESET while the target cold-starts from scale-to-zero](#service-to-service-http-gets-econnreset-while-the-target-cold-starts-from-scale-to-zero)
- [Compute ingress buffers streaming responses until completion — an open SSE tail delivers nothing and 504s at 60s](#compute-ingress-buffers-streaming-responses-until-completion--an-open-sse-tail-delivers-nothing-and-504s-at-60s)
- [planLimitReached is masked by the cold-start "not configured correctly yet" message](#planlimitreached-is-masked-by-the-cold-start-not-configured-correctly-yet-message)
- [Composer's secret model has no optional/conditional secrets — every "off" stage still needs a junk credential](#composers-secret-model-has-no-optionalconditional-secrets--every-off-stage-still-needs-a-junk-credential)
- [Module-boundary param slots admit only sources, never a literal — a static-per-app value forces a platform env var or a factory option](#module-boundary-param-slots-admit-only-sources-never-a-literal--a-static-per-app-value-forces-a-platform-env-var-or-a-factory-option)

---

## compute-services create returns a placeholder-region serviceEndpointDomain that 404s until a version is promoted

**Filed upstream:** [PRO-200](https://linear.app/prisma-company/issue/PRO-200/compute-services-create-returns-a-placeholder-region) — _"compute-services create returns a placeholder-region serviceEndpointDomain that 404s until a version is promoted"_
**Product:** Prisma Compute
**Version:** `@prisma/management-api-sdk` 1.47.0 · Management API `https://api.prisma.io/v1`
**First hit:** `examples/smoke` — proving the v2 Alchemy Compute provider end-to-end against real Prisma Cloud
**Cost:** ~1 hour — three all-green deploys that each 404'd on a dead URL before we queried the version directly

**Symptom.** `POST /v1/projects/{projectId}/compute-services` (with `regionId: us-east-1`) returns a `serviceEndpointDomain` on the `.cdg.` region subdomain. Curling it returns a permanent, plain-text `404 Not Found` from the edge — while the deploy sequence is all green and `GET /v1/compute-services/versions/{id}` reports `status: "running"`, correct `portMapping.http`, and injected env vars. Nothing signals the URL is wrong.

**Cause.** The create-time `serviceEndpointDomain` is a placeholder region that does not serve. The real serving domain resolves only after a version is promoted and running, on a _different_ region subdomain matching the service's region:

- create response: `https://cmr26hp1d2c7q0vf8ji978s7k.cdg.prisma.build` → 404
- `GET /v1/compute-services/{id}` after promote: `https://cmr26hp1d2c7q0vf8ji978s7k.ewr.prisma.build` → 200

Same service id (created explicitly in `us-east-1`), different region subdomain (`.cdg.` vs `.ewr.`).

**Workaround.** Ignore the create response's `serviceEndpointDomain`. After promote, re-`GET /v1/compute-services/{id}` and use _that_ `serviceEndpointDomain`. Our Alchemy provider's `Deployment` re-reads the service post-promote and returns it as `deployedUrl`.

**Fixed upstream** ([pdp-control-plane#4650](https://github.com/prisma/pdp-control-plane/pull/4650), merged 2026-07-22): the pre-promote `serviceEndpointDomain` is now composed from the service's actual region and documented as a contract — it names the domain the service will serve on once promoted. The post-promote re-read stays correct (a stored Foundry-assigned domain is returned verbatim), but is no longer the only trustworthy source; ADR-0039's `origin()` relies on the create-time value.

**Reproduction.**

1. Create a compute service with `regionId: us-east-1`; note `serviceEndpointDomain` (`.cdg.`).
2. Create a version → PUT the tar.gz to `uploadUrl` → start → poll until `running` → promote.
3. `curl` the create-time domain → `404 Not Found`, permanently.
4. `GET /v1/compute-services/{id}` → a different `serviceEndpointDomain` (`.ewr.`); `curl` that → `200`.

**References.**

- Upstream: [PRO-200](https://linear.app/prisma-company/issue/PRO-200/compute-services-create-returns-a-placeholder-region)
- Workaround source: [`packages/prisma-alchemy/src/compute/Deployment.ts`](packages/prisma-alchemy/src/compute/Deployment.ts)
- Related: [`.drive/projects/mvp-example-app/design-notes.md`](.drive/projects/mvp-example-app/design-notes.md) — "Validated end-to-end (Compute)"

---

## app build --build-type nextjs yields a boot-crashing standalone for pnpm projects

**Filed upstream:** [PRO-201](https://linear.app/prisma-company/issue/PRO-201/app-build-build-type-nextjs-yields-a-boot-crashing-standalone-for-pnpm) — _"app build --build-type nextjs yields a boot-crashing standalone for pnpm projects"_
**Product:** Prisma Compute
**Version:** `@prisma/cli` app build (via `bunx @prisma/cli@latest`); Next.js 15.5.19; pnpm 10.27.0; bun 1.3.13
**First hit:** `examples/storefront-auth/modules/storefront` — deploying the Next.js Storefront Module to Compute
**Cost:** ~1 hour of iteration before landing the hoisted + direct-`next build` approach

**Symptom.** The deployed Next.js standalone crashes at boot with `Cannot find module 'styled-jsx/package.json'` (from `next/dist/server/require-hook.js`). The compute version reports `status: running`, but the endpoint serves a 404 "There is no service on this URL". Fails identically under `bun` and `node`.

**Cause.** Next `output: "standalone"` copies `next` as a flat dir into the app's node_modules and resolves peers (styled-jsx) relative to it. pnpm's default isolated layout keeps those peers under `.pnpm/`, unreachable from the flattened copy. `@prisma/cli app build --build-type nextjs` produces exactly this crashing artifact. Switching to a flat layout (`.npmrc` `node-linker=hoisted`) fixes the standalone — but then `app build` can't run, because under hoisted there is no per-package node_modules for its spawned `next build` to resolve `next` from. No single config makes `app build` work for a pnpm Next app.

**Workaround.** `.npmrc` `node-linker=hoisted`, run `next build` directly (not `app build`), and package the standalone yourself: copy `.next/static` + `public` into the standalone tree, write the compute manifest pointing at the standalone `server.js`, tar it.

**Reproduction.**

1. pnpm workspace with a Next.js app, `output: "standalone"`.
2. `bunx @prisma/cli@latest app build --build-type nextjs` (default isolated pnpm).
3. Run the artifact (`bun server.js`) → crashes: `Cannot find module 'styled-jsx/package.json'`.
4. Add `.npmrc` `node-linker=hoisted`, clean reinstall, retry `app build` → fails: can't resolve the `next` bin.

**References.**

- Upstream: [PRO-201](https://linear.app/prisma-company/issue/PRO-201/app-build-build-type-nextjs-yields-a-boot-crashing-standalone-for-pnpm)
- Workaround source: [`packages/app-nextjs/src/assemble.ts`](packages/app-nextjs/src/assemble.ts), [`.npmrc`](.npmrc)
- Related: [`.drive/projects/mvp-example-app/design-notes.md`](.drive/projects/mvp-example-app/design-notes.md) — "Compute skill findings"

---

## Idle direct-connection close crashes a persistent Bun.SQL client into a 502 loop on scale-to-zero Compute

**Filed upstream:** [FT-5219](https://linear.app/prisma-company/issue/FT-5219/idle-direct-connection-close-crashes-a-persistent-bunsql-client-into-a) — _"Idle direct-connection close crashes a persistent Bun.SQL client into a 502 loop on scale-to-zero Compute"_
**Product:** Prisma Postgres (surfaced on Prisma Compute)
**Version:** Bun 1.3.13 (`Bun.SQL`); Prisma Postgres direct connection; Prisma Compute (scale-to-zero)
**First hit:** `examples/storefront-auth/modules/auth` — the Auth Module after it sat idle
**Cost:** ~1 hour; first presented as "the Storefront renders 500"

**Symptom.** A Bun/Hono + `Bun.SQL` service worked right after deploy, then after idle returned 500 on its DB routes and then 502 in a restart loop. Logs: `PostgresError: Connection closed` (`ERR_POSTGRES_CONNECTION_CLOSED`) from `handleClose`, with `auth listening on 0.0.0.0:3000` reprinted on each restart.

**Cause.** Prisma Postgres closes the idle direct connection (and Compute scales the service to zero). Bun.SQL surfaces the close as an async error with no awaiter → uncaught → the Bun process crashes → Compute restarts it → reconnect → idle → crash → 502 loop. The version still reports `status: running`.

**Workaround.** Process guards + a short client `idleTimeout` + reconnect-on-demand, and catch the query error:

```ts
const sql = new SQL({ url, max: 1, idleTimeout: 10 });
process.on("uncaughtException", (e) => console.error(e));
process.on("unhandledRejection", (e) => console.error(e));
// handler: try { await sql`SELECT 1` } catch { return 503 }
```

**Reproduction.**

1. Bun app with a module-scope `new SQL({ url: process.env.DATABASE_URL })` and a route that runs `SELECT 1`.
2. Deploy to Compute; `DATABASE_URL` = the project's default PPg direct connection.
3. Hit the route → 200. Let it idle, hit again → 500, then a 502 restart loop.

**References.**

- Upstream: [FT-5219](https://linear.app/prisma-company/issue/FT-5219/idle-direct-connection-close-crashes-a-persistent-bunsql-client-into-a)
- Workaround source: [`examples/storefront-auth/modules/auth/src/index.ts`](examples/storefront-auth/modules/auth/src/index.ts)
- Related: PRO-200, PRO-201 (Compute Gotchas); [`dogfood-report.md`](dogfood-report.md)

---

## Creating a database with isDefault:true fails — a project already auto-provisions a default database

**Filed upstream:** [FT-5220](https://linear.app/prisma-company/issue/FT-5220/creating-a-database-with-isdefaulttrue-fails-a-project-already-auto) — _"Creating a database with isDefault:true fails — a project already auto-provisions a default database"_
**Product:** Prisma Postgres
**Version:** `@prisma/management-api-sdk@1.47.0`
**First hit:** `examples/smoke` — provisioning a Postgres via the Alchemy provider
**Cost:** a failed deploy + a confused look at the error

**Symptom.** `POST /v1/projects/{id}/databases` with `isDefault: true` under a fresh project → `PrismaApiError: Default database already exists`.

**Cause.** Creating a project auto-provisions a default database; there can be only one default, so "create my DB as the default" 409s.

**Workaround.** Use the project's existing default database (auto-injected as `DATABASE_URL` on Compute), or create a non-default named database (`isDefault: false`).

**Reproduction.**

1. Create a project.
2. Create a database with `isDefault: true` → `Default database already exists`.

**References.**

- Upstream: [FT-5220](https://linear.app/prisma-company/issue/FT-5220/creating-a-database-with-isdefaulttrue-fails-a-project-already-auto)
- Related: [`examples/smoke/alchemy.run.ts`](examples/smoke/alchemy.run.ts) (creates a non-default DB); [`dogfood-report.md`](dogfood-report.md)

---

## Next.js on Compute ignores runtime env vars unless the route is force-dynamic

**Filed upstream:** [PRO-202](https://linear.app/prisma-company/issue/PRO-202/nextjs-on-compute-ignores-runtime-env-vars-unless-the-route-is-force) — _"Next.js on Compute ignores runtime env vars unless the route is force-dynamic"_
**Product:** Prisma Compute (Next.js interaction)
**Version:** Next 15.5.19 on Prisma Compute
**First hit:** `examples/storefront-auth/modules/storefront` — wiring `AUTH_URL` into the Storefront
**Cost:** ~30 min ("Storefront renders AUTH_URL not set" despite the env being set)

**Symptom.** A Next.js app on Compute reads `process.env` at build time and serves that value forever; Compute's runtime-injected env (`DATABASE_URL`, `AUTH_URL`, …) is never read. Headers: `cache-control: s-maxage=31536000`, `x-nextjs-prerender: 1`.

**Cause.** Next 15 prerenders routes as static by default and evaluates server components (and their `process.env` reads) at build time. A `fetch(..., { cache: "no-store" })` alone does **not** force the route dynamic. Compute injects env at runtime, so a static page bakes in the empty build-time env.

**Workaround.** `export const dynamic = "force-dynamic"` on any route that reads runtime env / calls another service.

**Reproduction.**

1. Next server component reading `process.env.X` (or fetching a URL from env), `output: "standalone"`.
2. Build with X unset; deploy to Compute; set X as a Compute env var.
3. Request the page → build-time (empty) value, `x-nextjs-prerender: 1`. Add `force-dynamic`, rebuild → runtime value read.

**References.**

- Upstream: [PRO-202](https://linear.app/prisma-company/issue/PRO-202/nextjs-on-compute-ignores-runtime-env-vars-unless-the-route-is-force)
- Workaround source: [`examples/storefront-auth/modules/storefront/app/page.tsx`](examples/storefront-auth/modules/storefront/app/page.tsx)
- Related: [`dogfood-report.md`](dogfood-report.md)

---

## Fresh deploys race env-var creation against the first version start

**Filed upstream:** [PRO-211](https://linear.app/prisma-company/issue/PRO-211/compute-fresh-deploys-race-env-var-creation-against-first-version) — _"Compute: fresh deploys race env-var creation against first version start (no ordering primitive, no restart on config change)"_
**Product:** Prisma Compute (deploy orchestration / environment variables)
**Version:** Management API v1, `alchemy@2.0.0-beta.59` client
**First hit:** `examples/storefront-auth` R2 migration — fresh deploy of the two-service module
**Cost:** ~20 min (plus a review round establishing the old stack never had the ordering either)

**Symptom.** Deploying producer service + consumer service + an env var derived from the producer's URL in one apply: on a fresh deploy the consumer's version is created before the env-var row lands, and it serves "AUTH_URL not set".

**Cause (corrected after reading pdp-control-plane source).** Env vars are `ConfigVariable` rows **materialized into a version at version-create time** (`materializeBranchEnvVars` resolves the branch's map and hands it to Foundry with the version) and frozen there — version start does not re-resolve, and updating a variable touches only the row, never an existing version. So the race is the env-var POST vs the consumer's **version-create** call, issued by one apply with no dependency edge between them. Consequences: (1) a version created before the row exists never sees it, regardless of VM recycles; (2) config changes take effect only via a new version — there is no restart-on-config-change. _The original filing (and this entry's first version) claimed boot-time application and recycle-healing; the source model contradicts that. Our one observed recycle-heal is treated as a platform bug, not behavior to rely on._

**Workaround.** Give the consumer's version-create a real dependency on the env-var write in the deploy graph — the version genuinely consumes the environment (PDP's version-create call contains the materialized map). In Prisma Composer this is the Connection primitive's corrected lowering: `Deployment` declares its expected environment records as a prop, which both orders the write first and redeploys the consumer when a value changes. Manual stacks: create the variable, then ship a new version.

**Reproduction.**

1. One stack: service A; env var on service B's project whose value is A's deployed URL; service B.
2. Fresh deploy (no prior state) where the version-create wins the race → config-missing behavior, permanent for that version.
3. Ship a new version of B → healed (its snapshot includes the variable).

**References.**

- Upstream: [PRO-211](https://linear.app/prisma-company/issue/PRO-211/compute-fresh-deploys-race-env-var-creation-against-first-version)
- Race + edge analysis: [`packages/app-cloud/src/target.ts`](packages/app-cloud/src/target.ts) (the corrected ordering comment — the `deploy`/`serialize` edge)
- Related: [`dogfood-report.md`](dogfood-report.md)

---

## Connection create/read response buries the real Postgres DSN under endpoints.*; `url` is an API self-link

**Filed upstream:** [PRO-212](https://linear.app/prisma-company/issue/PRO-212/connection-createread-response-buries-the-real-postgres-dsn-url-is-an) — _"Connection create/read response buries the real Postgres DSN — `url` is an API self-link, top-level `connectionString` is deprecated"_
**Product:** Prisma Postgres / Management API
**Version:** `@prisma/management-api-sdk` · Management API `https://api.prisma.io/v1`
**First hit:** `examples/storefront-auth/modules/auth` — the auth service's DB connection at the R4 deploy proof
**Cost:** ~1.5 hours — every DB query 30s-timed-out on a deployed, healthy-looking service.

**Symptom.** `POST /v1/databases/{databaseId}/connections` returns `data.url = https://api.prisma.io/v1/connections/con_…` — the connection resource's **API self-link**, not a Postgres DSN. A consumer that wires `data.url` into a Postgres client gets `ERR_POSTGRES_CONNECTION_TIMEOUT` after 30s (the driver dials an HTTPS host as if it were Postgres) → 502 on every query, while `status: running` and env vars are all present.

**Cause.** The usable DSNs are nested: `data.endpoints.direct.connectionString` and `data.endpoints.pooled.connectionString` (`accelerate` too). The top-level `data.connectionString` is **deprecated**, and `data.url` is the self-link. The naming points at the wrong fields, and the credentials-bearing DSN is only returned at create (write-only on read), so the right nested field must be captured then.

**Workaround.** Read `endpoints.direct.connectionString` (fall back to `endpoints.pooled.connectionString`); never `url` or the deprecated top-level `connectionString`. Verified by minting a connection and running `select 1` over both direct and pooled DSNs.

**References.**

- Upstream: [PRO-212](https://linear.app/prisma-company/issue/PRO-212/connection-createread-response-buries-the-real-postgres-dsn-url-is-an)
- Fix: [`packages/prisma-alchemy/src/postgres/Connection.ts`](packages/prisma-alchemy/src/postgres/Connection.ts)

---

## Compute's bun auto-installs at runtime — masks incomplete artifacts and cross-platform native binaries as an ENOSPC crash loop

**Filed upstream:** [PRO-213](https://linear.app/prisma-company/issue/PRO-213/compute-runs-bun-with-runtime-auto-install-on-masks-incomplete) — _"Compute runs `bun` with runtime auto-install ON — masks incomplete artifacts and cross-platform native-binary gaps as an ENOSPC crash loop"_
**Product:** Prisma Compute (bun runtime)
**Version:** Bun on Compute; Next.js 15.5.19 `output: "standalone"`; build darwin-arm64 → Compute linux-x64
**First hit:** `examples/storefront-auth/modules/storefront` — the Next Module at the R4 deploy proof
**Cost:** ~3 hours, chasing a symptom several layers from the cause.

**Symptom.** Crash loop: `starting bun with entrypoint: bootstrap.js` → `🚚 @next/swc-linux-x64-gnu [139/139] error: ENOSPC extracting tarball` → `Application exited with 0x0` → `reboot`, repeating. Endpoint serves `404 "There is no service on this URL"`; `status: running` throughout.

**Cause.** Compute's `bun` has runtime auto-install **on**: a failed `require` triggers a boot-time `bun install`. Two triggers: (1) a darwin-built Next standalone traces darwin `sharp`/`@next/swc`, so on linux those requires miss and bun fetches the linux tree (~139 packages) onto a tiny disk → ENOSPC; (2) an artifact missing `node_modules` entirely (a packaging bug tarring the wrong subtree) is **silently masked** by auto-install fetching everything → same ENOSPC, no clear signal.

**Workaround.** Ship a `bunfig.toml` with `[install]\nauto = "disable"` in the artifact (bun reads it from CWD = artifact root) — a missing dep then fails loudly (`Cannot find package 'next'`) and unused optional native deps degrade gracefully. Make the artifact fully self-contained (bundle real `node_modules`; for a Next standalone, include the standalone tree's hoisted `node_modules`, not just the app subdir). For Next: `images: { unoptimized: true }` + `outputFileTracingExcludes` to drop `sharp`/`@next/swc`.

**References.**

- Upstream: [PRO-213](https://linear.app/prisma-company/issue/PRO-213/compute-runs-bun-with-runtime-auto-install-on-masks-incomplete)
- Fix: [`packages/app-nextjs/src/assemble.ts`](packages/app-nextjs/src/assemble.ts), [`examples/storefront-auth/modules/storefront/next.config.ts`](examples/storefront-auth/modules/storefront/next.config.ts)
- Related: PRO-201 (Next standalone packaging), FT-5219 (Bun.SQL scale-to-zero)

---

## Branch create has no idempotency — a duplicate gitName 409s, with no create-or-return

**Filed upstream:** [PRO-214](https://linear.app/prisma-company/issue/PRO-214/management-api-branch-create-has-no-idempotency-ifexists-409-on) — _"Management API: branch create has no idempotency (`ifExists`) — 409 on duplicate gitName"_
**Product:** Prisma Postgres / Compute (Management API, branches)
**Version:** `@prisma/management-api-sdk` 1.47.0
**First hit:** the Prisma Cloud extension's container resolution (`resolveBranch`), building stage-as-branch
**Cost:** low — caught at implementation; the client-side dance is boilerplate every caller repeats.

**Symptom.** `POST /v1/projects/{projectId}/branches` with a `gitName` that already exists returns `409`, full stop. Any "ensure this branch exists" step that runs on every deploy cannot just create.

**Cause.** The create body accepts only `gitName` + `isDefault` (`additionalProperties: false`) — there is no `ifExists`/upsert option, so idempotency must be client-side.

**Workaround.** Observe first (`GET …/branches?gitName=X` — server-side exact match, ≤1 row), `POST` only when absent, and on a racing `409` re-read and adopt the winner instead of failing.

**References.**

- Upstream: [PRO-214](https://linear.app/prisma-company/issue/PRO-214/management-api-branch-create-has-no-idempotency-ifexists-409-on)
- Fix: [`packages/1-prisma-cloud/0-lowering/lowering/src/container.ts`](packages/1-prisma-cloud/0-lowering/lowering/src/container.ts) (`resolveBranch`)

---

## A project-scoped compute-service create lands on the default branch — and collides with production

**Filed upstream:** [PRO-215](https://linear.app/prisma-company/issue/PRO-215/management-api-project-scoped-compute-service-create-collides-with) — _"Management API: project-scoped compute-service create collides with production on `main`; branchId-on-create differs from databases"_
**Product:** Prisma Compute (Management API)
**Version:** `@prisma/management-api-sdk` 1.47.0
**First hit:** `prisma-composer deploy --stage staging` on `examples/storefront-auth` — the stage-as-branch live proof
**Cost:** ~1 hour — one failed live deploy, diagnosis, and a provider rework.

**Symptom.** Deploying a same-named compute service into a preview Branch fails outright: `compute_service:already_exists: An app named "auth" already exists on branch "main"`.

**Cause.** `POST /v1/projects/{projectId}/compute-services` with no `branchId` lands the service on the project's default (`main`) Branch, and compute-service names are unique **per Branch** — so the create collides with the production service before any later branch-attach can run. Databases are the mirror image: their create body has **no** `branchId` at all (attach is a `PATCH` after create), so the two sibling resource types need opposite mechanisms and the naive uniform approach hard-fails only for compute.

**Workaround.** For compute services, pass `branchId` in the create body (create directly on the target Branch; no PATCH). For databases, create project-scoped, then `PATCH /v1/databases/{id}` with `{ branchId }`.

**References.**

- Upstream: [PRO-215](https://linear.app/prisma-company/issue/PRO-215/management-api-project-scoped-compute-service-create-collides-with)
- Fix: [`packages/alchemy/src/compute/ComputeService.ts`](packages/alchemy/src/compute/ComputeService.ts), [`packages/alchemy/src/postgres/Database.ts`](packages/alchemy/src/postgres/Database.ts)

---

## First connection to a freshly-provisioned Postgres is rejected while the upstream is cold — breaks deploy-time migrations

**Filed upstream:** [FT-5226](https://linear.app/prisma-company/issue/FT-5226/first-connection-to-a-freshly-provisioned-postgres-is-rejected-while) — _"First connection to a freshly-provisioned Postgres is rejected while the upstream is cold — breaks deploy-time migrations"_
**Product:** Prisma Postgres (edge proxy / cold-start)
**Version:** node-postgres (`pg` 8.21) via `@prisma-next/driver-postgres`; PPg direct connection; connecting at deploy time
**First hit:** `examples/pn-widgets` — the `pnPostgres` deploy-migrate lowering connects to the DB the instant it is provisioned
**Cost:** ~2 hours — several live E2E iterations plus a throwaway-DB diagnosis, and a red-herring SSL "fix" on the way

**Symptom.** A client connecting to a PPg database **immediately after it is provisioned** fails on the first connection. Through Prisma Next's control client it surfaces as `CliStructuredError: Database connection failed`; the raw node-postgres error is `message: "Failed to connect to upstream database. Please contact Prisma support…"`, `err.code === undefined`, no `err.cause`. The **direct** endpoint fast-rejects (~0.4–0.6s); the **pooled** endpoint slow-times-out (~10s). Intermittent — the same DSN sometimes connects on attempt 1; it reproduces reliably only when connecting within a moment of provisioning.

**Cause.** The PPg edge accepts the TCP/TLS connection but the **upstream database is cold** (just provisioned / scaled to zero) and not yet ready, so the proxy rejects with the generic "upstream" error. Confirmed **not** TLS, **not** network (no `ECONNREFUSED`/`ETIMEDOUT`), **not** auth: on a **warmed** DB every SSL posture (`require`, `verify-full`, `no-verify`) and both endpoints connect, and PPg's cert is publicly trusted. Same cold/scale-to-zero family as FT-5219, different surface — FT-5219 is an *idle-close* crash of a persistent runtime client; this is the *first connect* being rejected at deploy time. A deploy-time migration hits the cold window ~every time because it connects the instant the DB is provisioned.

**Workaround.** Bounded connection **retry** on connect — retry connect/transient failures (not real errors) for ~1 min; warm DBs connect immediately and the retry rides out the cold-start (observed connect at ~10s):

```ts
// deploy-time only; wraps the control client's connect + operation
await withConnectionRetry(() => client.dbInit(...), { attempts: 12, delayMs: 5000 });
// real migration errors (no-path / runner) are surfaced immediately, never retried
```

**Red herring.** The failure is preceded by a `pg-connection-string@8.21` `deprecatedSslModeWarning`. Not the cause: pg 8.21 now treats `sslmode=require` as strict `verify-full` (and warns), but PPg's cert is publicly trusted so verification succeeds on a warm DB. Downgrading to `sslmode=no-verify` silences the warning but does **not** fix the failure, and is a needless security downgrade — don't chase it.

**Reproduction.**

1. Provision a PPg database via the Management API.
2. Immediately (sub-second) open a node-postgres connection to `endpoints.direct.connectionString` and run `select 1`.
3. → "Failed to connect to upstream database" (fast-reject on direct; ~10s timeout on pooled). Wait ~10s, retry → connects.

**References.**

- Upstream: [FT-5226](https://linear.app/prisma-company/issue/FT-5226/first-connection-to-a-freshly-provisioned-postgres-is-rejected-while)
- Workaround source: [`packages/app-cloud/src/prisma-next-migrate.ts`](packages/app-cloud/src/prisma-next-migrate.ts) (`withConnectionRetry`)
- Removal guard: the CI canary (`scripts/cold-connect-canary.ts`, "Cold-connect canary" E2E job) fails only when every cold connect succeeds — when the platform fixes FT-5226 it goes red, forcing removal of `withConnectionRetry` and itself (an inconclusive run passes with a warning annotation instead of blocking)
- Related: [FT-5219](https://linear.app/prisma-company/issue/FT-5219) (idle-close, runtime), [PRO-212](https://linear.app/prisma-company/issue/PRO-212) (nested endpoint DSNs)

---

## Idle direct-connection close kills pooled node-postgres clients — first query after idle 500s with "Connection terminated unexpectedly"

**Filed upstream:** [PRO-216](https://linear.app/prisma-company/issue/PRO-216/idle-direct-connection-close-kills-pooled-node-postgres-clients-first) — _"Idle direct-connection close kills pooled node-postgres clients — first query after idle fails with 'Connection terminated unexpectedly'"_
**Product:** Prisma Postgres idle-close × Prisma Compute scale-to-zero (the FT-5219 family, pooled-client variant)
**Version:** `pg` 8.21.0 `Pool` (via `@prisma-next/postgres` 0.14.0); PPg direct connection; Prisma Compute (scale-to-zero)
**First hit:** `examples/store` — the orders service after an idle spell; presented as the storefront rendering Next's error page
**Cost:** ~1 hour — two separate "the demo URL is down" reports before the service logs were pulled

**Symptom.** A service using a node-postgres `Pool` works right after deploy, then after sitting idle its first DB-backed request fails once with `Connection terminated unexpectedly` (surfaced here as an RPC 500; the consumer's SSR render then 500s). The next request works. No crash loop — just a reliable one-request failure after every idle spell.

**Cause.** Prisma Postgres closes idle direct connections well under 30 s. A pool with a longer idle timeout (`idleTimeoutMillis: 30_000` here) keeps the dead socket checked in and hands it to the next query. Unlike FT-5219's persistent Bun.SQL client the process survives, and unlike FT-5226 the failure surfaces at `query()` time on an already-established connection — so a connect-time retry (`retryTransientConnect` wrapping `pool.connect()`) never engages. The pool's async idle-client `'error'` event is also unhandled by default, which turns the close into a process crash if no `uncaughtException` guard exists.

**Workaround.** Keep the pool's idle timeout under the platform's idle-close window, and attach a pool error handler so the close is logged rather than fatal:

```ts
const pool = new pg.Pool({ connectionString, idleTimeoutMillis: 5_000 });
pool.on("error", (err) => console.error("pg pool idle client error", err));
```

**Reproduction.**

1. Deploy a Compute service holding a module-scope `pg.Pool` (default or 30 s `idleTimeoutMillis`) on a PPg direct connection, with a route that queries.
2. Hit the route → 200. Let it idle ≥ 30 s.
3. Hit again → one failure with `Connection terminated unexpectedly`; the following request → 200.

**References.**

- Fix in this repo: `resilientPool` in [`packages/1-prisma-cloud/1-extensions/target/src/prisma-next.ts`](packages/1-prisma-cloud/1-extensions/target/src/prisma-next.ts) (commit `0088520`)
- Related: [FT-5219](https://linear.app/prisma-company/issue/FT-5219) (same idle-close, persistent Bun.SQL client → 502 loop), [FT-5226](https://linear.app/prisma-company/issue/FT-5226) (same cold/idle family, deploy-time first connect)

---

## Service-to-service HTTP gets ECONNRESET while the target cold-starts from scale-to-zero

**Filed upstream:** [PRO-217](https://linear.app/prisma-company/issue/PRO-217/service-to-service-http-gets-econnreset-while-the-target-cold-starts) — _"Service-to-service HTTP gets ECONNRESET while the target cold-starts from scale-to-zero"_
**Product:** Prisma Compute (ingress / scale-to-zero cold start)
**Version:** Prisma Compute, Bun `fetch` — from a Next.js standalone SSR render (observed 2026-07-13) and from a plain Bun service (observed 2026-07-16)
**First hit:** `examples/store` — the storefront's SSR calls to the catalog and orders services' `*.ewr.prisma.build` endpoints. Hit again in `examples/streams`, where the `jobs` service calls the streams module.
**Cost:** folded into the idle-500 diagnosis above; intermittent enough to first read as "the in-app browser is flaky". Later cost a round of misdiagnosis in `examples/streams`: a bare status code cannot tell an app's own 502 from the edge's, so the reset was mistaken for a too-short retry budget until response bodies were captured.

**Symptom.** An HTTP request from one Compute service to another intermittently fails with `ECONNRESET` — Bun reports `The socket connection was closed unexpectedly` with the target service's URL as `path`. It happens on the first request(s) after the target has been idle; a retry moments later succeeds. When the caller is an SSR page fanning out to several services, one reset is enough to 500 the whole page render.

The failure is a **thrown socket error, and only that**: it surfaces fast (~400 ms on the first touch after an idle spell — far quicker than the target's own boot), and across every cold hit captured in `examples/streams` the edge never once answered `502`/`503`/`504`. Code written to retry a cold-start *status* is therefore guarding a face of this bug that has not been observed; the reset is the whole of it. It lands on whatever call happens to be first, idempotent or not — in `examples/streams` on both the stream-creating `PUT` and, on a later request whose `PUT` was already memoized, the non-idempotent append.

**Cause (observed, mechanism presumed).** The target service had scaled to zero. Instead of the edge holding the connection until the VM finishes booting (which it does do on most cold hits — those requests just take seconds), the connection is sometimes closed mid-establishment during the cold-start window, surfacing as a socket reset to the caller. Warm targets never reset.

The window is measurable, and much wider than first recorded. In `examples/streams`' Compute logs, `spark: starting bun with entrypoint: bootstrap.js` → the server's own "listening" line was first measured at **~3.5 s** for a service restoring little state and **~8 s** for one restoring more from its object store. Later sampling (2026-07-17, two independent operators) measured boots of **3.3 s, 10.4 s, 11.6 s, 12.8 s, 21.9 s** — so treat **~3 s to ~22 s** as the real range, not 3.5–8 s. That is the window a first request falls into. Usually the request simply blocks for it and succeeds — a first request against a deliberately fresh instance returned `201` in 3.7 s with no error. The bug is not the wait; it is that the same first request sometimes gets the ~400 ms socket close instead, and nothing on the caller's side predicts which.

**Boot length tracks how long the service was left alone, and the close only shows up in the long boots.** Promoting fresh versions back-to-back (samples ~4 s apart) yields atypically short **~1 s** boots, and across 20 such touches the edge held every time. Spacing the same trigger 60 s apart yields the 3–22 s boots above, and the close reproduces readily (3 of 5 touches in one probe; 4 of 4 first touches in another). A test that redeploys in a tight loop is therefore measuring a window the bug does not live in — and will conclude, wrongly, that the bug is gone. This cost the cold-start canary two rounds; see its removal guard below.

**Workaround.** No principled client-side fix for non-idempotent calls (blind retry could double-execute a write). Mitigations:

- retry only requests that never reached the server / are idempotent reads;
- keep chatty targets warm — a scheduled ping (the `cron` shared module's 30 s trigger) masks the window for whatever it touches;
- warm the whole app with one request before a demo.

**But do not push this into application code.** Hand-rolling it per app costs every consumer a platform-specific backoff, cannot cover the non-idempotent calls (where this was actually observed to land), and hides the defect from the people who would fix it. The compensation lives ONCE, as policy in the streams client Composer ships (the `IDEMPOTENT_BACKOFF` policy in `client.ts`'s `StreamsClient`): idempotent operations — create, read, tail — are retried with a bounded backoff; **appends are not retried** (no idempotency key upstream, so a failed append is indistinguishable from an applied one) and surface as a 502 naming the cause, keeping the platform behaviour visible where it cannot be safely absorbed. An app's first append after an idle spell may therefore still fail intermittently — the honest state of the platform. The cost this pushes onto tooling and users is filed as [PRO-219](https://linear.app/prisma-company/issue/PRO-219/scale-to-zero-cold-starts-force-platform-specific-retry-boilerplate); an always-on / min-instances option, or making the first-request behaviour consistent, would remove the window and the compensation with it. Neither exists today.

**Removal guard.** The CI "Cold-start canary (PRO-217)" job (`scripts/cold-start-canary.ts`, in the E2E deploy workflow) touches freshly promoted instances each run, 60 s apart, and confirms from the deployment's own boot log that each touch was sent before the server's "listening" line — a touch that cannot be placed on one side of the boot counts for nothing rather than being guessed. It fails only when enough touches reached a genuine cold start **and** every one of them held; because this bug is intermittent, "every touch held" in a small run is the expected outcome of a run that is too small, so the job requires 14 confirmed cold-start holds before it will claim the bug is gone (at a conservative 20% close rate, 0.8^14 ≈ 4.4% — the chance of being fooled by luck). An inconclusive run passes with a warning annotation. That failure is the signal to remove the streams client's `IDEMPOTENT_BACKOFF` (the PRO-219 compensation) and the canary itself, the same contract as FT-5226's cold-connect canary.

**The service-RPC face, and why it has no canary of its own.** The same ingress closes a service-to-service RPC call's first connection while the target cold-starts. The generated `service-rpc` client absorbs it: every call carries an idempotency key and is retried with a bounded backoff, and the server dedupes on the key so a retry cannot double-execute (ADR-0037). Two things follow that differ from the streams face. First, this retry is **permanent protocol semantics, not a compensation** — it is correct on any transport that can drop a request, so nothing here is ever removed when PRO-217 is fixed; there is no workaround to time the removal of, and therefore no RPC-specific canary. Second, an RPC canary was built and dropped on the evidence anyway: an RPC service that restores no state (`examples/storefront-auth`'s `auth`) boots in under ~1.5 s — narrower than the 2 s clock-skew margin the coldness proof needs — so a probe cannot certify a cold start even though it reliably forces one (touch measured 376–1185 ms ahead of the listening line across 14 samples). PRO-217 stays watched by the streams canary above, which catches it because streams has the long boot window RPC lacks; when that canary reports the platform healed, the RPC keys and retry still stay, because they were never a workaround.

**Reproduction.**

1. Deploy two Compute services, A calling B over HTTP on each request to A.
2. Let B idle to scale-to-zero.
3. Hit A repeatedly right as B cold-starts → occasional `ECONNRESET` from A's fetch to B; warm B never resets.

Idling is an unreliable trigger — a service left alone for 6 minutes (and another for ~30) still answered warm in under 700 ms, so the scale-to-zero threshold is longer than a convenient wait. Stopping the deployment does not work either: `POST /v1/deployments/{id}/stop` returns 204, the app then serves a plain `404` and stays down until something explicitly calls `start` — it never revives on a request, so it cannot produce a cold start at all.

What does work: promote a fresh version of B (create → upload → start → **race the promote call itself**, retrying immediately on its "not running yet" 409) and touch A the instant promote succeeds. Do **not** wait for the version to report `running` first — `running` flips within ~1 s of `start`, well before the app is listening, so by the time a poll loop and a promote call have run, the boot is already over and the touch lands on a warm instance. That mistake is what made the canary report the bug fixed while it was live.

Two more requirements for a trustworthy probe. **Leave ~60 s between samples** — back-to-back promotions produce ~1 s boots the close does not appear in (see above). And **confirm coldness from the deployment's own log** (`/v1/deployments/{id}/logs?from_start=true`, read from the start) rather than inferring it from latency: a touch counts only if it was sent before the server's own "listening" line. Note that comparison crosses clocks — the touch is timestamped on the runner, "listening" by the app on the VM — so require a margin (the canary uses 2 s) comfortably larger than plausible skew, and treat anything closer as unknown. Capture the response **body**, not just the status, or A's own 502 is indistinguishable from the edge's.

**References.**

- Observed in `storefront` runtime logs (`app logs --project store --app storefront`): `code: 'ECONNRESET', path: 'https://….ewr.prisma.build/rpc/listProducts'`
- Observed again from `examples/streams`' `jobs` service: `streams unreachable: Error: The socket connection was closed unexpectedly`, returned in 404 ms
- Product ask: [PRO-219](https://linear.app/prisma-company/issue/PRO-219/scale-to-zero-cold-starts-force-platform-specific-retry-boilerplate) — the userspace retry boilerplate this forces on every consumer
- Related: [FT-5219](https://linear.app/prisma-company/issue/FT-5219) / FT-5226 (the DB faces of the same scale-to-zero/cold family), [PRO-218](https://linear.app/prisma-company/issue/PRO-218/compute-ingress-buffers-streaming-responses-sse-cannot-deliver-edge) (the same ingress, streaming-response face)

---

## Compute ingress buffers streaming responses until completion — an open SSE tail delivers nothing and 504s at 60s

**Filed upstream:** [PRO-218](https://linear.app/prisma-company/issue/PRO-218/compute-ingress-buffers-streaming-responses-sse-cannot-deliver-edge) — _"Compute ingress buffers streaming responses — SSE cannot deliver; edge 504s at 60s"_
**Product:** Prisma Compute (ingress / streaming responses)
**Version:** Prisma Compute, observed 2026-07-15; server: `@prisma/streams-server` 0.1.11 behind the streams module
**First hit:** `examples/streams` — the streams module's deployed consumer smoke (`?live=sse` tail)
**Cost:** ~1 hour isolating the layer — the same request works on localhost and against the local stand-in, and the server-side code is provably correct

**Symptom.** An open `?live=sse` tail on a deployed service never delivers a byte — no response headers, no catch-up data, no events — and the edge returns a plain-text `504` after exactly ~60s (`time_starttransfer: 60.3s`, zero upstream bytes forwarded). Appends POSTed while the tail is open are accepted (204) and readable by normal GETs. Same behavior on the promoted domain and the version preview domain, over HTTP/2 and HTTP/1.1. Long-poll (`?live=long-poll`) works end to end. Observed on `cps_cfqde5muxclzwpjr5sud3ioj` (project `streams-example`), version `cpv_fmsobwdnu9g9z9vqkxljjdzj`.

**Cause (observed, mechanism presumed).** The ingress buffers HTTP responses until the upstream response **completes**, then forwards them as fixed-length responses. Determinative experiment: SSE on a *closed* stream (the server's SSE loop ends, completing the response) arrives instantly — with an ingress-**added** `content-length: 139` on a `text/event-stream` body the server sent chunked. And the 60s timeout is response-completion, not idle: the streams server emits an SSE `control` keep-alive every 30s on an idle tail, so upstream bytes were flowing when the edge 504'd. Any indefinitely-streaming response — SSE, long-lived chunked downloads — cannot traverse the ingress; every completing response is unaffected.

**Workaround.** Use `?live=long-poll` for live tailing on deployed services — each delivery is a completing response, and it is verified live end to end (the streams module's deployed smoke and the full non-SSE conformance suite pass: 215/239, all 24 failures in the suite's "SSE Mode" group). SSE remains correct locally and against the module's local stand-in; the deployed conformance harness keeps the SSE tests so they flip green when the platform streams responses.

**Reproduction.**

1. Deploy any service that serves an unbounded `text/event-stream` (e.g. the streams module); `curl -N` its SSE endpoint on the deployed URL.
2. → zero bytes (not even headers), then a plain-text `504` at ~60s, while POSTs to the same service succeed throughout.
3. Make the stream end server-side (for durable streams: append with `stream-closed: true`, then re-open the SSE read) → the whole SSE body arrives at once with an added `content-length`.

**References.**

- Upstream: [PRO-218](https://linear.app/prisma-company/issue/PRO-218/compute-ingress-buffers-streaming-responses-sse-cannot-deliver-edge)
- Workaround + note: [`packages/1-prisma-cloud/2-shared-modules/streams/README.md`](packages/1-prisma-cloud/2-shared-modules/streams/README.md) — "Deployed live path: use long-poll"
- Related: [PRO-217](https://linear.app/prisma-company/issue/PRO-217) (same ingress, cold-start face); server SSE handler: `@prisma/streams-server` `src/app_core.ts` (returns the stream `Response` immediately — upstream is not the buffer)

---

## planLimitReached is masked by the cold-start "not configured correctly yet" message

**Filed upstream:** [FT-5227](https://linear.app/prisma-company/issue/FT-5227/planlimitreached-is-masked-by-the-cold-start-not-configured-correctly) — _"planLimitReached is masked by the cold-start 'not configured correctly yet' message"_
**Product:** Prisma Postgres (edge proxy / plan enforcement)
**Version:** Prisma Postgres direct connection via `postgres` (postgres.js) 3.4.9; Management API `https://api.prisma.io/v1`; observed 2026-07-16
**First hit:** `examples/streams` — the streams module's live re-proof; the deploy died in the hosted state store's bootstrap
**Cost:** ~40 min — two wasted deploy retries chasing a "wait a minute or two" message, then a probe to find the real cause

**Symptom.** Every database in the workspace refuses connections, but the FIRST connect reports a transient-sounding problem:

```
Failed to identify your database: Your Prisma Postgres database is not configured
correctly yet. Please contact Prisma support if the problem persists longer than a
minute or two.
```

Retry the same DSN a few seconds later and the real, permanent cause appears:

```
Failed to identify your database: Your account has restrictions: planLimitReached
```

The Management API is no help: the project and database both read `status: "ready"`. Through Prisma Composer's hosted state store the failure surfaces two layers from its cause — `HostedStateBootstrapError: … finding/creating the prisma-composer-state project — ownership verification failed: … not configured correctly yet` — which points at the state store's own bootstrap rather than at the account.

**Cause.** Two unrelated conditions share one error prefix and the first one wins on a cold database. The generic "not configured correctly yet" text is the same message [FT-5226](https://linear.app/prisma-company/issue/FT-5226) documents for a cold upstream; the plan restriction is only reported once the upstream is warm. The two want **opposite** responses — FT-5226 says retry, `planLimitReached` says stop and reclaim a database — so the message that arrives first tells you to do the wrong thing. Worse, any bounded cold-start retry (the documented FT-5226 workaround, and what deploy-time code does) spends its whole budget re-showing the misleading message and then reports the misleading message.

**Workaround.** When a connect fails with "not configured correctly yet", **retry until the message changes, not just until it succeeds** — treat the text as provisional until a warm attempt confirms it. To disambiguate directly, connect to a **freshly created** database in the same workspace: a new DB connects on the first attempt while the existing ones keep failing, which points at a count limit rather than a broken database or a cold proxy. Then count databases (`GET /v1/projects` → each project's `/databases`) against the plan and reclaim or raise the limit; the restriction is workspace-wide, so an unrelated project's database fails identically — a useful second confirmation.

**Reproduction.**

1. Fill a workspace to its plan's database limit.
2. Connect to any existing (idle, cold) database's direct DSN → "…not configured correctly yet…".
3. Retry the same DSN for ~10s → `Your account has restrictions: planLimitReached`.
4. Create a new project, connect to its default database → succeeds on attempt 1.

**References.**

- Upstream: [FT-5227](https://linear.app/prisma-company/issue/FT-5227/planlimitreached-is-masked-by-the-cold-start-not-configured-correctly)
- Related: [FT-5226](https://linear.app/prisma-company/issue/FT-5226) (the cold-start message this is confused with, and whose retry workaround this defeats), [PRO-212](https://linear.app/prisma-company/issue/PRO-212) (the same API's habit of reporting the wrong field)
- Surfaced through: [`packages/1-prisma-cloud/0-lowering/lowering/src/state/bootstrap.ts`](packages/1-prisma-cloud/0-lowering/lowering/src/state/bootstrap.ts) (`verifyOwnership`)

---

## Composer's secret model has no optional/conditional secrets — every "off" stage still needs a junk credential

**Filed upstream:** not filed — a recorded framework design tradeoff ([ADR-0029](docs/design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md): "every wired secret is required"), not a product bug.
**Product:** Prisma Compute (deploy preflight / secret provisioning)
**Version:** Prisma Composer framework, observed 2026-07-21
**First hit:** the email module (`packages/1-prisma-cloud/2-shared-modules/email`) — its `deliveryCredential` secret is only ever read when `deliveryMode` is `resend`/`smtp`; mode `none` (the local-dev/preview story) never reads it
**Cost:** no time lost — anticipated at design time (spec D8) — but it is real friction every app author hits, so it is recorded here rather than only in the spec

**Symptom.** A stage that will never deliver email (preview, `EMAIL_DELIVERY_MODE=none`) still must set a non-empty `EMAIL_DELIVERY_CREDENTIAL`, or the deploy preflight rejects the app before it ever boots — even though the running service provably never calls `.expose()` on that secret in `none` mode (`delivery.ts`'s `noneDelivery` placeholder throws if it is ever invoked, and it never is).

**Cause.** Prisma Composer's secret model has no "optional" or "conditional on another param's value" secret: every secret slot a service or module declares is required, unconditionally, the same way every declared dependency is required. There is no way to say "this secret is required only when `deliveryMode !== 'none'`" — the framework has no notion of one param's value gating whether another slot must be bound.

**Workaround.** Set any non-empty junk value for `EMAIL_DELIVERY_CREDENTIAL` on stages where `deliveryMode` is `none` (documented in the module's README's env-var-per-stage table). The value is never read in that mode.

**Reproduction.**

1. Provision `email()` with `params: { deliveryMode: envParam('EMAIL_DELIVERY_MODE') }` and leave `EMAIL_DELIVERY_CREDENTIAL` unset on a stage where `EMAIL_DELIVERY_MODE=none`.
2. Deploy → preflight fails before the service ever boots: the secret slot is unbound.
3. Set `EMAIL_DELIVERY_CREDENTIAL` to any non-empty string → deploy succeeds; the value is never read (verified: `none` mode never constructs a `Delivery` backing).

**References.**

- Design record: [`.drive/projects/email-module/spec.md`](.drive/projects/email-module/spec.md) — D8, "the delivery credential secret is unconditionally required, junk allowed when mode is none"
- Module README: [`packages/1-prisma-cloud/2-shared-modules/email/README.md`](packages/1-prisma-cloud/2-shared-modules/email/README.md) — "Platform env vars (per stage)"

---

## Module-boundary param slots admit only sources, never a literal — a static-per-app value forces a platform env var or a factory option

**Filed upstream:** not filed — a design property of `ParamNeedBindings` (core's module boundary), not a product bug.
**Product:** Prisma Compute (module boundary wiring)
**Version:** Prisma Composer framework, observed 2026-07-21
**First hit:** the email module's `deliveryUrl` — a value that is almost always static per app (it follows `deliveryMode`, which already varies per stage) but has nowhere to be bound as a plain literal at the module boundary
**Cost:** no time lost — designed around at spec time — recorded per spec's friction-finding requirement

**Symptom.** A module boundary's `params` (`ParamNeedBindings<PN>`) accepts only a `ParamSource` (e.g. `envParam(...)`) for each declared `paramNeed()` slot — never a plain literal value — even for a param whose value is genuinely constant across every deploy of every app that provisions the module. The only way to make a value vary per app while staying literal (not a platform env var) is to keep it OUT of the module boundary entirely and pass it as a plain factory option instead.

**Cause.** `paramNeed()` slots exist specifically so an app can bind a per-stage-varying platform value through the boundary; the type only models that one case (a forwardable source), not "a literal the wiring layer should just pass through."

**Workaround.** The email module put `deliveryUrl` outside the `params`/boundary system entirely: `email(opts?: { deliveryUrl?: string })` is a factory option, resolved once at module-construction time in application code, not a wired param. This avoids forcing every app to mint a platform env var for a value that is almost always `https://api.resend.com`.

**Reproduction.**

1. Try to provision a module's `paramNeed()` slot with a plain string literal instead of a `ParamSource` (e.g. `params: { deliveryUrl: 'https://api.resend.com' }` against a `ParamNeedBindings<{ deliveryUrl: ParamNeed }>` target).
2. → does not type-check (and at runtime, `Load` rejects a non-source value bound into a param-forwarding slot — see `core/src/__tests__/params.test.ts`, "a non-source value wired into a module param-forwarding slot is rejected").
3. Move the value to a factory option instead (`email({ deliveryUrl: '...' })`) → works, at the cost of it being fixed per module-factory call rather than reconfigurable through the deploy's own param-binding surface.

**References.**

- Design record: [`.drive/projects/email-module/spec.md`](.drive/projects/email-module/spec.md) — "Module factory" pinned consequences, "`deliveryUrl` is a factory option, static per app"
- Core's param-forwarding rejection: [`packages/0-framework/1-core/core/src/__tests__/params.test.ts`](packages/0-framework/1-core/core/src/__tests__/params.test.ts)

---

## The deploy CLI's module-graph loader can't parse a `.tsx` file with real JSX — even though the runtime bundler handles it fine

**Filed upstream:** not filed — worth tracking as a product gap, since react-email (a common email-templating library) is JSX by construction.
**Product:** Prisma Compute (`prisma-composer deploy`, via Alchemy)
**Version:** Prisma Composer framework, observed 2026-07-22
**First hit:** the email module example (`examples/email`) — its `welcome` template was rewritten as a react-email component (`src/mailer/emails/welcome.tsx`), imported (through `templates.tsx` and `service.ts`) from `module.ts`
**Cost:** roughly half a day diagnosing and working around

**Symptom.** `pnpm run deploy` failed with `TypeError: Unknown file extension ".tsx"`, thrown from Node's own `node:internal/modules/esm/get_format`, while loading `templates.tsx`. The same file bundles and runs correctly under Bun (`bun build`, `bun test`) — the failure is specific to the deploy CLI's module-graph-loading step.

**Cause.** `prisma-composer deploy` loads the app's `module.ts` → `service.ts` → dependency-factory-argument import graph with Node's own native ESM loader, to build deploy topology (ADR-0005: the framework doesn't bundle the app's code). Node's native TypeScript support (`--experimental-strip-types` / `--experimental-transform-types`) strips *type* syntax but has no JSX transform at all — confirmed by direct testing: a `.tsx` file with real JSX syntax fails to load under bare `node` and under both experimental-types flags alike; only a separate loader hook (the `tsx` npm package, via `--import=tsx`) can execute it. No pre-existing `.tsx` file in this repo's example apps sits in a `module.ts`/`service.ts`-reachable import graph (the ones that exist are Next.js pages, reached only through the Next.js build adapter), so this is the first time the conflict surfaces.

Setting `NODE_OPTIONS=--import=tsx` globally around the deploy command does make Node parse the JSX, but it also changes module resolution for every other Node process spawned during that deploy — it broke an unrelated, pre-existing import inside Alchemy's own CLI startup (`@alchemy.run/node-utils`'s `foregroundChild` export stopped resolving), so it isn't a safe fix.

**Workaround.** Kept the JSX-authored `templates.tsx`/`emails/welcome.tsx` as the real source (so the example still demonstrates react-email authoring), but added a build step (`examples/email/scripts/build.ts`) that precompiles `templates.tsx` to plain, JSX-free JS via `bun build --target=node` (all real npm packages passed as `--external`, so nothing from `node_modules` gets inlined — this is a JSX transform, not a bundle) before `service.ts` imports it. `service.ts` imports the compiled `dist/mailer/templates.generated.ts`, not the raw `.tsx`; the runtime server bundle imports the same compiled file, so there's one wired-up template set, not two paths that could drift.

**Reproduction.**

1. Add a `.tsx` file with real JSX syntax anywhere in a module's `module.ts` → `service.ts` → dependency-argument import graph.
2. `prisma-composer deploy module.ts` → `TypeError: Unknown file extension ".tsx"` from Node's ESM loader, before any resources are planned.
3. Precompile the JSX away (e.g. `bun build --target=node --format=esm` with npm packages kept `--external`) into a plain `.ts`/`.mjs` file, and import that from `service.ts` instead → deploy succeeds.

**References.**

- Surfaced through: [`examples/email/scripts/build.ts`](examples/email/scripts/build.ts), [`examples/email/src/mailer/service.ts`](examples/email/src/mailer/service.ts)
- Design record: [`.drive/projects/email-module/spec.md`](.drive/projects/email-module/spec.md) — 2026-07-22 amendment, "Template definitions" (react-email demo)
