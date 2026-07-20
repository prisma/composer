# Getting started

## First: give your agent the skill

Composer is built to be driven by an agent, and this is the whole setup:

```sh
npx skills add prisma/composer --skill prisma-composer
```

Your agent now knows the entire API and arrives prepped with the building
blocks it can compose — the ready-made Modules for scheduled jobs, blob
storage, and event streams, plus the ones you write. From there you describe
what you want ("a Next.js storefront calling an orders API with its own
Postgres, deployed to a staging stage") and it composes the app; you review
TypeScript, not YAML.

Do this even if you intend to write every line yourself. It costs one command,
and it stops your agent inventing an API that doesn't exist the first time you
ask it for help.

It works because of three properties you'll see throughout this guide:
capabilities arrive as **Modules** that snap together instead of integrations
you assemble; **the compiler checks the wiring**, so a mistake fails `tsc` in
seconds rather than a deploy ten minutes later; and **the deploy is
deterministic** — one command, no infrastructure config, and re-running it
converges instead of drifting.

## The rest of this guide

The point of what follows is that you can read what your agent writes. It
takes you from an empty directory to a two-service app running on Prisma
Cloud, meeting every core idea once: a contract, a service, a root module, a
build, a deploy. At the end there's a section on
[porting an app you already have](#porting-an-existing-app).

The app is deliberately tiny — a `quotes` API and a public `gateway` that
calls it, no database — so you can see the whole shape at once. Adding a
Postgres (including a Prisma Next-typed one) is the first thing to do after,
and [Building an app](building-an-app.md#databases) covers it.

You'll need:

- [Bun](https://bun.sh) — Prisma Compute runs Bun, so that's what the server
  code targets (`Bun.serve`), and it's the fastest way to run things locally.
- pnpm (or npm).
- For the deploy at the end: a Prisma Cloud workspace, plus a service token
  and your workspace id from the [Prisma Console](https://console.prisma.io).
  (Naming, once: **Prisma Cloud** is the platform; **Prisma Compute** runs
  your services on it, and **Prisma Postgres** hosts the databases.)

## 1. Project setup

```sh
mkdir my-app && cd my-app && pnpm init
pnpm add @prisma/composer @prisma/composer-prisma-cloud arktype
pnpm add -D typescript @types/bun
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["module.ts", "src"]
}
```

This is what you're about to create:

```
my-app/
├── module.ts                  # the root module — the app itself
├── prisma-composer.config.ts  # deploy config (read only by the CLI)
└── src/
    ├── quotes/
    │   ├── contract.ts        # the quotes service's public API, as types
    │   ├── service.ts         # what quotes is: deps + build + what it exposes
    │   └── server.ts          # the code that actually runs
    └── gateway/
        ├── service.ts
        └── server.ts
```

## 2. The quotes service

Three files. First, the **contract** — the API other services will call,
written as schemas. It lives with the service that owns it. Any
[Standard Schema](https://standardschema.dev) validator works (arktype, zod,
valibot…); the examples use arktype:

```ts
// src/quotes/contract.ts
import { contract, rpc } from '@prisma/composer/rpc';
import { type } from 'arktype';

export const quotesContract = contract({
  random: rpc({ input: type({}), output: type({ quote: 'string' }) }),
});
```

Second, the **service declaration**. This is pure data — no behavior. It says
what the service is called, what it depends on (nothing yet), how it's built,
and which contract it exposes:

```ts
// src/quotes/service.ts
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { quotesContract } from './contract.ts';

export default compute({
  name: 'quotes',
  deps: {},
  build: node({ module: import.meta.url, entry: '../../dist/quotes/server.mjs' }),
  expose: { rpc: quotesContract },
});
```

Third, the **server** — the code your build turns into `dist/quotes/server.mjs`
and the platform boots. `serve()` generates the HTTP handler from the
contract; if you forget a handler or return the wrong shape, it doesn't
compile:

```ts
// src/quotes/server.ts
import { serve } from '@prisma/composer/rpc';
import service from './service.ts';

const { port } = service.config();

const QUOTES = [
  'Simplicity is prerequisite for reliability.',
  'Make it work, make it right, make it fast.',
];

const handler = serve(service, {
  rpc: {
    random: async () => ({ quote: QUOTES[Math.floor(Math.random() * QUOTES.length)]! }),
  },
});
export default handler;

// Bind all interfaces — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handler });
```

Notice what's missing: no port constant, no URL of anything, no
`process.env`. Configuration arrives through `service.config()` (the `port`
it reads is a param every service gets for free, default 3000), dependencies
through `service.load()` — that's the whole framework contract with your
code.

## 3. The gateway service

The gateway depends on the quotes contract. Notice the asymmetry with §2:
the quotes service *exposed* the bare contract (its offer); the gateway wraps
it in `rpc()` (its need — "a client of this contract"). Declaring
`deps: { quotes: rpc(quotesContract) }` means `service.load()` hands the
server a ready-made, typed client — calling it is just an async function
call:

```ts
// src/gateway/service.ts
import node from '@prisma/composer/node';
import { rpc } from '@prisma/composer/rpc';
import { compute } from '@prisma/composer-prisma-cloud';
import { quotesContract } from '../quotes/contract.ts';

export default compute({
  name: 'gateway',
  deps: { quotes: rpc(quotesContract) },
  build: node({ module: import.meta.url, entry: '../../dist/gateway/server.mjs' }),
});
```

```ts
// src/gateway/server.ts
import service from './service.ts';

const { quotes } = service.load();
const { port } = service.config();

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch: async () => {
    const { quote } = await quotes.random({});
    return new Response(quote);
  },
});
```

The gateway exposes no contract of its own, so there's no `serve()` here —
it's an ordinary HTTP server that happens to receive a typed client.

## 4. Compose the app

The root module is the app. It provisions both services and wires the quotes
service's exposed port into the gateway's dependency slot — `provision()`
returns a ref carrying one port per exposed contract, so `quotes.rpc` exists
because the service declared `expose: { rpc: … }`:

```ts
// module.ts
import { module } from '@prisma/composer';
import gatewayService from './src/gateway/service.ts';
import quotesService from './src/quotes/service.ts';

export default module('my-app', ({ provision }) => {
  const quotes = provision(quotesService);
  provision(gatewayService, { deps: { quotes: quotes.rpc } });
});
```

Next to it goes the deploy config. Only `prisma-composer deploy`/`destroy`
read this file — your app code never imports it:

```ts
// prisma-composer.config.ts
import { defineConfig } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';

export default defineConfig({
  extensions: [prismaCloud(), nodeBuild()],
  state: () => prismaState(),
});
```

## 5. Run it locally

There's no dev server yet (it's on the roadmap) — but a server entry is just
a program, and locally `service.load()` and `service.config()` read plain
environment variables. The naming rule: `COMPOSER_` + the slot's name (+ the
connection param, for dependencies), uppercased — `COMPOSER_PORT` for the
service's own `port` param, `COMPOSER_QUOTES_URL` for the `quotes`
dependency's URL, and a `db` dependency would read `COMPOSER_DB_URL`. A
missing required value fails loudly at boot with the exact variable name it
wanted.

These are the same `COMPOSER_*` variables a deploy writes for the running
service. Locally they're yours to set; in a deployed environment they belong
to the deploy, which rewrites them every time.

Two terminals:

```sh
# terminal 1 — quotes; port defaults to 3000
bun run src/quotes/server.ts

# terminal 2 — gateway on 3001, pointed at the local quotes
COMPOSER_PORT=3001 COMPOSER_QUOTES_URL=http://localhost:3000/ bun run src/gateway/server.ts

curl localhost:3001
# Make it work, make it right, make it fast.
```

In production nobody writes these variables by hand — the deploy provisions
them from the wiring in `module.ts`. Locally you *are* the deploy.

## 6. Build and deploy

You own the build — the framework only assembles what you built. It asks one
thing of it: each entry must be a **single self-contained file**, with
everything inlined except the runtime's own built-ins (`bun`, `bun:*`,
`node:*`), which the deploy VM provides. Deploy copies that one file and never
ships `node_modules`, so anything left un-inlined fails at boot.

Any bundler that produces such a file works; this guide uses bun. Two services
means two separate builds — not one multi-entry build, which would split the
shared contract code into a chunk neither output contains:

```jsonc
// package.json
"scripts": {
  "build": "bun build src/quotes/server.ts --target=bun --outfile dist/quotes/server.mjs && bun build src/gateway/server.ts --target=bun --outfile dist/gateway/server.mjs"
}
```

```sh
pnpm run build
```

Deploying needs exactly two environment variables. Create a service token in
your workspace in the [Prisma Console](https://console.prisma.io); the
workspace id is in the workspace's settings:

```sh
export PRISMA_SERVICE_TOKEN=...
export PRISMA_WORKSPACE_ID=...

pnpm exec prisma-composer deploy module.ts
```

The CLI creates a Project named `my-app` in your workspace, provisions both
services on Prisma Compute, points the gateway's `quotes` dependency at the
deployed quotes service, and starts everything.

The deploy finishes by printing what it made — your own module names, the
platform resource each became, and the public URLs:

```
my-app
├─ quotes    compute-service cps_abc123
│            https://xyz.ewr.prisma.build
└─ gateway   compute-service cps_def456
             https://uvw.ewr.prisma.build
```

Open the gateway's URL from that output: you get a quote, served over one
typed RPC hop.

Now try the *quotes* service directly — `curl <quotes-url>/rpc/random` — and
you'll get `401`. That's deliberate. Deploying also gave the gateway a
**service key** for its `quotes` dependency, and told quotes to accept only
that: quotes answers the gateway and turns away everyone else. Neither
service's code mentions a key, and it's why the local run needed none — only
a deploy creates them.
[Building an app](building-an-app.md#calls-are-authenticated-for-you) has the
details.

Re-deploying is idempotent — it updates the same Project. For an isolated
copy of the whole app (own services, own config), deploy a **stage**, and
tear it down when you're done:

```sh
pnpm exec prisma-composer deploy module.ts --stage demo
pnpm exec prisma-composer destroy module.ts --stage demo
```

## Porting an existing app

You don't rewrite an app to put it on Composer — you declare it. The server
code you already have stays the server; you add the declaration around it.

**A Node/Bun service.** Add a `service.ts` with
`compute({ name, deps, build: node({ module, entry }) })` pointing `entry` at
your built server file, then make three changes to the server itself:

1. Read the port from `service.config()` instead of `process.env.PORT`, and
   bind `0.0.0.0`.
2. Replace every `process.env` read with what it really is: a param for plain
   config, a secret for credentials, or a dependency for anything another
   service provides. If a param's value differs per stage — an app origin, an
   external URL — bind it with `envParam`.
   [Building an app § Config params](building-an-app.md#config-params) has
   the how-to-choose table and all three shapes.
3. If it talks to Postgres: declare `deps: { db: postgres() }` and build your
   existing client (`pg`, Bun's `SQL`, whatever you use today) from the
   injected `db.url` instead of a connection-string env var.

Your build must produce a self-contained entry file — keep your own build if
it already does.

**A Next.js app.** Use the `nextjs` build adapter instead of `node`; `next
build` with `output: 'standalone'` is the whole build:

```ts
export default compute({
  name: 'web',
  deps: { api: rpc(apiContract) },
  build: nextjs({ module: import.meta.url, appDir: '..' }),
});
```

Add `nextjsBuild()` from `@prisma/composer/nextjs/control` to the deploy
config's `extensions`. Any page or server action that calls `service.load()`
needs `export const dynamic = 'force-dynamic'`, because the runtime
environment doesn't exist at build time.
[`examples/storefront-auth`](../../examples/storefront-auth/) is a complete
ported-shaped app: a Next.js frontend calling a Bun API service that owns a
Postgres.

**More than one service.** Port them into one `module.ts` and replace the
URLs they used to reach each other with contracts — that's the payoff: the
edges become typed, and every environment (production, stages, tests) gets
the wiring for free.

## Where to go next

- [Building an app](building-an-app.md) — databases (including Prisma
  Next-typed ones with migrations), reusable Modules, cron/storage/streams,
  config params, secrets.
- [Testing](testing.md) — unit tests with `mockService`, integration tests
  with `bootstrapService`.
- [Deploying and operating](deploying.md) — stages, destroy, CI, how the app
  behaves in production.
- [`examples/`](../../examples/) — complete apps: start with
  [pn-widgets](../../examples/pn-widgets/) (one service + one Prisma
  Next-typed database) or [store](../../examples/store/) (four modules, cron,
  a Next.js storefront).
