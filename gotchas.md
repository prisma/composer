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
**First hit:** `examples/storefront-auth/hexes/storefront` — deploying the Next.js Storefront hex to Compute
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
- Workaround source: [`packages/makerkit-nextjs/src/assemble.ts`](packages/makerkit-nextjs/src/assemble.ts), [`.npmrc`](.npmrc)
- Related: [`.drive/projects/mvp-example-app/design-notes.md`](.drive/projects/mvp-example-app/design-notes.md) — "Compute skill findings"

---

## Idle direct-connection close crashes a persistent Bun.SQL client into a 502 loop on scale-to-zero Compute

**Filed upstream:** [FT-5219](https://linear.app/prisma-company/issue/FT-5219/idle-direct-connection-close-crashes-a-persistent-bunsql-client-into-a) — _"Idle direct-connection close crashes a persistent Bun.SQL client into a 502 loop on scale-to-zero Compute"_
**Product:** Prisma Postgres (surfaced on Prisma Compute)
**Version:** Bun 1.3.13 (`Bun.SQL`); Prisma Postgres direct connection; Prisma Compute (scale-to-zero)
**First hit:** `examples/storefront-auth/hexes/auth` — the Auth hex after it sat idle
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
- Workaround source: [`examples/storefront-auth/hexes/auth/src/index.ts`](examples/storefront-auth/hexes/auth/src/index.ts)
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
**First hit:** `examples/storefront-auth/hexes/storefront` — wiring `AUTH_URL` into the Storefront
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
- Workaround source: [`examples/storefront-auth/hexes/storefront/app/page.tsx`](examples/storefront-auth/hexes/storefront/app/page.tsx)
- Related: [`dogfood-report.md`](dogfood-report.md)

---

## Fresh deploys race env-var creation against the first version start

**Filed upstream:** [PRO-211](https://linear.app/prisma-company/issue/PRO-211/compute-fresh-deploys-race-env-var-creation-against-first-version) — _"Compute: fresh deploys race env-var creation against first version start (no ordering primitive, no restart on config change)"_
**Product:** Prisma Compute (deploy orchestration / environment variables)
**Version:** Management API v1, `alchemy@2.0.0-beta.59` client
**First hit:** `examples/storefront-auth` R2 migration — fresh deploy of the two-service system
**Cost:** ~20 min (plus a review round establishing the old stack never had the ordering either)

**Symptom.** Deploying producer service + consumer service + an env var derived from the producer's URL in one apply: on a fresh deploy the consumer's version is created before the env-var row lands, and it serves "AUTH_URL not set".

**Cause (corrected after reading pdp-control-plane source).** Env vars are `ConfigVariable` rows **materialized into a version at version-create time** (`materializeBranchEnvVars` resolves the branch's map and hands it to Foundry with the version) and frozen there — version start does not re-resolve, and updating a variable touches only the row, never an existing version. So the race is the env-var POST vs the consumer's **version-create** call, issued by one apply with no dependency edge between them. Consequences: (1) a version created before the row exists never sees it, regardless of VM recycles; (2) config changes take effect only via a new version — there is no restart-on-config-change. _The original filing (and this entry's first version) claimed boot-time application and recycle-healing; the source model contradicts that. Our one observed recycle-heal is treated as a platform bug, not behavior to rely on._

**Workaround.** Give the consumer's version-create a real dependency on the env-var write in the deploy graph — the version genuinely consumes the environment (PDP's version-create call contains the materialized map). In MakerKit this is the Connection primitive's corrected lowering: `Deployment` declares its expected environment records as a prop, which both orders the write first and redeploys the consumer when a value changes. Manual stacks: create the variable, then ship a new version.

**Reproduction.**

1. One stack: service A; env var on service B's project whose value is A's deployed URL; service B.
2. Fresh deploy (no prior state) where the version-create wins the race → config-missing behavior, permanent for that version.
3. Ship a new version of B → healed (its snapshot includes the variable).

**References.**

- Upstream: [PRO-211](https://linear.app/prisma-company/issue/PRO-211/compute-fresh-deploys-race-env-var-creation-against-first-version)
- Race + edge analysis: [`packages/makerkit-prisma-cloud/src/target.ts`](packages/makerkit-prisma-cloud/src/target.ts) (the corrected ordering comment — the `deploy`/`serialize` edge)
- Related: [`dogfood-report.md`](dogfood-report.md)

---

## Connection create/read response buries the real Postgres DSN under endpoints.*; `url` is an API self-link

**Filed upstream:** [PRO-212](https://linear.app/prisma-company/issue/PRO-212/connection-createread-response-buries-the-real-postgres-dsn-url-is-an) — _"Connection create/read response buries the real Postgres DSN — `url` is an API self-link, top-level `connectionString` is deprecated"_
**Product:** Prisma Postgres / Management API
**Version:** `@prisma/management-api-sdk` · Management API `https://api.prisma.io/v1`
**First hit:** `examples/storefront-auth/hexes/auth` — the auth service's DB connection at the R4 deploy proof
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
**First hit:** `examples/storefront-auth/hexes/storefront` — the Next hex at the R4 deploy proof
**Cost:** ~3 hours, chasing a symptom several layers from the cause.

**Symptom.** Crash loop: `starting bun with entrypoint: bootstrap.js` → `🚚 @next/swc-linux-x64-gnu [139/139] error: ENOSPC extracting tarball` → `Application exited with 0x0` → `reboot`, repeating. Endpoint serves `404 "There is no service on this URL"`; `status: running` throughout.

**Cause.** Compute's `bun` has runtime auto-install **on**: a failed `require` triggers a boot-time `bun install`. Two triggers: (1) a darwin-built Next standalone traces darwin `sharp`/`@next/swc`, so on linux those requires miss and bun fetches the linux tree (~139 packages) onto a tiny disk → ENOSPC; (2) an artifact missing `node_modules` entirely (a packaging bug tarring the wrong subtree) is **silently masked** by auto-install fetching everything → same ENOSPC, no clear signal.

**Workaround.** Ship a `bunfig.toml` with `[install]\nauto = "disable"` in the artifact (bun reads it from CWD = artifact root) — a missing dep then fails loudly (`Cannot find package 'next'`) and unused optional native deps degrade gracefully. Make the artifact fully self-contained (bundle real `node_modules`; for a Next standalone, include the standalone tree's hoisted `node_modules`, not just the app subdir). For Next: `images: { unoptimized: true }` + `outputFileTracingExcludes` to drop `sharp`/`@next/swc`.

**References.**

- Upstream: [PRO-213](https://linear.app/prisma-company/issue/PRO-213/compute-runs-bun-with-runtime-auto-install-on-masks-incomplete)
- Fix: [`packages/makerkit-nextjs/src/assemble.ts`](packages/makerkit-nextjs/src/assemble.ts), [`examples/storefront-auth/hexes/storefront/next.config.ts`](examples/storefront-auth/hexes/storefront/next.config.ts)
- Related: PRO-201 (Next standalone packaging), FT-5219 (Bun.SQL scale-to-zero)
