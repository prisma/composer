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
import { contract, rpc } from '@prisma/composer/service-rpc';
import { type } from 'arktype';

export const authContract = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});
```

On the producer, `serve()` turns the service's `expose` into a fetch handler.
The handler map must cover every method — a missing or wrong-shaped handler
doesn't compile. Each handler receives the validated input, the service's own
loaded deps as a second argument, and an optional third argument carrying the
call's idempotency key (see below — most handlers ignore it):

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

### Calls are authenticated for you

You don't do anything for this. There is no key in your code, your contract,
or your module — but it's worth two minutes, because one consequence looks
like a broken deploy the first time you meet it.

When you deploy, the framework creates an unguessable **service key** for each
dependency you declared, gives it to the consumer's client, and tells the
provider to accept it. Every call carries the key, and `serve()` answers
anything else with `401` before your handler runs. So a provider answers only
the services your app connected to it — which matters, because a deployed
service has a public URL and would otherwise answer the whole internet.

The surprise: **`curl`ing your own endpoint returns `401`.** You aren't one of
the services connected to it, so it turns you away. That's the feature, not a
broken deploy. To exercise a provider by hand, call it through a consumer or
run it locally.

**Locally and in tests, nothing changes.** Only a deploy creates keys, so a
service you run in a terminal, a fake, and `bootstrapService` all accept every
call, and there's no key for you to supply.

### Calls retry safely for you

You don't do anything for this either. A provider that has scaled to zero has
to boot before it answers, and a first call can be dropped mid-connection
while it does. The client absorbs that: every call carries an **idempotency
key**, a dropped call is retried with a backoff, and the provider runs one
call per key — a retry that arrives after the first already ran gets the first
answer back instead of running your handler twice. So `await auth.verify(...)`
just works across a cold start, and it works whether or not the call changes
state. You write nothing; the key is on the request and the deduplication is
in `serve()`.

The deduplication rides on the key, so a request sent *without* one — a `curl`,
any hand-rolled request — simply isn't deduplicated: it runs once, which is what
you'd expect. The generated client always sends a key, so your service-to-service
calls always get it. If a handler needs a stronger guarantee than one instance's
memory — surviving a crash mid-call — its optional third argument carries the key
to write into its own transaction; most handlers never need it.

Two limits worth knowing:

- **A key opens the whole service, not one method.** Any valid key reaches
  every method that service exposes. If two surfaces need separate access,
  make them two services.
- **Each dependency gets its own key**, so one leaking never exposes the
  others. Keys stay the same across redeploys; to replace one, remove the
  dependency (or destroy the stack) and deploy again.

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
returns `{ url, client }`: the raw connection string, plus a client generated
from your schema — queries like
`db.client.orm.public.Product.where({ id }).first()` are compile-time
checked, no SQL strings, no row mapping. The client is constructed on first
access, so a service that brings its own Postgres client reads `db.url` and
still gets contract-checked wiring and deploy-time migrations (ADR-0040).

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

`pnPostgres` is both ends of the edge, told apart by what you pass it. The
contract alone is the dependency end — the service declaring what it queries:

```ts
deps: { db: pnPostgres(catalogData) }
```

An options object is the resource end — the module that owns the database
provisions it, naming the `prisma-next.config.ts` path (relative to the
module file) so the deploy can find `migrations/`:

```ts
const db = provision(
  pnPostgres({ name: 'database', contract: catalogData, config: './prisma-next.config.ts' }),
);
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

## Object Storage

`bucket` is a raw S3-compatible object-store bucket — a flat key-value store
with no higher-level abstractions attached. Import it alongside `postgres` and
use it the same way:

```ts
import { bucket, compute } from '@prisma/composer-prisma-cloud';

export default compute({
  name: 'uploads',
  deps: { store: bucket() },           // dependency end: receives credentials
  // ...
});
```

```ts
// module.ts — provision the bucket resource and wire it to the service
const store = provision(bucket({ name: 'uploads' })); // resource end: provisions + keys
provision(uploadsService, { deps: { store } });
```

Inside the service entry, `load()` hands back
`{ url, bucket, accessKeyId, secretAccessKey }` — the standard S3 config set.
Use any S3-compatible client (`@aws-sdk/client-s3`, `minio`, Bun's S3 API, …):

```ts
import { S3Client } from '@aws-sdk/client-s3';
const { store } = service.load();
const s3 = new S3Client({
  endpoint: store.url,
  bucket: store.bucket,
  credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey },
});
```

A bucket resource uses the same S3 contract kind as the `storage` module's
blob store, so a service declared with `deps: { store: s3() }` — where `s3` is
imported from `@prisma/composer-prisma-cloud/storage` — can also be wired to a
`bucket` resource without any changes to the service declaration.

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

Everything a running service receives arrives through one of three channels,
and choosing the channel is most of the decision:

| The value is… | Declare it as | Provide it | Read it |
| --- | --- | --- | --- |
| produced by another node — a database, another service | a dependency: `deps: { db: postgres() }` | wire it at `provision()` | `service.load()` |
| plain configuration — a region, a flag, an app origin | a param: `params: { region: string() }` | a `default`, a literal at `provision()`, or a per-stage platform variable via `envParam()` | `service.config()` |
| a credential | a secret: `secrets: { key: secret() }` | `envSecret('NAME')` at the root | `service.secrets()`, redacted |

Dependencies are covered above; [secrets below](#secrets). This section is
the middle row.

A param is a value you want to configure without touching code: a region, a
feature flag, a job list. Declare it with a schema —
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
[Standard Schema](https://standardschema.dev) validator (arktype, zod,
valibot — anything implementing the interface). Params can have a `default`
or be `optional`. Read them with
`service.config()` — they never appear in `load()`.

Every service gets a reserved `port` param (default 3000); declaring your own
`port` is an authoring error, caught immediately.

### Binding a param at provision

A `default` is the fallback, not the only source: the `provision()` call can
bind the value, and the binding wins. The service declares what it needs; the
place that provisions it decides where the value comes from:

```ts
// the service declares the param
const web = compute({
  name: 'web',
  params: { appOrigin: string() },
  // ...
});

// a literal — the app knows the value, so it lives in the app's code:
provision(web, { params: { appOrigin: 'https://example.com' } });

// or a platform environment variable, per stage:
import { envParam } from '@prisma/composer-prisma-cloud';
provision(web, { params: { appOrigin: envParam('APP_ORIGIN') } });
```

`envParam('NAME')` is for values the code *can't* know. An app origin is the
canonical case: it's different on production and on every preview stage, and
a stage's public URL doesn't exist until that stage first deploys. Each stage
keeps its own copy of the variable, so one topology serves them all.

How the value travels: **the stage's platform variable is the store; the
deploying shell only seeds it.** At deploy, preflight checks the name exists
for the target stage — a name the stage is missing is copied up from the
deploying shell's environment, and a name absent from both fails the deploy
early, naming the variable. Once the stage has it, your shell no longer
matters. At boot the service reads the variable and hands it to the param's
schema as a raw string — so bind `envParam` to string params. To change the
value later, set it on the platform and redeploy; a running instance's
environment is frozen when the instance is created.

It's still a param: read through `config()`, never redacted. Credentials
belong in secrets, below.
[`examples/env-param`](../../examples/env-param/) is the minimal working
version, including a smoke script that proves the per-stage split.

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

The platform variable is seeded exactly the way an `envParam` one is
([above](#binding-a-param-at-provision)): preflight copies it from the
deploying shell when the stage doesn't have it yet — so CI (or you) exports
`AUTH_SIGNING_SECRET` for a first deploy. The framework itself never holds
the value: not in code, not in deploy state, not in generated config — it
carries only the variable's *name*, and the platform injects the value
straight into the running instance.

## Builds

The framework never bundles your code — it assembles what your build
produced, byte for byte. Two build adapters ship:

**`node` — any plain server process.** Point `entry` at a self-contained ESM
file: everything inlined except runtime built-ins (`bun`, `bun:*`, `node:*`),
which the deploy VM provides. Deploy copies that one file and never ships
`node_modules`, so anything left un-inlined fails at boot. Any bundler that
produces such a file works. With bun:

```sh
bun build src/server.ts --target=bun --outfile dist/server.mjs
```

Building two services from one package? Two separate builds, one per entry,
so shared code lands in both.

If your build emits a **directory** instead — a server plus the client bundle,
CSS and images it serves at runtime, as Bun's HTML import produces — name the
directory with `dir` and the file that boots inside it with `entry`:

```ts
build: node({ module: import.meta.url, dir: '../dist/server', entry: 'server.js' })
```

`dir` resolves relative to your service module, like `entry` does; `entry`
then resolves inside `dir`, and may be nested (`server/start.js`). Deploy
copies the whole tree verbatim and boots the file you named, so the server
finds its siblings exactly where the build left them — resolve them against
`import.meta.url`, not the working directory.

Nothing is guessed: you name the directory and the entry, and that is what
ships. Two things to know:

- The tree must contain no symlinks — the platform's packager rejects them, so
  assembly fails early and names the link rather than shipping a broken
  artifact. Have your build emit real files.
- `entry` must be a file inside `dir`. Pointing it outside with `../` is an
  error, not an escape hatch — only `dir` is copied.

Without `dir` you get the single-file form above, unchanged.

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
  round trip, [ADR-0029](../design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md)
  for the secrets model, and
  [ADR-0032](../design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)
  for provision-time binding and `envParam`.
- [ADR-0030](../design/90-decisions/ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md)
  — why service keys work the way they do.
- [ADR-0005](../design/90-decisions/ADR-0005-users-build-the-framework-assembles.md)
  — why you build and the framework assembles.
