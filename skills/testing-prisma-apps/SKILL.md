---
name: testing-prisma-composes
description: >-
  How to test an app built on Prisma Compose. Every dependency an app
  uses arrives through one call, `service.load()`; you test by controlling what
  it returns or reads, never by editing the code under test. Two tools:
  `mockService` (from `@prisma/compose/testing`) for unit tests, and
  `bootstrapService` (from `@prisma/compose-prisma-cloud/testing`) for integration tests.
  Use when writing tests for a Prisma App, faking a service dependency,
  unit-testing a page / server action / RPC handler, or integration-testing the
  real request path without a deployment. Triggers on "test a prisma app",
  "mockService", "bootstrapService", "fake a service dependency",
  "test a page/action without deploying", "@prisma/compose/testing".
---

# Testing Prisma Apps

An app's code gets its dependencies from exactly one place — `service.load()` —
and never as arguments or globals. So you test by deciding what `load()` gives
the code, and you leave the code under test unchanged. Pick the tool by how much
of the real path you want to run.

| You want to… | Use | From |
| --- | --- | --- |
| Test a page / action / handler in isolation | `mockService` | `@prisma/compose/testing` |
| Run the real boot + request path against a fake dependency | `bootstrapService` | `@prisma/compose-prisma-cloud/testing` |

The full model is in
[`docs/design/10-domains/testing.md`](../../docs/design/10-domains/testing.md).

## Unit test — `mockService`

For code you call directly. Mock the code's own service module so `load()`
returns doubles, then run the code with no server and no environment:

```tsx
// page.test.tsx
import { mockService } from '@prisma/compose/testing';
import realService from '../src/service.ts';

vi.mock('../src/service.ts', () => ({
  default: mockService(realService, {
    // typed against the dependency's contract — a wrong-shaped fake won't compile
    auth: { verify: async () => ({ ok: true }) },
  }),
}));

import Page from './page.tsx';
expect(renderToString(await Page())).toContain('Signed in: true');
```

- `mockService(service, doubles)` returns a copy of the service whose `load()`
  yields your `doubles` merged with the service's parameter defaults.
- The doubles are type-checked against the service's declared dependencies.
- Wiring the module substitution is your runner's job: `vi.mock` (Vitest),
  `mock.module` (bun test). `mockService` only supplies the typed value.

## Integration test — `bootstrapService`

For the real request path: the service actually boots and serves, talking to a
stand-in you run. Point a dependency at the stand-in via the config, then drive
HTTP requests:

```ts
// service.integration.test.ts  (run under `bun test`)
import { bootstrapService } from '@prisma/compose-prisma-cloud/testing';
import fakeAuth from '@storefront-auth/auth/fake'; // an in-memory handler, no db
import storefront from '../src/service.ts';

const fake = Bun.serve({ port: 0, fetch: fakeAuth });

const app = await bootstrapService(storefront, {
  service: { port: 4310 },
  inputs: { auth: { url: fake.url.href } },
});

const res = await app.fetch(new Request(app.url));
expect(await res.text()).toContain('Signed in: true');
```

- The service's own code (`server.ts`) is not modified — it boots exactly as in
  production; you only choose its configuration.
- **Pass a concrete `service.port`** — the service listens on it; there's no
  OS-assigned port reported back.
- **No `close()`** — run each integration-test file in its own process (bun test
  does), so the started server is cleaned up when the file ends.
- **Next.js services take a third argument** — a boot thunk, because the built
  entry lives in Next's standalone output directory:

  ```ts
  import { standaloneEntryPath } from '@prisma/compose/nextjs/control';
  await bootstrapService(storefront, config, async () => {
    await import(standaloneEntryPath(storefront.build));
  });
  ```

## The fake you pass

A dependency's type *is* its contract, so any value of that shape is a valid
double, checked by the compiler. Three levels of realism:

- **A bare object** — `{ verify: async () => ({ ok: true }) }`. Fastest.
- **The real client over an in-memory handler** — runs JSON encoding + schema
  validation, no socket.
- **A real local server** — the fake served on a loopback port over real HTTP
  (what `bootstrapService` drives).

Ship a dependency's fake from its own package (a `/fake` entry point, outside
`src/` so it never reaches production) so the fake and the real service always
share one contract.
