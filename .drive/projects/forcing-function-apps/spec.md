# Purpose

Ground the Prisma App Framework's next capabilities in **real applications we
run ourselves**, so the high-value gaps — secrets, scheduled work, object
storage, streams, and the local dev loop — are discovered, shaped, and
prioritized by real pressure rather than speculation. A hypothetical example
exerts pressure once; an app the team depends on keeps exerting it.

The second, equally important aim: **prove the resource-substitution seam.**
Resources the platform doesn't offer yet (cron, object storage) are built as
*emulated resource Systems* composed from primitives Prisma Cloud already has
(compute + postgres). If a consuming app can later swap an emulated resource
for a native platform primitive without changing, the same seam carries
cross-platform resource portability — and the binding contracts we define
become the spec the platform team's native primitives should satisfy.

# At a glance

Two app ports, in pressure order, each pulling capabilities as it needs them:

1. **datahub** ([prisma/datahub](https://github.com/prisma/datahub)) — the
   team's internal data hub: an ingest service (Hono/bun), a Next.js
   dashboard, Postgres, a `POST /tick` endpoint that is literally waiting for
   a cron resource, and secrets (Stripe, PostHog, ClickHouse). Its topology is
   a strict subset of open-chat's needs: **two services + postgres + cron +
   secrets**. Low-risk, internal, in daily use — the first consumer of the
   secrets model and the emulated cron System.

2. **open-chat** ([prisma/open-chat](https://github.com/prisma/open-chat), live
   at oss.chat) — a public, local-first AI chat app: Bun server + separately
   deployable Prisma Streams service, Postgres, **R2 object storage** (the
   streams durable tier), Stripe webhooks, a monthly credit-drip job, and
   secrets (OpenRouter, Stripe, auth). Adds **streams** (a real Prisma
   primitive), **object storage**, and hard dev-loop pressure — the app is
   explicitly local-first, so developing it through the framework makes
   emulation gaps hurt immediately.

Capabilities built along the way (each pulled by an app need, never
speculatively):

- **Secrets as bindings** — both apps, day one.
- **Cron as an emulated resource System** — a scheduler (compute service +
  schedule state in postgres) that invokes target services through their
  existing http/rpc ports. First consumer: datahub's `/tick`.
- **Object storage as an emulated resource System** — a blob contract
  (put/get/delete/list) whose backing implementation (postgres-backed
  emulation, R2) is invisible to the consumer. First consumer: open-chat's
  streams durable tier / transcripts.
- **Streams as a resource** — Prisma Streams wired in as a resource type.
- **The local dev loop** — `prisma dev` runs the whole topology locally, with
  local stand-ins for each resource.

# Non-goals

- **A second deployment target pack** (Vercel, Supabase). Deferred: R2 as an
  object-storage backing already smuggles cross-platform in at the *resource*
  level without doubling the *target* surface. Revisit after this project.
- **Native platform primitives.** We do not build platform-side cron or object
  storage; we define the binding contracts and file them as platform asks.
- **Onboarding, scaffolding, or docs for external users.** We are the
  consumer.
- **Feature work on datahub or open-chat** beyond what the port itself
  requires. The apps' own behavior is the fixed point the port must preserve.
- **A bespoke scheduler/queue product.** The emulated cron is deliberately
  minimal — enough to satisfy the binding contract, not a durable-execution
  engine.

# Place in the larger world

- Builds on the merged core: `system()` / `provision()` (ADR-0014), bindings
  (ADR-0015), the Prisma Cloud pack, and the storefront-auth example
  ([`docs/design/10-domains/core-model.md`](../../../docs/design/10-domains/core-model.md)).
- **Depends on the in-flight system-composition work** (boundary ports,
  nesting, forwarding — branch `claude/system-composition`, ADR-0016/0017):
  a resource-as-System *is* a nested System exposing only a typed boundary.
  That seam is **owned by hex-composition**; this project consumes it (see
  plan.md § "What we consume from hex-composition"), and does not re-derive it.
- **Depends on the publishing setup** (PR #29): the ports live in their own
  repos and consume published `@prisma/app*` packages, which makes this
  project the first real consumer of the release pipeline.
- Consumes the platform: Prisma Compute, Prisma Postgres, Prisma Streams
  (`prisma/streams`). Platform friction feeds `gotchas.md` and the Linear
  gotchas projects, as before.
- Tracker: [Prisma App: Forcing-Function Apps](https://linear.app/prisma-company/project/prisma-app-forcing-function-apps-495e5a5c6a0d)
  (Terminal).

# Cross-cutting requirements

- **Pull, don't push.** Every capability slice is justified by a concrete need
  of the app currently being ported. No speculative surface area.
- **Contracts never leak the backing implementation.** A resource's binding
  contract is defined by what consumers need, not by what the emulation can
  do. The test: the emulated → native (or postgres → R2) swap must require
  zero changes in consuming apps. If the emulation forces a contract
  compromise (e.g. presigned URLs), the compromise is a recorded design
  decision, not an accident.
- **Emulated resources are Systems.** They are built with the framework's own
  composition primitives — internal services and state behind a typed
  boundary — not as special cases in core or the target pack.
- **Every binding contract doubles as a platform ask.** For each emulated
  resource, a written contract spec lands where the platform team can pick it
  up (Linear ticket in the project).
- **The apps stay alive.** datahub is in daily internal use and oss.chat is
  public; ports are incremental and each app remains deployable/runnable
  throughout. Production cutover only happens when the framework deployment
  is verified equivalent.
- **Friction is a deliverable.** Rough edges in the framework discovered by
  the ports are the project's primary output; they are recorded (gotchas.md
  pattern or design-notes) and either fixed in-flight or filed.

# Transitional-shape constraints

- Capability slices that need resource-as-System (cron, object storage) do not
  start until the system-composition branch lands on main. Secrets and the
  datahub port skeleton have no such dependency and can proceed first.
- Ports may begin against `workspace:`/preview versions of `@prisma/app*`, but
  the datahub port must end on published versions (that's part of its DoD).

# Project-DoD

- [ ] **datahub deploys via `prisma-app deploy`** from its own repo, consuming
      published `@prisma/app*` packages: ingest + web as services, postgres as
      a resource, secrets as bindings, and its `/tick` driven by the cron
      resource System. The team's real instance runs on this deployment.
- [ ] **open-chat deploys the same way**, with streams, object storage, cron,
      and secrets all consumed as framework resources.
- [ ] **The swap is demonstrated**: at least one resource (object storage or
      cron) has two interchangeable backings, and switching them requires no
      change to the consuming app.
- [ ] **Both apps run fully locally** via the framework's dev loop — every
      resource has a local stand-in; no cloud credentials required for local
      development.
- [ ] **Binding contracts for cron and object storage are filed as platform
      asks** on Linear, written so the platform team could implement native
      primitives against them.
- [ ] **ADRs recorded** for: the secrets model, the emulated-resource /
      resource-as-System seam, and the dev-loop architecture.

# Open questions

- **Where do ports live?** Default: in the `datahub` / `open-chat` repos
  themselves (real dogfood of publishing + external consumption). Alternative:
  staging forks. Decide at datahub slice-spec time with the repo owners.
- **oss.chat production cutover** — in scope or stretch? datahub's internal
  cutover is in-DoD; flipping the public oss.chat deployment is a judgment
  call at the time.
- **Prisma Streams integration shape** — `@prisma/streams-server` is
  self-hosted (with R2 as durable tier). Is the streams resource a wrapper
  System around streams-server, a managed platform primitive, or both behind
  one contract? Needs a design pass with the streams team's roadmap in view.
- **What backs secrets on Prisma Cloud** — plain Compute env vars, a
  management-API secret store, or an emulated secret System? Needs grounding
  against the platform surface before the secrets slice is specced.
- **Dev-loop architecture** — process-per-service vs single-process wiring;
  how webhook replay (Stripe, GitHub) enters the local topology. Design pass
  scheduled late deliberately, after two ports' worth of evidence.

# References

- [`docs/design/00-purpose/goals.md`](../../../docs/design/00-purpose/goals.md) — framework goals this project advances (dev emulator, managed lifecycles).
- [`docs/design/10-domains/core-model.md`](../../../docs/design/10-domains/core-model.md) — the core model the ports consume; § "Extension points" names the seams this project exercises.
- [`docs/design/90-decisions/ADR-0013-resources-are-provisioned-by-systems-deps-are-declarations.md`](../../../docs/design/90-decisions/ADR-0013-resources-are-provisioned-by-systems-deps-are-declarations.md) and [ADR-0015](../../../docs/design/90-decisions/ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md) — the resource/binding model emulated resources must fit.
- [prisma/datahub](https://github.com/prisma/datahub) — first port target.
- [prisma/open-chat](https://github.com/prisma/open-chat) — second port target; [docs/architecture.md](https://github.com/prisma/open-chat/blob/main/docs/architecture.md).
- [prisma/streams](https://github.com/prisma/streams) — the streams primitive.
- `.drive/deferred.md` — prior-project platform asks (state API, unique names) this project may re-surface.
- [PR #29](https://github.com/prisma/makerkit/pull/29) — publishing setup (dependency).
- Branch `claude/system-composition` (`hex-composition` project) — the
  resource-as-System seam this project consumes (dependency).
