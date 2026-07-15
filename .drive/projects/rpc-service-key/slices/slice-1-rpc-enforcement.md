# Slice 1 — RPC-layer service-key enforcement

One PR. Scope: `packages/0-framework/2-authoring/rpc` only. No core, no target,
no example. Fully unit-testable via the in-memory transport.

## What ships

### 1. `serviceKey` connection parameter — `src/rpc.ts`

- `rpc(contract)`'s connection gains a second param alongside `url`:
  `serviceKey`, **optional** (unprovisioned deploys and existing tests must not
  break). Use the existing param builder (`string()`); mark optional the way
  `coerce()` in the target serializer expects (`param.optional === true`).
- `hydrate({ url, serviceKey })` passes the key through to `makeClient`.
- This param is internal wiring; it does **not** change the authoring surface
  (`rpc(contract)` is still the whole call).

### 2. Client attaches the key — `src/client.ts`

- `makeClient(contract, url, opts?)` gains `opts.serviceKey?: string`.
- When a key is present, every request carries `Authorization: Bearer <key>`
  in addition to the existing `content-type` header. When absent, no auth header
  (the migration/inert state until slice 2 provisions keys).

### 3. Server verifies — `src/serve.ts`

- Export a constant for the reserved accepted-keys env var name, e.g.
  `export const RPC_ACCEPTED_KEYS_ENV = 'COMPOSER_RPC_ACCEPTED_KEYS'`. The target
  (slice 2) imports this to know what to write; the reader owns the name.
- `serve()` reads that env var (address-free — one served service per process,
  same as the stashed config `load()`/`config()` read). Declare `process`
  **structurally** at the top of the module, exactly like
  `target/src/serializer.ts` does, so the package keeps its "no node/bun
  coupling" property.
- Parse the value as a JSON array of strings = the accepted key set.
  - **Unset or empty array** → enforcement off; behave exactly as today
    (pass-through). This is the only state until slice 2.
  - **Non-empty** → require `Authorization: Bearer <key>` where `<key>` is a
    member of the set. Missing header, malformed header, or non-member →
    `401` (JSON `{ error }` body, same shape as the other error responses),
    returned **before** body parse / method lookup / dispatch.
- Membership test is **constant-time**: compare the presented key against each
  accepted key with a length-independent constant-time string equality (no
  `node:crypto` — keep the module runtime-agnostic), OR the per-key results,
  and always iterate the whole set. Good hygiene; the value is already a
  256-bit random token.

## Tests

Extend the existing `__tests__`:

- `rpc-connection.test.ts`: `end.connection.params` now includes `serviceKey`
  (update the `toEqual`). Add: `serviceKey` is optional.
- `client.test.ts` (or `serve.test.ts`): with a `serviceKey`, the outgoing
  `Request` carries `Authorization: Bearer <key>`; without one, it does not.
- `serve.test.ts`: drive enforcement through the in-memory transport.
  - accepted set configured + client sends a member key → dispatches, `200`.
  - configured + client sends wrong/no key → `401`, handler never runs.
  - unset/empty accepted set → passes through (existing round-trip tests stay
    green with no env set).
  - `401` is returned before input validation (a bad-input body with no key is
    `401`, not `400`).
  - Use `beforeEach`/`afterEach` (or `try/finally`) to set and clear the
    reserved env var so cases don't leak into each other or into the
    pass-through tests.

## Out of scope (slice 2)

Minting keys, the per-edge value channel in `buildConfig`, the `ServiceKey`
Alchemy resource, writing the consumer `serviceKey` / provider accepted-set
env vars, and the live deploy proof.

## DoD

- `@internal/rpc` unit + type tests green (`bun test` in the package; repo
  typecheck/lint clean).
- No change outside `packages/0-framework/2-authoring/rpc`.
- Existing RPC round-trip behavior unchanged when no accepted set is configured.
