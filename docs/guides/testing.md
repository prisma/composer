# Testing

Your app's code gets every dependency from one call — `service.load()` — and
nothing from arguments or globals. That makes testing a matter of deciding
what `load()` returns; the code under test is never modified. There are two
tools, and you pick by how much of the real path you want to exercise:

| You want to… | Use | From |
| --- | --- | --- |
| Call a page / action / handler directly, dependencies faked | `mockService` | `@prisma/composer/testing` |
| Boot the real built entry and drive it over real HTTP | `bootstrapService` | `@prisma/composer-prisma-cloud/testing` |

Most tests are the first kind. Reach for the second when the thing you're
proving is the wiring itself — that the service boots, reads its config,
builds its clients, and answers requests.

## Unit tests — `mockService`

`mockService(service, overrides)` returns a copy of the service whose
`load()` yields your fakes and whose `input()` yields the input object you
supply under the reserved `input` key (one flat object — dependency names
route to `load()`, `input` to `input()`; the input double is handed over
as-is, not validated). The fakes are type-checked against the service's
declared dependencies and its input schema, so a double with the wrong shape
doesn't compile.

Substituting the mocked service for the real one is your test runner's job —
`vi.mock` in Vitest, `mock.module` in bun test. A Vitest example, testing a
Next.js page:

```tsx
// page.test.tsx
import { renderToString } from 'react-dom/server';
import { mockService } from '@prisma/composer/testing';
import realService from '../src/service.ts';

vi.mock('../src/service.ts', () => ({
  default: mockService(realService, {
    auth: { verify: async () => ({ ok: true }) },
  }),
}));

import Page from './page.tsx';

it('renders the verified state', async () => {
  expect(renderToString(await Page())).toContain('Signed in: true');
});
```

No server, no database, no environment — the page just renders against the
fake.

## Integration tests — `bootstrapService`

`bootstrapService` boots the service's **real built entry** in-process, fed
the same way a deployed boot is fed — you just choose the values. Point a
dependency at a stand-in you run on a loopback port, then make real HTTP
requests. Run these under `bun test`:

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

Five things to know:

- **Build first.** It boots the *built* entry, so the test task must depend
  on the build (in the examples, turbo's `test` task depends on `build`).
- **Pass a concrete `service.port`.** The entry listens itself; there's no
  OS-assigned port reported back.
- **There is no `close()`.** Run each integration-test file in its own
  process — bun test does this per file — and the server dies with it.
- **The service's code is untouched.** If you find yourself editing
  `server.ts` to make it testable, something upstream is wrong.
- **You don't need a service key.** A deployed RPC provider rejects callers
  that don't present one, but only a deploy creates keys — so in a test
  nothing checks, every call reaches your handler, and there's nothing to put
  in `inputs`.

**Next.js services need a third argument** — a boot function — because the
built entry lives inside Next's standalone output. Resolve it with
`standaloneServerPath`; `bootstrapService` exports the resolved port as
`process.env.PORT` before booting, which is exactly what Next's standalone
server binds:

```ts
import { pathToFileURL } from 'node:url';
import { standaloneServerPath } from '@prisma/composer/nextjs/control';

await bootstrapService(storefront, config, async () => {
  await import(pathToFileURL(standaloneServerPath(storefront.build)).href);
});
```

The complete working version is
[`examples/storefront-auth/modules/storefront/app/page.integration.test.ts`](../../examples/storefront-auth/modules/storefront/app/page.integration.test.ts).

## Writing good fakes

A dependency's type *is* its contract, so anything of that shape is a valid
fake, and the compiler holds it to that. In increasing order of realism:

- **A bare object** — `{ verify: async () => ({ ok: true }) }`. Right for
  most unit tests.
- **The real client over an in-memory handler** — exercises JSON encoding and
  schema validation, still no socket.
- **A real local server** — the fake served over actual HTTP, which is what
  `bootstrapService` drives.

One habit pays for all of this: ship each service's fake from its own package
as a `/fake` entry point (outside `src/`, so it can't reach production).
Fake and service then share one contract — when the contract changes, both
stop compiling at once, and every consumer's tests find out immediately.

The reasoning behind the two-seam design is in
[`docs/design/10-domains/testing.md`](../design/10-domains/testing.md).
