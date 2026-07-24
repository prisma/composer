# Building an app

This guide covers everything you reach for once
[Getting started](getting-started.md) has shown you the shape: giving a
service a database (plain or Prisma Next-typed), packaging pieces as reusable
Modules, the cron/storage/streams modules that ship with the framework, and
the service input — configuration and secrets as one schema.

## How the pieces fit

A Prisma App is a tree of **Modules**. At the leaves are **services** —
`compute()`, the units that run your code — and **resources** — stateful
things like `postgres()`. A parent module wires them together; your code
never participates in the wiring, it just receives the results:

```ts
compute({
  name: 'auth',                 // the service's name in the app graph
  deps: { db: postgres() },     // what it needs         → read via service.load()
  input: authInput,             // its incoming config   → read via service.input()
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: authContract },// what it offers to other services
});
```

Dependencies and input are two deliberately separate channels with two
separate accessors. A dependency is a live connection to another node; input
is data — plain values and credentials together, declared as one schema
([below](#service-input)), where a field typed as the redacting
`SecretString` box can never end up as an ordinary string. Your code contains
no configuration `process.env` reads and no URLs; that is what makes every
environment — production, a stage, a test — just a different set of injected
values.

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
      input: { signingKey: secrets.signingKey },
    });
    return { rpc: service.rpc };
  },
);
```

The boundary still declares `secrets: { signingKey: secret() }` — a nameless
need the module forwards without ever learning the platform variable's name.
Inside, the forwarded ref is just another leaf of the service's input binding
([below](#service-input)).

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
- `input` — the service's input binding ([below](#service-input)); required
  exactly when the service declares an input schema.
- `secrets` — for a module boundary: a binding for each forwarded secret
  need.

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

## Service input

Everything a running service receives arrives through one of two channels,
and choosing the channel is most of the decision:

| The value is… | Declare it as | Provide it | Read it |
| --- | --- | --- | --- |
| produced by another node — a database, another service | a dependency: `deps: { db: postgres() }` | wire it at `provision()` | `service.load()` |
| anything else — a region, a flag, a job list, a credential | one field of the service's `input` schema | bind it at `provision()`: a literal, `envParam()`, or `envSecret()` | `service.input()` |

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
the schema's shape whose leaves are literals, `envParam(...)`, or
`envSecret(...)`:

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

**`envParam('NAME')`** is for plain values the code *can't* know. An app
origin is the canonical case: it's different on production and on every
preview stage, and a stage's public URL doesn't exist until that stage first
deploys. Each stage keeps its own copy of the variable, so one topology
serves them all. How the value travels: **the stage's platform variable is
the store; the deploying shell only seeds it.** At deploy, preflight checks
the name exists for the target stage — a name the stage is missing is copied
up from the deploying shell's environment. Once the stage has it, your shell
no longer matters. The variable's value arrives as a raw string, so bind
`envParam` to string fields. To change the value later, set it on the
platform and redeploy; a running instance's environment is frozen when the
instance is created.
[`examples/env-param`](../../examples/env-param/) is the minimal working
version, including a smoke script that proves the per-stage split.

**`envSecret('NAME')`** is for credentials, with one rule: **the value never
enters framework config**. The platform variable is seeded exactly the way
an `envParam` one is — preflight copies it from the deploying shell when the
stage doesn't have it yet, so CI (or you) exports `STRIPE_SECRET_KEY` for a
first deploy. The framework carries only the variable's *name*; the platform
injects the value straight into the running instance. What your code gets is
a `SecretString` box that redacts on logging, rendering, and
JSON-serialization — leaking it takes a deliberate `.expose()`:

```ts
const input = service.input();
if (input.stripeEnabled) stripe(input.stripeSecretKey.expose());
```

A reusable Module forwards a secret need up to its parent without ever
learning the platform name ([above](#reusable-modules)), which is what lets
a Module require credentials without dictating your naming.

### Absence is the schema's call

An env-bound field whose variable is unset (or empty) in the deploy shell
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
- [ADR-0042](../design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md)
  — why the service input is one schema and the binding carries the sourcing;
  [ADR-0029](../design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md)
  for the forwardable secret need, and
  [ADR-0032](../design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)
  for provision-time binding and env sourcing.
- [ADR-0030](../design/90-decisions/ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md)
  — why service keys work the way they do.
- [ADR-0005](../design/90-decisions/ADR-0005-users-build-the-framework-assembles.md)
  — why you build and the framework assembles.
