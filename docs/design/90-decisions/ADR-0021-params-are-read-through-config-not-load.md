# ADR-0021: Params are read through config(), separate from load()'s dependencies

## Decision

A service reads its **dependencies** through `load()` and its **config params**
through a sibling method, `config()`. `load()` returns only hydrated
dependencies; `config()` returns only the typed param values. The two never share
a namespace.

```ts
const { db, auth } = service.load();     // dependencies: a Postgres binding, an rpc client
const { port, jobs } = service.config(); // params: typed by their schemas
```

## Reasoning

Dependencies and config params are different things that happen to both be
resolved at boot. A dependency is a wired connection to another node — its value
is a hydrated client or binding. A param is a piece of static configuration — its
value is decoded from storage and validated against a schema. They come from
different places, have different lifecycles, and are declared in different slots
(`deps` vs `params`).

Returning both from one `load()` call merges those two namespaces into a single
object, which creates a real hazard: a dependency named `db` and a param named
`db` collide, and one silently clobbers the other. The service author has no
reason to expect a name chosen for a dependency to conflict with one chosen for a
param — they are separate declaration surfaces — yet a single merged return makes
them share a keyspace.

Splitting the accessors removes the hazard and states the distinction in the API.
`load()` is about wiring; `config()` is about configuration. A reader of a service
entry sees immediately which values are connections to other services and which
are the service's own settings.

## Consequences

- **`load()` returns `HydratedDeps<D>` only**; its return type no longer includes
  param values.
- **`config()` returns `Values<P>`** — the typed, validated param values. Like
  `load()`, it is memoized per process.
- **Dependency and param names can no longer collide**, because they are never
  merged into one object.
- **A service entry that reads a param switches from `load()` to `config()`.** This
  is a visible, mechanical change at each read site.

## Alternatives considered

- **One `load()` returning deps and params merged.** Rejected: it shares a
  namespace between two independent declaration surfaces, so a dep and a param of
  the same name collide and one is silently lost.
- **Namespacing within a single return** (`load().deps.db`, `load().params.port`).
  Rejected: it avoids the collision but keeps one accessor doing two jobs, and
  reads more awkwardly than two purpose-named methods.

## Related

- [`ADR-0018`](ADR-0018-config-params-carry-a-caller-owned-schema.md) — the params
  that `config()` returns.
- [`../10-domains/config-params.md`](../10-domains/config-params.md) — where
  `config()` sits in the runtime path.
