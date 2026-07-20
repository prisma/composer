# Design: the streams binding — typed contract, framework-owned lifecycle, and provider params

Status: recorded for operator review (2026-07-17). Source: Will's review of
PR #92 (2026-07-17 09:16 round) and the design discussion that followed.
Supersedes the ad-hoc shapes those comments flagged. Once approved, the slice
spec/plan for the implementation derives from this document; decisions that
outlive the project get promoted to ADRs at close-out.

Two parts. Part A fixes how provider-side minted values reach a running
service (deletes `restashAddressFree`). Part B redesigns the streams contract
and client surface (deletes the app-side stream lifecycle code). They are
independent designs that happen to be exposed by the same review.

---

## Part A — provider-side minted values are reserved params

### The rule this restores

The address-namespaced platform vars (`COMPOSER_<ADDRESS>_*`) are the
target's **private storage medium** (ADR-0019). Exactly one reader is
sanctioned: `run(address)`'s `deserialize`, which validates each var against
a declared schema and re-emits the typed values into the process-local stash
(`COMPOSER_<NAME>`, address-free) that `load()`/`config()` read. Application
code never reads `process.env`; nothing downstream of `run()` knows the
address. Writer and reader share one definition (the serializer), so they
cannot drift.

### The defect in the current branch

ADR-0031's provisioning gave the *consumer* side this treatment properly: a
consumer's minted value (e.g. rpc's `serviceKey`) is a declared connection
param, filled at provision, carried through the typed pipeline.

The *provider* side did not get it. A provider's minted values — the rpc
accepted-keys set, the streams service's API key — are written at deploy as
**undeclared** vars by per-brand hooks (`ProvisionLanding`). Because they are
undeclared, `deserialize` cannot carry them, so two runtime readers scrape
`process.env` directly (`serve()` for `COMPOSER_RPC_ACCEPTED_KEYS`, the
streams entrypoint for `COMPOSER_STREAMS_API_KEY`), and `restashAddressFree`
exists solely to make those scrapes work: at boot it copies the service's
**entire raw namespace** to address-free names, unvalidated, around the typed
pipeline. That is the design violation the review flagged ("Woah what?
why???"), and it is a symptom: the cause is the undeclared values.

### The design

**Every provider-side minted value is a reserved param**: a named, schema-
carrying declaration owned by the target, exactly like `port`. One
registration per brand, kept where brands are already named — the target's
provisioning registry in `control.ts` — so `compute()` (factory and
descriptor) stays brand-blind.

A registration replaces today's `ProvisionLanding` and carries:

- `name` — the reserved param's name. The stored var name is derived through
  `configKey(address, { owner: 'service', name })` at deploy and
  `configKey('', …)` at boot, so writer and reader cannot drift (this is
  already how `serviceKeyEnvName`/`streamsApiKeyEnvName` are built).
- `schema` — a Standard Schema for the decoded value (e.g. `string[]` for
  accepted keys, `string` for the streams API key). Boot validates against
  it like any param.
- `value(refs)` — deploy-side: given the provider's inbound minted refs for
  this brand (possibly empty), the typed value to store, or `undefined` to
  store no row. Encoded by the serializer as a service-own literal
  (JSON), like every other param — no more brand-hook-invented encodings.

**Deploy side** (`descriptors/compute.ts`): unchanged in structure — for each
exposing service, group inbound provisioned edges' refs by brand, ask each
registered entry for its value, write the env row through the serializer's
normal encode. The provider-driven iteration is kept deliberately: a deployed
provider with zero wired consumers must still be able to emit a
deny-everything value (rpc stores `[]`), because an absent var means "never
provisioned" (local dev, tests), not "no consumers".

**Boot side** (`compute.ts` `run()`): `deserialize` gains the reserved
provider params as a second enumeration source alongside `paramEntries` —
same validation, same stash emission. If the row is absent, nothing is
stashed (absence keeps meaning "never provisioned"). `restashAddressFree` is
**deleted**; `run()` returns to deserialize + stash + stashSecrets + `PORT`,
as on main.

**Runtime readers**: the address-free stash row is the documented
process-local channel for framework runtime code, and it now holds a
validated value or nothing.

- `serve()` keeps its documented slot (`COMPOSER_RPC_ACCEPTED_KEYS`), now fed
  by the typed stash rather than a raw sweep. Absent → pass-through mode,
  unchanged semantics. This stays an env-shaped contract because `serve()`
  is framework-layer (target-agnostic) code that cannot call a target
  factory's `config()`; the slot's name and decoded shape are part of the
  rpc kind's runtime contract, and any target that hosts an rpc provider
  must fill it.
- The streams entrypoint reads its slot (`COMPOSER_STREAMS_API_KEY`) the same
  way, same justification.

These values do **not** appear in user-facing `config()`: they are the
framework's plumbing, not the service's settings. Reserved provider params
are validated and stashed but excluded from `Values<P>`.

### What this deletes or renames

- `restashAddressFree` — deleted, with its tests replaced by tests that the
  reserved provider params round-trip through deserialize/stash.
- `ProvisionLanding` / "landing" — the name goes away. The concept is renamed
  to what it now literally is: a **provider param** registration (working
  names: `ProviderParam`, registry `providerParams`; final naming at
  implementation, but no coined vocabulary — the doc comments say "the
  provider-side reserved param for this brand's minted values").
- `serviceKeyEnvName` / `streamsApiKeyEnvName` — subsumed by deriving the
  name from the registration through `configKey`.

### Invariants preserved (pinned by existing tests, which move, not die)

- Zero-consumer rpc provider stores exactly `"[]"` (deny-all, fail-closed).
- A pure consumer (no `expose`) gets no provider rows.
- A third brand touches only `control.ts` (its registration) — no compute
  file, no descriptor.

---

## Part B — the streams contract carries the streams

### The defect

`streamsContract` is kind-only: `satisfies` is `kind === 'streams'`, and the
binding is transport config (`{ url, apiKey }`) hydrated to a raw protocol
client. The contract carries no stream names and no event definitions, so
everything above the transport fell to the app: the `STREAM` constant, the
memoized ensure-create, the `withStream` heal wrapper on every operation.
That is platform-level handling in user code, which the framework exists to
prevent.

### The contract

A streams contract **names the streams it transports**, each with an
**optional event definition**. Untyped streams are retained deliberately —
the parity is `postgres()`, which binds a real resource without a schema
contract — but "untyped" only drops the event type, never the lifecycle:
no variant of the API requires the app to name streams in call sites, create
them, or heal them.

Authoring (names indicative; final spelling at implementation):

```ts
// Typed: the event definition is a Standard Schema (arktype canonical).
const jobLog = streamsContract({
  jobs: streamDef({ event: JobEvent }),   // typed stream
  audit: streamDef(),                     // untyped stream: events are `unknown`
});
```

- `streamDef({ event })` — a typed stream: events validate against the
  schema.
- `streamDef()` — an untyped stream: same lifecycle, no validation, events
  type as `unknown`.
- The contract value carries the def map as its `__cmp` (the rpc pattern);
  stream names are protocol data (URL path segments), not config keys, so no
  `configKey` interaction.

### The consumer surface

```ts
// deps: { events: durableStreams(jobLog) }
const { events } = service.load();

await events.jobs.append({ id, state: 'queued' }); // validated, typed
const { events: page, nextOffset } = await events.audit.read();
const delivery = await events.jobs.tail({ offset: nextOffset });
```

- `durableStreams(contract)` hydrates to **one handle per declared stream**,
  keyed by name. The handle owns the name; no `STREAM` constant.
- Bare `durableStreams()` (no contract) is retained for dynamic stream names
  (e.g. per-tenant streams, and the raw parity with `postgres()`): it
  hydrates to a client whose surface is `stream(name)` returning an untyped
  handle. Same lifecycle ownership; the name is data, not app-side protocol
  handling.

### Handle semantics (the lifecycle moves inside the framework)

Each handle owns, internally:

- **Ensure-create**: the first operation on a handle creates the stream
  (memoized per handle; create is already ensure-style upstream, so racing
  instances are harmless). Consequence, accepted: using a stream is
  sufficient to create it, so a mistyped dynamic name creates an empty
  stream rather than erroring. Contract-declared streams make the name a
  reviewed, typo-checked identifier, which is the primary path.
- **Heal on stream-not-found**: if an operation fails with the wire client's
  404, drop the memo, re-create, retry the operation **once**. The safety
  argument, proven in PR #92's review round 11 and unchanged by the move: a
  404 is generated instead of a write at every layer, so it proves nothing
  was applied — retrying once cannot duplicate an event, even an append.
  Ambiguous failures (socket close, 502/504) carry no 404 status, never
  match, and surface raw.
- **Append safety, unchanged**: appends are never retried (beyond the heal's
  proven-safe case) and never batched; the wire-counting mutation tests move
  from the example into the client package and keep their teeth.
- **Cold-start compensation, unchanged**: `IDEMPOTENT_BACKOFF` on
  create/read/tail, nothing on append, PRO-219 annotation and the PRO-217
  canary's removal trigger all stay as shipped.

`isStreamNotFound` stops being exported: its only consumer was the app-side
heal, which no longer exists. The example app after this design is routes and
error mapping only.

### Validation semantics (typed streams)

- `append` validates the event against the def **before** sending — a bad
  event fails locally, no wire traffic.
- `read`/`tail` validate each received event **after** receiving — the same
  trust model as rpc's `makeClient` output validation: a provider can be
  type-compatible and still lie at runtime.
- Untyped streams skip both; values pass through as `unknown`.

### What `satisfies` checks — and deliberately does not

`satisfies` stays **kind-level** (`kind === 'streams'`). The streams server
is schema-agnostic — the Durable Streams protocol carries bytes, not types —
so a provider cannot attest to event shapes and pretending otherwise would
be a guess (the principles forbid guessing). The event definitions are a
**client-side compact**: enforcement is the consumer's validation at the
edges, exactly like rpc's output validation. Two consumers declaring
conflicting defs for the same stream name is therefore expressible and not
detected at wiring time; the runtime validation is what catches the lie,
on the reader's side, per reader.

### Client construction

`createStreamsClient`'s object-of-closures becomes a **class** (review
direction, no repo rule to the contrary): `StreamsClient` class holding the
transport (URL, auth, writer map), `StreamHandle` class holding per-stream
state (name, def, ensure memo). `isAlreadyExists` and the 404 predicate stay
module-private functions.

### Example after the design

`examples/streams/src/jobs/app.ts` keeps: routes, HTTP mapping of
`offset`/`timeout` query params, the 502-with-cause error mapping. It loses:
`STREAM`, `ensureStream`, `withStream`, the `isStreamNotFound` import. The
heal test (delete the stream out from under the app, prove recovery) moves
to the streams package as a handle test; the example's integration tests
exercise the typed handle surface.

---

## Scope split

- **PR #92** (this branch): Part A in full. Part B with **untyped defs
  only** — contract carries names, handles own lifecycle, `streamDef()`
  without an event parameter, bare `durableStreams()` retained. This is
  everything the review findings require; no half-implemented schema
  parameter ships.
- **Follow-up slice** (recorded, not scheduled): `streamDef({ event })` —
  the schema parameter, both-edge validation, typed handle generics. Purely
  additive on the #92 shape; nothing lands in #92 that the typed version
  throws away.
- **Set aside separately** (operator direction, 2026-07-17): RPC cold-start
  handling with its own canary — its own task, not part of this design.

## Review threads this resolves

| Thread | Resolution |
|---|---|
| `STREAM` / `withStream` in app code | Part B: handles own name + lifecycle |
| `restashAddressFree` ("Woah what? why???") | Part A: deleted; values become declared reserved params |
| `ProvisionLanding` "deeply suspicious" / registry map "looks like a hack" | Part A: reframed and renamed as provider param registrations; same brand-blind seam, now inside the param system |
| `createStreamsClient` "convert to a class" | Part B: class-based client and handles |
| app.ts/server.ts split | Kept: the handler stays a pure `Request → Response` function testable without a server; reply on thread |
| descriptors/compute.ts "just indentation?" | Substantive (per-brand block → generic loop); reply on thread; Part A reshapes it again |

---

## Amendment 1 (2026-07-17, post-audit rulings)

From [streams-binding-audit.md](streams-binding-audit.md), after Will's
review of the as-built branch:

- **The provider contract is the postgres pattern** (`7b07aa0`): the
  module's port is `Contract<'streams', StreamDefs>` with an honest empty
  def map as its unread placeholder — the same encoding `postgresContract`
  uses. The consumer's required type is equally wide (kind is the whole
  wiring requirement); literal handle typing comes from the generic
  parameter. The `never`-typed `__cmp` and its cast are deleted.
- **Creation is implicit and only implicit** — no public `create()` on
  handles; the first operation creates, memoized. Recorded as deliberate.
- **Reading a never-created stream creates it** and returns an empty page,
  uniformly on both the contract and dynamic paths. Deliberate: symmetry
  beats a special case, and contract-declared names are reviewed
  identifiers. Known cost, accepted: a typo'd *dynamic* name yields empty
  data rather than an error.
- **`contentType` is gone from the public surface**; the module is
  JSON-events by contract. Any future negotiation belongs to the typed
  `streamDef({ event })` follow-up.
- **`StreamDef` carries `{ kind: 'stream-def' }`** so the def map rejects
  arbitrary values and the typed follow-up has a shape to extend.
- **Part A improvement over this doc**: `control.ts` *derives* its deploy
  registry from the boot list (`provider-params.ts`) and throws at module
  load on a missing value — stronger than the two-lists-plus-drift-test
  this doc described.
