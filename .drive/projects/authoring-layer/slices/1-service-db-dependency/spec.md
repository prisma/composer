# Slice 1 — Service + DB dependency (no contract)

## At a glance

A developer writes one service that declares a Postgres dependency, and MakerKit
provisions Prisma Postgres + Compute and injects a typed `db` handle — the handler
never reads `process.env`:

```ts
export default service(
  { db: postgres() },
  ({ db }) => Bun.serve({ port: PORT, fetch: async () =>
    Response.json(await db`select 1 as ok`) })
)
```

## Chosen design

`@makerkit/core` provides `service`, the `postgres()` descriptor, **Load**
(build + validate the in-memory graph), the **lower** step (graph → existing
`packages/prisma-alchemy` resources), and the **host shim** (hydrate `DATABASE_URL`
→ a `Bun.SQL` client → inject as `db`). We lean on what the MVP proved: Compute
auto-injects `DATABASE_URL` from the project's default DB, so config wiring is nearly
free. The handler owns `Bun.serve` for now — no Output/serving model yet. This is the
current `hexes/auth` service inverted: MakerKit reads the env and hands over `db`
instead of the handler reading it.

## Coherence rationale

One PR, one review: a single new package plus one ported service. The deploy path is
the same Alchemy engine + `prisma-alchemy` providers we already run for the example —
Slice 1 changes *who authors the stack* (the primitive, not hand-written
`alchemy.run.ts`), not the deployment mechanism.

## Scope

**In:** `@makerkit/core` (`service`, `postgres()`, Load, lower→prisma-alchemy,
host shim); one ported single-service example; deploy + verify.
**Out (deliberately):** `hex`, `provision`, ownership model, a second service,
typed interfaces / connection types, the Output/serving model, streams, data
contracts, non-default-DB config.

## Plan (inline — dispatch breakdown)

- **1a — pure core.** `service`, `postgres()` descriptor, Load (build + validate
  graph), unit tests. No lowering, no deploy. Control-plane vs execution-plane behind
  separate import surfaces from the start.
- **1b — lower + shim + port.** Map the loaded graph → `prisma-alchemy`
  Project/ComputeService/Deployment; host shim hydrates `DATABASE_URL` → `db`; port one
  service; build the artifact.
- **1c — deploy + verify.** Deploy to Compute; endpoint returns a live DB query;
  redeploy + destroy clean.

## Pre-investigated edge cases

- Module top-level must stay side-effect-free: importing a service to read its deps
  (Load) must run nothing (the "handle is a descriptor and runnable, but inert until
  invoked" rule).
- Compute is scale-to-zero: first hit after deploy is ~15s 502 then 200 — verification
  in 1c must tolerate the cold start.

## Slice-DoD

The single-service example deploys via `@makerkit/core` (not hand-written
`alchemy.run.ts`), its endpoint returns a live DB query, the handler contains zero
`process.env`, and redeploy + destroy are clean. (CI-green + reviewer-accept +
project-DoD floor inherited.)

## Open questions

- Package name/layout (`@makerkit/core` vs split), and the exact control/execution
  import-surface boundary — decide in 1a and record.

## References

- [`docs/design/03-domain-model/authoring-surface.md`](../../../../../docs/design/03-domain-model/authoring-surface.md)
- `packages/prisma-alchemy` — the lowering target
- `examples/storefront-auth/hexes/auth` — the service being inverted
