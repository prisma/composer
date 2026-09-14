# Project Plan — alchemy-provider-adoption

## Summary

Three slices: two stacked (postgres family, then compute family) and one parallel (upstream contributions). The spike that grounded this plan is this project's originating session; call-site inventory is in `spec.md` References.

**Spec:** `.drive/projects/alchemy-provider-adoption/spec.md`

## Slices

### Slice 1 — Postgres family adoption (TML-3154)

Bump alchemy to the first released beta containing the Prisma provider; wire upstream live providers + `PrismaEnvironment` auth; rename our collection tag; swap `Project`/`Database`/`Connection` to upstream classes; rewire postgres/prisma/orm descriptors; create-then-PATCH branch attach; `directConnectionString`; state-row migration (mechanics decided here: aliases vs SQL); rebind postgres emulator provider.

- **Builds on:** nothing (first slice).
- **Hands to:** slice 2 — alchemy bumped, upstream live-provider wiring + auth layer in place, collection tag renamed, state-migration mechanism proven on the postgres rows.

### Slice 2 — Compute family adoption (TML-3155)

Swap `ComputeService`/`Deployment`/`EnvironmentVariable`; decide Compute vs App+Deployment; `artifactPath`-only enforcement (ADR-0005); env parity + `DATABASE_URL` exclusion; state migration on compute rows; rebind compute emulator provider.

- **Builds on:** slice 1's hand-off.
- **Hands to:** close-out — Composer fully on upstream for the six resources; old implementations deleted.

### Slice 3 — Upstream contributions (TML-3156) — parallel

Fork alchemy-run/alchemy (wmadden-electric), then ONE implementation PR (per the operator override below): `liveProviderLayer` export, bucket resources, and the generic `postgresState` backend, implemented directly — no asks filed. `PgWarm` offered in the same conversation.

- **Builds on:** nothing (written against upstream shapes directly).
- **Hands to:** slice-1 dependency softening (the export); Composer bucket deletion at close-out if the bucket PR merges + releases in time (otherwise buckets stay per transitional constraint).

## Sequencing

- Stack: 1 → 2.
- Parallel: 3 alongside both.
- **Operator overrides (2026-08-03):** all Composer-side slices land on THIS branch (no per-slice branches; one Composer PR at the end). Slice 3 is ONE implementation PR to alchemy-run/alchemy — `liveProviderLayer` export, bucket resources, and the postgres state backend implemented directly, no asks filed. Upstream branch: `prisma-provider-composer-needs` in `~/Projects/prisma/alchemy` (push blocked until the wmadden-electric fork exists).

## Close-out (required)

- [ ] Verify all acceptance criteria in `.drive/projects/alchemy-provider-adoption/spec.md`
- [ ] Migrate long-lived docs into `docs/` (ADR for the adoption + revised local-dev seam; alchemy-lowering.md rewrite)
- [ ] Strip repo-wide references to `.drive/projects/alchemy-provider-adoption/**`
- [ ] Delete `.drive/projects/alchemy-provider-adoption/`
