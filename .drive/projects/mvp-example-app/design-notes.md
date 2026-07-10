# Design notes — MVP example app

Project-level design record. The canonical model lives in
[`docs/design/`](../../../docs/design/); this file records only the decisions
specific to standing up the deployable MVP.

## Principles inherited

From [`docs/design/01-principles/`](../../../docs/design/01-principles/): don't
reinvent the wheel (build on Alchemy), no globals (inject typed config), code is
the source of truth, everything reproducible in a fresh environment.

## The model this exercises

Two **Systems** (Storefront, Auth), each a **Service** (its code) plus a **Resource**
(its own Postgres). No shared data. See
[`docs/design/03-domain-model/`](../../../docs/design/03-domain-model/) for
Service/Resource/Configuration and the layering that this project instantiates
against real Prisma Cloud primitives.

## Key decisions

- **Own v2/Effect Alchemy providers, not the v1 ones.** Prisma ships a v1 (async)
  Postgres provider; our design is built on Alchemy v2 (Effect). We wrote our own
  v2 Postgres provider (Project/Database/Connection) and will write the Compute
  provider the same way. Rationale in the session; the v1 path was rejected.
- **Wrap the official SDK.** Providers call `@prisma/management-api-sdk`
  (`createManagementApiClient({ token })`) rather than hand-rolling REST/OAuth.
  Auth is a `PRISMA_SERVICE_TOKEN` resolved from env via a `PrismaCredentials`
  service (no full `alchemy login` flow for the MVP).
- **Compute has no upstream Alchemy provider — we build one.** Confirmed via the
  SDK types and ignite. The lifecycle is: create deployment (returns
  `foundryVersionId` + `uploadUrl`) → PUT the tar.gz to `uploadUrl` → start the
  version → promote the service. `skipCodeUpload` reuses an existing build.
- **The Compute provider consumes a *prebuilt* artifact.** It takes a path to the
  tar.gz + the `{ manifestVersion, entrypoint }` manifest as input. This decouples
  the provider's control flow from *how* the bundle is produced, so bundling can be
  solved separately at the app build-step slice.
- **One Postgres per System.** Simplest correct thing; sidesteps aggregate contracts,
  which are out of scope for the MVP.

## Alternatives considered

- **Deploy Compute via the Prisma CLI (`prisma compute deploy`) and use Alchemy
  only for Postgres.** Faster to a first deploy, but leaves half the system outside
  Alchemy and doesn't surface the seam the Prisma App Framework must close. Rejected in favour of
  an all-Alchemy path (operator's call).
- **Use the v1 Postgres provider.** Rejected — see above.

## Slice 1 findings (Compute Management API)

- **The deploy payload carries no manifest and no env.** Create-version takes only
  `{ portMapping?, skipCodeUpload? }`. So the `{ manifestVersion, entrypoint }`
  manifest rides *inside* the tar.gz artifact (a bundling concern for Slices 2–3),
  and **env vars are a separate branch-scoped resource** (`/v1/environment-variables`),
  not part of deploy. Wiring a Postgres connection string into a service is
  therefore its own step in Slice 4 (an EnvironmentVariable resource/call), not a
  `Deployment` prop.
- **Deploy sequence:** create version → PUT tar.gz to `uploadUrl` → start →
  promote. Version identity is the version's `id` (not `foundryVersionId`).
- Modelled as **two resources**: `ComputeService` (stable identity) + `Deployment`
  (one deploy). `Deployment.delete` is a no-op (versions are torn down with the
  service).
- **Compute artifact format (ignite Terminal ADRs 0003/0005/0008).** The artifact
  is a `.tar.gz` of a **client-side Bun bundle** + `compute.manifest.json`.
  `prisma compute deploy` runs `Bun.build({ entrypoints, target: "bun", sourcemap:
  "external" })` → one JS file (+ maps), writes the manifest
  (`{ manifestVersion: "1", entrypoint: "<bundled JS>" }`, pointing at the *bundled*
  output), tars it, uploads to the presigned `uploadUrl`. The VM init (Spark) runs
  `bun <entrypoint>`; `node_modules` must be installed before bundling (the CLI
  doesn't `bun install`). Build step = **Bun.build → write manifest → tar.gz**. Auth
  (Bun/Hono) uses this directly; the Storefront uses `next build` standalone output
  with the manifest pointing at Next's `server.js`.

## Validated end-to-end (Postgres)

The Postgres provider is **proven against real Prisma Cloud** via `examples/smoke`.
`alchemy deploy` creates project → database → connection; a re-deploy is a project
**noop** (idempotent `read`); `alchemy destroy` removes all three in reverse order.
Auth = a workspace **service token** (Console → Settings → Service Tokens) in a
gitignored `.env`, sourced into the process env before the CLI — `--env-file`
doesn't populate `process.env`, which the stack reads directly.

## Validated end-to-end (Compute)

The Compute provider is **proven against real Prisma Cloud** via the same
`examples/smoke` stack. `alchemy deploy` runs the full sequence — create version →
PUT the tar.gz → start → poll until `running` → promote — and the deployed app
then serves live HTTP: `curl <endpoint>` returns `hello from prisma compute` (200).
`alchemy destroy` tears down service + version with the project.

Three things this surfaced, now fixed in the provider / app:

- **The serving domain resolves late.** A ComputeService's create-time
  `serviceEndpointDomain` is a placeholder region (we saw `.cdg.`); the live URL
  (`.ewr.`, us-east-1) only resolves once a version is promoted and running. The
  `Deployment` re-reads the service *after* promote and returns that as
  `deployedUrl`; the stack surfaces this, not the ComputeService attribute.
- **Port must be wired end to end.** `Deployment` takes a `port` prop that sets the
  version's `portMapping.http`; the app binds the same port (`PORT` env, default
  3000). Without `portMapping.http` the endpoint has no route and 404s.
- **Use an explicit `Bun.serve()`.** A default-export server
  (`export default { port, fetch }`) does not reliably auto-start from a *bundled*
  entrypoint run as `bun index.js`; call `Bun.serve()` directly (matches ignite-bot).

## Compute skill findings (Slice 3 prep)

Prisma ships its Compute deploy knowledge as the `prisma-compute` agent skill
(`npx @prisma/cli agent install`, installed globally for this agent). What it
changes for us:

- **Next.js build — what actually worked (Slice 3).** The artifact is `next build`
  with `output: "standalone"`; `scripts/bundle-next.ts` copies in the static assets,
  writes the Compute manifest (entrypoint = the standalone `server.js`), and tars it
  for our `Deployment` to upload. Two traps hit and solved:
  1. **pnpm hides Next's peers.** The isolated layout puts `styled-jsx` under `.pnpm`,
     and the flattened standalone `next` copy can't resolve it → the server crashes at
     boot (`Cannot find module 'styled-jsx/package.json'`). Fixed with a repo `.npmrc`
     `node-linker=hoisted`, which yields a flat, self-contained standalone.
  2. **`app build --build-type nextjs` is a dead end here.** Under isolated pnpm it
     emits the crashing artifact; under hoisted it can't run `next build` (no
     per-package node_modules). So we invoke `next build` directly, not `app build`.
     `@prisma/compute-sdk`'s `NextjsBuild`/`PreBuilt` strategies likely hit the same
     pnpm issue.
- **`verify-public-url` is the PRO-200 gotcha, upstream.** The skill's own rule says
  to fetch the real public deployment URL after deploy rather than trust a
  readiness/create-time value — the same trap we hit and filed.
- **Runtime rules match what we did:** bind `0.0.0.0` (Bun.serve default), listen on
  `process.env.PORT` (deploy default port 3000 / `--http-port`).
- **Env vars resolve from the app's attached Branch**, not the deploy payload
  (confirms the Slice 1 finding); the auto-injected `DATABASE_URL` we saw is the
  default branch/database attachment.
- **Route naming:** the blessed low-level routes are `/v1/apps` + `/v1/deployments`;
  our provider uses the `/v1/compute-services/*` compatibility aliases. They work
  (proven end-to-end), but a future cleanup could move to the App/Deployment routes.

## Validated end-to-end (two-system MVP)

The full MVP is **live on real Prisma Cloud** via `examples/storefront-auth`: two
Systems, each its own Prisma **project** (a Service + the project's default Postgres,
auto-injected as `DATABASE_URL`), wired by an `AUTH_URL` `EnvironmentVariable` so
the Storefront calls Auth while rendering.

- `alchemy deploy` provisions 2×(Project → ComputeService → Deployment) + the
  `AUTH_URL` env var; re-deploy is **all noop** (idempotent); `alchemy destroy`
  tears both Systems down.
- Proof: `curl <auth>/verify` → `200 {"ok":true}` (Auth + its Postgres); the
  Storefront page renders `Auth /verify says: 200 {"ok":true}` — the Storefront→Auth
  ingress round-trip.
- **One project per System** is the clean mapping: each System gets its own Postgres for
  free (the project's default DB), and only the cross-system `AUTH_URL` needs an explicit
  env var. Two Systems in one project would fight the per-project default-DB injection.
- **Next server components must be forced dynamic.** `export const dynamic =
  "force-dynamic"` — otherwise Next prerenders the page at build time (when `AUTH_URL`
  is unset) and serves that static HTML forever, so the runtime env is never read. A
  `cache: "no-store"` fetch alone does **not** force the route dynamic in Next 15.
- **Auth's DB access must be crash-resilient.** Prisma Postgres closes idle direct
  connections (and the service scales to zero); Bun.SQL surfaces that as an async
  `ERR_POSTGRES_CONNECTION_CLOSED` with no awaiter, which crashed the process into a
  502 restart loop (symptom: the Storefront rendered "Auth /verify says: 500/502").
  Fix in `systems/auth`: `process.on("uncaughtException"/"unhandledRejection")` guards +
  a short `idleTimeout` (close client-side before the server does) + `max: 1`, and
  handlers that catch the query error (503, not crash). Verified across idle/reconnect
  cycles. Keep the **direct** connection (`DATABASE_URL`) — pooled/accelerate are
  legacy per the prisma-postgres skill.

## Open questions

- Direct vs pooled connection string from the Connection resource (currently using
  the connection's top-level `url`).
- Next.js → Compute artifact (Slice 3). **Done and proven live** — `next build`
  standalone + `node-linker=hoisted` + `bundle-next.ts`; see the Slice 3 note under
  "Compute skill findings". The Storefront serves 200 on Compute via our provider.

## Slice 4 wiring notes

- **A project auto-provisions a default database.** Creating a `Database` with
  `isDefault: true` fails with "Default database already exists" — connect to the
  project's default DB, or create a non-default named one (the smoke does the latter).
- **Env injection — partly automatic.** Compute auto-injects `DATABASE_URL` and
  `DATABASE_URL_POOLED` for the project's **default** database (observed on the
  running version's `envVars`). A service that uses the default DB needs no manual
  wiring; a second/non-default DB still needs a branch-scoped env-var resource
  (`/v1/environment-variables`) set before the `Deployment`. Confirm the exact
  behaviour per-System in Slice 4; the Auth service fails fast if its URL is unset.
- **Port coordination — resolved.** `Deployment` takes a `port` prop that sets the
  version's `portMapping.http`; the app binds the same port (`PORT` env, default
  3000). Wire both from one source per System in Slice 4.

## References

- [`spec.md`](./spec.md)
- [`packages/prisma-alchemy`](../../../packages/prisma-alchemy) — commit `64e530f`.
- `ignite/docs/portal/technology/prisma-compute/architecture.md`.
