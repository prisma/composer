# Design notes — MVP example app

Project-level design record. The canonical model lives in
[`docs/design/`](../../../docs/design/); this file records only the decisions
specific to standing up the deployable MVP.

## Principles inherited

From [`docs/design/01-principles/`](../../../docs/design/01-principles/): don't
reinvent the wheel (build on Alchemy), no globals (inject typed config), code is
the source of truth, everything reproducible in a fresh environment.

## The model this exercises

Two **Hexes** (Storefront, Auth), each a **Service** (its code) plus a **Resource**
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
- **One Postgres per Hex.** Simplest correct thing; sidesteps aggregate contracts,
  which are out of scope for the MVP.

## Alternatives considered

- **Deploy Compute via the Prisma CLI (`prisma compute deploy`) and use Alchemy
  only for Postgres.** Faster to a first deploy, but leaves half the system outside
  Alchemy and doesn't surface the seam MakerKit must close. Rejected in favour of
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

- **Don't reinvent the Next.js build.** `@prisma/cli app build --build-type nextjs`
  produces a deployable artifact, and `@prisma/compute-sdk` exposes a `NextjsBuild`
  strategy (requires `output: "standalone"`, entrypoint `server.js`) plus
  `PreBuilt({ appPath, entrypoint })`. Slice 3 produces the Storefront artifact via
  Prisma's Next build, then deploys it through our Alchemy provider — which consumes
  a prebuilt artifact, exactly the seam we designed.
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

## Open questions

- Direct vs pooled connection string from the Connection resource (currently using
  the connection's top-level `url`).
- Next.js → Compute artifact (Slice 3). **Resolved approach:** use Prisma's own Next
  build (`app build --build-type nextjs`, or the SDK `NextjsBuild`) to produce the
  standalone artifact (entrypoint `server.js`); deploy it via our provider. Remaining
  unknown: the exact shape `app build` emits (tar.gz vs staged dir) and how it maps to
  our `Deployment` `artifactPath` — settle empirically against the real Storefront.

## Slice 4 wiring notes

- **A project auto-provisions a default database.** Creating a `Database` with
  `isDefault: true` fails with "Default database already exists" — connect to the
  project's default DB, or create a non-default named one (the smoke does the latter).
- **Env injection — partly automatic.** Compute auto-injects `DATABASE_URL` and
  `DATABASE_URL_POOLED` for the project's **default** database (observed on the
  running version's `envVars`). A service that uses the default DB needs no manual
  wiring; a second/non-default DB still needs a branch-scoped env-var resource
  (`/v1/environment-variables`) set before the `Deployment`. Confirm the exact
  behaviour per-Hex in Slice 4; the Auth service fails fast if its URL is unset.
- **Port coordination — resolved.** `Deployment` takes a `port` prop that sets the
  version's `portMapping.http`; the app binds the same port (`PORT` env, default
  3000). Wire both from one source per Hex in Slice 4.

## References

- [`spec.md`](./spec.md)
- [`packages/prisma-alchemy`](../../../packages/prisma-alchemy) — commit `64e530f`.
- `ignite/docs/portal/technology/prisma-compute/architecture.md`.
