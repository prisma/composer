# Project Plan — MVP example app

## Summary

Four slices take the MVP from "Postgres provider done" to "two connected
components deployed to Prisma Cloud via Alchemy and verified end-to-end."

**Spec:** [`./spec.md`](./spec.md) · **Design notes:** [`./design-notes.md`](./design-notes.md)

## Slices

### Slice 1 — Compute provider (v2 Alchemy)

**Outcome:** `packages/prisma-alchemy` gains a v2/Effect **Compute** provider — a
`ComputeService` resource (stable identity + endpoint) and a `Deployment` resource
whose `reconcile` runs create → upload → start → promote idempotently, consuming a
**prebuilt** artifact (tar.gz path + `{ manifestVersion, entrypoint }` manifest).
Typechecks, smoke-covered, folded into `Prisma.providers()`.

- **builds on:** the committed Postgres provider.
- **hands to:** a `Prisma.providers()` bundle that provisions Compute *and* Postgres.
- **status:** ✅ delivered + **proven end-to-end** against real Prisma Cloud via
  `examples/smoke` — deploy runs create → upload → start → poll → promote and the
  deployed app serves `200`; `destroy` cleans up. Postgres path proven the same
  way. See design-notes "Validated end-to-end (Compute)".

### Slice 2 — Example workspace + Auth service + build-to-artifact pipeline

**Outcome:** `examples/storefront-auth` is a working workspace with a repeatable
build that emits a Compute tar.gz + manifest, and the **Auth** service (Bun/Hono)
as the first app proving that pipeline reads/writes its own Postgres.

- **builds on:** — (independent).
- **hands to:** a `build → artifact` step downstream apps reuse, and the Auth artifact.
- **status:** ✅ delivered — implemented (Sonnet) + reviewed (Opus: SHIP + one hardening fix); `tsc` clean, artifact verified against the ADR format.

### Slice 3 — Storefront (Next.js) on the pipeline

**Outcome:** the **Storefront** Next.js app with public HTTP ingress that calls
Auth while serving a request, building to a Compute artifact via slice 2's pipeline.

- **builds on:** slice 2 (the build pipeline).
- **hands to:** the Storefront artifact + the ingress→Auth call path.
- **status:** ✅ delivered + **live on real Prisma Cloud** — `next build` standalone
  packaged by `bundle-next.ts`, deployed via our provider; serves `200`. Needed
  `node-linker=hoisted` (pnpm isolates Next's peers like styled-jsx). The Auth call is
  wired in Slice 4 (AUTH_URL currently unset → the page renders that).

### Slice 4 — Wire, deploy, verify

**Outcome:** `alchemy.run.ts` provisions 2×(Project→Database→Connection) +
2×(ComputeService→Deployment), feeding each DB's connection string into its
service env; a real deploy to Prisma Cloud; verify ingress→Auth round-trip,
idempotency, and `destroy`. Meets project DoD.

- **builds on:** slices 1, 2, 3 (+ operator credentials).
- **hands to:** — (project close).
- **status:** ✅ delivered + **live on real Prisma Cloud**. Realized as one project
  per hex (each hex's default Postgres auto-injects `DATABASE_URL` — no explicit
  Connection→env wiring needed); `AUTH_URL` wired via a new `EnvironmentVariable`
  resource. `curl <auth>/verify` → `200 {"ok":true}`; the Storefront renders the
  round-trip. Re-deploy noop; destroy tears down. DoD met.

## Sequencing

- **Parallel:** { Slice 1, Slice 2 } — independent, start together.
- **Stack:** Slice 2 → Slice 3 → Slice 4; and Slice 1 → Slice 4.
- **Critical path:** 2 → 3 → 4.

## Tracker

No Linear Project yet. Running **local-`.drive`-only** until the operator opts into
Linear sync (open question in the spec). On opt-in: one Linear issue per slice
under a new "MVP example app" project.

## Close-out (required)

- [ ] Verify all acceptance criteria in [`./spec.md`](./spec.md)
- [ ] Migrate long-lived docs into `docs/` (the Compute provider + the Alchemy→Prisma-Cloud deploy path as reference)
- [ ] Strip repo-wide references to `.drive/projects/mvp-example-app/**`
- [ ] Delete `.drive/projects/mvp-example-app/`
