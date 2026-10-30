# Building an app

This guide covers everything you reach for once
[Getting started](getting-started.md) has shown you the shape: giving a
service a database (plain or Prisma-ORM-typed), packaging pieces as reusable
Modules, the cron/storage/streams modules that ship with the framework, the
service input — configuration and secrets as one schema — and making a
service reachable from the internet.

## How the pieces fit

A Prisma App is a tree of **Modules**. At the leaves are **services** —
`compute()`, the units that run your code — and **resources** — stateful
things like `rawPostgres()`. A parent module wires them together; your code
never participates in the wiring, it just receives the results:

```ts
compute({
  name: 'auth',                 // the service's name in the app graph
  deps: { db: rawPostgres() },     // what it needs         → read via service.load()
  input: authInput,             // its incoming config   → read via service.input()
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: authContract },// what it offers to other services
});
```

A service that receives no requests and so never listens on its port, such as a scheduler that only calls out, declares `listens: false`. `prisma dev` then reports it running as soon as its process starts, instead of waiting for its port. Every other service must listen on `service.port()`.

Dependencies and input are two deliberately separate channels with two
separate accessors. A dependency is a live connection to another node; input
is data — plain values and credentials together, declared as one schema
([below](#service-input)), where a field typed as the redacting
`SecretString` box can never end up as an ordinary string. Your code contains
no configuration `process.env` reads and no URLs; that is what makes every
environment — production, staging, a test — just a different set of injected
values.

## Contracts

An **RPC contract** is a service's API written as schemas, and it types both ends
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

For an HTTP server the framework does not generate, use a
[raw HTTP connection](#raw-http-connections-and-reverse-proxies) instead.
There are no gRPC, WebSocket or streaming contracts yet.

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

## Raw HTTP connections and reverse proxies

A reverse proxy, a Next.js app or a static file server already speaks HTTP
and has no RPC contract. To call one, the provider exposes
`rawHttpContract` and the caller declares `rawHttp()`:

```ts
import { module } from '@prisma/composer';
import { rawHttp, rawHttpContract } from '@prisma/composer/http';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';

const site = compute({
  name: 'site', deps: {}, expose: { http: rawHttpContract },
  build: node({ module: import.meta.url, entry: '../dist/site/server.mjs' }),
});
const docs = compute({
  name: 'docs', deps: {}, expose: { http: rawHttpContract },
  build: node({ module: import.meta.url, entry: '../dist/docs/server.mjs' }),
});
const gateway = compute({
  name: 'gateway', deps: { site: rawHttp(), docs: rawHttp() },
  build: node({ module: import.meta.url, entry: '../dist/gateway/server.mjs' }),
});

export default module('web', ({ provision }) => {
  const siteRef = provision(site);
  const docsRef = provision(docs);
  provision(gateway, { deps: { site: siteRef.http, docs: docsRef.http } });
});
```

In the gateway, `gateway.load()` returns `{ site, docs }`. Each has a `url`,
to hand to your proxy library, and `fetch(path, init)`, which resolves `path`
against that `url`. The client never leaves its provider's origin by itself:
`fetch` rejects a path that resolves to another host, such as
`//other.example/x` or an absolute URL, and it returns a redirect to you
instead of following it. Pass `redirect: 'follow'` in `init` to follow
redirects. The framework fills in the right origin locally and in each
deployed environment.

The framework checks only that the provider declared an HTTP port: TypeScript
and Load both reject a bare service reference or a port of another kind.
Which paths, methods and headers the provider accepts is your code's
business. A raw HTTP connection has no service key, retry or idempotency
key, and exposing the port adds nothing to the provider's server.

Each dependency appears as a call from the gateway to the upstream in the
application topology, including through module boundaries. Passing a URL as
`input` (for example with `serviceOrigin()`) does not; use it for canonical
link origins, and declare a dependency for every service you call.

## Databases

There are two ways for a service to get a Postgres, depending on how much you
want the framework to do.

### `rawPostgres()` — bring your own client

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

### `postgres()` — a Prisma-ORM-typed database

If you want typed queries and managed migrations, make the database a
[Prisma ORM](https://github.com/prisma/orm) one. `load()` then
returns `{ url, client }` and two more members covered
[below](#client-options-such-as-extension-types): the raw connection string,
plus a client generated from your schema — queries like
`db.client.orm.public.Product.where({ id }).first()` are compile-time
checked, no SQL strings, no row mapping. The client is constructed on first
access, so a service that brings its own Postgres client reads `db.url` and
still gets contract-checked wiring and deploy-time migrations (ADR-0040).

The workflow, once per schema change (Prisma ORM commands, via the `prisma` CLI — see the Prisma ORM docs for the details):

1. Edit `contract.prisma` — your schema.
2. `prisma contract emit` — regenerates `contract.json` + `contract.d.ts` from it.
3. `prisma migration plan --name <slug>` — authors the migration into `migrations/`. On a brand-new project this authors the baseline (empty → your schema); commit `migrations/` with the change.
4. Deploy. The deploy applies `migrations/` before the service starts — there's no `CREATE TABLE IF NOT EXISTS` anywhere in app code. Every service that uses the database waits for its migration: if the migration fails, the new service code does not ship. Old code keeps running against the new schema until the new deployment is live, so a migration must not break the code it replaces.

The deploy is replay-only: it applies the migrations you authored and committed, and it never creates schema itself — a fresh database is brought up by replaying the committed baseline. If no authored path reaches the target contract, the deploy refuses and names the fix: author the missing migration as above, or — when you're just iterating against a local database — bring it along directly with `prisma db update`. Databases whose schema an older framework version synthesized at first deploy need a one-time retrofit; see [Deploying and operating](deploying.md#updating-a-database-whose-schema-an-older-version-synthesized).

In your app, the emitted contract is wrapped once, and that one value is
referenced by both the resource and every service that queries it:

```ts
// src/data.ts
import { dataContract } from '@prisma/composer-prisma-cloud/orm';
import type { Contract } from '../contract.d.ts';
import contractJson from '../contract.json' with { type: 'json' };

export const catalogData = dataContract<Contract>(contractJson);
```

`postgres` is both ends of the edge, told apart by its argument. A
contract is the dependency end — the service declaring what it queries:

```ts
deps: { db: postgres(catalogData) }
```

A `{ name, contract, config }` object is the resource end — the module that owns the database
provisions it, naming the `prisma.config.ts` path (relative to the
module file) so the deploy can reload the emitted `contract.json` and find
`migrations/`:

```ts
const db = provision(
  postgres({ name: 'database', contract: catalogData, config: './prisma.config.ts' }),
);
```

Because both ends share the contract value, the deploy refuses to wire a
service against a database whose schema doesn't match. The migration resource
persists only compact contract identity in deploy state; the full emitted
contract is reloaded from `prisma.config.ts` at reconcile time. If that
artifact is missing, unreadable, or no longer matches the declared contract,
the deploy fails before touching the database.
[`examples/orm-demo`](../../examples/orm-demo/) is the minimal working
version;
[`examples/store/modules/catalog`](../../examples/store/modules/catalog/) is
the full pattern inside a reusable Module.

### Client options, such as extension types

`load()` hands the service a binding with three ways to reach the database.
All of them share one connection pool, which retries a database that is
still starting and drops idle connections before Prisma Postgres closes
them:

- `db.client` is the typed client with default options.
- `db.clientWith(options)` builds a typed client with the Prisma ORM
  runtime's options, such as `extensions`, `middleware` or `log`. Call it
  once, at module scope.
- `db.connection` is the pool itself, in the form the runtime's `binding`
  option takes, for an app that builds its client entirely itself.

The options belong to the code that uses the client, not to the dependency
declaration, which only states what the service needs.

If your schema uses a column type from a Prisma ORM extension pack, such as
`embedding pgvector.Vector(length: 1024)?` with
`@prisma/orm-extension-pgvector` listed in `prisma.config.ts`, the client
needs that pack's runtime extension. Install the pack in the app at exactly
the version of `@prisma/orm-postgres` that Composer names, and pass its
runtime extension:

```ts
import pgvectorRuntime from '@prisma/orm-extension-pgvector/runtime';

const { db } = service.load();
export const orm = db.clientWith({ extensions: [pgvectorRuntime] });
```

Composer does not look extensions up from the contract. If you use
`db.client` with such a contract, the first access throws
`Contract requires extension pack(s) 'pgvector', but runtime descriptors do
not provide matching component(s)`. A service that reads only `db.url`
needs no extensions.

The exact version matters. The pack depends on the ORM's shared packages
(`@prisma/orm-framework`, `@prisma/orm-family-sql`) at its own exact
version, so a pack version different from the facade's installs a second
copy of them. The runtime extension then comes from one copy and the client
from the other, and the client rejects or mishandles it without a clear
error.

## Reusable Modules

When a service and its database belong together, package them as a
**Module**: a unit that owns its internals and offers only typed ports. A
consumer provisions the Module and wires its exposed contract — it never
sees, and can never reach, the database inside.

A Module declares its boundary (what it depends on, what it exposes) in the second
argument, wires its internals in the builder function, and returns the exposed
interfaces it promised. The builder function receives `provision`, the boundary's
forwarded `deps`, the module's `input` ([below](#a-modules-input)), and `environment`, whose `name` is a value
([below](#values-that-differ-per-environment)):

```ts
import { module } from '@prisma/composer';
import { secretString } from '@prisma/composer/arktype';
import { rawPostgres } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

export default module(
  'auth',
  { input: type({ signingKey: secretString() }), expose: { rpc: authContract } },
  ({ input, provision }) => {
    const db = provision(rawPostgres({ name: 'database' }));
    const service = provision(authService, {
      id: 'service',
      deps: { db },
      input: { signingKey: input.signingKey },
    });
    return { rpc: service.rpc };
  },
);
```

The module declares `signingKey` as a `secretString()` field of its input and
passes it on without learning the platform variable's name. Inside, the field
is just another leaf of the service's input binding ([below](#service-input)).

The root then treats it like any other node:

```ts
const auth = provision(authModule, { input: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });
provision(storefrontService, { deps: { auth: auth.rpc } });
```

A Module can also declare boundary `deps` — dependencies its parent must supply,
wired exactly like a service's. The builder function receives them as `deps`,
ready to forward into a `provision()` call. (Before Composer 0.36 this field was
called `inputs`; rename it in the builder function's destructuring.) The root module you already have is just the
outermost Module, with no boundary at all.

`provision(node, opts?)` takes:

- `id` — the node's name in the graph, defaulting to its own `name`. Set it
  explicitly when the default stutters (a service named `auth` inside a
  module named `auth` would read as `auth.auth`).
- `deps` — a value for each declared dependency slot: another provision, or
  an exposed port.
- `input` — the service's or module's input binding; required exactly when
  the node declares an input schema.

Two naming rules the platform enforces: provision names must be at least
three characters (call a database `'database'`, not `'db'` — the wiring key
on the service side can still be `db`), and ids must be unique within their
module.

### A module's input

A module declares its configuration as one `input` schema, as a service does
([below](#service-input)), and whoever provisions it binds `input`:

```ts
import { module, resolve } from '@prisma/composer';
import { field, secretString } from '@prisma/composer/arktype';
import { envSecret } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

const email = module(
  'email',
  { input: type({ from: 'string', deliveryCredential: secretString(), 'replyTo?': field(type('string')) }) },
  ({ input, environment, provision }) => {
    const sender = resolve([input.from, environment.name], ([from, name]) =>
      name === 'production' ? from : `${name}+${from}`);
    provision(emailService, {
      id: 'service',
      input: { from: sender, replyTo: input.replyTo, deliveryCredential: input.deliveryCredential },
    });
  },
);

export default module('shop', ({ provision }) => {
  provision(email, {
    input: { from: 'shop@example.com', deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') },
  });
});
```

`prisma deploy --environment staging` gives `shop.email.service` the input
`{ from: 'staging+shop@example.com', deliveryCredential:
envSecret('EMAIL_DELIVERY_CREDENTIAL') }`.

- The body receives each field as a [value](#values-that-differ-per-environment).
  It can pass a field into a `provision()` binding, or, if the field is
  plain, list it as a `resolve()` dependency to compute with it.
- Reading a field in the body fails the deploy with a message naming the
  field: a template literal, `String()`, arithmetic, `JSON.stringify` or
  `Object.keys` on `input.domain` reports that `input.domain` of the module is
  a value, not its real value.
- A field exists only under a plain object. A path into a string, an array or
  a secret, such as `input.domain.length` or `input.tags[0]`, fails the deploy
  with a message saying that `input.domain` has no fields.
- A truthiness check such as `if (input.enabled)` is not caught. The field is
  an object, so the check always passes and the branch always runs:
  `if (input.enabled) provision(extra)` provisions `extra` in every
  environment. A module's structure cannot depend on its input; to provision
  something only sometimes, let the parent decide whether to provision it.
- An optional field the binding leaves out is a key left out: above, the
  service's input has no `replyTo` key.
- The module's schema checks the binding when the deploy loads the graph, so
  a mistake fails before anything reaches the platform.
- A root module's input is filled from the config adapters ([Values from outside the code](#values-from-outside-the-code)).
- A module's `input` takes every source a service's does. Its schema checks
  `envParam()`'s value, and checks each of the other three as its
  **pointer**: the object that names the platform variable the service
  reads at boot. A `secretString()` field accepts the pointer of
  `envSecret()` and of a redacted `generatedParam()`. A plain field accepts
  no pointer, so a field bound to `serviceOrigin()` or a plain
  `generatedParam()` is wrapped with `field()`, below.
- `field()`, from `@prisma/composer/arktype` or `@prisma/composer/zod`,
  wraps one leaf field's schema: `type({ from: field(type('string')) })` or
  `z.object({ from: field(z.string()) })`. A wrapped field also accepts a
  plain pointer, which stands for a value known only at boot such as
  `serviceOrigin()`, so in the body `input.from` is typed
  `Value<string | Pointer<string>>`. Pass it on into another wrapped field or
  a service's input; a plain `string` field refuses it at compile time. For a
  value that is not a pointer, a wrapped field reports the plain field's
  error, except that ArkType reports a missing key as
  `from must be a string or an object (was missing)`. Wrap leaves, never an
  object schema, and with ArkType put a default outside the wrapper:
  `field(type('string')).default('x')`. With another Standard Schema library,
  `Pointer`, `isPlainPointer()` and `isSecretPointer()` from
  `@prisma/composer` are what `field()` and `secretString()` check. Wrap every leaf field of a reusable module's schema other than a `secretString()` field, unless a `resolve()` lists it: the module then takes a literal, a deploy-time value or a value known only at boot, whichever its caller has. In the example above, `from` stays plain because a `resolve()` computes with it, and `replyTo` is wrapped. A root's fields stay plain too, because the config pool never holds a pointer. Never wrap a `secretString()` field: `field(secretString())` would accept a plain pointer into a secret field, and the service would then fail at boot.
- A body reaches only the keys every member of a union schema has, and has no
  element access into an array field. To narrow, forward the whole `input`,
  or narrow inside a `resolve()` function.
- Before Composer 0.37, a module declared per-key `params` with `paramNeed()`
  and `secrets` with `secret()`, bound with
  `provision(module, { params, secrets })`. Both are gone, and `module()` and
  `provision()` refuse them with an error naming `input`. Declare each one as a
  field of the module's `input` schema, a secret as a `secretString()` field,
  and bind them all with `input`; `auth()` and `email()` take `input` the same
  way. A service's `params` do not change.

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

A runner that declares an `input` schema ([below](#service-input)) takes its
binding on `cron()` itself, with `envSecret(...)` where the schema expects a
secret. It is required exactly when the runner declares a schema, the same
rule `provision()` applies:

```ts
provision(
  cron({
    schedule,
    runner: ingestService,
    input: { token: envSecret('INGEST_TOKEN') },
  }),
  { deps: { catalog: catalog.rpc } },
);
```

**The scheduler is the one service in your app that never sleeps.** Compute
scales an idle service to zero, and the scheduler receives no requests of its
own, so it holds the platform's keep-awake guard for its whole lifetime. One
warm instance per app is the cost of the clock; the runner sleeps like any
other service and wakes when the scheduler calls it.

[`examples/storage`](../../examples/storage/) and
[`examples/streams`](../../examples/streams/) show the other two, including
the streams module's secret binding.

### Where new blocks come from

An **extension** is a package that brings its own Modules, resources, or
deploy target — the same mechanism `@prisma/composer-prisma-cloud` itself
uses. The convention is an npm package named `prisma-composer-*`, which is
how you and your agent find one; an extension is installed like any
dependency and enters the deploy through the `extensions` array in the
`composer` section of `prisma.config.ts`.

The ecosystem is new. Today the three Modules above plus the ones you write
are the whole set, so treat `prisma-composer-*` as the place to look rather
than a catalogue that already has what you need.

## Service input

Everything a running service receives arrives through one of two channels,
and choosing the channel is most of the decision:

| The value is… | Declare it as | Provide it | Read it |
| --- | --- | --- | --- |
| produced by another node — a database, another service | a dependency: `deps: { db: rawPostgres() }` | wire it at `provision()` | `service.load()` |
| anything else — a region, a flag, a job list, a credential | one field of the service's `input` schema | bind it at `provision()`: a literal, `envParam()`, `envSecret()`, or a value from `resolve()` | `service.input()` |

Dependencies are covered above. This section is the second row.

A service declares its whole incoming configuration — plain values and
credentials together — as **one
[Standard Schema](https://standardschema.dev)** (arktype, zod, valibot —
anything implementing the interface). The schema gives you the TypeScript
type *and* validates the assembled input at deploy and again at boot, so
garbage config is a loud failure, not a runtime surprise. A credential is
simply a field typed as the framework's redacting `SecretString` box:

```ts
import { secretString } from '@prisma/composer/arktype';
import { type } from 'arktype';

const schedulerInput = type({
  jobs: type({ jobId: 'string', every: 'string' }).array(),
  'region?': 'string',
  apiKey: secretString(),
});

compute({ name: 'scheduler', input: schedulerInput, /* ... */ });
```

With Zod, import `secretString` from `@prisma/composer/zod` instead:
`z.object({ apiKey: secretString() })`. With another Standard Schema
library, accept a value for which `isSecretString()` or `isSecretPointer()`
from `@prisma/composer` is true.

These helpers use your app's copy of the schema library, so the app installs
it: `arktype` for `@prisma/composer/arktype`, which supports ArkType 2, and
`zod` for `@prisma/composer/zod`, which supports Zod 4. Composer installs
neither.

Because the input is a real schema, legality can be conditional — "no
`stripeSecretKey` unless billing is on" is a union, not a framework feature,
and `service.input()` narrows it like any other TypeScript union:

```ts
const chatInput = type({ stripeEnabled: 'false' }).or(
  type({ stripeEnabled: 'true', stripeSecretKey: secretString() }),
);

const chat = compute({ name: 'chat', input: chatInput, /* ... */ });
```

Every service also gets a reserved `port` (default 3000), outside the input
schema and read through its own typed accessor — `service.port()`, a sibling
of `service.origin()` — so `Bun.serve({ port: service.port() })` listens
where Compute routes, with no `process.env` in your code. (The framework
also exports the resolved port as the `PORT` environment variable, but that
is only for a server it does not write and cannot call — Next.js's
standalone `server.js`, which binds `PORT` itself.)

### Binding the input at provision

The service declares what shapes are legal; the place that provisions it
decides where each value comes from. The binding is a plain object mirroring
the schema's shape whose leaves are literals, `envParam(...)`,
`envSecret(...)`, or values from `resolve()`
([below](#values-that-differ-per-environment)):

```ts
import { envParam, envSecret } from '@prisma/composer-prisma-cloud';

provision(chat, {
  input: {
    stripeEnabled: true,
    appOrigin: envParam('APP_ORIGIN'),
    stripeSecretKey: envSecret('STRIPE_SECRET_KEY'),
  },
});
```

Secretness is enforced by validation, not annotation: binding a plain
literal where the schema expects a `SecretString` fails the deploy (a
credential almost landed in plain config), and binding `envSecret` where the
schema expects a string fails the same way. Neither side can silently
misclassify a credential.

**A field bound to `serviceOrigin()` or `generatedParam({ redacted: false })`
is wrapped.** Their value exists only at boot, so at deploy the schema sees
a pointer to the platform variable, and only a field wrapped with `field()`,
from `@prisma/composer/arktype` (or `@prisma/composer/zod`), accepts it:
`type({ returnUrl: field(type('string')) })`. A plain `'string'`
field fails the deploy, and in a module's binding it fails to compile. A
redacted `generatedParam()` is a secret, so its field is `secretString()`.
In the service a wrapped field reads as its inner type:
`service.input().returnUrl` is a `string`, because at boot the pointer has
been replaced by the variable's text. `mockService()` takes the input
double in the same shape.

An ArkType schema with a `SecretString` field cannot also transform its
input. A morph anywhere in the schema, such as `'string.trim'`,
`.pipe()` or a wrapped transforming field like
`field(type('string.integer.parse'))`, and deleting undeclared keys with
`'+': 'delete'`, make ArkType copy the whole input, and a copied
`SecretString` loses its value, so the service could not read the secret at
boot. The deploy checks for this and refuses such a schema, naming the
secret field. Do the transform in the service code instead. A Zod schema
keeps the secret box when it transforms, so it can do both.

**`envParam('NAME')`** is for plain values the code *can't* know. An app
origin is the canonical case: it's different on production and on every
preview environment. The deploy reads the variable from the config pool: by default the shell that runs `prisma deploy` or `prisma dev`, or the `config` adapters you list ([Values from outside the code](#values-from-outside-the-code)), and writes its value into
the service's input. So set it in that shell for every deploy; in CI, export
it per environment. An unset or empty variable leaves the key out, and the
schema decides ([below](#absence-is-the-schemas-call)). The value is a string,
so bind `envParam` to string fields. To change it, deploy again with the new
value. [`examples/env-param`](../../examples/env-param/) is the minimal working
version, including a smoke script that proves the per-environment split.

**`envSecret('NAME')`** is for credentials, with one rule: **the value never
enters framework config**. Each environment keeps its own copy of the
platform variable, and that copy is the store: at deploy, preflight checks
that the environment has the variable, and copies a missing one up from the
secrets pool: by default the deploying shell, so CI (or you) exports `STRIPE_SECRET_KEY` for a first
deploy. The framework carries only the variable's *name*; the platform
injects the value straight into the running instance. What your code gets is
a `SecretString` box that redacts on logging, rendering, and
JSON-serialization — leaking it takes a deliberate `.expose()`:

```ts
const input = service.input();
if (input.stripeEnabled) stripe(input.stripeSecretKey.expose());
```

A reusable Module takes a secret as a `secretString()` field of its `input`
and passes it on without ever learning the platform name
([above](#reusable-modules)), which is what lets
a Module require credentials without dictating your naming.

### Absence is the schema's call

An env-bound field whose variable is unset (or empty) in the config pool
resolves to *key omitted*; whether that is legal is the schema's call — an
optional field, a union arm, or a validation error that fails the deploy. A
credential for an off-by-default feature is an ordinary optional
`SecretString` field, not a framework flag. Because an omitted key can also
be a typo'd variable name, the deploy report prints every key that resolved
absent.

### What travels

The deploy validates the resolved binding, applies the schema's defaults,
and serializes the result into one document row, with each secret as a
pointer naming the platform variable that holds the value — never the value
itself:

```json
{ "stripeEnabled": true, "stripeSecretKey": { "$secret": "STRIPE_SECRET_KEY" } }
```

At boot the framework swaps each pointer for a redacting box over the named
variable, validates against the schema again, and `service.input()` returns
the typed object. The document is secret-free by construction, which is why
the deploy report can print it verbatim.

## Values that differ per environment

The graph is the same in every environment: the same services, the same
databases, the same wiring. What may differ is configuration. A module body
computes it with `resolve()`, from the name of the environment being
deployed:

```ts
import { module, resolve } from '@prisma/composer';

export default module('shop', ({ environment, provision }) => {
  const greeting = resolve([environment.name], ([name]) => `hello from ${name}`);
  const shout = resolve([greeting], ([text]) => text.toUpperCase());
  provision(echoService, { input: { greeting: shout } });
});
```

```sh
prisma deploy                          # echo's greeting input is "HELLO FROM PRODUCTION"
prisma deploy --environment staging    # "HELLO FROM STAGING"
prisma dev                             # "HELLO FROM DEV"
```

`environment.name` and the result of `resolve()` are **values**: stand-ins
for data that is known only once the deploy knows which environment it is
deploying. The module body cannot read a value, compare it or branch on it.
It can only pass it on: as a dependency of another `resolve()`, as a leaf of
a service's or a module's input binding at any depth, as a service param, as
one of a `resource()` node's `props`, or as a
[public URL's `url`](#a-hostname-per-environment). A field of a module's
`input` is a value too ([A module's input](#a-modules-input)). A value cannot
be a provision id or a `deps` entry.

`resolve(dependencies, fn)` lists the values it depends on, and `fn`
receives their real values as one tuple, in the same order. After every
module body has run, the deploy runs each `fn` once, dependencies first, and
puts its result where the value was bound. `fn` returns plain data: strings,
finite numbers, booleans, `null`, arrays and plain objects. It runs
synchronously.

Two rules follow from running `fn` after the module bodies:

- **`fn` cannot add to the graph.** Calling `provision()` inside `fn` fails
  the deploy. Provision the node in the module body and pass the value into
  it.
- **`fn` must be a pure function of its dependencies.** A deploy runs it in
  two processes, the `prisma` CLI and the process that deploys, and each
  must compute the same graph. Removing an environment with the `destroy`
  operation runs every `fn` too, for the environment being removed, and
  every `prisma dev` rebuild runs them again. A `fn` that reads the clock, a
  random number, a file or an environment variable deploys a graph nobody
  checked. To retire an environment, keep its case in every `fn` until the
  `destroy` operation for it has finished.

Each of these stops `prisma deploy` or `prisma dev` before anything reaches
the platform, with a message that names the binding the value sits in, such as
`input key "greeting" of service "shop.echo"`:

- `fn` throws. The message carries the thrown error's message, and the
  thrown error is its cause.
- `fn` returns `undefined`, at the top or anywhere inside its result. Return
  a result for every environment; Composer never picks a default.
- `fn` returns a value. List that value as a dependency instead; `fn`
  receives its real value.
- `fn` returns a source, such as `envSecret()` called inside `fn`.
- `resolve()` lists a value known only at boot, or a field whose real value
  holds one ([below](#sources-in-resolve)).
- `resolve()` lists `envParam('NAME')` and the variable is unset or empty.
- `fn` returns a Promise, a function, a class instance or anything else
  that is not plain data.
- A value depends on itself.

When a dependency's `fn` is the one that failed, the message says so: it
starts `A resolve() function that … depends on`.
[`examples/env-param`](../../examples/env-param/) serves a value computed
from the environment's name.

### Sources in resolve()

`envParam()` is known at deploy, so `resolve()` can list it: `fn` receives
the variable's value at deploy, read from the config pool. `envSecret()`,
`generatedParam()` and `serviceOrigin()` are known only at boot: the deploy
never holds a secret, and it creates a generated value or a service's origin
after it has run `fn`. So `fn` would have nothing to compute with, and
`resolve()` cannot list them. Nor can it list a module's input field wrapped
with `field()` or typed `secretString()`, because its real value may be one of
them. A dependency must be a **deploy-time value**: `environment.name`,
another `resolve()` result, `envParam()`, or a plain field of a module's
input. Bind the other sources directly:

```ts
import { module, resolve } from '@prisma/composer';
import { field, secretString } from '@prisma/composer/arktype';
import { envParam, envSecret, serviceOrigin } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

const billing = module(
  'billing',
  { input: type({ greeting: 'string', stripeKey: secretString(), returnUrl: field(type('string')) }) },
  ({ input, provision }) => {
    provision(billingService, {
      id: 'service',
      input: { greeting: input.greeting, stripeKey: input.stripeKey, returnUrl: input.returnUrl },
    });
  },
);

export default module('shop', ({ provision }) => {
  provision(billing, {
    input: {
      greeting: resolve([envParam('GREETING')], ([greeting]) => greeting.toUpperCase()),
      stripeKey: envSecret('STRIPE_KEY'),
      returnUrl: serviceOrigin('shop.web'),
    },
  });
  // … shop.web
});
```

`GREETING=hi prisma deploy --environment staging` gives `shop.billing.service`
the input binding `{ greeting: 'HI', stripeKey: envSecret('STRIPE_KEY'),
returnUrl: serviceOrigin('shop.web') }`.

Listing a value known only at boot, such as
`resolve([envSecret('STRIPE_KEY')], ([key]) => …)`, fails to compile, with a
type error that says a dependency must be a deploy-time value:

```text
error TS2322: Type 'SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>' is not assignable to type '"a resolve() dependency must be a deploy-time value, never a value known only at boot or a field wrapped with field(); to compute with an input field, declare it plain"'.
```

A second error can follow where the result is used, because TypeScript types
the result of a call that fails as `Value<unknown>`. The compiler cannot see
every case: a field typed `unknown`, a schema without type information and a
cast all compile. So the deploy also refuses a dependency whose real value is
a value known only at boot, or holds one at any depth, before anything
reaches the platform. The message names the field and says what to do
instead. For a wrapped field, it says to declare the field plain:

```text
The resolve() function for input key "url" of service "shop.email.service" lists input.from of module "shop.email", whose real value is serviceOrigin('shop.web'), a value known only at boot. A resolve() dependency must be a deploy-time value. To compute with input.from, declare it plain, without field(), and bind it to deploy-time data.
```

For a secret field, the message says to pass the field on into a binding and
read it in the service. For a source listed directly, such as `envSecret()`,
it says to bind the source directly into the input of the service that reads
it.

To use a different secret in each environment, give the secret one name and
set a different value for it on each environment, instead of choosing between
two names in `resolve()`.

Turning `envParam()` itself into text in a module body, such as
`` `${envParam('GREETING')}` ``, fails the deploy, as reading an input field
does. List it in `resolve()` to compute with its value.

## Values from outside the code

```ts
// prisma.config.ts
import { defineConfig as composer, dotenv, environmentVariables } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';
import { definePrismaConfig } from 'prisma/config';

export default definePrismaConfig({
  composer: composer({
    entry: './module.ts',
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
    config: [dotenv(), environmentVariables()],
    secrets: [dotenv(), environmentVariables()],
  }),
});
```

```ts
// module.ts: the root declares its input; the deploy fills it from the config pool
export default module(
  'shop',
  { input: type({ EMAIL_FROM: 'string', 'SITE_HOSTNAME?': 'string' }) },
  ({ input, environment, provision }) => {
    const web = provision(webService, {
      input: { from: input.EMAIL_FROM, stripeKey: envSecret('STRIPE_KEY') },
    });
    const url = resolve([input.SITE_HOSTNAME, environment.name], ([hostname, name]) =>
      hostname !== undefined ? publicUrl.hostname(hostname) : publicUrl.prismaBuild());
    provision(publicUrl({ name: 'site', url, target: web.http }));
  },
);
```

A root module declares `input` like any other module, and the deploy fills it
from the `config` adapters.

Each adapter receives the environment's name and returns values. When two
adapters return the same top-level key, the later one in the list wins.

Without `config` or `secrets`, both read the process environment. A list you
write replaces that default, so list `environmentVariables()` to keep reading
the shell.

`dotenv()` reads `.env`, `.env.local`, `.env.<environment>` and
`.env.<environment>.local` beside `prisma.config.ts`, in that order, and a
later file wins. An environment name with `/` is encoded in the file name:
the environment `feature/x` reads `.env.feature%2Fx`.

`envParam('NAME')` reads `NAME` from the config pool.

The `secrets` adapters fill a missing `envSecret()` platform variable at
deploy, and give `prisma dev` its secrets.

A root's input takes no secret, so bind `envSecret()` inside the body, as
`stripeKey` is above.

Pass the root's input fields on one by one, as `from: input.EMAIL_FROM` is
above. The root's whole `input` is the whole config pool, which by default
holds every variable of the shell, secrets included, so Load refuses it in a
binding or a `resolve()` dependency.

The root's schema checks the config pool before anything is created, so a
missing value fails with the schema's message.

A value in `.env` or `.env.local` is read by every environment, including a
`prisma deploy` to `production` from your machine.

Composer reads the adapters in the CLI and again in the deploy engine's
process, so an adapter must return the same values both times.

`PRISMA_SERVICE_TOKEN` and `PRISMA_WORKSPACE_ID` still come from the shell.

An adapter is any function, so a project can write its own.

## Making a service public

A service is reachable from the internet only through a **public URL** that
you declare. A public URL depends on the HTTP interface a service exposes, and
exposes nothing itself. Provision it where the hostname is decided, usually
in the root module:

```ts
// web/src/service.ts
import { rawHttpContract } from '@prisma/composer/http';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';

export default compute({
  name: 'web', deps: {}, expose: { http: rawHttpContract },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
});
```

```ts
// module.ts
import { module } from '@prisma/composer';
import { publicUrl } from '@prisma/composer-prisma-cloud';
import webService from './web/src/service.ts';

export default module('shop', ({ provision }) => {
  const web = provision(webService);
  provision(publicUrl({ name: 'site', url: 'shop.com', target: web.http }));
});
```

`publicUrl()` takes three parameters:

- `name` gives the public URL its address, `shop.site`, like any other node.
- `target` is the HTTP interface the service exposes, here `web.http`. It
  must be a [raw HTTP interface](#raw-http-connections-and-reverse-proxies):
  wiring an RPC interface fails the type check. A module's exposed HTTP
  interface works too: the public URL serves the service inside the module
  that exposes it.
- `url` says which hostname serves the service. It is required: leaving it
  out throws.

`url` takes one of two strategies:

- `publicUrl.prismaBuild()` serves the service at its `prisma.build`
  hostname, the one the platform gives every service. It creates nothing on
  the platform, and the deploy reports the service's URL for the public URL.
- `publicUrl.hostname('shop.com')` serves the service at a hostname you
  name. A bare string, `url: 'shop.com'`, means the same. On Prisma Cloud
  the deploy attaches the hostname to the service as a custom domain, once
  the service's new deployment is live.

One public URL serves one hostname. To serve `shop.com` and `www.shop.com`,
provision two public URLs wired to the same interface. Two public URLs in one
app may not name the same hostname: the deploy and `prisma dev` stop before
changing anything, naming both public URLs.

`publicUrl()` checks a hostname as soon as it runs. It trims the hostname,
drops one trailing dot and lowercases it. It throws, naming the public URL and
the problem, for a scheme such as `https://`, a path, a port, a `*` label, an
IP address, fewer than two labels, a label that is not 1 to 63 characters of
`a-z`, `0-9` and `-` or that starts or ends with `-`, or a hostname longer
than 253 characters:

```text
publicUrl("site"): "https://shop.com" has a scheme. Pass the hostname alone, without "https://".
```

### A hostname per environment

The hostname usually differs per environment, so `url` is usually a
[value](#values-that-differ-per-environment). `fn` returns either strategy,
or a bare string:

```ts
import { module, resolve } from '@prisma/composer';
import { publicUrl } from '@prisma/composer-prisma-cloud';

export default module('shop', ({ environment, provision }) => {
  const web = provision(webService);
  const url = resolve([environment.name], ([name]) =>
    name === 'production' ? 'shop.com' : publicUrl.prismaBuild());
  provision(publicUrl({ name: 'site', url, target: web.http }));
});
```

Production serves at `shop.com`, and every other environment at its
service's `prisma.build` hostname. The graph is the same in every
environment; only the resolved `url` differs. A value is checked once it
resolves, so a `fn` that returns anything else stops `prisma deploy` and
`prisma dev` before any of the app's resources are created or changed:

```text
shop.site: url resolved to 42, which is not a hostname or a public URL strategy.
```

### Before you name a hostname

The deploy attaches a named hostname to the service straight away, and the
platform refuses it unless two DNS records are already published:

- a TXT record at `_prisma-verification.<hostname>` carrying your
  workspace's verification value, which proves you own the hostname, and
- a CNAME record that points the hostname at the platform.

If either is missing, the deploy fails with the platform's error, such as
`domain-ownership-required` for a missing TXT record. Publish the records,
then deploy again. Until a hostname can be declared before its DNS is ready,
use `publicUrl.prismaBuild()` for every environment whose DNS is not set up.

Until the next Composer release, a named hostname works only in the production
environment, the one on the project's default branch. Use
`publicUrl.prismaBuild()` in every other environment.

Changing a hostname that is serving to one whose records are not published
fails the deploy too, and the old hostname keeps serving. The deploy creates
the new custom domain before it removes the old one, and stops when the
platform refuses the new one.

To move a hostname to another service, remove its public URL and deploy, then
add it on the new service and deploy again. The hostname does not serve
between the two deploys.

### Under `prisma dev`

`prisma dev` serves every service on its local URL. It ignores a named
hostname, and prints one warning per public URL that names one:

```text
shop.site names the hostname shop.com. prisma dev ignores it and serves the service on its local URL.
```

This holds whatever name `--environment` gives: the local target ignores
hostnames in every environment.

### A service with no public URL

A service with no public URL is meant to be reached only by other services
in the app. Today the platform still gives every service a `prisma.build`
hostname, so such a service is reachable there. When the platform makes that
hostname opt-in, your code does not change.

[`examples/env-param`](../../examples/env-param/) makes its service public at
its `prisma.build` hostname.

## Builds

The framework never bundles your code — it assembles what your build
produced, byte for byte. Two build adapters ship:

**`node` — any plain server process.** Point `entry` at the file your build
produced. By default deploy copies exactly that and never ships
`node_modules`, so the build must inline everything except runtime built-ins
(`bun`, `bun:*`, `node:*`), which the deploy VM provides. Any bundler that
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

- Symlinks are kept as symlinks, never followed and copied. A link whose target
  resolves inside the built output ships as-is. A link that points outside it,
  or at something that isn't there, fails the deploy with an error naming the
  link, rather than shipping a broken artifact or packaging files from your
  machine.
- `entry` must be a file inside `dir`. Pointing it outside with `../` is an
  error, not an escape hatch. Only `dir` is copied verbatim.

**Packages your build leaves external.** Both forms take `dependencies`, which
says what your build did with installed packages, in the words bundlers use
(esbuild's and Rollup's `external`, Vite's `ssr.external`):

- `'bundled'`, the default: the build inlined its packages. Deploy copies
  exactly what you built.
- `'external'`: the build left packages as imports. Deploy traces `entry` and
  stages the installed packages it imports beside the output, keeping their
  `node_modules` layout. This works for the single-file form too: deploy then
  stages the packages that one file imports. If that file also imports other
  files from your build, use the directory form.

```ts
// The build leaves packages external, so stage them from node_modules.
build: node({ module: import.meta.url, dir: '../dist', entry: 'server/entry.mjs', dependencies: 'external' })
```

The trace reads every file the entry reaches, so on a large build it can take
minutes. Use `'external'` only when the build needs it.

If `dependencies` is wrong and a package is missing, the service fails to start
with the runtime's own error. If it fails with `Cannot find package 'x'`,
bundle `x` into the build or set `dependencies: 'external'`.

**Framework server builds.** These leave packages external by default, so set
`dependencies: 'external'` on their `node()` build:

- Astro with the Node adapter (`@astrojs/node`).
- SvelteKit with `@sveltejs/adapter-node`.
- React Router's server build (`react-router build`), unless you set Vite's
  `ssr.noExternal: true` to bundle everything.

Through v0.28, the directory form always traced. A directory build that
relied on that now needs `dependencies: 'external'`, or it fails at boot with
a missing-package error.

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
- [ADR-0042](../design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md)
  — why the service input is one schema and the binding carries the sourcing;
  [ADR-0029](../design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md)
  for secrets, which the deploy carries by name only, and
  [ADR-0032](../design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)
  for provision-time binding and env sourcing.
- [ADR-0030](../design/90-decisions/ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md)
  — why service keys work the way they do.
- [ADR-0005](../design/90-decisions/ADR-0005-users-build-the-framework-assembles.md)
  — why you build and the framework assembles.
