# ADR-0055: The `postgres` binding builds clients with the app's options

## Decision

The binding a `postgres(contract)` dependency hydrates to gains two
members. `clientWith(options)` builds a typed Prisma ORM client with the
options the app passes, and `connection` is the connection pool every
client is built over. The dependency declaration takes no options.

Consider a contract with a vector column. Its schema declares the type, and
its `prisma.config.ts` lists the pgvector pack so that `prisma contract emit`
and the migrations understand it:

```prisma
model Document {
  id        String  @id
  embedding pgvector.Vector(length: 1024)?
}
```

The service declares its dependency exactly as before, and passes pgvector's
runtime extension where it builds its client:

```ts
// service.ts
export default compute({
  name: 'search',
  deps: { db: postgres(appContract) },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
});

// server.ts
import pgvectorRuntime from '@prisma/orm-extension-pgvector/runtime';

const { db } = service.load();
export const orm = db.clientWith({ extensions: [pgvectorRuntime] });
```

The binding is now:

```ts
interface PostgresBinding<C> {
  readonly url: string;                       // the raw connection string
  readonly connection: PostgresConnection;    // the pool, as the runtime's `binding` option
  readonly client: Client<C>;                 // default options, built on first access
  clientWith(options: PostgresClientOptions): Client<C>;
}
```

- `client` is unchanged for a service that needs no options. It is
  `clientWith({})`, built once on first access.
- `clientWith(options)` takes the runtime's own option type,
  `PostgresOptionsBase` from `@prisma/orm-postgres/runtime`, less
  `poolOptions`, because the pool is the binding's. Each call builds a new
  client.
- `connection` is upstream's `PostgresBinding` value,
  `{ kind: 'pgPool', pool }`, created on first access. An app that builds
  its client itself passes it as the runtime's `binding` option.

All clients share the one pool. The runtime never closes a pool it was
handed, so closing one client does not affect another. The pool retries a
database that is still starting in both of node-postgres's `connect` forms,
so a library handed `connection.pool` can call `pool.query()` as well.

A contract that needs an extension fails, with the runtime's own error, when
a client is built without it: on the first access of `client`, or at the
`clientWith(...)` call. The error reads "Contract requires extension pack(s)
'pgvector', but runtime descriptors do not provide matching component(s)."

## Reasoning

**The client's inputs are not just the contract and the URL.**
ADR-0022 had Composer build the Prisma ORM client because "contract plus URL
is the client's entire input". That is not true. A contract that uses an
extension type records the pack's name but not its code, and the runtime
refuses to build a client without the pack's *runtime extension
descriptor*, the object that supplies its codecs. Apps also have reasons to
pass `middleware`, `log` or `cursor`. Before this decision, an app that
needed any of them read `db.url` and built its own client. That lost what
Composer's client carries: a pool that retries a database that is still
starting, the short idle timeout Prisma Postgres needs, and the handler for
idle-connection errors.

**What Composer owns is the connection, not the client's configuration.**
The dependency declaration states what a service needs from the database,
and the framework hands the service something that satisfies it, the way a
test supplies a double. Client options are not part of that requirement.
They are how this service consumes the database. ADR-0015 already puts that
choice in app code: turning a binding into a client is an ordinary function
the app applies. This decision gives that function the pool Composer built,
so the app keeps the framework's connection handling while choosing its own
options.

**No Composer change for the next option.** `clientWith` passes the
runtime's own option type through. When the runtime gains an option, or an
app needs one Composer has never heard of, the app passes it. Composer keeps
no list of the options it supports.

**The framework does not find the descriptor from the contract.** The
contract names the pack (`pgvector`), so Composer could import a package
derived from that name. It does not. Turning a pack name into a package
name is guessing, which the "we don't guess" principle forbids. Composer
would have to depend on every extension package it might load. And the
descriptor must reach the deployed service, whose bundle the app builds
(ADR-0005), so the import has to be in the app's code anyway.

**The client stays lazy, and so does the extension check.** ADR-0040 builds
the client on first access so a service that reads only `url` never pays
for, or fails on, client construction. The pool is also created on first
access. Composer does not compare the contract's packs with the descriptors
earlier, because the runtime makes that comparison when the client is
built, and its error names the missing pack.

**The pack must be installed at exactly the facade's version.** Composer
builds every client with the app's copy of `@prisma/orm-postgres`, a peer
dependency (ADR-0046). The pack does not share that guarantee: pgvector
peers only on `@prisma/orm-target-postgres`, and takes
`@prisma/orm-framework` and `@prisma/orm-family-sql` as regular
dependencies pinned to its own exact version. A pack at a different version
installs a second copy of those packages, and the descriptor is built
against one copy while the runtime reading it is the other. ADR-0046
describes how that fails: silently. The guide and the agent skill say to
install the pack at exactly the facade's version.

## Consequences

- A service whose contract uses an extension type, or that needs any other
  runtime option, gets a typed client over Composer's pool by calling
  `db.clientWith(options)` once at module scope.
- `postgres(contract)` and `db.client` behave exactly as before. Existing
  services change nothing.
- `verifyMarker` is reachable through `clientWith`. Composer still sets it
  nowhere: the deploy is the schema check (ADR-0022), and an app that turns
  it on has chosen a runtime check for itself.
- A test double for this binding implements the same four members, for
  example with clients built over a test database, and the app's code that
  calls `clientWith` runs unchanged.
- The app depends on each extension package itself, at exactly the version
  of `@prisma/orm-postgres` that Composer names. Nothing enforces this at
  install. Composer adds no dependency.
- A missing descriptor is found when the client is built in the running
  service, not at deploy. A test that builds the client finds it before
  that.

## Alternatives considered

- **Options on the dependency declaration,
  `postgres(contract, { extensions })`.** The first version of this
  decision. Rejected: the declaration states what the service needs, and
  ADR-0015 keeps client construction out of it. It also accepted only the
  options Composer had chosen, so every further option would have needed
  another Composer change. No other dependency constructor takes options.
- **Extensions on the contract, `dataContract(contractJson, { extensions })`.**
  Every client of a contract needs the same extensions, so the contract
  could carry them, as an rpc contract carries the functions its client is
  built from. Rejected: it answers only extensions. `middleware`, `log` and
  the other options are the consuming service's choice and have no place on
  the contract, so they would still need somewhere else to go.
- **Only `connection`, with the app always building its client.** Rejected
  as the only form: the app then imports the runtime and names the contract
  a second time, and nothing checks that the two contracts agree.
  `clientWith` builds from the dependency's own contract. `connection`
  remains for apps that want full control.
- **Discover the descriptor from the contract's pack ids.** Rejected: it
  guesses a package from a name, hides a runtime dependency from the app's
  build, and makes Composer depend on, or dynamically load, every pack.
- **Read the descriptors from `prisma.config.ts`.** The config lists the
  pack descriptors the ORM's CLI and migrations need (pgvector's `/pack`
  entry), not the runtime ones, and ADR-0022 keeps the config out of the
  app's bundle by passing it as a path. Rejected.

## Related

- [ADR-0015](ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md):
  a declaration carries no client construction; the app turns the binding
  into its client.
- [ADR-0022](ADR-0022-data-deps-carry-a-prisma-orm-contract.md): amended.
  Composer still builds the default client, but the client's options are the
  app's.
- [ADR-0040](ADR-0040-the-orm-binding-carries-the-url-and-a-lazy-client.md):
  extended. The binding keeps `url` and the lazy `client`, and adds
  `connection` and `clientWith`.
- [ADR-0046](ADR-0046-the-orm-facade-is-a-peer-dependency.md): the ORM
  facade is a peer dependency.
- [Architectural principles](../01-principles/architectural-principles.md):
  no globals, runtime-agnostic, we don't guess.
