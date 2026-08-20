# Purpose

Stop maintaining Composer's own Alchemy resources for Prisma Cloud. The official
`alchemy/Prisma` provider (alchemy-run/alchemy, PR #416) now covers the same
Management API surface with a more hardened deployment lifecycle, and it is
written by our own colleague. Every line of API-wrapper code we keep is drift
risk against the Management API and duplicated effort against upstream. After
this project, Composer consumes upstream for everything that is genuinely about
Prisma Cloud, contributes the pieces upstream lacks that are generic, and keeps
locally only what encodes Composer concepts.

A second aim: keep Composer's **local dev emulation** iterating on our own
timeline. The emulators stay in Composer, driving upstream's live providers and
our emulator providers through the same provider-layer substitution seam we use
today — explicitly *not* blocked on upstream's dev-mode design (Sam's
`ProviderLayer.dual`, #963) settling.

# At a glance

Four workstreams:

1. **Adopt** — replace Composer's six overlapping resources (`Project`,
   `Database`, `Connection`, `ComputeService`, `Deployment`,
   `EnvironmentVariable`, ~670 lines in
   `packages/1-prisma-cloud/0-lowering/lowering/src/`) with upstream's resource
   classes and live providers. Requires the alchemy bump beta.59 → beta.66+
   (the provider ships inside the `alchemy` package; beta.59 has no `Prisma/`
   directory).
2. **Port** — rewire Composer to upstream's shapes: descriptor call sites to
   upstream prop/attribute names; state rows migrated off the five colliding
   type-ids; our provider collection tag renamed (upstream also uses
   `'Prisma'`, and Effect context merge silently drops one of two same-key
   collections); auth via `Layer.succeed(PrismaEnvironment, …)` instead of
   `fromProfile()` (which prompts on TTY / hard-fails non-interactive);
   `directConnectionString` bound explicitly (upstream's `databaseUrl` resolves
   pooled-first); platform-seeded `DATABASE_URL` kept out of the resource graph
   (verified `isManagedBySystem: true`); branch attachment via
   create-then-PATCH (verified in PDP: create+attach are separate transactions,
   no idempotency key).
3. **Contribute upstream** — object storage resources (~161 lines; upstream
   deferred exactly the routes we call) and the generic core of the Postgres
   state store (~450 lines; only alchemy state backend with distributed
   locking, which upstream's own `Compute` docstring asks users to find).
   `PgWarm` offered to upstream; drop ours if they solve cold-start in
   `Database`/`Connection`.
4. **Keep local** — the dev emulators (~3,200 lines + s3-protocol) and the five
   Composer-concept resources (`ServiceKey`, `GeneratedParam`, `S3Credentials`,
   `PnMigration`, state-store policy layer). Emulators plug in behind
   `LowerOptions.providers` exactly as today, now paired with upstream's live
   providers.

Aman has agreed to the direction (call, 2026-08-03). The one upstream ask that
gates workstream 1+4 composition: export `liveProviderLayer()` (or an
equivalent override on `providers()`) so Composer can compose upstream live
providers with its own local providers — today it is private and only
`providers()` (which hardwires dev-vs-live selection internally) is exported.

# Non-goals

- **Contributing the emulators upstream.** Explicitly reversed from the
  original proposal: they stay in Composer so we iterate without upstream
  review latency. Revisit only after upstream's dev-mode design (dual) settles.
- **Adopting `ProviderLayer.dual` / upstream dev mode.** Composer keeps its
  layer-swap seam and split state universes (localState for dev, hosted store
  for deploy). Dual solves a problem we don't have yet.
- **Adopting upstream's `Prisma.Compute` build/bundle conveniences.** We hand
  upstream pre-built artifacts via `artifactPath` only (ADR-0005: the framework
  never bundles/transforms user code). Auto-build, framework detection, and
  Effect-native bundling are never exercised by Composer.
- **Adopting alchemy's profile/credential store.** Composer keeps env-var
  credentials (`PRISMA_SERVICE_TOKEN` via `Config.redacted`).
- **Deterministic database names with branch attachment in one create.**
  Upstream's guard is correct (verified against PDP); we adopt
  create-then-PATCH rather than asking for the guard to be relaxed.

# Place in the larger world

- Upstream: `alchemy-run/alchemy`, provider at `packages/alchemy/src/Prisma`
  (14.5k lines, merged 2026-07-29). Owner-of-record for merges is Sam Goodwin;
  Aman authored the Prisma provider. Contributions land there as PRs.
- Composer side: the lowering package
  (`packages/1-prisma-cloud/0-lowering/lowering`) shrinks to buckets (until
  upstreamed), state store, container resolution; the extension
  (`packages/1-prisma-cloud/1-extensions/target`) keeps descriptors + the five
  Composer-concept resources; `local-target` + `dev-emulators` unchanged in
  ownership, rewired to upstream resource shapes.
- The forcing-function-apps project consumes this: its object-storage and dev
  workstreams sit directly on the seams this project moves.

# Cross-cutting requirements

- **No regression for deployed stages.** Existing state rows reference the old
  type-ids and attribute shapes (`{id, name}` vs upstream's `databaseId`).
  Every stage must deploy cleanly across the migration without recreating live
  resources; destroy of pre-migration rows must still resolve a provider.
- **ADR-0005 holds everywhere.** Only `artifactPath` (or `Prisma.Deployment`'s
  equivalent) is ever exercised; no code path may fall through to upstream
  build/bundle/entrypoint inference.
- **Env parity rules survive the port.** ADR-0019/0029/0032 serialization, the
  `COMPOSER_*` namespace, and the poison-`DATABASE_URL` exclusion must behave
  identically on upstream `EnvironmentVariable`.
- **Local dev keeps working at every intermediate commit** — the emulator
  providers must bind to whichever resource classes are current.
- **Pinned upstream version.** Alchemy stays pinned exact (as today); each bump
  is a deliberate change with the beta-to-beta breaking-change review this
  project's spike established (beta.60–65 were all Cloudflare/AWS-scoped).

# Transitional-shape constraints

- Adoption is per-resource-family, not big-bang: postgres family
  (Project/Database/Connection) and compute family
  (App/Deployment/EnvironmentVariable) may land in separate slices, each
  leaving main deployable.
- Until the upstream `liveProviderLayer` export lands in a release, Composer
  may carry a small local reimplementation of upstream's provider wiring
  (client layer + individual `*Provider()` calls) — accepted drift risk,
  removed the moment the export ships.
- Bucket resources stay in Composer until the upstream contribution merges and
  releases; the s3/s3-store descriptors must tolerate either home.

# Project DoD

- [x] Composer's six overlapping resource implementations are deleted;
      lowering/descriptors consume `alchemy/Prisma` classes.
- [x] `alchemy` pinned at a released version ≥ the first beta containing the
      Prisma provider; CI green.
- [x] A pre-existing deployed stage (created before the migration) deploys and
      destroys cleanly on the new stack.
- [x] Local dev (`prisma-composer dev`) runs the full example topology on the
      emulators against upstream resource shapes.
- [x] Deployed smoke suite passes (storefront-auth or equivalent example) on
      Prisma Cloud.
- [x] Object-storage resources PR and state-store PR opened upstream (merge is
      not in our gift; opened + review-responsive is the bar).
- [x] The upstream ask (export `liveProviderLayer` or equivalent) is filed and
      either landed or worked around per the transitional constraint.
- [x] ADR recorded documenting the adoption and the revised local-dev seam (ADR-0048).

# Open questions

- ~~Compute vs App+Deployment~~ — resolved: the low-level `App`+`Deployment`
  pair, with Composer's own env dependency edge (`deployment-edge.ts`). The
  `COMPOSER_*_ORIGIN` self-edge needs the App before env rows, and composite
  `Compute` owns a build path ADR-0005 rules out (ADR-0048, design-notes.md).
- ~~State migration mechanics~~ — resolved: rows are rewritten on read in the
  hosted store (`state/legacy-resources.ts`), with type-id aliases so old rows
  resolve; no destroy-and-recreate (ADR-0048, design-notes.md).
- ~~Which released beta first contains the provider~~ — resolved:
  `alchemy@2.0.0-beta.67` is the adopted pin.

# References

- Session evaluation + notes for Aman: `wip/alchemy-prisma-provider-notes-for-aman.md`
- Memory: `alchemy-upstream-prisma-provider` (blockers now resolved by decisions above)
- Upstream provider: https://github.com/alchemy-run/alchemy/pull/416
- Engine dual-mode: https://github.com/alchemy-run/alchemy/pull/963
- Linear project: https://linear.app/prisma-company/project/alchemy-prisma-provider-adoption-79d1f6cc7bff
- ADR-0005 (no bundling), ADR-0019/0023/0024 (containers), ADR-0029/0032 (env
  serialization), ADR-0034 (hosted state), ADR-0041 (local dev pipeline)
