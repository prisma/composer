# Project Plan — alchemy-provider-adoption

## Summary

Three slices: two stacked (postgres family, then compute family) and one
parallel (upstream contributions). The spike that grounded this plan is this
project's originating session; call-site inventory is in `spec.md` References.

**Spec:** `.drive/projects/alchemy-provider-adoption/spec.md`

## Slices

### Slice 1 — Postgres family adoption (TML-3154)

Bump alchemy to the first released beta containing the Prisma provider; wire
upstream live providers + `PrismaEnvironment` auth; rename our collection tag;
swap `Project`/`Database`/`Connection` to upstream classes; rewire
postgres/prisma-next descriptors; create-then-PATCH branch attach;
`directConnectionString`; state-row migration (mechanics decided here: aliases
vs SQL); rebind postgres emulator provider.

- **Builds on:** nothing (first slice).
- **Hands to:** slice 2 — alchemy bumped, upstream live-provider wiring +
  auth layer in place, collection tag renamed, state-migration mechanism
  proven on the postgres rows.

### Slice 2 — Compute family adoption (TML-3155)

Swap `ComputeService`/`Deployment`/`EnvironmentVariable`; decide Compute vs
App+Deployment; `artifactPath`-only enforcement (ADR-0005); env parity +
`DATABASE_URL` exclusion; state migration on compute rows; rebind compute
emulator provider.

- **Builds on:** slice 1's hand-off.
- **Hands to:** close-out — Composer fully on upstream for the six resources;
  old implementations deleted.

### Slice 3 — Upstream contributions (TML-3156) — parallel

Fork alchemy-run/alchemy (wmadden-electric), then two upstream PRs: bucket
resources; generic `postgresState` backend. Plus the one-line
`liveProviderLayer` export ask (filed early — slice 1 consumes it if it lands
in time, otherwise uses the transitional local rebuild). `PgWarm` offered in
the same conversation.

- **Builds on:** nothing (written against upstream shapes directly).
- **Hands to:** slice-1 dependency softening (the export); Composer bucket
  deletion at close-out if the bucket PR merges + releases in time (otherwise
  buckets stay per transitional constraint).

## Sequencing

- Stack: 1 → 2.
- Parallel: 3 alongside both (start immediately — the export ask is the first
  action, since slice 1 benefits from it).

## Close-out (required)

- [ ] Verify all acceptance criteria in `.drive/projects/alchemy-provider-adoption/spec.md`
- [ ] Migrate long-lived docs into `docs/` (ADR for the adoption + revised
      local-dev seam; alchemy-lowering.md rewrite)
- [ ] Strip repo-wide references to `.drive/projects/alchemy-provider-adoption/**`
- [ ] Delete `.drive/projects/alchemy-provider-adoption/`
