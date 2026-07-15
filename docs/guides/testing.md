# Testing

An app's code gets its dependencies from exactly one place — `service.load()`
— and never as arguments or globals. So you test by deciding what `load()`
gives the code, and you leave the code under test unchanged. Pick the tool by
how much of the real path you want to run:

| You want to… | Use | From |
| --- | --- | --- |
| Test a page / action / handler in isolation | `mockService` | `@prisma/composer/testing` |
| Run the real boot + request path against a fake dependency | `bootstrapService` | `@prisma/composer-prisma-cloud/testing` |

The full model is in
[`docs/design/10-domains/testing.md`](../design/10-domains/testing.md).

## Unit tests — `mockService`

For code you call directly. `mockService(service, overrides)` returns a copy
of the service whose `load()` yields your doubles and whose `config()` yields
the param defaults overlaid with any overrides — one flat object; dependency
keys route to `load()`, param keys to `config()`. The doubles are type-checked
against the service's declared dependencies, so a wrong-shaped fake doesn't
compile.

Wiring the module substitution is your runner's job — `vi.mock` in Vitest,
`mock.module` in bun test; `mockService` only supplies the typed value:

```tsx
// page.test.tsx
import { mockService } from '@prisma/composer/testing';
import realService from '../src/service.ts';

vi.mock('../src/service.ts', () => ({
  default: mockService(realService, {
    auth: { verify: async () => ({ ok: true }) },
  }),
}));

import Page from './page.tsx';
expect(renderToString(await Page())).toContain('Signed in: true');
```

No Postgres, no server, no environment — the page renders against the fake.

## Integration tests — `bootstrapService`

For the real request path: the service's actual built entry boots in-process,
exactly as a deployed boot would, against a config you choose. Point a
dependency at a stand-in you run, then drive real HTTP. Run under `bun test`:

```ts
// service.integration.test.ts
import { bootstrapService } from '@prisma/composer-prisma-cloud/testing';
import fakeAuth from '@my-app/auth/fake'; // an in-memory handler, no db
import storefront from '../src/service.ts';

const fake = Bun.serve({ port: 0, fetch: fakeAuth });

const app = await bootstrapService(storefront, {
  service: { port: 4310 },
  inputs: { auth: { url: fake.url.href } },
});

const res = await app.fetch(new Request(app.url));
expect(await res.text()).toContain('Signed in: true');
```

The rules:

- **The service's own code is not modified** — it boots exactly as in
  production; you only choose its configuration.
- **`service.port` must be concrete** — the entry self-listens; no
  OS-assigned port is reported back.
- **No `close()`** — run each integration-test file in its own process (bun
  test does), so the started server is cleaned up when the file ends.
- **Build first** — `bootstrapService` boots the *built* entry, so the test
  task must depend on the build (turbo's `test` → `build` dependency handles
  this in the examples).

**Next.js services take a third argument** — a boot thunk — because the built
entry lives in Next's standalone output. Resolve it with
`standaloneServerPath` from `@prisma/composer/nextjs/control`, and hand the
port to Next explicitly (its standalone server binds `process.env.PORT`, not
the service's config):

```ts
import { standaloneServerPath } from '@prisma/composer/nextjs/control';

await bootstrapService(storefront, config, async () => {
  process.env.PORT = String(PORT);
  await import(pathToFileURL(standaloneServerPath(storefront.build)).href);
});
```

The complete pattern is
[`examples/storefront-auth/modules/storefront/app/page.integration.test.ts`](../../examples/storefront-auth/modules/storefront/app/page.integration.test.ts).

## The fake you pass

A dependency's type *is* its contract, so any value of that shape is a valid
double, checked by the compiler. Three levels of realism:

- **A bare object** — `{ verify: async () => ({ ok: true }) }`. Fastest.
- **The real client over an in-memory handler** — runs JSON encoding + schema
  validation, no socket.
- **A real local server** — the fake served on a loopback port over real HTTP
  (what `bootstrapService` drives).

Ship a dependency's fake from its own package as a `/fake` entry point,
outside `src/` so it never reaches production. The fake and the real service
then always share one contract — when the contract changes, both stop
compiling together.
