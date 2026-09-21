# S2+S3 — datahub port: skeleton + cron

One slice, two repos. Runs the plan's S2 (port skeleton) and S3 (datahub
consumes cron) together — cron shipped in
[#45](https://github.com/prisma/composer/pull/45), so nothing separates them
anymore. S4 (live deploy + cutover) is explicitly out: it needs the team's real
secrets and workspace credentials. Linear: TML-3012.

This spec is the record of the slice as executed, which predates the Composer
rename (ADR-0026's package/CLI surface was still `@prisma/app*` /
`prisma-app`) and ADR-0029 (secrets were still a param facet). Names below are
the ones the slice actually used.

Branches: `claude/prisma-app-port` in **datahub** (the port);
`claude/datahub-port` in this repo (framework fixes + these artifacts,
based on #45's branch).

## What datahub is (verified against source)

- **`apps/ingest`** — Bun + Hono service. POST endpoints per sync source
  (Stripe customers/charges/products/prices/subscriptions/invoices, PostHog
  persons/events, aggregate refreshes) plus **`POST /tick`** = one budgeted
  step of every job (`tick.ts`; catch-up = more ticks; `DEFAULT_TICK_MS` =
  180_000). Today an in-process `setInterval` fires ticks when
  `TICK_INTERVAL_MS > 0`. Config surface (`env.ts`, zod): `DATABASE_URL`,
  `STRIPE_API_KEY`*, `POSTHOG_HOST`, `POSTHOG_PROJECT_ID`, `POSTHOG_API_KEY`*,
  `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`*,
  `CLICKHOUSE_DATABASE`, `INGEST_POSTHOG_EVENTS` (string → string[] transform),
  `PORT`, `TICK_INTERVAL_MS`. (* = secret.)
- **`apps/web`** — Next.js 16 dashboard, reads postgres through
  `@workspace/db` in `lib/queries.ts`.
- **`packages/db`** — prisma/orm client (`@prisma-next/postgres` + contract
  files) over a hand-built `pg` Pool (custom idle-error listener for Compute
  sleep/resume), **module-global**, reads `process.env.DATABASE_URL` at import.
- Current deploy: `prisma.compute.ts` (`@prisma/compute-sdk`), env from
  per-app `.env` files.

## Decisions of record

1. **One schedule job.** datahub's tick model is already "one endpoint, one
   budgeted step of everything", so the cron schedule is
   `defineSchedule({ tick: '180s' })` and the trigger handler calls `tick()`.
   Do NOT explode `INGEST_JOBS` into per-source cron jobs — budgets and
   ordering live inside `tick.ts` on purpose.
2. **Ingest IS the cron router.** Ingest exposes
   `{ trigger: triggerContract }` and mounts `serveSchedule`'s fetch handler
   on its Hono app (route `POST /rpc/trigger` to it). No separate router
   service — the scheduler is the only added instance. Composition:

   ```ts
   // system.ts (datahub root)
   export default system('datahub', {}, ({ provision }) => {
     const db = provision('database', rawPostgres({ name: 'database' }));
     provision('cron', cron('cron', { schedule, router: ingestService }), { db });
     provision('web', webService, { db });
     return {};
   });
   ```

   Ingest lives at address `cron.router`; its deps (`db`) forward through the
   cron system's boundary (proven by the cron package's Load test).
3. **Secrets are `secret` params, values sourced from the deployer's env.**
   `system.ts`/`service.ts` load on the deployer's machine, so a helper
   (`fromEnv('STRIPE_API_KEY')`) supplies each secret/scalar param's `default`
   from `process.env` at deploy-load. This replaces the `.env`-file mechanism.
   The framework redacts secret defaults in `configOf`. A first-class
   deploy-values mechanism stays deferred (this is the plan's S1 resolution —
   the config-params project absorbed the rest of S1's need; ADR-0029 later
   replaced secret params with the first-class slot).
4. **Params keep datahub's zod schemas.** zod ≥3.24 implements Standard
   Schema, and params take any Standard Schema — port `env.ts`'s field schemas
   onto the params (including the `INGEST_POSTHOG_EVENTS` transform). This
   deliberately exercises a second schema vendor through the config pipeline.
5. **`DATABASE_URL` is bridged from `load()`, not passthrough.** The deployed
   instance only receives stashed config keys — nothing sets `DATABASE_URL`.
   The module-global `@workspace/db` client stays (minimal diff); each
   service's entry does `process.env.DATABASE_URL = service.load().db.url`
   **before** any module that imports `@workspace/db` loads (ingest: entry
   sets it, then dynamic-imports the app; web: `instrumentation.ts` or
   equivalent — implementer grounds which runs first in Next 16 standalone).
   Converting `@workspace/db` to `postgres` (ADR-0022) is the deep port —
   record it as follow-up evidence, do not do it in this slice.
6. **Framework packages via pkg.pr.new previews of
   [#45](https://github.com/prisma/composer/pull/45)** (the owner/repo-scoped
   URL form; verified resolvable). The branch is a coherent snapshot. If the
   port needs a framework fix that lands on `claude/datahub-port`, open a PR
   for that branch and switch to its preview URLs.

## Scope (datahub branch)

- Root: `system.ts`, the app config (prismaCloud + nodeBuild + nextjsBuild +
  state, mirroring storefront-auth's), root `package.json` deploy/destroy
  scripts, framework deps.
- `apps/ingest`: `service.ts` (compute: deps `{ db: rawPostgres() }`, params per
  env.ts with zod schemas + secret facets, expose `{ trigger }`, node build
  adapter); entry refactor (config from `service.config()`, DATABASE_URL
  bridge, serveSchedule mounted, in-process `setInterval` scheduler and
  `TICK_INTERVAL_MS` **deleted** — the cron system is the clock now); delete
  `env.ts` in favor of params (keep zod field schemas).
- `apps/web`: `service.ts` (compute: deps `{ db }`, nextjs build adapter);
  DATABASE_URL bridge.
- Remove `prisma.compute.ts` + `@prisma/compute-sdk` usage for deploy
  (runtime `@prisma/compute` KeepAwakeGuard **stays** — it is a platform
  runtime API, orthogonal to the deploy path).

## Definition of done

- [x] `Load(system)` test green in datahub: graph contains `database`,
      `cron.router`, `cron.scheduler`, `web`; edges `database→cron.router`,
      `database→web`, `cron.router→cron.scheduler`.
- [x] Ingest's entry boots via `bootstrapService` with a supplied Config
      (fake values): `/health` responds; `POST /rpc/trigger {jobId:'tick'}`
      reaches the tick handler (tick's own DB work may be stubbed or may fail
      cleanly past the dispatch point — the assertion is dispatch, not sync).
- [x] Every param from `env.ts` is declared on the service with the right
      secret/optional/default facets; no `.env`-file reads remain in the
      deploy path; secret values come only from the deployer's env.
- [x] `bun install` resolves the preview packages; datahub `typecheck` and
      `build` green; no `@prisma/compute-sdk` deploy config remains.
- [x] The in-process tick scheduler is gone; the only clock is
      `cron.scheduler`.
- [x] Follow-up evidence recorded in the project plan (postgres conversion,
      module-global-client pattern, deploy-values mechanism).

## Non-goals

- **Live deploy / cutover (S4)** — needs team secrets + workspace creds.
- **postgres conversion of `@workspace/db`** — recorded follow-up.
- **ClickHouse/PostHog/Stripe as framework resources** — they are external
  SaaS; params suffice.
- **open-chat / M2.**
