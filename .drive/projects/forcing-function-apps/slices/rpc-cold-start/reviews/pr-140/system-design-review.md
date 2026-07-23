# PR #140 — System-design review (architect persona)

**Range:** `origin/main...HEAD` on `claude/streams-cold-start-rpc-37e5c1`.
**Lens:** system shape, ubiquitous language, bounded contexts, dependency
direction, typology integrity, conceptual minimality. Not correctness/blast
radius (→ principal-engineer pass), not learnability/scope (→ tech-lead).

**Verdict: the design is sound and the boundaries hold.** The added concept —
an idempotency key as a property of the network binding — is placed in the
right bounded context, with clean dependency direction and honest scoping. The
naming is largely clean under the probes. Two observations are worth recording,
both minor and neither blocking: one genuine consumer-vs-essence catch on
`RpcHandlerContext`, and one naming-passivity note on `IdempotencyStore`. The
rest of this document says what I checked and why each check passes, because an
unexamined "looks fine" is worthless.

---

## 1. The concept added, and where it lives

The PR adds one concept: **a per-call idempotency key that rides the network
binding**, making every service-RPC call safely retryable. Concretely:

- Client (`client.ts`) mints one `crypto.randomUUID()` per logical call, reuses
  it byte-identically across a bounded jittered retry, and never shares it
  between two calls.
- Server (`serve.ts`) requires the key (keyless → `400`), single-flights
  duplicates that arrive mid-execution, and replays completed `2xx`/`4xx`
  answers from a bounded in-process `IdempotencyStore`.
- Handlers gain an optional third argument `ctx: RpcHandlerContext` carrying
  `ctx.idempotencyKey`, the escalation path for cross-instance exactly-once.

**Bounded context and dependency direction — verified clean.** Everything lives
in `packages/0-framework/2-authoring/service-rpc/`. The idempotency protocol is
a property of the RPC network binding, so it belongs with the RPC client/server
generation — this is the right context.

- No leak into core. `serve.ts:25` imports only `Contract, Expose,
  RunnableServiceNode` from `@internal/core`; core gains no idempotency concept
  (connection-contracts.md's "core mints nothing and knows nothing about RPC"
  still holds).
- **No prisma-cloud dependency for the PRO-217 motivation.** `package.json`
  deps are `@internal/core`, `@internal/foundation`, `@standard-schema/spec`,
  `arktype` — nothing from prisma-cloud. The streams client's retry numbers are
  *reimplemented*, not imported, with the reason stated inline
  (`client.ts:33-38`: "must not depend on prisma-cloud"). This is the correct
  treatment: the framework layer stays target-agnostic in type while borrowing
  a proven constant. The `grep` for `prisma-cloud|streams|IDEMPOTENT_BACKOFF`
  hits only comments, never an import.
- Adopter surface is minimal: `exports/index.ts` adds exactly one name
  (`RpcHandlerContext`). `IdempotencyStore`, `Outcome`,
  `RequestBodyTooLargeError`, `MAX_BODY_BYTES`, `REPLAY_CACHE_MAX_ENTRIES` are
  `export`ed from `serve.ts` for the package's own tests but **not** re-exported
  to adopters — so their naming audience is framework maintainers, a lower bar
  than the adopter-facing `RpcHandlerContext`.

---

## 2. Typology integrity of every introduced name

Firing the probes (discriminator-completeness, consumer-vs-essence,
concept-vs-mechanism, reads-cold) at each new name.

### Clean — affirmed

- **`Idempotency-Key` header.** Reuses established industry vocabulary (Stripe's
  header of the same name). Not invented. Symmetric with the service key, which
  rides the standard `Authorization: Bearer` header — both bindings speak
  standard HTTP header vocabulary. Good.
- **`Outcome`** (`serve.ts:70`, `{ status, bodyText }`). A deliberately distinct
  name for the *reduced, serializable* form of a response, as opposed to the web
  `Response`. This is a good decision, not laziness: caching a live `Response`
  (whose body is a one-shot stream) would be a latent bug, so naming the reduced
  form distinctly is the conceptually correct move. Reads cold via
  `toResponse(o: Outcome)`.
- **`RequestBodyTooLargeError`** (`serve.ts:96`). Names exactly the condition it
  signals; used as a typed control-flow marker caught in `run()`. Reads cold.
- **`MAX_BODY_BYTES`, `REPLAY_CACHE_MAX_ENTRIES`, `REPLAY_TTL_MS`.** Each carries
  a justifying comment. The `REPLAY_` prefix is an *accurate* discriminator, not
  noise: the LRU/TTL bounds govern the completed-answer (replay) set
  specifically; the pending single-flight set is bounded naturally by
  concurrency and is deliberately not LRU-bounded. The prefix correctly scopes
  the constant to what it governs.
- **No qualifier-prefix noise anywhere.** `Rpc*` on `RpcHandlerContext` is the
  kind namespace (a real contrast set: a future kind would have its own handler
  context), not an empty qualifier. No `Base*`/`Internal*`/`Keyed*`-style
  prefixes implying an unnamed complement.

### Observation A (minor, adopter-facing): `RpcHandlerContext` is named for its consumer, not its essence

`serve.ts:43`. The struct's single field is `idempotencyKey` — a fact about the
**call**, not about the **handler**. Strict essence-analysis therefore prefers
`RpcCallContext` (the call's ambient metadata) over `RpcHandlerContext` (named
after the code that receives it). This is a real consumer-vs-essence catch.

Weighing against it: "handler context" is a widely-understood idiom — Express,
Koa, and AWS Lambda all call the ambient per-invocation object the "context" the
handler receives, and the `ctx` parameter name reinforces the idiom at the call
site. So the name follows a strong convention even though the essence points
slightly elsewhere. **Severity: low.** Not worth churning an adopter-facing
type over; recorded so the choice is deliberate, not accidental.

### Observation B (minor, internal): `IdempotencyStore` reads passive for a thing that also coordinates

`serve.ts:155`. The class does three things: single-flight coordination (pending
promises), replay caching (completed outcomes), and LRU+TTL bounding. "Store"
captures the caching and bounding but undersells the single-flight
*coordination* — a reader could expect a passive key→value store rather than an
active call de-duplicator. The docs use a different word again ("the server's
memory of answers", ADR-0037). None of these is wrong, and the `dispatch()`
method name recovers the active semantics, and the type is package-internal.
**Severity: low.** A name like `IdempotencyRegistry`/`CallDeduplicator` would
foreground the coordination, but this is not worth a rename.

---

## 3. The third handler argument: right typology, and the struct earns its keep

The task asks whether `(input, deps, ctx)` — bolting `ctx` on as a third
positional arg — strains the handler concept. **It does not, given this kind's
scope, and the analysis actually resolves Observation A's mild worry.**

The three positional args are three genuinely distinct concerns: `input` (the
RPC payload — the essence), `deps` (the service's loaded dependencies — DI), and
`ctx` (the binding's per-call ambient facts). The obvious alternative — oRPC's
single-context-object style `({ input, ctx }) => ...` — was **explicitly
rejected** for this kind by ADR-0036 (adopting oRPC's authoring model was the
category error PR #114 made). Within that scope constraint, appending an
optional third positional arg is the minimal non-breaking way to surface the
key.

The non-breaking-ness is a real, verified property, not a hope: `HandlerFor`
(`serve.ts:48-50`) types `ctx` as a third parameter, and a 2-arg function is
assignable to a 3-arg parameter type by JS/TS arity subtyping. The type-level
test confirms both directions — `serve-handlers.test-d.ts:55-72` shows the
2-arg handler still compiles and the 3-arg form sees `ctx.idempotencyKey: string`.

**Why this makes `RpcHandlerContext`-as-a-struct correct rather than
speculative.** Positional-arg growth does not scale — a fourth cross-cutting
concern would want a fourth slot, which is where the shape would start to
strain. The struct is the pressure-relief valve: future per-call facts extend
`RpcHandlerContext` rather than lengthening the arg list. So the design has
deliberately chosen its growth axis (inside `ctx`, not more positions), and that
choice is *why* a bare `key: string` third arg would have been the worse
call — it would have forced the next concern into a fourth position. The
one-field struct is not speculative extensibility tax; it is the designated,
minimal seam.

---

## 4. Symmetry with the service key — parallel, with one justified break

connection-contracts.md frames both keys as riding the binding, and the new
§ "The binding retries safely" explicitly says "This is a property of the
binding, like the service key above." The parallel holds:

| | Service key (ADR-0030) | Idempotency key (ADR-0037) |
|---|---|---|
| Carried in | `Authorization: Bearer` header | `Idempotency-Key` header |
| In-memory / mock binding | no edge, no key, unaffected | no hop to drop, no retry/dedupe |
| Contract says | nothing | nothing |
| Visible to handler code | **no** | **optionally yes** (`ctx.idempotencyKey`) |
| Provenance | per-binding, provisioned by target registry | per-call, minted at runtime |

Two asymmetries, both correct:

1. **The handler can read the idempotency key but never the service key.** This
   break is *by design and named*: the service key is a pure transport-auth fact
   the handler never needs; the idempotency key is deliberately surfaced as the
   escalation path for the cross-instance residual. The asymmetry is the point,
   not a slip.
2. **Provenance differs** — the service key is one per-edge value provisioned at
   deploy; the idempotency key is fresh per call. So "rides the binding" is used
   at the *behavior* level (retry/dedupe is a network-binding property), not the
   *artifact* level (the key itself is per-call). The doc is careful enough
   here ("The retry is permanent behavior of a network binding") that this reads
   as a fair analogy, not an overreach.

The section heading — "The binding retries safely, so a dropped request is not a
lost call" — names the *guarantee*, matching the sibling heading "The network
binding authenticates itself." Both name the property, not the mechanism.
Symmetric heading style. Good.

---

## 5. Conceptual minimality of the store, and the joint it carves

**The state model is minimal.** Two states — `pending` (holds the in-flight
promise, for single-flight) and `completed` (holds outcome + timestamp, for
replay) — plus two orthogonal bounds: LRU (memory, since the cache is resident
in every provider) and TTL (time, aligning replay to the retry envelope).
Neither bound is redundant: TTL-without-LRU leaves memory unbounded under a high
unique-key rate inside the window; LRU-without-TTL lets an answer replay
arbitrarily long after the retry envelope closed. Each bound carries distinct
weight; there is no speculative machinery.

**The cache-vs-not joint is carved correctly — and the carve is more elegant
than the spec bill-of-materials suggests.** The rule is `status >= 500 → not
cached, else cached` (`serve.ts:189-192`), with thrown errors also dropped
(`serve.ts:184-187`). Two things are worth stating explicitly because they show
the joint is at the right place:

- The set the server **refuses to cache** ({thrown, 5xx}) is exactly the set the
  client **retries** ({thrown, 429, 5xx}), minus 429 — which `serve()` never
  emits. So a request the client will retry always re-executes on the server,
  and a request the server caches ({200, and the in-`run` 4xx: 400/413}) is one
  the client will never resend. The retry policy and the cache policy are
  **complementary by construction**, which is why "replay a `4xx`" is safe even
  though it looks surprising: the generated client won't trigger it, and a
  non-generated caller (curl, a test fixture) reusing a key gets a harmless
  deterministic replay.
- The pre-dispatch rejections (`401`, keyless `400`, unknown-method `404`, wrong-
  verb `405`) never enter the store at all — they are cheap, stateless, and
  deterministic, so deduping them would be machinery for nothing. Only 413/400/
  500/200 flow through `run`, which is the correct scope for the store.

This is the "2xx-and-4xx-replayed-but-not-5xx" carve the spec asked for, and it
sits at a real joint: *answer* (a conclusion the caller should not re-attempt)
vs. *retryable outcome* (the thing a retry exists to escape). ADR-0037's prose
("What counts as an answer matters") names the joint in the same terms.

---

## 6. ADR-0037 reasoning quality

- **"No per-method flag because the framework can't verify the claim" is a sound
  conceptual argument.** Idempotence is a property of what a handler does to
  state; the RPC layer cannot inspect that; therefore `idempotent: true` is an
  unverifiable claim whose failure mode is silent (wrong mark → duplicate
  writes). The key inverts this into a mechanism the framework enforces, asking
  the author for nothing. The ADR also lands the secondary point — a
  safe-default boolean ("not idempotent") guarantees under-marking, so the
  mechanism would protect nothing. This is the textbook "prefer an enforced
  mechanism over an unverifiable declaration" move, applied correctly.
- **The named residual is honestly scoped, not a hole dressed as a decision.**
  Both the ADR and spec state plainly that in-process memory cannot cover a
  retry landing on a *different* instance, explain why closing it (a durable
  store behind every provider) is not warranted by any supported target's named
  failure modes, and give the concrete escalation path (`ctx.idempotencyKey`
  written inside the handler's own transaction). Crucially, the honesty rests on
  the primary failure being *pre-handler*: PRO-217 drops the connection before
  any handler runs, so retrying it cannot duplicate work regardless of dedupe.
  The dedupe adds value only for the narrower "answer lost after the handler ran,
  retry hits the same instance" case. The docs claim exactly that and no more —
  no false "exactly-once" advertisement. This is a residual named, not hidden.

**Scope-drift check against ADR-0036 — passes.** ADR-0036 calibrates this kind
as topology-internal, "not general distributed-systems infrastructure," and
records that durable exactly-once delivery was a category error. An idempotency
key plus retry *could* look like drift toward general RPC-framework territory.
It does not, because: (a) it is calibrated against one named platform failure
(PRO-217) per the connection-contracts.md per-edge rule, (b) it stays in-memory
with no durable store and no cross-instance guarantee, and (c) it explicitly
*declines* the durable version in "Alternatives considered." It adds exactly the
robustness the named failure warrants and no more. The retry is framed as
permanent protocol semantics ("correct on any transport that can drop a
request") with PRO-217 as the *urgency*, not the *justification* — so the
framework layer is not coupled to Prisma Compute even though one platform's
behavior made shipping it urgent.

One coherence note I checked (not a defect): gotchas.md frames the *streams*
client's identical backoff as a removable "PRO-219 compensation" while this
PR's *service-RPC* retry is "permanent protocol semantics." Same numbers,
opposite lifecycle status. This is consistent, not contradictory: the streams
retry is a bare retry (a workaround), whereas the service-RPC retry is *keyed*
and therefore safe on any dropping transport. The distinction is exactly the one
this PR exists to establish. Whether streams should later inherit keys is
out of scope (the spec lists it under streams follow-ups).

---

## 7. Test strategy at the architectural level

The tests prove the architectural properties, not just happy paths:

- **Cross-method isolation** — `serve.test.ts` "a replayed answer cannot cross
  methods, even when the same idempotency key is reused" builds a two-method
  service, reuses one key across `verify` and `echo`, and asserts `echo` returns
  its own answer. This exercises the structural guarantee (`byMethod` map keyed
  by method first, `serve.ts:156`) rather than trusting it.
- **Key-identity semantics** — client tests assert at the stub transport
  (the right altitude): "503 then success → exactly two requests, same key on
  both"; "two separate logical calls → different keys"; "404 → exactly one
  request" re-checked after a 300 ms settle window so a stray background retry
  would be caught.
- **The carve itself** — "5xx not cached → same-key retry re-executes"
  (handlerCalls === 2) proves the retryable-vs-answer joint; single-flight is
  proved with a gated handler and concurrent same-key calls.
- **The absorbed fixes** are tested at the property they protect: the 413 body
  cap is asserted against a lying and an absent `content-length` (bytes-read
  enforcement, not header trust); exception masking asserts the secret string is
  absent from the body *and* present in `console.error`, separately for handler
  throws, output-validation failures ("provider bug" logged distinguishably),
  and mid-read stream errors; input-validation `400` asserts the detail *is*
  present.
- **Type-level** — `serve-handlers.test-d.ts` proves the non-breaking claim
  directly: 2-arg handlers still compile, 3-arg form types `ctx.idempotencyKey`.

The structure targets the invariants an architect cares about (isolation,
key-identity, the carve, non-breaking arity) rather than line coverage.

---

## Summary for synthesis

- **Boundaries and dependency direction: clean.** New concept correctly placed
  in `service-rpc`; no core leak; no prisma-cloud dependency (streams numbers
  reimplemented, not imported); adopter surface grows by exactly one name.
- **Naming: largely clean under the probes.** Two minor observations —
  `RpcHandlerContext` is named for its consumer where its one field is a
  call-fact (essence would prefer `RpcCallContext`; idiom defends the choice);
  `IdempotencyStore` reads passive for a class that also single-flight-
  coordinates. Neither blocking; both internal-or-idiomatic.
- **The three-positional handler shape is right for this kind's scope**, its
  non-breaking-ness is verified by arity subtyping, and the one-field `ctx`
  struct earns its keep as the designated growth axis (so the arg list stays
  at three).
- **Conceptual minimality holds:** two states + two orthogonal bounds, no
  speculative machinery; the cache/retry sets are complementary by construction,
  carving "answer vs. retryable outcome" at a real joint.
- **ADR reasoning is sound and the residual is honestly scoped** — not drift
  toward general distributed-systems infra; it adds exactly the robustness one
  named failure warrants and explicitly declines the durable version.

Nothing in the system-design lens blocks this PR.
