---
name: prisma-composer
description: >-
  How to write, test, and deploy an app with Prisma Composer
  (`@prisma/composer`): declare services with `compute()` and typed
  dependencies, define RPC contracts, compose Modules, read config and
  secrets, compose the ready-made cron/storage/streams Modules, find
  extensions (npm packages named `prisma-composer-*`), test with
  `mockService`/`bootstrapService`, and deploy with `prisma-composer deploy`
  (stages, destroy). Use when building a Prisma App, wiring a service
  dependency, adding a Postgres database, adding scheduled jobs / blob
  storage / event streams, writing tests for composed services, or
  deploying/tearing down an environment. Triggers on
  "prisma composer", "@prisma/composer", "prisma app", "compute()",
  "service.load()", "module()", "contract()", "mockService",
  "bootstrapService", "prisma-composer deploy", "--stage",
  "prisma-composer destroy", "prisma-composer-".
---

# Writing apps with Prisma Composer

A **Prisma App** is a tree of **Modules** composed in TypeScript. The leaves
are **services** (`compute()`) and **resources** (`postgres()`); the root
module wires them together by their typed ports. Your code receives everything
from exactly one place — the service node:

- `service.load()` — dependencies (typed RPC clients, database bindings)
- `service.config()` — config params (validated, typed values)
- `service.secrets()` — secret values (redacting `SecretBox`es)

The framework never bundles or transforms your code. You build your app
(`tsdown`, `next build`); `prisma-composer deploy` assembles the built output
and provisions it on Prisma Cloud (Compute + Prisma Postgres).

Two things make building here fast and hard to get wrong — lean on both:

- **Compose before you write.** Reach for an existing Module (below) before
  implementing a capability yourself; wiring one in is a couple of lines.
- **The compiler checks the wiring.** A dependency wired to the wrong
  producer, a missing RPC handler, a config value of the wrong shape — all of
  it fails `tsc`, not the deploy. Typecheck, then build, then deploy; don't
  reach for the cloud to find out whether the app is correct.

Two packages, and only two, appear in your `package.json`:

| Package | Provides |
| --- | --- |
| `@prisma/composer` | Core authoring: `module`, `secret`, params, `/rpc`, `/node`, `/nextjs`, `/config`, `/testing`, `/tsdown`, the `prisma-composer` CLI |
| `@prisma/composer-prisma-cloud` | The Prisma Cloud target: `compute`, `postgres`, `envSecret`, `/control`, `/testing`, and the shared `/cron`, `/storage`, `/streams`, `/prisma-next` modules |

## Anatomy of a service

A service is four small files. Worked example: an `auth` service that owns a
Postgres database and serves an RPC contract, consumed by a `storefront`
Next.js app.

**The contract** lives with the service that owns it. Any Standard Schema
validator types the messages; arktype is the house choice:

```ts
// auth/src/contract.ts
import { contract, rpc } from '@prisma/composer/rpc';
import { type } from 'arktype';

export const authContract = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});
```

**The service declaration** is pure data — name, dependencies, build, exposed
ports. No behavior, no platform keys:

```ts
// auth/src/service.ts
import node from '@prisma/composer/node';
import { compute, postgres } from '@prisma/composer-prisma-cloud';
import { authContract } from './contract.ts';

export default compute({
  name: 'auth',
  deps: { db: postgres() },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: authContract },
});
```

**The server entry** is what your build produces and the platform boots. It
reads its dependencies through `load()` and serves the contract with
`serve()` — the handler map is keyed by the expose port's name and is
exhaustive at compile time:

```ts
// auth/src/server.ts
import { serve } from '@prisma/composer/rpc';
import { SQL } from 'bun';
import service from './service.ts';

const { db } = service.load();     // { url } — you build your own client
const { port } = service.config(); // params, separate namespace from deps

const sql = new SQL({ url: db.url, max: 1, idleTimeout: 10 });

const handler = serve(service, {
  rpc: {
    verify: async ({ token }) => ({ ok: token.length > 0 }),
  },
});
export default handler;

// Bind all interfaces — Compute routes external HTTP to the VM; a
// loopback-only listener is unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handler });
```

**The consumer** declares the dependency as `rpc(contract)` and gets a typed
client back from `load()`:

```ts
// storefront/src/service.ts
import nextjs from '@prisma/composer/nextjs';
import { rpc } from '@prisma/composer/rpc';
import { compute } from '@prisma/composer-prisma-cloud';
import { authContract } from '@my-app/auth/contract';

export default compute({
  name: 'storefront',
  deps: { auth: rpc(authContract) },
  build: nextjs({ module: import.meta.url, appDir: '..' }),
});
```

```tsx
// storefront/app/page.tsx
import service from '../src/service.ts';

// load() reads the runtime environment, which doesn't exist at build time —
// render per request instead of prerendering.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const { auth } = service.load();
  const { ok } = await auth.verify({ token: 'demo-token' });
  return <p>Signed in: {String(ok)}</p>;
}
```

## The root module

The root module provisions the pieces and wires exposed ports into dependency
slots. It is the app — `prisma-composer deploy` loads its default export:

```ts
// module.ts
import { module } from '@prisma/composer';
import authModule from '@my-app/auth';
import storefrontService from '@my-app/storefront';

export default module('my-app', ({ provision }) => {
  const auth = provision(authModule);
  provision(storefrontService, { deps: { auth: auth.rpc } });
});
```

`provision(node, opts?)` accepts `id` (defaults to the node's own name),
`deps` (wire each declared dependency to a provisioned ref or exposed port),
and `secrets` (bind secret needs — see § Secrets).

## Builds are yours

The framework assembles only what you built (ADR-0005: users build, the
framework assembles). For a plain server process, build each entry
self-contained with the shipped tsdown preset:

```ts
// tsdown.config.ts
import { prismaTsDownConfig } from '@prisma/composer/tsdown';
export default prismaTsDownConfig({ entry: { server: 'src/server.ts' }, outDir: 'dist' });
```

Two services in one package means two separate builds into separate `outDir`s
— not one multi-entry build, which would split shared code into a chunk
neither dist contains. For Next.js, `next build` with `output: 'standalone'`
is the whole build; `nextjs({ module, appDir })` tells the deploy where the
app root is.

Always build before deploying — `prisma-composer deploy` does not build for
you.

## Deploy config

`prisma-composer.config.ts` sits next to `module.ts`. It is read only by
`prisma-composer deploy`/`destroy`, never imported by app code:

```ts
// prisma-composer.config.ts
import { defineConfig } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';

export default defineConfig({
  extensions: [prismaCloud(), nodeBuild()],
  state: () => prismaState(), // workspace-hosted deploy state, shared by every deployer
});
```

Add `nextjsBuild()` from `@prisma/composer/nextjs/control` to `extensions`
when the app contains a Next.js service.

## Databases

Two kinds of Postgres dependency:

**`postgres()`** — the binding is `{ url }` and the app owns its client
(ADR-0015). Construct it in your server entry, as in the auth example above.

**`pnPostgres(...)`** — a Prisma Next-typed database (ADR-0022): `load()`
returns the typed client the framework constructs from your data contract, so
queries like `db.orm.public.Product.all()` are compile-time checked. The
contract is emitted from `contract.prisma` by `prisma-next contract emit` and
wrapped once, referenced by both ends:

```ts
// src/data.ts — the ONE value both ends reference
import { pnContract } from '@prisma/composer-prisma-cloud/prisma-next';
import type { Contract } from '../contract.d.ts';
import contractJson from '../contract.json' with { type: 'json' };

export const catalogData = pnContract<Contract>(contractJson);
```

The dependency end is `deps: { db: pnPostgres(catalogData) }`. The resource
end (inside the module that owns the database) also names the
`prisma-next.config.ts` path, which the deploy's migration step loads to find
`migrations/` — migrations are applied at deploy, before the service starts:

```ts
const db = provision(pnPostgres({ name: 'database', contract: catalogData, config }));
```

See `examples/store/modules/catalog` in the prisma/composer repo for the
complete pattern.

## Reusable Modules

A Module is the unit of reuse: it owns its internals (its database, its
services) and exposes only typed ports. Declare the boundary in the second
argument; wire internals in the builder; return the exposed ports:

```ts
// auth/src/module.ts — a Module that owns its own Postgres
import { module, secret } from '@prisma/composer';
import { postgres } from '@prisma/composer-prisma-cloud';
import { authContract } from './contract.ts';
import authService from './service.ts';

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

Naming rules that bite: a provision id shorter than 3 characters is rejected
by the platform (name the database `'database'`, not `'db'`), and a service
whose name equals its enclosing module's reads as `auth.auth` unless you give
it an explicit `id`.

A module can also declare boundary `deps` — inputs the parent wires exactly as
it would wire a service's. The consumer never sees the module's internals.

### The building blocks you can compose

Modules are the building blocks: provision one, wire its exposed port, and
you're done — you never reimplement what a Module already owns. The
first-party set ships inside `@prisma/composer-prisma-cloud`. It's small, and
growing:

| Import | What it provisions | Exposes |
| --- | --- | --- |
| `cron` from `/cron` | An always-on scheduler firing your schedule at your runner service | nothing |
| `storage` from `/storage` | An S3-backed blob store (own Postgres + minted credentials) | `store` |
| `streams` from `/streams` | Durable append-only event streams over a `store` | `streams` |

**Finding more.** A Composer extension — a package that brings its own
Modules, resources, or deploy target — is published on npm under the name
`prisma-composer-*`. That name is the convention, so it's how you look for
one. The ecosystem is new: today the blocks above plus the app Modules you
write are the whole set, so don't reach for a `prisma-composer-*` package
without checking that it actually exists on npm first.

Cron end to end — the schedule is one source of truth; `serveSchedule` is
exhaustive over its job ids at compile time:

```ts
// service.ts
import { defineSchedule, triggerContract } from '@prisma/composer-prisma-cloud/cron';
export const schedule = defineSchedule({ tick: '60s' });
// the runner service exposes { trigger: triggerContract }

// server.ts
import { serveSchedule } from '@prisma/composer-prisma-cloud/cron';
const handler = serveSchedule(service, schedule, {
  tick: (deps) => deps.worker.tick({}),
});

// module.ts — the cron module's boundary deps mirror the runner's own
provision(cron({ schedule, runner: runnerService }), { deps: { worker: worker.rpc } });
```

## Config params

Params are caller-owned schemas on the declaration (ADR-0018/0021). `string()`
and `number()` cover the scalars; `param(schema)` wraps anything else:

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

Read them with `service.config()` — never `load()`; deps and params are
separate namespaces. Facets are `default` and `optional`. Every service has a
reserved `port` param (default 3000); declaring your own `port` is an
authoring error.

## Secrets

Secret values never travel through framework config (ADR-0029). A service
declares a nameless **need**; the root binds it to a platform env-var name;
the value stays only in that platform variable:

```ts
// service.ts — the need
import { secret } from '@prisma/composer';
compute({ /* ... */ secrets: { signingKey: secret() } });

// module.ts root — the binding
import { envSecret } from '@prisma/composer-prisma-cloud';
provision(authModule, { secrets: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });

// server.ts — the read
const { signingKey } = service.secrets(); // SecretBox<string>
signingKey.expose();                      // the only way to the value; the box redacts everywhere else
```

Modules forward needs without learning the name (the auth Module above). A
secret is not a param — don't put credentials in `params`.

## Testing

You test by deciding what `load()` gives the code, never by editing the code
under test:

| You want to… | Use | From |
| --- | --- | --- |
| Test a page / action / handler in isolation | `mockService` | `@prisma/composer/testing` |
| Run the real boot + request path against a fake dependency | `bootstrapService` | `@prisma/composer-prisma-cloud/testing` |

**Unit — `mockService`.** Returns a copy of the service whose `load()` yields
your doubles (type-checked against the declared deps) and whose `config()`
yields param defaults overlaid with any overrides, in one flat object. Wiring
the module substitution is your runner's job (`vi.mock` in Vitest,
`mock.module` in bun test):

```tsx
// page.test.tsx
import { mockService } from '@prisma/composer/testing';
import realService from '../src/service.ts';

vi.mock('../src/service.ts', () => ({
  default: mockService(realService, {
    auth: { verify: async () => ({ ok: true }) }, // wrong shape = compile error
  }),
}));

import Page from './page.tsx';
expect(renderToString(await Page())).toContain('Signed in: true');
```

**Integration — `bootstrapService`.** Boots the service's real built entry
in-process against a config you choose, exactly as a deployed boot would;
drive it over real HTTP. Run under `bun test`:

```ts
import { bootstrapService } from '@prisma/composer-prisma-cloud/testing';
import fakeAuth from '@my-app/auth/fake'; // in-memory handler, no db
import storefront from '../src/service.ts';

const fake = Bun.serve({ port: 0, fetch: fakeAuth });

const app = await bootstrapService(storefront, {
  service: { port: 4310 },
  inputs: { auth: { url: fake.url.href } },
});

const res = await app.fetch(new Request(app.url));
```

- **`service.port` must be concrete** — the entry self-listens; no OS-assigned
  port is reported back.
- **No `close()`** — run each integration-test file in its own process (bun
  test does).
- **Next.js services take a third argument**, a boot thunk, because the built
  entry lives in Next's standalone output — resolve it with
  `standaloneServerPath` from `@prisma/composer/nextjs/control` and set
  `process.env.PORT` before importing it (Next's standalone server binds
  `PORT`, not the service's config).

**The fake you pass.** A dependency's type is its contract, so any value of
that shape is a valid double: a bare object (fastest), the real client over an
in-memory handler, or a real local server (what `bootstrapService` drives).
Ship a dependency's fake from its own package as a `/fake` entry point,
outside `src/`, so the fake and the real service always share one contract.

## Deploying

Requires exactly two environment variables: `PRISMA_SERVICE_TOKEN` and
`PRISMA_WORKSPACE_ID`. The target environment — a **stage** — is chosen on the
command line, never in code:

| You want to… | Run |
| --- | --- |
| Deploy to production | `prisma-composer deploy module.ts` |
| Deploy an isolated environment | `prisma-composer deploy module.ts --stage <name>` |
| Override the app name for one run | `prisma-composer deploy module.ts --name demo-42` |
| Tear down an isolated environment | `prisma-composer destroy module.ts --stage <name>` |
| Tear down production's resources | `prisma-composer destroy module.ts --production` |

A Prisma App is one Project; a stage is a Branch of it (ADR-0023/0024) — its
own compute, its own empty database, its own configuration. Deploys are
idempotent: re-deploying a stage updates the resources inside it. A stage name
must be a valid git ref name; an invalid name is a hard error.

Destroy always requires an explicit target — a bare `prisma-composer destroy`
is an error, and `--stage` with `--production` is too. Destroying a stage
deletes its Branch after removing its resources; the production Branch itself
is never deleted, only the resources inside it. Destroy never creates
anything: destroying a never-deployed stage fails rather than standing one up.

```sh
turbo run build && prisma-composer deploy module.ts --stage pr-42
```

## Production pitfalls

- **Scale-to-zero closes idle database connections.** A persistent client
  crashes into a 502 restart loop unless you keep the pool small and
  reconnect-friendly (`new SQL({ url, max: 1, idleTimeout: 10 })` for Bun) and
  log `uncaughtException`/`unhandledRejection` instead of dying.
- **Bind `0.0.0.0`**, not loopback — Compute routes external HTTP to the VM.
- **Next.js pages that call `load()` need `export const dynamic =
  'force-dynamic'`** — the runtime environment doesn't exist at build time,
  and Next ignores runtime env for prerendered routes.
- **Cold starts reset service-to-service connections.** A call into a
  scaled-to-zero service can get `ECONNRESET`; retry it.
- **The ingress buffers streaming responses.** An open SSE tail delivers
  nothing and times out at 60s — don't build on streamed HTTP responses.

## What Composer doesn't do yet

Name the gap instead of inventing an API:

- **No dev server / watch loop.** Local dev is running a server entry
  directly (see each example's `dev` script); dependencies must be supplied
  via the environment or a locally-run counterpart. A first-class dev loop is
  on the roadmap.
- **No interactive auth.** Deploys authenticate only via a static
  `PRISMA_SERVICE_TOKEN`; there is no `login` flow.
- **No in-memory contract bindings.** A dependency can't yet be wired to a
  co-located handler without HTTP; use `bootstrapService` with a loopback
  fake.
- **RPC over HTTP is the only contract kind.** No gRPC, WebSocket, or
  streaming contracts.

For anything else missing, check the examples and design docs in the
prisma/composer repo (`examples/`, `docs/design/10-domains/`,
`docs/design/90-decisions/`), then file an issue there rather than guessing.
