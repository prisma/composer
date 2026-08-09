# ADR-0045: Deploy state lives behind the platform state API; deploys hold a server-side lease

## Decision

Each stage's deploy state — the provisioning engine's record of what exists in the cloud — lives behind the Management API. The platform implements Alchemy's stock `HttpStateApi` wire contract verbatim under `/v1/projects/{projectId}/branches/{branchId}/alchemy-state`, and composer's state layer is Alchemy's own stock HTTP client (`makeHttpStateStore`) pointed at it — no store code of our own. Around every run the deploy holds a **server-side lease** per `(stack, stage)`; every state operation carries the lease id and the server rejects any operation without a live lease.

```
deploy run
 ├─ POST   …/alchemy-state/lease                acquire; 409 → fail fast,
 │                                              error names the current holder
 ├─ PATCH  …/alchemy-state/lease                heartbeat every 20s (TTL 60s)
 ├─ *      …/alchemy-state/state/…              the stock HttpStateApi wire
 │                                              contract; every call carries
 │                                              Alchemy-State-Lease-Id
 └─ DELETE …/alchemy-state/lease                release (scoped finalizer)
```

This supersedes [ADR-0010](ADR-0010-deploys-hold-a-session-advisory-lock.md) — the Postgres session advisory lock becomes this lease; the fail-fast contention behavior is preserved — and the storage half of [ADR-0034](ADR-0034-deploy-state-lives-in-the-stage-branch.md): state is still a child of the stage's Branch with exactly the environment's lifetime, but the visible per-stage `prisma-composer-state` database disappears. It closes [ADR-0012](ADR-0012-the-state-store-speaks-sql-directly.md) as obsolete via that record's own pick-up trigger ("the platform-side state API lands — this store shrinks to a client or disappears"). [ADR-0011](ADR-0011-targets-supply-the-deploy-state-layer.md) is unchanged: the Prisma Cloud target still supplies this layer as the deploy's state store.

## Reasoning

The end state was recorded twice before it existed. ADR-0009 named a platform-side state API as where hosted state ultimately belongs; ADR-0034 called its own database store the proof of the *right shape* for that API — state scoped as a child of the Branch, cascading on delete. The platform now implements that API, so composer stops carrying the interim machinery: the per-stage database, its bootstrap/ownership-marker/connection-minting code, the SQL store, and the advisory lock with its liveness checker.

Because the server speaks Alchemy's stock wire contract verbatim, the client side is not ours to write. Composer builds Alchemy's own `makeHttpStateStore` with the scope's URL, the workspace service token, and one request transform that adds the lease header. There is no SQL, no driver, no schema, and no store of our own whose storage correctness we must prove — the contract is Alchemy's, proven by Alchemy. Composer does keep an in-process fake of the wire contract to test its own wiring (the lease lifecycle, the guard, the client pointed at our URL shape); a fake can drift from the contract it mirrors and must track it. What remains in composer beyond that is scope resolution (a URL needs a concrete `branchId`; production resolves the Project's default Branch), the lease client, and operator-facing error wrapping.

The lease replaces the advisory lock because the lock's substrate is gone. ADR-0010 chose a Postgres session lock precisely because it was a lease the store's own database provided for free — bound to a connection, released on crash. With no database there is no session, so the lease moves to where the state now lives: the server. A deploy acquires it before the first state operation (60-second TTL by default; the server clamps requested TTLs to 30–300 seconds — a server-side rule, checkable only in its implementation, prisma/pdp-control-plane#4817), heartbeats it on a forked fiber every 20 seconds, and releases it as a finalizer. Contention keeps ADR-0010's exact behavior: a second deploy of the same `(stack, stage)` fails immediately with the server's message naming the current holder — it never queues.

Enforcement also moves server-side, which deletes a whole client subsystem. Under ADR-0010 the client had to *notice* a lost lock, and its liveness checker existed to work around driver crash behavior. Now every state operation is checked by the server: without a live lease it fails with 409 — a status the stock client treats as fatal (it retries transient failures, never 409) — so a run that loses its lease stops within at most one further request. No client-side liveness check exists at all.

What does not change is the addressing ADR-0034 fought for. State rows are children of the Branch: delete the Branch (CLI, Console, any platform surface) and the stage's state goes with it; production's state sits on the implicit default Branch. Auth is unchanged too — the same workspace service token the deploy already holds, with no minted per-run connection strings and no ownership markers, because there is no database to prove ownership of. Per the server implementation (prisma/pdp-control-plane#4816/#4817), the rows are encrypted at rest under the per-project data-encryption key, and the server enforces bounds on key lengths (stack, stage, fqn), so malformed scopes fail loudly at the API rather than landing in storage.

One naming wrinkle is deliberate: the store still registers itself with Alchemy's telemetry as `id: 'prisma-postgres'`. That slug identifies the state *service* in metrics and spans (`alchemy.state_store.id`), and changing it would split every dashboard series keyed on it. The slug outlives the database it once described; it now just means "Prisma-hosted state".

The cutover carries no migration, on ADR-0034's own precedent. A stage deployed under the database store starts from empty API state, and deploying over it blind would recreate every resource and die in `already_exists` failures. So the state layer keeps its empty-scope check, re-pointed: after acquiring the lease, if the API holds no resources for `(stack, stage)` but the Branch already holds live resources (Compute apps, databases, or buckets), the deploy refuses with instructions — destroy the stage with the previous composer version, or delete the stage's Branch (the Project, for production), then redeploy fresh. Legacy `prisma-composer-state` databases are never read and never deleted by this version: deleting a stage's Branch removes that stage's database platform-side, while production's lingers (one quota slot, no money) until deleted by hand — a documented cleanup, not an automated one.

## Consequences

- **No visible state database.** The Console shows only the user's own databases; the quota slot each stage's store consumed (ADR-0034's standing consequence) is returned, and the delete-the-state-database-by-hand footgun disappears with it.
- **Crash recovery trades instant for bounded.** The advisory lock freed the moment a crashed deploy's connection dropped; a crashed deploy's lease now blocks the stage until its TTL expires — up to 60 seconds. Accepted: rare case, small bound, and the retrying operator sees who holds the lease.
- **Contention behavior is preserved.** Fail fast, never queue, error names the holder. A `--wait` affordance can still layer over the same lease later without changing its semantics.
- **Lease loss is detected server-side within one extra request**, instead of within a client-side trust window. The stock client's fatal treatment of 409 is what makes this hold; if the client's retry policy ever changes, this property must be re-verified.
- **The routes are experimental, and a route move is a live break.** The state URL is baked into every published composer version and the platform serves one live API to all of them, so if the routes move, already installed versions fail at deploy time until each user upgrades. Alchemy's contract carries an unauthenticated `/version` probe that can detect contract drift, but detection only names the break — it does not prevent it. Accepted while the surface stabilizes; moving the routes is a platform decision that must weigh this cost.
- **No migration.** Legacy stages refuse to deploy until destroyed or deleted (see the deploying guide); their state databases are cleaned up by Branch deletion or by hand, never by this version's code.
- **Platform-side teardown still covers platform resources only.** State can track resources outside Prisma Cloud; deleting the Branch deletes the only record of them. Same documented limitation as ADR-0034, same shape.
- **Telemetry continuity.** The `prisma-postgres` state-store slug persists across the storage change; series keyed on it read through the cutover.

## Alternatives considered

- **Keep the database store** — rejected: two ADRs recorded the API as the end state, the API now exists, and keeping both means maintaining a bespoke store, its lock, and its proof suite alongside a stock client.
- **A composer-written API client** — rejected: the server implements Alchemy's contract verbatim, so the stock client is the contract; a bespoke client could only drift from it.
- **Port ADR-0010's liveness checker to the API** — rejected: the server checks the lease on every operation; a client-side pre-check would add a round-trip to re-derive what the next request reports anyway.
- **Migrate legacy state into the API** — rejected: destroy-then-redeploy is the recorded precedent (ADR-0034), the affected population is pre-GA, and migration tooling would have to be proven against every legacy store generation for a one-time event.
- **Queue on lease contention** — rejected again for the reasons in ADR-0010: a hanging deploy is worse than a clear refusal; waiting can be added as an explicit flag later.

## Related

- [ADR-0009](ADR-0009-deploy-state-is-hosted-in-the-workspace.md) / [ADR-0034](ADR-0034-deploy-state-lives-in-the-stage-branch.md) — the two prior stores; both named this API as the end state. ADR-0034's Branch-scoping and lifetime reasoning carries over unchanged.
- [ADR-0010](ADR-0010-deploys-hold-a-session-advisory-lock.md) — the advisory lock this lease supersedes; its contention UX survives.
- [ADR-0011](ADR-0011-targets-supply-the-deploy-state-layer.md) — unchanged: the target supplies this layer.
- [ADR-0012](ADR-0012-the-state-store-speaks-sql-directly.md) — closed as obsolete; its pick-up trigger fired.
- prisma/pdp-control-plane #4816 (schema) and #4817 (API) — the server implementation of the state routes and the lease.
- [`../03-domain-model/layering.md`](../03-domain-model/layering.md) — the provisioning-state spectrum this advances.
