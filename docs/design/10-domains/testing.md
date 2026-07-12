# Testing an app built on the framework

You test a Prisma App by controlling one function: `service.load()`, the single
call through which application code gets its dependencies. You never change the
code under test to make it testable — you decide what `load()` hands it. Two
tools cover the two situations you'll meet:

- **`mockService`** — unit-test a piece of code (a page, a server action, a
  helper) with fake dependencies.
- **`bootstrapService`** — integration-test the real request path: the service
  actually boots and serves, talking to stand-ins you run yourself.

## A worked example

The `storefront` app has a page that depends on an `auth` service:

```tsx
// storefront/app/page.tsx — ordinary application code
import service from '../src/service.ts';

export default async function Page() {
  const { auth } = service.load();
  const { ok } = await auth.verify({ token: 'demo' });
  return <p>Signed in: {String(ok)}</p>;
}
```

The page gets `auth` by calling `service.load()`. To test it without a real auth
service — no database, no deployment, no cloud account — you replace what
`load()` returns:

```tsx
// storefront/app/page.test.tsx
import { mockService } from '@prisma/compose/testing';

vi.mock('../src/service.ts', () => ({
  default: mockService(realService, {
    auth: { verify: async () => ({ ok: true }) },
  }),
}));

import Page from './page.tsx';

expect(renderToString(await Page())).toContain('Signed in: true');
```

The page runs its real logic; only `auth` is a stand-in. Everything below
expands on this one move.

## Why one function is enough

A service declares the dependencies it needs and the ports it exposes. Its code
— a page, a server action, an RPC handler, a plain function — never receives
those dependencies as arguments and never reaches for a global. It calls
`service.load()`.

`load()` does three things: it reads the service's configuration (which a
deployment places in the process environment), turns each dependency into the
concrete client the code will call (ADR-0015), and returns them with their real
types. Because this is the *only* way application code reaches a dependency, it
is the only place a test has to intervene — which is what lets the tests leave
the application code completely untouched.

The two tools intervene at the same point from opposite directions.
`mockService` decides what `load()` **returns**; `bootstrapService` decides what
`load()` **reads**. Which you want depends on how much of the real path you're
testing.

## Unit tests: `mockService`

When you want to test a piece of code in isolation — call it directly, assert on
what it returns or renders — use `mockService`. You mock the service module so
`load()` yields doubles, then exercise the code with no server and no
environment. That is the worked example above.

`mockService(service, doubles)` returns a copy of the service whose `load()`
returns your doubles merged with the service's own parameter defaults. The
doubles are typed against the service's declared dependencies: a fake `auth`
must be a valid `authContract` client, so a wrong-shaped fake is a compile
error, not a test that passes by accident.

It works for any service — every service has a `load()` — so it lives in the
framework core, `@prisma/compose/testing`. The one part that depends on your test
runner is *how* you substitute the module (`vi.mock` in Vitest, `mock.module`
in bun test). The framework gives you the typed value to substitute; wiring it
into the runner stays in your test.

## Integration tests: `bootstrapService`

When you want the real request path — the actual server boot, the real network
client, the real wire format — use `bootstrapService`. It starts your service's
real entry point in a configuration you choose, in-process, and hands you
something you can send HTTP requests to. You point one of its dependencies at a
stand-in you run yourself, and drive the round trip.

```ts
// storefront/app/page.integration.test.ts
import { bootstrapService } from '@prisma/compose-cloud/testing';
import fakeAuth from '@storefront-auth/auth/fake'; // an in-memory auth handler, no database
import storefront from '../src/service.ts';

// run the fake auth on a loopback port
const fake = Bun.serve({ port: 0, fetch: fakeAuth });

const app = await bootstrapService(storefront, {
  service: { port: 4310 },
  inputs: { auth: { url: fake.url.href } }, // point storefront's auth dependency at the fake
});

const res = await app.fetch(new Request(app.url));
expect(await res.text()).toContain('Signed in: true');
```

The point is what *doesn't* change: `storefront`'s server code is untouched. It
boots and listens exactly as it does in production; the test only chooses the
configuration it boots with. `load()` reads that configuration the same way a
deployed process would, so pointing `auth` at `http://localhost:…` is the same
mechanism a deployment uses to point it at the real service. You exercise the
production code path, not a rewrite of it.

Starting a service the way a deployment does is specific to the platform you
deploy to, so `bootstrapService` ships in that platform's testing entry
(`@prisma/compose-cloud/testing`), not the core. (`mockService` only substitutes a
return value, so it needs to know nothing about deployment and stays in core.)

Three practical notes:

- **You choose the port.** The service listens on it and never reports an
  OS-assigned one back, so pass a concrete number.
- **There is no `close()`.** Run each integration-test file in its own process
  (bun test does), and the server it started is cleaned up when the file ends.
- **A Next.js service needs one extra argument.** `bootstrapService` finds most
  services' entry points automatically, but a Next.js app's built entry lives
  inside Next's standalone output directory, so you pass a small function that
  imports it:

  ```ts
  import { standaloneEntryPath } from '@prisma/compose-nextjs/control';

  await bootstrapService(storefront, config, async () => {
    await import(standaloneEntryPath(storefront.build));
  });
  ```

## The stand-in: same contract, checked by the compiler

What do you pass as the fake? A dependency's type *is* its contract. An RPC
dependency on `authContract` becomes a client with a `verify(input) =>
Promise<output>` method, so any value of that shape is a valid double and the
compiler rejects one that isn't. You choose how realistic to make it:

- **A bare object** — `{ verify: async () => ({ ok: true }) }`. Fastest; no
  network, no serialization. Right when only the return value matters.
- **The real client over an in-memory handler** — the framework's own client
  talking to your fake through an in-process function instead of the network.
  JSON encoding and both schema validations still run; there is just no socket.
- **A real local server** — the fake served on a loopback port and reached over
  real HTTP. This is what `bootstrapService` drives.

A dependency's package can ship its own fake as a separate entry point, kept out
of the deployed code. Because that fake is written against the same contract the
real service exposes, the two cannot drift apart.

## Alternatives considered

- **Add injection points to the code under test** (constructor or parameter
  injection, so a test passes fakes in directly). Rejected: application code
  would carry test-only seams, and there is nothing to add — `load()` already
  *is* the single point every dependency flows through.
- **Boot the whole composed app locally**, several services wired together in
  one process. Rejected as a *different* capability: `bootstrapService` boots
  one service. Running a full graph locally (a local `dev`) is worth building on
  its own terms, but it is not this seam.
- **A runner-agnostic mock wrapper** hiding `vi.mock`/`mock.module` behind one
  API. Rejected: runners differ in module-mock mechanics (hoisting, ESM
  handling) in ways not worth papering over. The framework supplies the typed
  value and documents the per-runner pattern instead.

## Related

- [`core-model.md`](core-model.md) — the `run`/`load` split these tools drive.
- [`deploy-cli.md`](deploy-cli.md) — the deployment boot that `bootstrapService`
  mirrors.
- [`../90-decisions/ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md`](../90-decisions/ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md)
  — why a hydrated dependency is a client a test can stand in for.
