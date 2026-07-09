# ADR-0012: The state store speaks SQL directly; Prisma Next adoption is deferred

## Status

Accepted

## Decision

The hosted state store's data access is hand-written SQL over a plain Postgres
driver (postgres.js) — not Prisma Next. Adopting Prisma Next for the store is
deferred, with the pick-up triggers recorded below, not rejected.

## Reasoning

Here is a representative query from the store — the write path, more or less
in full:

```sql
insert into alchemy_resource_state (stack, stage, fqn, value)
values ($1, $2, $3, $4)
on conflict (stack, stage, fqn) do update set value = excluded.value
```

The store's entire data surface is like that: two tables — one row per
provisioned resource, one row per stack's outputs — accessed through roughly a
dozen key-value operations: get, upsert, delete, list. Every operation is
already typed at the boundary, because the store implements the engine's
`StateService` interface; no caller ever sees a row shape. That is the context
in which an ORM's value proposition has to argue.

Feasibility is not the question — Prisma Next fits this shape today. Its
control API applies a contract's schema programmatically (`dbUpdate` with
apply mode reconciles the database and writes its own marker, refusing
destructive plans by default), which matches the store's bootstrap-at-runtime
requirement; its runtime accepts an explicit connection string, which matches
the mint-per-run credential model; contract artifacts are emitted at
development time and committable, so a library can ship them.

The argument is cost against gain, and it concentrates in the store's most
safety-critical code. The advisory-lock machinery
([ADR-0010](ADR-0010-deploys-hold-a-session-advisory-lock.md)) is built on
postgres.js's reserved-connection primitive, and its correctness properties —
crash-release, the never-touch-the-dead-connection liveness check — hold
against that driver's specific failure behavior, verified empirically. Prisma
Next rides a different driver (node-postgres), so adoption means porting the
lock to a different connection-pinning mechanism and re-running its entire
proof suite (contention, crash-release, server-side kills), plus re-proving
that the engine's state-encoding envelopes round-trip byte-identically through
a different jsonb path, plus re-establishing the store's live deploy proofs on
the new stack. What that buys is a typed lane for a dozen trivial queries that
are already typed one layer up. For this code, today, the exchange is a poor
one — and the platform's intended state API may eventually absorb the store
entirely, making investment in its internals moot.

Deferred is not rejected. The store keeps plain SQL while it stays small; the
decision flips when the balance does.

**Pick-up triggers.** Revisit adoption when any of these holds:

- the store's schema or queries grow past trivial key-value shapes;
- exercising Prisma Next from inside a library (framework dogfooding) becomes
  worth the re-proof cost on its own;
- the platform-side state API lands — in which case this store shrinks to a
  client or disappears, and this record closes as obsolete rather than
  adopted.

## Consequences

- The store's data layer stays a few hundred lines of reviewable SQL with no
  framework dependency; its test suite runs against a real Postgres.
- The lock's proven driver-specific behavior remains undisturbed.
- The store does not dogfood Prisma Next — a deliberate, recorded trade, not
  an oversight.
- The schema-creation code carries a pointer to this record so the deferral
  stays discoverable at the site it governs.

## Alternatives considered

- **Adopt Prisma Next now** — feasible (control API, explicit-DSN runtime,
  committable artifacts) and attractive as dogfooding, but the cost lands in
  the lock port and the re-proof of live-proven code, against thin gain on
  trivial CRUD. Deferred on that balance.
- **An SQL query-builder layer** (Effect's SQL packages and similar) — the
  same re-plumbing cost without the contract/migration payoff that would
  justify it.
- **The runtime's native SQL client** (the deployed platform is Bun) —
  rejected outright: the store ships in a library that must not couple to a
  runtime; the driver choice must run anywhere a deploy runs.

## Related

- [`ADR-0009`](ADR-0009-deploy-state-is-hosted-in-the-workspace.md) — the
  store this governs.
- [`ADR-0010`](ADR-0010-deploys-hold-a-session-advisory-lock.md) — the lock
  machinery whose driver coupling dominates the adoption cost.
