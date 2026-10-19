# ADR-0055: The `postgres` dependency takes the app's runtime extensions

## Decision

`postgres(contract)`'s dependency end takes an optional second argument,
`{ extensions }`, and Composer passes those extensions to the Prisma ORM
runtime when it builds the binding's client. The application imports the
extensions and passes them. Composer never imports, names or looks up an
extension package itself.

Consider a contract with a vector column. Its schema declares the type, and
its `prisma.config.ts` lists the pgvector pack so that `prisma contract emit`
and the migrations understand it:

```prisma
model Document {
  id        String  @id
  embedding pgvector.Vector(length: 1024)?
}
```

The service that queries it passes pgvector's runtime extension beside the
contract:

```ts
import pgvectorRuntime from '@prisma/orm-extension-pgvector/runtime';
import { postgres } from '@prisma/composer-prisma-cloud/orm';

export default compute({
  name: 'search',
  deps: { db: postgres(appContract, { extensions: [pgvectorRuntime] }) },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
});
```

`db.client` is then built with pgvector's codecs and operations, so
`db.client.orm.public.Document` reads and writes the `embedding` column.
Without the second argument, the first `db.client` access throws the
runtime's own error: "Contract requires extension pack(s) 'pgvector', but
runtime descriptors do not provide matching component(s)."

The option's type is the Prisma ORM runtime's own:
`PostgresDependencyOptions = Pick<PostgresOptionsBase, 'extensions'>`, from
`@prisma/orm-postgres/runtime`. The resource end,
`postgres({ name, contract, config, targetRef? })`, is unchanged.

## Reasoning

**An extension type needs code at runtime, and only the app can supply it.**
A Prisma ORM contract records which extension packs it needs (the
`extensions` map in `contract.json`), but not the code that implements them.
That code is a *runtime extension descriptor*: an object, exported by the
pack's `/runtime` entry, that contributes the codecs which encode and decode
the pack's column types. The runtime refuses to build a client for a
contract whose packs have no matching descriptor. Before this decision the
binding's client was built from the contract and the URL alone, so a
contract with any extension type made `db.client` unusable, and the app's
only way out was to read `db.url` and build its own client. That lost what
the framework's client carries: the connection pool that retries a
cold-start database, the short idle timeout Prisma Postgres needs, and the
pool error handler.

**The framework does not find the descriptor from the contract.** The
contract names the pack (`pgvector`), so Composer could import a package
derived from that name. It does not, for three reasons. Turning a pack name
into a package name is guessing, which the "we don't guess" principle
forbids. Composer would depend on every extension package it might load, or
load one the app never declared. And the descriptor must reach the deployed
service, whose bundle the app builds (ADR-0005), so the import has to be in
the app's code anyway. Passing the descriptor as a value is dependency
injection, the same way every other runtime-specific thing enters the
framework from application code.

**The extensions belong on the dependency, not on `load()` or the
resource.** The dependency declaration is where the service says what it
needs from the database, and it is evaluated in both places that matter: by
the deploy, which only reads its type and contract, and by the service at
boot, where `hydrate` builds the binding. The resource end describes the
database and its migrations; the migrations already get the pack from
`prisma.config.ts`, which the deploy reads by path (ADR-0022). Two services
on one database can each pass the descriptors their own runtime needs.

**The client stays lazy, and so does the check.** ADR-0040 builds the client
on the first `client` access so a service that reads only `url` never pays
for, or fails on, client construction. Composer could compare the
contract's `extensions` map with the descriptors' ids earlier, when
`postgres(contract, options)` is called or at `hydrate`, and fail the
`load()` or even the deploy. It does not, because that check would break
the case ADR-0040 exists for: a service that brings its own client to an
extension-typed database has no reason to pass descriptors, and an early
check would refuse it. The runtime already makes the same comparison when
the client is built, and its error names the missing pack. A Composer error
at the same moment would not add information, and it would need an error
namespace that ADR-0044's closed list does not have. What a user needs that
the runtime's error does not say is where to pass the descriptor; the
guide and the agent skill say it, next to the `postgres()` dependency.

**One copy of the ORM keeps the descriptor and the runtime compatible.**
The app imports the descriptor from its extension package, and Composer
builds the client with the app's copy of `@prisma/orm-postgres`, which is a
peer dependency (ADR-0046). The pack peers on the same ORM, so the
descriptor and the runtime that reads it come from one copy.

## Consequences

- A service whose contract uses an extension type gets the framework-built
  client, with its cold-start retry, idle timeout and pool error handling,
  by passing the pack's runtime descriptor to `postgres()`.
- The app depends on the extension package itself and keeps its version in
  step with `@prisma/orm-postgres`, as the pack's own peer dependency
  requires. Composer adds no dependency.
- A missing descriptor is found on the first `client` access in the running
  service, not at deploy. A test that touches `db.client` finds it before
  that.
- `postgres(contract)` without options behaves exactly as before.
- Only `extensions` is accepted. Other runtime options (`middleware`,
  `log`, `verifyMarker`, `cursor`) are not reachable through the dependency;
  `verifyMarker` in particular stays off, because the deploy is the schema
  check (ADR-0022). Adding another option is a separate decision.

## Alternatives considered

- **Discover the descriptor from the contract's pack ids.** Rejected: it
  guesses a package from a name, hides a runtime dependency from the app's
  build, and makes Composer depend on, or dynamically load, every pack.
- **Read the descriptors from `prisma.config.ts`.** The config lists the
  pack descriptors the ORM's CLI and migrations need (pgvector's `/pack`
  entry), not the runtime ones, and ADR-0022 keeps the config out of the
  app's bundle by passing it as a path. Rejected.
- **Pass the extensions to `service.load()`.** Rejected: the dependency
  declaration is where a service states what it needs, and `load()` takes
  no per-dependency arguments.
- **Check the extensions at declaration or at `hydrate`.** Rejected for the
  reasons in the lazy-check paragraph above: it refuses URL-only consumers
  and repeats a check the runtime makes.
- **Accept every runtime option.** Rejected for now: no app has needed the
  others, and `verifyMarker` would contradict the deploy-time schema check.

## Related

- [ADR-0022](ADR-0022-data-deps-carry-a-prisma-orm-contract.md): data
  dependencies carry a Prisma ORM contract.
- [ADR-0040](ADR-0040-the-orm-binding-carries-the-url-and-a-lazy-client.md):
  the binding carries the URL and a lazy client; this ADR keeps the client
  lazy and passes it the app's extensions.
- [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md):
  the closed list of error namespaces.
- [ADR-0046](ADR-0046-the-orm-facade-is-a-peer-dependency.md): the ORM
  facade is a peer dependency.
- [Architectural principles](../01-principles/architectural-principles.md):
  no globals, runtime-agnostic, we don't guess.
