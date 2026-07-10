# Slice 1 — Compute provider (v2 Alchemy)

**Project:** mvp-example-app · **Plan:** [`../plan.md`](../plan.md)

## Contract

Add a v2 / Effect Alchemy provider for **Prisma Compute** to
`packages/prisma-alchemy`, mirroring the existing Postgres provider. Two resources,
folded into `providers()`:

- **ComputeService** — the stable app identity (id + endpoint). reconcile
  creates/observes a compute service; delete removes it (404-tolerant); read for
  recovery.
- **Deployment** — one deploy of a service, consuming a **prebuilt artifact** (path
  to a tar.gz + `{ manifestVersion, entrypoint }` manifest). reconcile runs the
  sequence idempotently: create deployment (returns `foundryVersionId` +
  `uploadUrl`) → PUT the tar.gz to `uploadUrl` → start the version → promote the
  service.

## DoD

- `pnpm --filter @prisma/alchemy exec tsc --noEmit` passes.
- Structure mirrors the Postgres provider (Context.Service tags, Provider.effect,
  the `call`/`callOptional`/`callVoid` helpers, Redacted secrets, 404-tolerant
  delete). v2/Effect only; no globals.

## Hands to

A `Prisma.providers()` bundle that provisions Compute *and* Postgres — consumed by
Slice 4's `alchemy.run.ts`.

## Delivery

Delegated to a resumable implementer (Sonnet) + reviewer (Opus) pair.
