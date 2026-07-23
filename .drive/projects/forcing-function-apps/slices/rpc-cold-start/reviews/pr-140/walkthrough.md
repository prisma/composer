# Walkthrough — PR #140: service-RPC idempotency keys

Audience note: this is the narrative tour of the change set. The two evidence
files next to it — [`system-design-review.md`](system-design-review.md)
(architect lens) and [`code-review.md`](code-review.md) (principal-engineer
lens) — carry the substantive verdicts and findings; this file references them
where they matter and does not re-adjudicate.

## Before / After (intention in code)

```ts
// BEFORE — makeClient: one shot, no retry, no key. A dropped first-touch
// connection to a cold-starting target surfaced as a thrown error to the app.
const res = await send(new Request(methodUrl(url, method), {
  method: 'POST', headers, body: JSON.stringify(input),
}));
if (!res.ok) throw new Error(`RPC call "${method}" failed: …`);
return standardValidate(schemas.output, await res.json()); // client re-validates
```

```ts
// AFTER — one idempotency key per logical call, reused across a bounded retry;
// the server dedupes on it, so retrying can never double-execute.
const idempotencyKey = crypto.randomUUID();
return callWithRetry(send, () => new Request(methodUrl(url, method), {
  method: 'POST',
  headers: { ...baseHeaders, [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
  body,
}), method); // no client-side re-validation: serve() already guaranteed output
```

## Sources

- PR: [#140](https://github.com/prisma/compose/pull/140)
- Canonical spec: [spec.md](../../spec.md) · decision: [ADR-0037](../../../../../../docs/design/90-decisions/ADR-0037-service-rpc-calls-carry-an-idempotency-key.md)
- Commit range: `origin/main...HEAD`

## Intent

Make every service-to-service RPC call safe to retry, so a first-touch
connection dropped while a scale-to-zero target boots (PRO-217) becomes a
retried call that succeeds instead of an error the app sees. The safety comes
from a mechanism, not a promise: the protocol requires an idempotency key and
the framework dedupes on it, so no method has to declare whether it is safe to
repeat.

## Change map

- **Implementation**:
  - [packages/0-framework/2-authoring/service-rpc/src/client.ts (L52–L155)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/client.ts:52-155) — key minting + bounded retry
  - [packages/0-framework/2-authoring/service-rpc/src/serve.ts (L155–L230)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/serve.ts:155-230) — `IdempotencyStore` (single-flight + replay)
  - [packages/0-framework/2-authoring/service-rpc/src/serve.ts (L356–L362)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/serve.ts:356-362) — keyless-request 400
  - [packages/0-framework/2-authoring/service-rpc/src/serve.ts (L94–L122)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/serve.ts:94-122) — body cap read
  - [packages/0-framework/2-authoring/service-rpc/src/serve.ts (L43–L46)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/serve.ts:43-46) — `RpcHandlerContext`
- **Tests (evidence)**:
  - [client.test.ts (L107–L177)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/__tests__/client.test.ts:107-177) — key present, per-call uniqueness, same-key-across-retries, 429/5xx retry
  - [serve.test.ts (L281–L400)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/__tests__/serve.test.ts:281-400) — replay, single-flight, LRU, cross-method isolation
  - [serve.test.ts (L114–L215)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/__tests__/serve.test.ts:114-215) — exception masking (three paths), input-400 keeps detail, body cap

## The story

1. **The client stops trusting the first attempt.** It mints one key per
   logical call and retries a dropped call — thrown network errors, 429, and
   any 5xx — with a jittered backoff, sending the *same* key every attempt so
   the server can recognise a retry. Every other 4xx surfaces immediately: a
   real rejection is not a transient failure.

2. **The server makes retrying safe rather than dangerous.** `serve()` now
   requires the key and dedupes on it: a duplicate arriving while the first
   call is still running waits for it (single-flight, one handler execution),
   and a duplicate arriving after a completed answer replays that answer. The
   architect pass names the joint that makes this correct: the answers the
   server *replays* (2xx/4xx) and the outcomes it *never caches* (5xx/throws)
   are exactly complementary to what the client retries — so a retried request
   always re-executes, and a replayed 4xx is one the client would never have
   resent. See [`system-design-review.md`](system-design-review.md) §
   observation 1.

3. **The key is required, not optional.** A keyless request is a 400 naming
   the header — "required" enforced, because a server that silently accepted
   keyless requests would lose deduplication for any caller that forgot one.

4. **Three fixes that live in the same code came along.** They were promised
   when the oRPC PR (#114) was declined and touch these exact files: a request
   body size cap (413, counted against bytes actually read so a lying
   `content-length` can't bypass it), masking of handler exception messages
   (a generic 500 to the caller, the real error to `console.error`; but an
   input-validation 400 deliberately keeps its detail), and removal of the
   client's now-redundant response re-validation (the server already validates
   output; both ends are framework-generated).

## Behavior changes & evidence

- **Every call is retryable, safely** — one-shot-or-throw → keyed retry with
  server dedupe.
  - **Why**: PRO-217 drops first-touch connections during a cold boot; a
    retry rescues it, and the key stops the retry from double-executing a
    write. Permanent protocol semantics, not a platform workaround.
  - **Implementation**: [client.ts (L95–L155)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/client.ts:95-155), [serve.ts (L155–L230)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/serve.ts:155-230)
  - **Tests**: [client.test.ts (L139–L156)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/__tests__/client.test.ts:139-156) (same key across two requests), [serve.test.ts (L282–L352)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/__tests__/serve.test.ts:282-352) (replay + single-flight)

- **A replay can never answer the wrong call** — the store keys by method then
  key, so a lookup for method B cannot return A's answer.
  - **Why**: dedup correctness is the whole safety argument; cross-method
    leakage would be a silent data bug.
  - **Implementation**: [serve.ts (L155–L165)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/serve.ts:155-165)
  - **Tests**: [serve.test.ts (L381–L400)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/__tests__/serve.test.ts:381-400)

- **Handlers can reach the key** — new optional third argument
  `(input, deps, ctx)` carrying `ctx.idempotencyKey`, for an edge that wants
  cross-instance exactly-once in its own transaction.
  - **Why**: the in-memory store cannot cover a retry landing on a different
    instance; this is the escape hatch, not a framework guarantee.
  - **Implementation**: [serve.ts (L43–L46)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/serve.ts:43-46)
  - **Tests**: non-breaking arity proven in [serve-handlers.test-d.ts](../../../../../../packages/0-framework/2-authoring/service-rpc/src/__tests__/serve-handlers.test-d.ts); both example suites run real two-argument handlers unchanged.

- **Internal failures no longer leak** — handler/output-validation exceptions
  → generic 500 + server log; body over 1 MiB → 413; a mid-read body error is
  masked too (not a rejected promise).
  - **Why**: an exception message can carry secrets; `serve()` is typed to
    return a Response, so a rejection is also a contract break.
  - **Implementation**: [serve.ts (L94–L122)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/serve.ts:94-122), and the run() error paths
  - **Tests**: [serve.test.ts (L114–L215)](../../../../../../packages/0-framework/2-authoring/service-rpc/src/__tests__/serve.test.ts:114-215)

## Compatibility / migration / risk

- **Breaking (protocol):** a keyless request now gets 400. Verified contained
  — every production edge hydrates through `makeClient` (which always sends a
  key); the only keyless callers were test fixtures, one fixed in this PR
  ([cron serve-schedule.test.ts](../../../../../../packages/1-prisma-cloud/2-shared-modules/cron/src/__tests__/serve-schedule.test.ts)). See
  [`code-review.md`](code-review.md) blast-radius check.
- **Mixed-version deploy:** a new client retries against an old server that
  doesn't dedupe. The retry is still bounded, but a non-idempotent call could
  double-execute during the rollout window if a retry fires. Worth noting for
  rollout ordering (deploy providers before consumers). Flagged in
  [`code-review.md`](code-review.md) (deferred, spec's residual).
- **Memory:** each provider holds a bounded replay cache (1000 entries, 60s).
- **Live proof:** deployed `storefront-auth` end to end — keyed round trip
  succeeded, wire order (401 before 400) confirmed. The retry's cold-start
  *rescue* was not observed (no PRO-217 close reproduced against a
  fast-booting target); covered in-process, noted NOT VERIFIED live in
  [`code-review.md`](code-review.md).

## The one decision for the human

The two lens passes agree the PR is ship-worthy; there is no architect-vs-
engineer conflict to adjudicate. The single item that wants a conscious call
is **[code-review.md](code-review.md) F01 (operability): there is no
per-attempt request timeout.** The retry-budget reasoning documented in
`client.ts` rests on a held connection blocking until the server answers —
which is correct for PRO-217's fast close, but a target that *accepts and then
hangs* (never answers) blocks the caller and every single-flighted waiter
indefinitely, and the retry never fires. This is the flip side of the
"held connection rides out the boot" argument. Not a correctness hole and not
in the spec's failure set, but it is the one production failure mode the
current shape does not bound. Decide whether to add a per-attempt
`AbortController` ceiling now or accept it as a documented limitation.

## Non-goals / intentionally out of scope

- Durable cross-instance dedup (the handler's option via the key, not a
  framework guarantee).
- A per-method `idempotent` flag (rejected in ADR-0037 — an unverifiable
  claim; the key is a mechanism).
- An RPC cold-start canary (built, then dropped on the evidence — the retry is
  permanent so there is nothing for a canary to time the removal of).
