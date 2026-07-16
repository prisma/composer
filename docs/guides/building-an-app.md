# Building an app

This guide covers everything you reach for once
[Getting started](getting-started.md) has shown you the shape: giving a
service a database (plain or Prisma Next-typed), packaging pieces as reusable
Modules, the cron/storage/streams modules that ship with the framework,
configuration, and secrets.

## How the pieces fit

A Prisma App is a tree of **Modules**. At the leaves are **services** —
`compute()`, the units that run your code — and **resources** — stateful
things like `postgres()`. A parent module wires them together; your code
never participates in the wiring, it just receives the results:

```ts
compute({
  name: 'auth',                 // the service's name in the app graph
  deps: { db: postgres() },     // what it needs   → read via service.load()
  params: { region: string() }, // its config      → read via service.config()
  secrets: { key: secret() },   // its credentials → read via service.secrets()
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: authContract },// what it offers to other services
});
```

Dependencies, config, and secrets are three deliberately separate things with
three separate accessors, so a database can never masquerade as a string and
a credential can never end up in ordinary config. Your code contains no
`process.env` reads and no URLs; that is what makes every environment —
production, a stage, a test — just a different set of injected values.

## Contracts

A **contract** is a service's API written as schemas, and it types both ends
of the edge: the producer's handlers and the consumer's client. Define it
once, in the package of the service that owns it:

```ts
import { contract, rpc } from '@prisma/composer/rpc';
import { type } from 'arktype';

export const authContract = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});
```

On the producer, `serve()` turns the service's `expose` into a fetch handler.
The handler map must cover every method — a missing or wrong-shaped handler
doesn't compile. Each handler receives the validated input (and the service's
own loaded deps as a second argument):

```ts
const handler = serve(service, {
  rpc: {
    verify: async ({ token }) => ({ ok: await check(token) }),
  },
});
```

On the consumer, declare `deps: { auth: rpc(authContract) }` and
`service.load()` returns `{ auth }` — call `await auth.verify({ token })`
like a local function. Inputs and outputs are also validated at runtime, at
the boundary, against the same schemas.

The only contract kind today is RPC over HTTP — no gRPC, WebSockets, or
streaming contracts yet.

## Databases

There are two ways for a service to get a Postgres, depending on how much you
want the framework to do.

### `postgres()` — bring your own client

The dependency delivers connection config — `{ url }` — and nothing else. You
build the client you already know (`pg`, Bun's `SQL`, an ORM) in your server
entry:

```ts
import { SQL } from 'bun';

const { db } = service.load();
const sql = new SQL({ url: db.url, max: 1, idleTimeout: 10 });
```

(Those pool settings are not decorative — Compute scales to zero and idle
connections get closed; see
[Deploying and operating](deploying.md#production-behavior).)

### `pnPostgres()` — a Prisma Next-typed database

If you want typed queries and managed migrations, make the database a
[Prisma Next](https://github.com/prisma/prisma-next) one. `load()` then
returns a client generated from your schema — queries like
`db.orm.public.Product.where({ id }).first()` are compile-time checked, no
SQL strings, no row mapping.

The workflow, once per schema change (all `prisma-next` commands — see the
Prisma Next docs for the details):

1. Edit `contract.prisma` — your schema.
2. `prisma-next contract emit` — regenerates `contract.json` +
   `contract.d.ts` from it.
3. `prisma-next migration plan` — authors the migration into `migrations/`.
4. Deploy. The deploy applies `migrations/` before the service starts —
   there's no `CREATE TABLE IF NOT EXISTS` anywhere in app code.

In your app, the emitted contract is wrapped once, and that one value is
referenced by both the resource and every service that queries it:

```ts
// src/data.ts
import { pnContract } from '@prisma/composer-prisma-cloud/prisma-next';
import type { Contract } from '../contract.d.ts';
import contractJson from '../contract.json' with { type: 'json' };

export const catalogData = pnContract<Contract>(contractJson);
```

The service depends on it:

```ts
deps: { db: pnPostgres(catalogData) }
```

And the module that owns the database provisions it, also naming the
`prisma-next.config.ts` path so the deploy can find `migrations/`:

```ts
const db = provision(pnPostgres({ name: 'database', contract: catalogData, config }));
```

Because both ends share the contract value, the deploy refuses to wire a
service against a database whose schema doesn't match.
[`examples/pn-widgets`](../../examples/pn-widgets/) is the minimal working
version;
[`examples/store/modules/catalog`](../../examples/store/modules/catalog/) is
the full pattern inside a reusable Module.

## Reusable Modules

When a service and its database belong together, package them as a
**Module**: a unit that owns its internals and offers only typed ports. A
consumer provisions the Module and wires its exposed contract — it never
sees, and can never reach, the database inside.

A Module declares its boundary (what it needs, what it offers) in the second
argument, wires its internals in the builder function, and returns the ports
it promised:

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

The root then treats it like any other node:

```ts
const auth = provision(authModule, {
  secrets: { signingKey: envSecret('AUTH_SIGNING_SECRET') },
});
provision(storefrontService, { deps: { auth: auth.rpc } });
```

A Module can also declare boundary `deps` — inputs its parent must supply,
wired exactly like a service's. The root module you already have is just the
outermost Module, with no boundary at all.

`provision(node, opts?)` takes:

- `id` — the node's name in the graph, defaulting to its own `name`. Set it
  explicitly when the default stutters (a service named `auth` inside a
  module named `auth` would read as `auth.auth`).
- `deps` — a value for each declared dependency slot: another provision, or
  an exposed port.
- `secrets` — a binding for each secret need (below).

Two naming rules the platform enforces: provision names must be at least
three characters (call a database `'database'`, not `'db'` — the wiring key
on the service side can still be `db`), and ids must be unique within their
module.

## The building blocks that ship with the framework

These are the Modules you compose instead of building the capability
yourself. Each owns its internals and hands you a typed port, so adding one
is a couple of lines:

| Import | What you get | Exposes |
| --- | --- | --- |
| `cron` from `@prisma/composer-prisma-cloud/cron` | A scheduler that fires your jobs at your service on an interval | nothing |
| `storage` from `@prisma/composer-prisma-cloud/storage` | An S3-backed blob store, credentials included | `store` |
| `streams` from `@prisma/composer-prisma-cloud/streams` | Durable append-only event streams, backed by a `store` | `streams` |

Cron is the one most apps want first. You supply two things — a schedule and
a runner service that exposes the `trigger` contract — and the module does
the rest:

```ts
// service.ts — the runner. The schedule is the single source of truth
// for job ids and intervals.
import { defineSchedule, triggerContract } from '@prisma/composer-prisma-cloud/cron';

export const schedule = defineSchedule({ rotateSpecial: '30s' });

export default compute({
  name: 'promotions',
  deps: { catalog: rpc(catalogContract) },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { trigger: triggerContract },
});
```

```ts
// server.ts — map each job id to work. serveSchedule checks the map
// against the schedule, so an unhandled job doesn't compile.
import { serveSchedule } from '@prisma/composer-prisma-cloud/cron';

const handler = serveSchedule(service, schedule, {
  rotateSpecial: (deps) => deps.catalog.rotateSpecial({}),
});
```

```ts
// module.ts — the cron module needs whatever your runner needs, so the
// root wires it like any other edge.
provision(cron({ schedule, runner: promotionsService }), {
  deps: { catalog: catalog.rpc },
});
```

[`examples/storage`](../../examples/storage/) and
[`examples/streams`](../../examples/streams/) show the other two, including
the streams module's secret binding.

### Where new blocks come from

An **extension** is a package that brings its own Modules, resources, or
deploy target — the same mechanism `@prisma/composer-prisma-cloud` itself
uses. The convention is an npm package named `prisma-composer-*`, which is
how you and your agent find one; an extension is installed like any
dependency and enters the deploy through the `extensions` array in
`prisma-composer.config.ts`.

The ecosystem is new. Today the three Modules above plus the ones you write
are the whole set, so treat `prisma-composer-*` as the place to look rather
than a catalogue that already has what you need.

## Config params

A param is a value you want to configure per environment without a redeploy
of code: a region, a feature flag, a job list. Declare it with a schema —
that schema gives you the TypeScript type *and* validates the stored value at
boot, so garbage config is a loud startup failure, not a runtime surprise:

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

`string()` and `number()` cover the scalars; `param(schema)` takes any
Standard Schema. Params can have a `default` or be `optional`. Read them with
`service.config()` — they never appear in `load()`.

Every service gets a reserved `port` param (default 3000); declaring your own
`port` is an authoring error, caught immediately.

## Secrets

Credentials get their own channel, separate from params, with one rule:
**the value never enters framework config**. The service declares a nameless
need, the root binds that need to a platform environment-variable name, and
the value only ever lives in that platform variable:

```ts
// the service: "I need a signing key" — no name, no value
compute({ /* ... */ secrets: { signingKey: secret() } });

// the root: "that need is the platform variable AUTH_SIGNING_SECRET"
provision(authModule, { secrets: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });

// the server: the only way to the value is an explicit expose()
const { signingKey } = service.secrets(); // SecretBox<string>
signingKey.expose();
```

The `SecretBox` redacts on logging, rendering, and JSON-serialization —
leaking it takes a deliberate `.expose()`. A Module forwards a need up to its
parent without ever learning the platform name, which is what lets a reusable
Module require credentials without dictating your naming.

At deploy time, the value is provisioned from the deploying shell's
environment — so CI (or you) exports `AUTH_SIGNING_SECRET`, and it never
appears in code, state, or generated config.

## Builds

The framework never bundles your code — it assembles what your build
produced, byte for byte. Two build adapters ship:

**`node` — any plain server process.** Point `entry` at a self-contained ESM
file. The shipped tsdown preset produces exactly that (everything inlined
except runtime built-ins):

```ts
import { prismaTsDownConfig } from '@prisma/composer/tsdown';
export default prismaTsDownConfig({ entry: { server: 'src/server.ts' }, outDir: 'dist' });
```

Building two services from one package? Two separate builds into two
`outDir`s, so shared code lands in both.

**`nextjs` — a Next.js app.** `next build` with `output: 'standalone'` is the
whole build; the adapter just needs to know where the app lives:

```ts
build: nextjs({ module: import.meta.url, appDir: '..' })
```

Add `nextjsBuild()` from `@prisma/composer/nextjs/control` to the deploy
config's `extensions`. And remember: any page or action that calls
`service.load()` needs `export const dynamic = 'force-dynamic'`.

## Digging deeper

The design record explains *why* the model is shaped this way:

- [`core-model.md`](../design/10-domains/core-model.md) — the complete
  type-level design.
- [`connection-contracts.md`](../design/10-domains/connection-contracts.md) —
  contracts in depth.
- [`module-composition.md`](../design/10-domains/module-composition.md) —
  boundaries, forwarding, nesting.
- [`config-params.md`](../design/10-domains/config-params.md) — the config
  round trip, and [ADR-0029](../design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md)
  for the secrets model.
- [ADR-0005](../design/90-decisions/ADR-0005-users-build-the-framework-assembles.md)
  — why you build and the framework assembles.
