# Testing apps built on the framework

How a Prisma App is tested — from a single page component up to the full
request path — with no deployment, no cloud account, and no change to the code
under test. It rests on one fact: **every dependency an app touches flows
through one seam, `service.load()`**, so a test injects its doubles at that
single point and nothing about the application code moves.

## The one seam: `service.load()`

A service declares its dependencies (`deps`) and the ports it exposes
(`expose`). Its runtime code — the RPC server, a Next.js page, a server action,
a plain helper — never receives its dependencies as arguments and never reaches
for a global. It calls `service.load()`, which reads the process config
(deserialized from the environment the deploy injected — see
[`deploy-cli.md`](deploy-cli.md)), hydrates each dependency to its client or
binding (ADR-0015), and returns them typed.

Because that is the *only* way application code obtains a dependency, it is the
only place a test has to touch. A test never edits the code under test to accept
a fake; it controls what `load()` yields. Two altitudes need two tools — but
they hit the same seam from opposite sides: one replaces `load()`'s output, the
other feeds `load()`'s input.

## Unit — `mockService`: replace the seam's output

For code that calls `load()` directly and is exercised directly — a page
component, a server action, a utility — the test mocks the service module so
`load()` returns doubles, then calls the code with no server and no environment.

```ts
// storefront/app/page.test.tsx
import { mockService } from '@prisma/app/testing';
// mock storefront's own service module so load() returns a typed fake auth
vi.mock('../src/service.ts', () => ({
  default: mockService(realService, { auth: { verify: async () => ({ ok: true }) } }),
}));
import Page from './page.tsx';

// the double is checked against Client<authContract>; a wrong shape fails to compile
expect(await Page()).toContain('true');
```

`mockService(service, overrides)` returns a service node whose `load()` yields the
overrides merged with the service's param defaults, **typed against the
service's own `deps`** — a double that does not satisfy `Client<authContract>`
is a compile error. This is ordinary dependency-injection testing; the app code
runs unchanged. It is target-agnostic (every service node has a `load()`), so it
lives in core, `@prisma/app/testing`. The one runner-specific step — how the
module substitution is wired (`vi.mock`, bun `mock.module`) — stays in the test;
the framework supplies the typed payload, not the mock call.

## Integration — `bootstrapService`: feed the seam's input

For the real request path — the actual boot, the real client, the real wire
format — the test is the in-process counterpart of the deploy bootstrap. The
deploy bootstrap is `main.run(address, () => import(appEntry))`
([deploy-cli.md](deploy-cli.md)); `run` writes the resolved config into the
environment and boots the entry. `bootstrapService` does exactly that with a
config the test chooses:

```ts
import { bootstrapService } from '@prisma/app-cloud/testing';
import fakeAuth from '@storefront-auth/auth/fake'; // a serve() handler, no db
import storefront from '../src/service.ts';

const fake = Bun.serve({ port: 0, fetch: fakeAuth });

// storefront's build is nextjs(), whose entry lives in Next's standalone output
// dir — not module-relative — so it supplies an explicit boot thunk. A `node`
// service (like auth) needs none: the default derivation fits it.
const app = await bootstrapService(
  storefront,
  { service: { port: 4310 }, inputs: { auth: { url: fake.url.href } } },
  bootStandaloneNext(storefront.build),
);

const res = await app.fetch(new Request(app.url));
expect(await res.text()).toContain('Auth /verify says: <!-- -->true');
```

Nothing about `server.ts` changes — it boots and listens exactly as in
production; the test just points its `auth` binding at a local fake and drives
it over loopback. `load()` deserializes the injected environment identically to
a deployed process. The fidelity is the point: an integration test exercises the
production code path, not a stubbed one.

`bootstrapService` is **target-specific** — writing the environment is the
target's serializer's job — so it ships in the target's testing entry
(`@prisma/app-cloud/testing`), not core. It reuses the exact `stash` the deploy
boot uses, so `load()` reads the injected config identically to a deployed
process; nothing about it lives in the production runtime. `config.service.port`
must be concrete (the entry self-listens and never reports an OS-assigned port
back), and there is no `close()` — teardown rides bun-test's per-file process
isolation. `mockService` stays in core (`@prisma/app/testing`); it is
target-agnostic because every service node has a `load()`.

## The doubles: same contract, by type

A dependency's *hydrated type* is its contract. An RPC dependency
`rpc(authContract)` hydrates to `Client<authContract>` — `{ verify(input):
Promise<output> }` — so a double is any value of that type, checked at compile
time. Three grades, increasing fidelity:

- **A bare object** — `{ verify: async () => ({ ok: true }) }`. Fastest; skips
  the wire entirely. For unit tests where only the return value matters.
- **A contract-faithful in-process fake** — `makeClient(authContract, url, {
  fetch: serve(fakeAuth, handlers) })`: the *real* client over a *fake*
  transport, so JSON encode/decode and both schema validations still run. Same
  process, no socket.
- **A real local server** — the fake `serve()`d on a loopback port, reached by
  the real client over real HTTP. What `bootstrapService` uses.

The fake ships from the dependency's own package (a `/fake` export), so its
handler map is typed against the same `authContract` the real service exposes —
the contract cannot drift between the real service and its fake.

## Non-goals

- **Running a whole composed graph locally.** `bootstrapService` boots one
  service; wiring several services together in-process (a local `dev`
  orchestration) is a separate capability, not this seam.
- **A runner-agnostic mock abstraction.** The framework ships the typed double
  builder and documents the `vi.mock` / `mock.module` patterns; it does not wrap
  every test runner's module system.

## Related

- [`core-model.md`](core-model.md) — the `run`/`load` split these tools drive.
- [`deploy-cli.md`](deploy-cli.md) — the deploy bootstrap `bootstrapService` mirrors.
- [`../90-decisions/ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md`](../90-decisions/ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md)
  — why the hydrated dependency is a client the seam can double.
