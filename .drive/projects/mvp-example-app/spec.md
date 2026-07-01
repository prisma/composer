# Purpose

Prove that MakerKit's model can be provisioned and deployed to Prisma Cloud
**entirely through Alchemy** — by standing up the smallest real, connected,
deployed application. The point is to ground the architecture in something that
actually runs, so the lower-level MakerKit design is made against reality rather
than speculation. The most valuable output is the friction we discover, not the
app itself.

# At a glance

Two connected components, each its own Hex:

- **Storefront** — a Next.js app with public HTTP ingress.
- **Auth** — a service the Storefront calls on an incoming request.

Each is backed by **its own Prisma Postgres** database. Everything — both
databases and both compute services — is provisioned and deployed to Prisma Cloud
through **our own v2 / Effect Alchemy providers**. One `alchemy deploy` stands the
whole system up in a fresh environment; the Storefront serves a request that
round-trips to Auth, and each service talks to its own database.

# Non-goals

- **MakerKit primitives.** This project builds *directly* on Alchemy. The MakerKit
  composition layer on top is the next phase, not this one.
- **Shared data.** No shared Postgres, data contracts, or aggregate contracts —
  each Hex gets its own database.
- **Breadth.** No third component, no streams, no realtime.
- **A production-grade Compute provider.** The MVP lifecycle (create → upload →
  start → promote) is enough; rollback, custom domains, and log streaming are out.
- **Local emulation.** Deploying to real Prisma Cloud is the target; `prisma dev`
  emulation is a separate goal.
- **Publishable packages.** The providers stay in-repo.

# Place in the larger world

Builds on the settled MakerKit design in [`docs/design/`](../../../docs/design/)
and the already-committed Postgres provider in
[`packages/prisma-alchemy`](../../../packages/prisma-alchemy) (commit `64e530f`).
Depends on `alchemy@2.0.0-beta.59`, `effect@4.0.0-beta.92`,
`@prisma/management-api-sdk`, Prisma Cloud (Compute + Prisma Postgres), and deploy
credentials. It is the **first concrete artifact that feeds the MakerKit
architecture phase** — especially the Alchemy↔Compute seam and what a MakerKit
Service/Resource must lower to.

# Cross-cutting requirements

- **All provisioning goes through Alchemy v2/Effect providers we own** — no v1, no
  manual click-ops, no CLI deploy path.
- **Idempotent convergence.** Re-running `alchemy deploy` converges without
  duplicating resources; `alchemy destroy` removes everything.
- **Fresh-environment reproducibility.** The system stands up from nothing given
  only credentials (the recreate-in-a-new-environment goal).
- **Secret hygiene.** Connection strings and the service token stay `Redacted` and
  are injected as environment configuration — never embedded in code or logged.
- **Typed and buildable.** The providers and both apps typecheck against the
  pinned beta toolchain, and the example builds.

# Transitional-shape constraints

None — greenfield example, no migration or intermediate compatibility state.

# Project-DoD

Inherits the team DoD floor. Project-specific close conditions:

- [ ] `alchemy deploy` provisions two Prisma Postgres databases and deploys two
      Compute services to Prisma Cloud in a fresh environment, with no manual step
      beyond supplying credentials.
- [ ] The deployed Storefront is reachable over HTTP ingress and successfully
      calls the deployed Auth service while serving a request.
- [ ] Each service reads/writes its own Postgres via the injected connection
      string (no `DATABASE_URL` hard-coded in app code).
- [ ] Re-running `alchemy deploy` is a no-op; `alchemy destroy` tears the system
      down cleanly.
- [ ] The whole example typechecks; the providers carry at least smoke coverage.

# Open questions

- **Compute artifact bundling for Next.js** — how the tar.gz is produced. The
  operator has done Next.js-on-Compute before; ground this at the build-step slice
  rather than inventing it.
- **Deploy credentials** — `PRISMA_SERVICE_TOKEN`, a workspace id, and
  `ALCHEMY_PASSWORD`. Operator to provide when we reach the deploy slice.
- **Auth's shape** — a Bun/Hono service (clean service boundary, likely) vs a
  second Next.js. Decide at the Auth slice.
- **Tracker** — Linear project vs local `.drive`-only for this work (operator
  decision; running local-only until told otherwise).

# References

- [`docs/design/`](../../../docs/design/) — the settled MakerKit model.
- [`packages/prisma-alchemy`](../../../packages/prisma-alchemy) — the Postgres
  provider (done); Compute provider to be added here.
- `@prisma/management-api-sdk` — the Management API client the providers wrap.
- `ignite/docs/portal/technology/prisma-compute/` — Compute control-plane
  mechanics (create → upload → start → promote).
- [`design-notes.md`](./design-notes.md) — the design decisions behind this project.
