# Prisma dogfood report — rough edges building the MakerKit MVP

Friction hit while building a two-hex example (**Storefront** = Next.js, **Auth** =
Bun/Hono), each with its own Prisma Postgres, deployed to **Prisma Compute** through a
**custom v2 (Effect) Alchemy provider** that wraps the **Management API SDK**. pnpm
workspace, Bun runtime.

Environment: `@prisma/cli` (latest via bunx), `@prisma/management-api-sdk@1.47.0`,
`alchemy@2.0.0-beta.59`, `effect@4.0.0-beta.92`, Next 15.5.19, pnpm 10.27.0, bun 1.3.13.

Already filed: [PRO-200], [PRO-201] (Compute Gotchas). Everything else below is
unfiled — flagged inline.

**The three that cost the most time**

1. Compute's create-time `serviceEndpointDomain` is a wrong-region placeholder that
   silently 404s (PRO-200) — three green deploys chasing a dead URL.
2. `app build --build-type nextjs` has no working configuration under pnpm (PRO-201).
3. Prisma Postgres closing an idle direct connection crash-loops a naive Bun.SQL app
   on Compute (502 loop) with no obvious cause.

---

## Prisma Compute

- **[PRO-200] `serviceEndpointDomain` from create is a placeholder region that 404s.**
  `POST /v1/projects/{id}/compute-services` (created in `us-east-1`) returns a domain on
  `.cdg.` that never serves. The real domain (`.ewr.`) only resolves after a version is
  promoted and running — you must re-`GET` the service. No error anywhere; a permanent
  404 while status/portMapping/env all look healthy. **Blocker.**

- **`status: "running"` doesn't mean the app is serving.** After `start`, the version
  reports `running` — but that only means the VM/process launched, not that an HTTP
  listener is up on the mapped port. A crash-at-boot app (see PRO-201, or the PPg crash
  loop below) still shows `running` while the endpoint 404s/502s. Readiness should track
  a healthy listener. This made every failure look like a routing problem. **Major.**

- **`portMapping.http` is mandatory or the endpoint is a silent 404.** Create-version
  with an empty `portMapping` produces a service with no HTTP route → 404, no error. The
  shape (`{ http: 3000 }`) is in Terminal ADR 0006, but that omitting it dead-ends isn't
  called out. **Major.**

- **[PRO-201] `app build --build-type nextjs` yields a boot-crashing standalone under
  pnpm, with no working config.** Isolated pnpm → the standalone crashes at boot
  (`Cannot find module 'styled-jsx/package.json'`); switching to `node-linker=hoisted`
  fixes the artifact but then `app build` itself can't run (`next build` can't resolve
  `next` — no per-package node_modules). Escape: run `next build` directly and package
  the standalone yourself. **Blocker.**

- **`app build` emits a staging directory, not a deployable artifact.** `app build --json`
  returns `{ directory, entrypoint }` (a temp dir); the Compute artifact format (`.tar.gz`
  with `compute.manifest.json` at the root) is produced by `app deploy`, not `app build`.
  Consuming `app build` output for a custom deploy means re-implementing the tar+manifest
  wrapping. **Minor / mental-model.**

- **Cold start returns a hard 502, not a held request.** Scale-to-zero: the first request
  after idle returns `502` (openresty) for ~15s while the VM wakes, then 200. A caller
  (e.g. another hex) sees a hard 5xx, not a slow 200 — cross-service calls must retry.
  Expected, but surprising and undocumented at the call site. **Minor.**

- **Logs are WebSocket-only.** `GET /v1/compute-services/versions/{id}/logs` → `426
  Expected WebSocket upgrade`. `app logs` streams/follows with no bounded "tail N and
  exit", so scripting a crash post-mortem meant piping `app logs` through `head` and
  killing it. A one-shot `--tail N --no-follow` (or a plain GET) would help agents. **Minor.**

- **Two different 404 bodies, neither diagnostic.** Wrong-region domain → `Not Found`
  (edge); promoted-but-unrouted/crashed → `There is no service on this URL`. Neither
  distinguishes "wrong URL" from "not deployed yet" from "app is down". **Minor.**

## Prisma Postgres

- **Idle direct connections are closed → a naive persistent client crash-loops on
  Compute.** Prisma Postgres closes idle **direct** connections (and Compute scales to
  zero). A long-lived native client (`Bun.SQL`) surfaces that as an *async*
  `ERR_POSTGRES_CONNECTION_CLOSED` with no awaiter, which crashes the process → 502
  restart loop on Compute. The recommended connection is direct (pooled/accelerate are
  legacy per the `prisma-postgres` skill), but direct isn't resilient to idle without
  client-side `idleTimeout` + reconnection + process guards. A "hello world" Bun + PPg
  app on Compute crash-loops the moment it goes idle. **Major — filed [FT-5219].**

- **A project auto-provisions a default database.** Creating a `Database` with
  `isDefault: true` then fails with `"Default database already exists"`. Not obvious the
  project already has one. **Minor — filed [FT-5220].**

- **`DATABASE_URL` (+ `DATABASE_URL_POOLED`) is auto-injected from the project's default
  DB.** Compute services get these env vars automatically from the project's default
  database — discovered only by inspecting a running version's `envVars`. Handy ("one
  project per service" → each gets its own DB for free), but it means "two services,
  separate DBs, one project" fights the injection, and it's not surfaced in the deploy
  flow. **Minor / discoverability.**

## @prisma/cli

- **`agent install` defaults to an invalid agent id and hides the error.** `@prisma/cli
  agent install` (or `--agent claude`) fails with `AGENT_SKILLS_INSTALL_FAILED — skills
  installer exited with code 1` and no cause. The underlying `skills` CLI rejects
  `claude`; the valid id is `claude-code`. Had to run the suggested `pnpm dlx skills@latest
  add prisma/skills --agent claude-code` directly to see `Invalid agents: claude`. The
  wrapper should pass the correct agent id (or surface the validation list). **Major.**

- **`app build` can't run under a hoisted pnpm layout.** No per-package node_modules → its
  spawned `next build` can't resolve `next`. Combined with the isolated-pnpm crash, this
  is the "no working config" half of PRO-201. **Major.**

- **`app build --json` stdout capture is fragile when nested.** Run directly it emits one
  clean JSON object (bunx's resolution noise goes to stderr). Nested inside another
  process's shell (Bun's `$`), the JSON was intermittently dropped — only `spawnSync`
  with explicit pipe capture was reliable. Partly a Bun/shell issue, but `--json` output
  mixing with tool preamble is easy to trip on. **Minor.**

- **`app logs` has no bounded tail** (see Compute → Logs). **Minor.**

## Management API / SDK

- **Route namespace split: `compute-services` vs `apps`/`deployments`.** The shipped SDK
  types expose `/v1/compute-services/*`, but the docs say the canonical low-level routes
  are `/v1/apps` + `/v1/deployments` and to "prefer App/Deployment naming in new
  automation". The SDK leads you to the alias set; it's unclear which is canonical or
  whether the aliases are deprecated. **Minor.**

- **Env-var value is write-only, so reconcilers can't diff.** `POST /v1/environment-
  variables` returns metadata but not the value (encrypted); `GET` never returns it. An
  idempotent tool can't read-compare to decide whether to update, and a duplicate key
  `POST` 409s (must `PATCH`). **Minor.**

- **`create-project` path mismatch.** Docs/README implied `POST /v1/workspaces/{id}/
  projects`; the SDK only has `POST /v1/projects` with body `{ name, workspaceId }`. **Minor.**

- **Version identity is `id`, not `foundryVersionId`.** Both fields are present on a
  version; subsequent calls need `id`. Easy to grab the wrong one. **Minor.**

- **Responses are enveloped in `{ data: ... }`.** Consistent but easy to miss on first
  use. **Minor.**

- **Env-var endpoints are marked experimental** ("⚠️ may change at any time"), yet they're
  the only way to wire cross-service config. **Minor.**

- **Service-token discovery + naming.** Where to mint a `PRISMA_SERVICE_TOKEN` (Console →
  workspace **Settings → Service Tokens**) isn't obvious, and the name differs by surface
  (`PRISMA_SERVICE_TOKEN` for the CLI; the SDK just takes `token`; some docs show
  `PRISMA_API_TOKEN`). **Minor.**

- **Logs endpoint is WS-only (426 on GET)** (see Compute). **Minor.**

## Alchemy (v2)

- **Prop-only diffing misses prebuilt-artifact content changes.** The default reconcile
  diffs props; a `Deployment` whose `artifactPath` is stable but whose *file contents*
  changed diffs as a **noop** → the new build never ships. Had to add an `artifactHash`
  prop so a rebuild registers as a change. Any "deploy a prebuilt file" resource needs a
  content hash; not obvious and silently wrong. **Major (design trap).**

- **Effect v4 removed `Context.Tag`.** Use `Context.Service<Self, Shape>()("Id")`; older
  tag examples don't compile. **Minor.**

- **A provider must define a `list` hook.** Omitting it fails even for a resource that has
  nothing to list (`list: () => Effect.succeed([])`). **Minor.**

- **A Stack needs an explicit state store.** Must pass `state: localState()` (from
  `alchemy/State/LocalState`) or it errors. **Minor.**

- **CLI peer deps at an inconsistent tag.** The alchemy CLI needs `@effect/platform-node`
  + `@effect/platform-node-shared` at the **`beta`** tag (not `next`; `@effect/platform`
  has no `beta`) — took trial-and-error to align with `effect@4.0.0-beta.92`. **Minor.**

- **`--env-file` doesn't populate `process.env`.** The stack reads `process.env`
  directly, but `alchemy deploy --env-file` doesn't load it → must `set -a; . .env`
  before the CLI. **Minor.**

- **Under hoisted pnpm the `alchemy` bin isn't in the package's `node_modules/.bin`.** It
  hoists to the workspace root; use `pnpm exec alchemy`, not `./node_modules/.bin/alchemy`.
  **Minor.**

## Ecosystem interactions (Next.js / pnpm / Bun)

These are upstream, but they surface specifically because of how Compute/PPg are consumed.

- **Next standalone + pnpm hides `styled-jsx` (root of PRO-201).** Isolated pnpm keeps
  Next's peers under `.pnpm/`; the flattened standalone `next` copy can't resolve them →
  boot crash under both `bun` and `node`. Fix: `.npmrc` `node-linker=hoisted`. **Blocker.**

- **Next 15: `cache: "no-store"` does not force the route dynamic.** The page was still
  prerendered as static at build time (when the runtime env was unset) and served forever
  — the runtime-injected `AUTH_URL` was never read. Need `export const dynamic =
  "force-dynamic"`. This directly defeats runtime env wiring on Compute. **Major — filed [PRO-202].**

- **Next standalone omits static assets + `public/`.** Must copy `.next/static` and
  `public` into the standalone tree yourself (`app build` does this; `next build` alone
  doesn't). **Minor.**

- **React caret drift.** `^19.2.0` resolved `react`→19.2.4 and `react-dom`→19.2.7 → Next
  `Incompatible React versions`. Pin exact. **Minor.**

- **Next `outputFileTracingRoot` mispicks the root in a monorepo.** Multiple lockfiles →
  Next traces from the outer checkout. Set `outputFileTracingRoot` explicitly. **Minor.**

- **Bun `$` + nested `bunx` drops stdout intermittently** (see CLI). **Minor.**

---

## Severity summary

| Product | Blocker | Major | Minor |
| --- | --- | --- | --- |
| Compute | PRO-200 endpoint domain; PRO-201 app-build/nextjs | `running` ≠ serving; portMapping mandatory | app-build dir; cold-start 502; WS logs; 404 bodies |
| Prisma Postgres | — | idle-close crash loop | default-DB 409; auto-injected DATABASE_URL |
| @prisma/cli | — | agent-install wrong id + hidden error; app-build under hoisted | fragile --json capture; unbounded app logs |
| Management API/SDK | — | — | route namespace split; write-only env value; create-project path; version id; envelope; experimental; token discovery |
| Alchemy (v2) | — | prop-only diffing misses artifact changes | Context.Tag; list hook; state store; peer-dep tags; --env-file; hoisted bin |
| Next/pnpm/Bun | Next+pnpm standalone | no-store not dynamic | static copy; React drift; tracing root |

## Filed tickets

- [PRO-200] — `compute-services` create returns a placeholder-region `serviceEndpointDomain` that 404s until a version is promoted.
- [PRO-201] — `app build --build-type nextjs` yields a boot-crashing standalone for pnpm projects.
- [FT-5219] — idle direct-connection close crashes a persistent Bun.SQL client into a 502 loop on scale-to-zero Compute (PPg gotchas).
- [PRO-202] — Next.js on Compute ignores runtime env vars unless the route is force-dynamic (Compute gotchas).
- [FT-5220] — creating a database with `isDefault: true` fails because a project auto-provisions a default database (PPg gotchas).

[PRO-200]: https://linear.app/prisma-company/issue/PRO-200/compute-services-create-returns-a-placeholder-region
[PRO-201]: https://linear.app/prisma-company/issue/PRO-201/app-build-build-type-nextjs-yields-a-boot-crashing-standalone-for-pnpm
[FT-5219]: https://linear.app/prisma-company/issue/FT-5219/idle-direct-connection-close-crashes-a-persistent-bunsql-client-into-a
[PRO-202]: https://linear.app/prisma-company/issue/PRO-202/nextjs-on-compute-ignores-runtime-env-vars-unless-the-route-is-force
[FT-5220]: https://linear.app/prisma-company/issue/FT-5220/creating-a-database-with-isdefaulttrue-fails-a-project-already-auto
