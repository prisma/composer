# ADR-0010: Deploys hold a session advisory lock per stack and stage

## Status

Accepted

## Decision

A deploy acquires a Postgres session advisory lock on the hosted state
database ([ADR-0009](ADR-0009-deploy-state-is-hosted-in-the-workspace.md)),
keyed by the application being deployed (its stack name and stage), and holds
it on a dedicated connection for the whole run. A second deploy of the same
application fails immediately with an error naming what is locked; it never
queues. If the deploying process dies, the connection drops and Postgres
releases the lock — crash recovery needs no bookkeeping. During the run, every
state operation re-verifies the lease from a *separate* connection (amortized
over a short window), and fails loudly if the lease is gone.

## Reasoning

Start with the collision this prevents. Two engineers run `prisma-app deploy`
for the same application within seconds of each other — a human and a CI job,
say, after a merge. Each deploy is a long sequence of steps: read the state
rows, diff, create or update cloud resources, write the results back.
Un-serialized, the two runs interleave — each reads state the other is halfway
through rewriting, each mutates the same cloud resources on a stale picture —
and the end state is a stack that matches neither run's plan, described by
state rows that match neither reality. Nothing reports an error; the damage
surfaces on the *next* deploy.

Sharing state is what makes this collision possible at all — hosted state
gives every credentialed machine the same store — and the engine offers no
protection: locking appears nowhere in its state-store interface and in none
of its built-in stores. Whatever concurrency control exists is ours to build
into the store itself.

What the situation needs is a lease: held for the entire run, released the
instant the holder dies, with no cleanup job or expiry bookkeeping. A Postgres
session advisory lock is exactly that object. It binds to a connection's
lifetime — hold the connection, hold the lock; lose the process, the
connection drops and the lock frees itself. (The *transaction*-scoped variant
is unusable here: it releases at the first commit, and a deploy spans many.)
The store already lives in Postgres, so the lease costs no new infrastructure:
one `pg_try_advisory_lock` on a connection reserved for the run, keyed by a
hash of the stack and stage.

The try-variant is deliberate. On contention the second deploy fails at once —
"another deploy holds the state lock for *stack*/*stage*" — rather than
queuing silently behind an unbounded wait. A human can decide to wait; a
command that hangs with no explanation cannot be reasoned about.

Holding the lock is not enough — the run must also *notice* if it loses it,
or it would keep mutating shared state unlocked. The obvious check (ping the
reserved connection before each operation) harbors a trap: if the reserved
connection's backend has been killed server-side, the driver does not fail
that query cleanly — it throws outside the promise chain and takes down the
whole process. So the liveness check never touches the possibly-dead reserved
connection. It records the lock connection's backend pid at acquire time and
asks a *pool* connection whether that pid still holds the advisory lock in
`pg_locks`. A passing check is trusted for a few seconds so a burst of state
operations costs one round-trip, not one per operation; a failing check is
never cached and fails the run immediately.

Reads are gated by the same check, not just writes: a lost lease means another
deploy may already be mutating this stack's rows, so a read is as
untrustworthy as a write. The check is best-effort by nature — it is not
atomic with the operation it guards, and within the trust window a lost lease
goes unnoticed — bounded staleness accepted in exchange for not doubling every
operation's latency.

## Consequences

- Two deploys of one stack/stage cannot interleave: the second fails fast with
  an actionable message. Different stacks or stages never contend.
- `kill -9` mid-deploy needs no recovery step: the next deploy acquires the
  lock immediately.
- A lease lost mid-run is detected within seconds, not instantly. The residual
  window (and the check-then-act gap) is accepted; the alternative is a
  round-trip per state operation.
- The lock's implementation is private to the store. If the engine ever grows
  a locking concept, the migration is internal; nothing else in the framework
  knows the mechanism exists.
- There is no queueing affordance yet. If waiting turns out to be the common
  want, a `--wait` flag can layer over the same lock without changing its
  semantics.

## Alternatives considered

- **No locking** — rejected: hosted state actively invites the concurrent
  case, and interleaved applies corrupt both state and infrastructure.
- **A lease table with heartbeats and expiry** — rejected: it re-implements,
  with bookkeeping and clock assumptions, exactly what the session lock's
  connection-lifetime binding provides for free.
- **Transaction-scoped advisory locks** — unusable: released at the first
  commit inside the run.
- **Blocking on contention** (`pg_advisory_lock` rather than the try-variant)
  — rejected as the default: an indefinitely hanging deploy is worse than a
  clear refusal; explicit waiting can be added later.
- **Checking liveness on the reserved connection itself** — rejected: a
  server-killed reserved connection crashes the process instead of failing the
  query (the driver's behavior, verified directly), turning a lost lease into
  a lost deploy.

## Related

- [`ADR-0009`](ADR-0009-deploy-state-is-hosted-in-the-workspace.md) — the
  shared store that makes the concurrent case real.
- [`../03-domain-model/layering.md`](../03-domain-model/layering.md) — where
  state and its guarantees sit in the provisioning plane.
