# Building an app

The authoring guide: everything a service can declare, how Modules compose,
and the building blocks that ship with the framework. It assumes you've been
through [Getting started](getting-started.md).

## The model in one paragraph

A Prisma App is a tree of **Modules**. The leaves are **services**
(`compute()` — units that run your code) and **resources** (`postgres()` —
stateful things services depend on). Every dependency is declared on the
service and wired by a parent module; app code receives dependencies from
exactly one place, `service.load()`, and never reads `process.env` or looks a
service up by name. The framework never bundles or transforms your code — you
build it, the deploy assembles the built output
([ADR-0005](../design/90-decisions/ADR-0005-users-build-the-framework-assembles.md)).

A service declaration:

```ts
compute({
  name: 'auth',                 // the node's name; also its default provision id
  deps: { db: postgres() },     // typed dependency slots — read via load()
  params: { region: string() }, // config values — read via config()
  secrets: { key: secret() },   // secret needs — read via secrets()
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: authContract },// ports other services can depend on
});
```

`deps`, `params`, and `secrets` are three separate namespaces with three
separate accessors — a dependency and a config value never masquerade as each
other ([ADR-0021](../design/90-decisions/ADR-0021-params-are-read-through-config-not-load.md)).

## Contracts

A **contract** types the edge between two services. The producer exposes and
serves it; a consumer depends on it and receives a typed client. The contract
lives with the service that owns it:

```ts
import { contract, rpc } from '@prisma/composer/rpc';
import { type } from 'arktype';

export const authContract = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});
```

Producer side — `serve()` turns the service's `expose` into a fetch handler.
The handler map is keyed by the expose port's name, exhaustive at compile
time, and each handler receives the validated input (plus the service's own
loaded deps as a second argument):

```ts
const handler = serve(service, {
  rpc: {
    verify: async ({ token }) => ({ ok: await check(token) }),
  },
});
```

Consumer side — declare `deps: { auth: rpc(authContract) }` and
`service.load()` returns `{ auth }` as a typed client: `await
auth.verify({ token })`. Input and output are validated at the boundary at
runtime, against the same schemas that type both ends.

RPC over HTTP is the only contract kind today — no gRPC, WebSocket, or
streaming contracts.

## Databases

Two kinds of Postgres dependency, by how much the framework does for you:

**`postgres()`** — the binding is `{ url }` and the app owns its client
([ADR-0015](../design/90-decisions/ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md)).
Build whatever client you like in the server entry:

```ts
import { SQL } from 'bun';
const { db } = service.load();
const sql = new SQL({ url: db.url, max: 1, idleTimeout: 10 });
```

(Those pool settings matter in production — see
[Deploying and operating](deploying.md#production-behavior).)

**`pnPostgres(...)`** — a [Prisma Next](https://github.com/prisma/prisma-next)-typed
database ([ADR-0022](../design/90-decisions/ADR-0022-data-deps-carry-a-prisma-next-contract.md)):
`load()` returns a typed client constructed from your data contract, so
queries are compile-time checked against the schema —
`db.orm.public.Product.where({ id }).first()`, no SQL strings, no row
mapping. Three pieces:

- `contract.prisma` — the schema. `prisma-next contract emit` turns it into
  `contract.json` + `contract.d.ts`, which you wrap once:

  ```ts
  // src/data.ts — the ONE value both ends reference
  import { pnContract } from '@prisma/composer-prisma-cloud/prisma-next';
  import type { Contract } from '../contract.d.ts';
  import contractJson from '../contract.json' with { type: 'json' };

  export const catalogData = pnContract<Contract>(contractJson);
  ```

- The dependency end: `deps: { db: pnPostgres(catalogData) }`.
- The resource end (in the module that owns the database): also names the
  `prisma-next.config.ts` path, which the deploy's migration step loads to
  find `migrations/`:

  ```ts
  const db = provision(pnPostgres({ name: 'database', contract: catalogData, config }));
  ```

Migrations are applied at deploy, before the service starts — no
`CREATE TABLE IF NOT EXISTS` in app code. The deploy refuses to wire a
service against a database with a different contract.
[`examples/store/modules/catalog`](../../examples/store/modules/catalog/) is
the complete pattern; [`examples/pn-widgets`](../../examples/pn-widgets/) is
the minimal one.

## Modules

A Module is the unit of composition and reuse: it owns its internals (its
database, its services) and is reachable only through its typed boundary.

**A closed root** — no boundary, only provisions. This is the app:

```ts
export default module('my-app', ({ provision }) => {
  const auth = provision(authModule);
  provision(storefrontService, { deps: { auth: auth.rpc } });
});
```

**A reusable Module** — declares a boundary (what it needs and what it
offers) in the second argument, wires its internals in the builder, and
returns its exposed ports:

```ts
import { module, secret } from '@prisma/composer';
import { postgres } from '@prisma/composer-prisma-cloud';

export default module(
  'auth',
  { secrets: { signingKey: secret() }, expose: { rpc: authContract } },
  ({ secrets, provision }) => {
    const db = provision(postgres({ name: 'database' }));
    const service = provision(authService, {
      id: 'service',
      deps: { db },
      secrets: { signingKey: secrets.signingKey },
    });
    return { rpc: service.rpc };
  },
);
```

A consumer provisions this Module and wires `auth.rpc` — it never sees the
database. A Module can also declare boundary `deps`: inputs the parent
supplies, wired exactly like a service's.

`provision(node, opts?)` accepts:

- `id` — the provision's name in the graph; defaults to the node's own name.
  Give an explicit id when the default would stutter (`auth.auth`).
- `deps` — wire each declared dependency slot to a provisioned ref or an
  exposed port.
- `secrets` — bind each secret need (see § Secrets).

One naming rule bites: the platform rejects provision names shorter than
three characters, so name a database `'database'`, not `'db'`. (The wiring
key — the service's own input name — can still be `db`.)

## Shared modules

First-party reusable Modules ship under `@prisma/composer-prisma-cloud`:

| Import | What it provisions | Exposes |
| --- | --- | --- |
| `cron` from `/cron` | An always-on scheduler firing your schedule at your runner service | nothing |
| `storage` from `/storage` | An S3-backed blob store (own Postgres + minted credentials) | `store` |
| `streams` from `/streams` | Durable append-only event streams, backed by a `store` | `streams` |

Cron end to end. The schedule is the one source of truth for job ids and
intervals; `serveSchedule` is exhaustive over its ids at compile time, so an
unhandled job doesn't compile:

```ts
// service.ts — the runner declares what the jobs need
import { defineSchedule, triggerContract } from '@prisma/composer-prisma-cloud/cron';

export const schedule = defineSchedule({ rotateSpecial: '30s' });

export default compute({
  name: 'promotions',
  deps: { catalog: rpc(catalogContract) },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { trigger: triggerContract },
});

// server.ts — map each job id to work
import { serveSchedule } from '@prisma/composer-prisma-cloud/cron';
const handler = serveSchedule(service, schedule, {
  rotateSpecial: (deps) => deps.catalog.rotateSpecial({}),
});

// module.ts — the cron module's boundary deps mirror the runner's own,
// so the root wires them like any other edge
provision(cron({ schedule, runner: promotionsService }), {
  deps: { catalog: catalog.rpc },
});
```

Storage and streams compose the same way —
[`examples/storage`](../../examples/storage/) and
[`examples/streams`](../../examples/streams/) show the wiring, including the
streams module's secret binding.

## Config params

Params are caller-owned schemas on the declaration
([ADR-0018](../design/90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md)):
the schema types the param and validates the value at boot. `string()` and
`number()` cover the scalars; `param(schema)` wraps any Standard Schema:

```ts
import { param, string } from '@prisma/composer';
import { type } from 'arktype';

compute({
  name: 'scheduler',
  params: {
    jobs: param(type({ jobId: 'string', every: 'string' }).array()),
    region: string({ optional: true }),
  },
  // ...
});
```

Read them with `service.config()`. Facets are `default` and `optional` — they
describe how a value is handled, not what it is. Every service has a reserved
`port` param (default 3000); declaring your own `port` is an authoring error.

## Secrets

Secret values never travel through framework config
([ADR-0029](../design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md)).
A service declares a nameless **need**; the root binds it to a platform
env-var name; the value stays only in that platform variable:

```ts
// the need (service.ts)
compute({ /* ... */ secrets: { signingKey: secret() } });

// the binding (module.ts root)
provision(authModule, { secrets: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });

// the read (server.ts)
const { signingKey } = service.secrets(); // SecretBox<string>
signingKey.expose();                      // the only way to the value
```

The `SecretBox` redacts everywhere except `.expose()` — logging it, rendering
it, or JSON-serializing it never leaks the value. Modules forward needs
without ever learning the platform name (the auth Module above). A secret is
not a param; don't put credentials in `params`.

## Builds

The framework assembles only what you built. For plain server processes, the
shipped tsdown preset makes each entry self-contained (everything inlined
except runtime built-ins):

```ts
import { prismaTsDownConfig } from '@prisma/composer/tsdown';
export default prismaTsDownConfig({ entry: { server: 'src/server.ts' }, outDir: 'dist' });
```

Two services in one package = two separate builds into separate `outDir`s.

For Next.js, `next build` with `output: 'standalone'` is the whole build;
declare it with `nextjs({ module: import.meta.url, appDir: '..' })` from
`@prisma/composer/nextjs`, and add `nextjsBuild()` from
`@prisma/composer/nextjs/control` to the deploy config's `extensions`. One
Next-specific rule: a page that calls `service.load()` needs
`export const dynamic = 'force-dynamic'` — the runtime environment doesn't
exist at build time.

## Further reading

- [`docs/design/10-domains/core-model.md`](../design/10-domains/core-model.md)
  — the complete type-level design.
- [`docs/design/10-domains/connection-contracts.md`](../design/10-domains/connection-contracts.md)
  — contracts in depth.
- [`docs/design/10-domains/module-composition.md`](../design/10-domains/module-composition.md)
  — boundaries, forwarding, nesting.
- [`docs/design/10-domains/config-params.md`](../design/10-domains/config-params.md)
  — the config round trip, end to end.
