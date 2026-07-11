# Slice spec: reusable auth System + the testing seam, proven live

The last slice of the system-composition project (H3). It turns the storefront's
auth from an inline service into a **reusable System that owns its database**,
and ships the **testing utilities** that make any app built on the framework
testable at two altitudes — proven by a unit test, an integration test, and the
existing live deploy.

Design contract: [`docs/design/10-domains/testing.md`](../../../../../docs/design/10-domains/testing.md)
(the testing model) + [`docs/design/10-domains/system-composition.md`](../../../../../docs/design/10-domains/system-composition.md)
(the System boundary). Deviations amend the docs first.

## Why

The composition machinery (H1 boundary + ADR-0017 control plane) is built and
merged, but nothing yet proves the value it exists for: that a System can be
**published, reused, and faked**. Today `examples/storefront-auth/systems/auth`
is a bare service whose Postgres is provisioned by the root and wired into its
`db` input. That is not a reusable unit — a consumer would have to know to
provision auth's storage. H3 makes auth a self-contained System and proves an
app composing it can be tested without a cloud.

## Deliverables

### 1. The reusable auth System (owns its db)

`auth` becomes a **System**, not a service: its body provisions its own Postgres
and its own compute service, wires the db in, and exposes the RPC contract as
the System's output. Its boundary has **no `db` input** — it exposes only
`{ rpc: authContract }`. The package declares `@prisma/*` as **peer
dependencies** (as a published reusable System would) and builds via its own
turbo `build` (standing in for publish-time build). The root `system.ts` no
longer provisions the database; it provisions the auth System and storefront,
wiring auth's exposed `rpc` into storefront's `auth` dependency.

### 2. `@prisma/app/testing` → `stubLoad` (unit seam)

Core, target-agnostic. `stubLoad(service, overrides)` returns a service node
whose `load()` yields `overrides` merged with the service's param defaults,
**typed against the service's `deps`** (a double not assignable to the dep's
hydrated type is a compile error). New export `@prisma/app/testing`
(`packages/app/src/testing.ts`; add `./testing` to the manifest + its tsdown
entry). It performs no module mocking itself — that stays in the test.

### 3. `bootstrapService` (integration seam)

The in-process counterpart of the deploy bootstrap. A `runForTest(config, boot)`
capability on the runnable node (implemented in `@prisma/app-cloud`'s
`compute.ts`, reusing the existing `stash` + `configOf`), wrapped by a generic
`bootstrapService(service, config)` in `@prisma/app/testing` that returns a
handle `{ url, fetch }`. It writes the chosen config to the environment exactly
as `run` does, boots the real entry, and hands back a driveable server.
**`server.ts` is not modified.** No `close()`: the entry owns its `Bun.serve`
handle, so teardown rides on bun-test's per-file process isolation (a single
boot per test file, cleaned up when the file's process ends). This is the
accepted trade for leaving the entry untouched.

### 4. The fake auth (ships from the auth package)

A `/fake` export on the auth package: an in-memory `verify` (`serve(fakeAuth, {
rpc: { verify: async ({ token }) => ({ ok: token.length > 0 }) } })`), no
Postgres, sharing the real `authContract` so its handler map is typed against
the same contract. Used by both proof tests.

## Proof

- **Unit test** — renders storefront's `page.tsx` with `load()` mocked via
  `stubLoad` to a fake `auth`; asserts the rendered output. No server, no env,
  no cloud. (vitest — the storefront's runner.)
- **Integration test** — runs the fake auth on a loopback port, boots storefront
  via `bootstrapService` with `auth.url` pointed at it, drives the page over
  HTTP, asserts the round trip. No cloud.
- **Live e2e** — the existing "Deploy, verify, destroy" job, unchanged in shape,
  now deploys the composed **auth System + storefront** to real Prisma Cloud and
  verifies the round trip. This is the reusable-System-deployed-for-real proof.
- All repo gates green (typecheck, test, lint, build, casts delta ≤ 0).

## Out of scope

- Running a whole composed graph locally (multi-service `dev` orchestration) —
  a separate capability the testing doc lists as a non-goal.
- A runner-agnostic module-mock abstraction — `stubLoad` ships the typed
  payload; the `vi.mock`/`mock.module` wiring stays in the tests.
- The post-merge cleanups (LoadedControl-style lookup dedup; folding
  `@prisma/alchemy` into `@prisma/app-cloud`) — tracked separately.

## Decisions (resolved)

- **Teardown:** option (a) — no `close()`; bun-test's per-file process isolation
  cleans up. `server.ts` stays untouched. (A cleaner "target owns the listen"
  refactor is explicitly out of scope for H3.)
- **Both paths ship, not either/or.** The unit test (`stubLoad`) AND the
  integration test (`bootstrapService`) are both deliverables. The integration
  test boots the **full Next storefront** in-process against a loopback fake auth
  — the real round trip. If Next-in-process boot proves genuinely intractable,
  fall back to driving a minimal RPC consumer through `bootstrapService` and flag
  it in the final report — do not drop the integration path.

## Notes for implementation

- `stubLoad`'s override type is the service's hydrated deps
  (`Client<C>` for rpc, the resource binding for resources) plus optional param
  overrides — derive it from the node's `Deps`/params, do not hand-roll.
- `runForTest` reuses `stash` (serializer.ts) + `configOf` — it must not add a
  second serialize path; writer/reader parity with deploy is the whole point.
- Keep the auth System's `authContract` and the fake in one package so the
  contract cannot drift.
