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
- Workaround source: [`examples/storefront-auth/scripts/bundle-next.ts`](examples/storefront-auth/scripts/bundle-next.ts), [`.npmrc`](.npmrc)
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

**Symptom.** Deploying producer service + consumer service + an env var derived from the producer's URL in one apply: on a fresh deploy the consumer's first VM boots before the env var lands and serves "AUTH_URL not set". Minutes later it silently heals — a scale-to-zero recycle boots a replacement VM that reads the variable.

**Cause.** Two orchestration gaps (env-at-boot-only itself is normal): (1) no way to order "config exists" before a version's first start within a deploy — the env-var POST and the version start are independent and race; (2) changing a production env var does not restart/roll the running version, so a write that misses the boot stays invisible until an unrelated recycle or redeploy.

**Workaround.** After a fresh multi-service deploy, verify consumers; if a config-derived read is missing, wait out a scale-to-zero recycle or ship a redeploy (new artifact hash → fresh version boots with the variable). Structurally, an ordering edge into the version start is exactly what MakerKit's Connection primitive will express.

**Reproduction.**

1. One stack: service A; env var on service B's project whose value is A's deployed URL; service B.
2. Fresh deploy (no prior state). Curl B immediately → config-missing behavior.
3. Wait for scale-to-zero recycle (or redeploy B) → healed, no code change.

**References.**

- Upstream: [PRO-211](https://linear.app/prisma-company/issue/PRO-211/compute-fresh-deploys-race-env-var-creation-against-first-version)
- Race + edge analysis: [`examples/storefront-auth/alchemy.run.ts`](examples/storefront-auth/alchemy.run.ts) (the corrected ordering comment)
- Related: [`dogfood-report.md`](dogfood-report.md)
