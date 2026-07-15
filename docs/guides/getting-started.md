# Getting started

From an empty directory to a deployed two-service Prisma App. You'll build a
`quotes` service that owns an RPC contract, a public `gateway` that calls it,
compose them in a root module, and deploy.

Prerequisites: [Bun](https://bun.sh) (the server runtime used throughout),
pnpm or npm, and a Prisma Cloud workspace (for the deploy at the end).

## 1. Project setup

```sh
mkdir my-app && cd my-app && pnpm init
pnpm add @prisma/composer @prisma/composer-prisma-cloud arktype
pnpm add -D tsdown typescript @types/bun
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

The layout you're about to create:

```
my-app/
├── module.ts                  # the root module — the app itself
├── prisma-composer.config.ts  # deploy config (read only by the CLI)
├── tsdown.config.ts           # your build
└── src/
    ├── quotes/
    │   ├── contract.ts        # the service's public RPC contract
    │   ├── service.ts         # the declaration: deps + build + expose
    │   └── server.ts          # the entry your build produces
    └── gateway/
        ├── service.ts
        └── server.ts
```

## 2. The quotes service

**The contract** — the typed edge other services depend on. It lives with the
service that owns it. Any Standard Schema validator works; arktype is what the
examples use:

```ts
// src/quotes/contract.ts
import { contract, rpc } from '@prisma/composer/rpc';
import { type } from 'arktype';

export const quotesContract = contract({
  random: rpc({ input: type({}), output: type({ quote: 'string' }) }),
});
```

**The declaration** — pure data: a name, dependencies (none yet), how the
service is built, and what it exposes:

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

**The server entry** — what your build produces and the platform boots.
`serve()` generates the HTTP handler from the contract; the handler map is
checked against it at compile time, so a missing or wrong-shaped handler
doesn't compile:

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

## 3. The gateway service

The gateway declares a dependency on the quotes contract and gets a typed
client back from `load()` — no URL, no fetch wrapper, no client setup:

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

Nothing exposes a contract here, so there's no `serve()` — the gateway is an
ordinary HTTP server that happens to receive a typed client.

## 4. Compose the app

The root module provisions both services and wires the exposed port into the
dependency slot. Its default export is the app:

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

The deploy config sits next to it. It is read only by `prisma-composer
deploy`/`destroy` — app code never imports it:

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

## 5. Build

You own the build; the framework only assembles what you built. The shipped
tsdown preset makes each entry self-contained. Two services means two separate
builds into separate output directories — not one multi-entry build, which
would split shared code (the contract) into a chunk neither output contains:

```ts
// tsdown.config.ts
import { prismaTsDownConfig } from '@prisma/composer/tsdown';

export default [
  prismaTsDownConfig({ entry: { server: 'src/quotes/server.ts' }, outDir: 'dist/quotes' }),
  prismaTsDownConfig({ entry: { server: 'src/gateway/server.ts' }, outDir: 'dist/gateway' }),
];
```

```sh
pnpm tsdown
```

## 6. Deploy

A deploy needs exactly two environment variables — a service token and the
workspace id from your Prisma Cloud workspace:

```sh
export PRISMA_SERVICE_TOKEN=...
export PRISMA_WORKSPACE_ID=...

pnpm exec prisma-composer deploy module.ts
```

The CLI resolves (or creates) the app's Project, provisions both services on
Prisma Compute, wires the gateway's `quotes` dependency to the deployed quotes
service, and starts them. Each service becomes a Compute service in the
Project; its public URL is its service endpoint domain, shown in the
[Prisma Console](https://console.prisma.io). Open the gateway's URL and you
get a quote — served over one typed RPC hop.

Re-deploying is idempotent: it updates the resources inside the same Project.
To stand up an isolated copy (same topology, separate everything), deploy a
**stage**, and tear it down when done:

```sh
pnpm exec prisma-composer deploy module.ts --stage demo
pnpm exec prisma-composer destroy module.ts --stage demo
```

## Where to go next

- [Building an app](building-an-app.md) — databases, reusable Modules, the
  shared cron/storage/streams modules, config params, secrets.
- [Testing](testing.md) — unit tests with `mockService`, integration tests
  with `bootstrapService`.
- [Deploying and operating](deploying.md) — stages, destroy semantics, CI,
  production behavior.
- [`examples/`](../../examples/) — complete apps, from a single service with a
  typed database ([pn-widgets](../../examples/pn-widgets/)) to a four-module
  store with cron ([store](../../examples/store/)).
