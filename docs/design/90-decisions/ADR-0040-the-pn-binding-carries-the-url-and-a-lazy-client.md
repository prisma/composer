# ADR-0040: The `prisma-next` binding carries the raw URL and a lazy client

## Decision

`pnPostgres(contract)`'s dependency end hydrates to a two-field binding —
the raw connection string beside the typed client — instead of the typed
client alone. The client is constructed on first access, not during
hydration.

Consider a service that builds its own `pg.Pool` because a third-party
library (say, an auth library that is not a Prisma Next consumer) must share
it. That service still wants its database schema-checked at wiring and
migrated at deploy. It now declares the contract-carrying dependency and
reads only the URL:

```ts
const service = compute({
  deps: { db: pnPostgres(appContract) },  // contract-checked, deploy-migrated
  /* … */
});

const { db } = service.load();
const pool = new pg.Pool({ connectionString: db.url }); // its own client
```

A service that wants the framework-built typed client reads the other field:

```ts
const products = await db.client.orm.public.Product.all();
```

`url` is the wire value the connection already carries. `client` is a
memoized accessor over the same client construction as before; `hydrate`
itself no longer constructs anything. The exported binding type is
`PnPostgresBinding<C> = { readonly url: string; readonly client: Client<C> }`.

Everything else about the edge is unchanged: the dependency still names the
contract, `satisfies` still compares storage hashes, and the deploy still
migrates the database to the contract's ref before dependent services start
(ADR-0022).

## Reasoning

**Before this decision, the binding equated "contract-checked database" with
"framework-built client."** A `pnPostgres` dependency hydrated directly to
the typed client, so the only way to consume a contract-carrying database
was through that client. An app that owns its client had to fall back to
plain `postgres()` — losing framework-run migrations entirely and pushing
schema application out of the deploy into an operator's hands, against a URL
the deploy resolves internally but never surfaces.

**Those are two separate wants, and the binding can serve both.** Plain
`postgres()` already treats the raw URL as a first-class binding value; a
`prisma-next` connection carries the same URL underneath its client. Putting
`url` in the binding makes the PN binding a strict superset of
`postgres()`'s `{ url }` — an app chooses its client without giving up
contract checking or deploy-time migration.

**Widening the binding does not weaken the contract.** The "data contracts
are the interface for data resources" principle governs whether a resource
may plug into a dependency — the storage-hash comparison at wiring — not
which client reads the data afterwards. The compatibility check is untouched;
only what the consumer receives is wider.

**Eager construction charged consumers for a client they might never use.**
The Prisma Next runtime deserializes and structurally validates
`contractJson` when the client is constructed (its connection pool is lazy;
its validation is not), and hydration resolves every dependency in one
synchronous pass. Two consequences: a URL-only consumer paid validation it
never needed, and a contract the runtime's validator rejects — for example
one emitted by a different toolchain version — failed the whole `load()`
call with an error naming no input, so the service could not read even its
unrelated dependencies. With construction moved into the first `client`
access, the cost disappears for URL-only consumers, and a validation failure
surfaces at the access that wanted the client, attributable to that access.

**Lazy failure on read is already this codebase's pattern.** `origin()`
(ADR-0039) raises its missing-value error at the call site for the same
reason: services that never read a value should be unaffected by its absence
or invalidity.

## Consequences

1. Binding shape change for existing `pnPostgres(contract)` consumers:
   `db.orm.…` becomes `db.client.orm.…`. Mechanical; the full client surface
   (`sql`, `transaction`, `close`, …) remains reachable under `client`.
2. A contract the installed runtime cannot validate no longer fails at
   `load()`; it fails at the first `client` access. A URL-only consumer can
   run against a contract the runtime's validator would reject — the
   storage-hash check at wiring remains the compatibility check that matters
   (ADR-0022).
3. `PnMigration` and the deploy lowering are untouched: provisioning
   `pnPostgres({ name, contract, config })` still migrates at deploy. An app
   owning its client gets framework-run migrations with no operator step.

## Alternatives considered

- **Cross-kind `satisfies`** — let a `'prisma-next'` resource satisfy a plain
  `'postgres'` dependency, so an app declares `postgres()` and provisions
  `pnPostgres`. Touches core's kind model to express what is really a
  binding concern, and a naive "no required hash → satisfied" rule would let
  a PN resource satisfy unrelated kinds. Rejected.
- **`{ url, orm }` — expose only the ORM, not the full client** — loses
  `sql`, `transaction`, `close`, and any future client surface for no gain.
  Rejected.
- **Keep the client eager and add `url` beside it** — retains the validation
  tax and the all-inputs failure mode for URL-only consumers: an app reading
  only `url` would still crash at boot on a contract its bundled runtime
  version rejects. Rejected.
