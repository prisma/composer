# Slice: service-RPC idempotency keys — safe retries for every call, plus the PRO-217 canary

## At a glance

`makeClient` carries no cold-start handling, so every service-to-service RPC
edge hits PRO-217's intermittent socket close raw on a cold target — and
PRO-217 is live (reproduced repeatedly on 2026-07-17 against log-confirmed
cold starts). A blanket retry was previously unsafe because a retried POST
could double-execute a write.

Settled design (Will, 2026-07-17, superseding an earlier per-method
`idempotent: true` boolean): **the protocol requires an idempotency key on
every call**, and the framework implements idempotency control on both ends.
With the mechanism in place every method is safely retryable and no
per-method declaration exists — a boolean is a human claim the framework
cannot check; a key is a mechanism it enforces.

**Package note:** the kind was renamed by [#131](https://github.com/prisma/compose/pull/131)
(ADR-0036). Everything below lives in
`packages/0-framework/2-authoring/service-rpc/`, package
`@internal/service-rpc`, public import path `@prisma/composer/service-rpc`,
with the public entrypoint at `src/exports/index.ts` (ADR-0035). Branch must
be rebased onto main at or after `6ec2625` before any code is written.

## The design

### Protocol

- Every request `makeClient` sends carries an `Idempotency-Key` header: a
  UUID minted **once per logical call** and reused **byte-identically across
  every retry of that call**. Two separate logical calls never share a key.
  `crypto.randomUUID()` — no new dependency.
- The key is REQUIRED: `serve()` rejects a keyless request with a loud 400
  naming the header. "Requires" is enforced, not suggested.

### Client (`makeClient`)

- Every method gets a bounded retry: 250 ms initial, ×2, 5 s cap, 5
  attempts, jittered (the streams client's numbers; read its `client.ts` for
  shape but **do not import from prisma-cloud** — service-rpc is
  framework-layer and target-agnostic). Retry thrown network errors, 5xx and
  429; never any other 4xx. Same key on every attempt.
- No per-method configuration; no `idempotent` flag exists in this design.

### Server (`serve()`)

- **Single-flight per in-flight key:** a duplicate arriving while the first
  attempt is still executing waits for it and receives the same response —
  the handler runs exactly once.
- **Replay within the retry envelope:** completed 2xx and 4xx responses (they
  are answers) are cached ~60 s and replayed byte-identically for a repeated
  key, under an LRU bound whose size is justified in a comment — this cache
  is resident in every RPC provider.
- **5xx and thrown errors are not cached** — they are the retryable
  outcomes; a retry must re-execute.
- A replayed answer must be structurally incapable of crossing methods.
- **Handler context:** handlers gain an optional second argument —
  `(input, deps, ctx)` carrying `ctx.idempotencyKey`, appended after the
  existing `deps` argument so every existing handler still typechecks and
  runs unchanged. Handlers may ignore it.

### Robustness calibration, and the residual this leaves

`docs/design/10-domains/connection-contracts.md` § *Purpose and scope* is the
governing scope statement: **internal means inside the application's
topology, not co-located on one network.** Components may come from
different targets, and such an edge necessarily crosses networks — that is in
scope. Protocol guarantees are calibrated per edge against **the named
failure modes of the targets carrying it**, and any proposal adding
robustness names the concrete failure it guards.

The concrete failure this slice guards is **PRO-217**: the Prisma Compute
ingress closing a first-touch connection while a scale-to-zero target boots.
That close happens during connection establishment, **before any handler
runs** — nothing was applied, so retrying it cannot duplicate work
irrespective of dedupe. The keys additionally close the narrower window where
a response is lost after the handler applied it and the retry reaches the
**same** instance.

**The residual, named not hidden:** in-memory control cannot cover a retry
that lands on a *different* instance than the one that applied the call
(instance death mid-request, or any edge where retries may be routed
elsewhere). This slice does not close it, and adds no durable store. The
escalation path is per-edge and belongs to the handler: `ctx.idempotencyKey`
lets a handler write the key inside its own transaction and obtain exactly-
once where its target's failure modes warrant it. Framework-side durable
dedupe is not proposed here — no concrete failure mode of a currently
supported target names it.

### Status of the retry: permanent, not a compensation

Bounded retry over keyed calls is correct protocol semantics for this kind —
it is **not** deleted when the platform heals. The canary's bug-gone message
retires the canary itself, its gotchas paragraph, and PRO-219's urgency
framing — never the retry or the keys. No comment on the retry or the key
machinery may say "remove when PRO-217 is fixed".

## Absorbed fixes (promised on [#114](https://github.com/prisma/compose/pull/114), same files)

These three were committed to when the oRPC PR was declined; they touch the
exact code this slice rewrites, so they land here rather than in a colliding
PR.

1. **Request body size limit in `serve()`.** `await req.json()` is currently
   unbounded. Cap it, answer over-limit with **413**, and do not trust
   `content-length` alone — a lying or absent header must not bypass the cap,
   so the bound is enforced while reading. Pick a limit appropriate to
   internal RPC payloads and justify it in one comment.
2. **Stop leaking handler exception messages to callers.** The 500 path
   currently returns `err.message` in the response body — an internal
   exception string handed to the caller. Mask it: a generic failure message
   to the caller, the real error logged server-side (`console.error`) so
   operators keep it. Output-validation failures (a provider bug) are masked
   the same way but logged distinguishably. **Input-validation 400s keep
   their detail** — that is the caller's own malformed request and the
   message is how they fix it.
3. **Remove the client's redundant second validation of responses.**
   `serve()` already validates a handler's output against the method schema
   before responding; `makeClient` re-validating it is duplicated work on
   every call. Both ends of every edge are framework-provisioned (see the
   scope statement above), so the second pass guards nothing. Expect this to
   leave the client needing only method *names* off `__cmp` — if the
   `MethodSchemas` blindCast in `client.ts` becomes unnecessary, delete it
   (a cast-ratchet reduction, not a neutral change).

## The canary (PRO-217, service-RPC face)

A sibling of `scripts/cold-start-canary.ts`, inheriting every rule of its
2026-07-17 rebuild — requirements, not suggestions:

- Fresh target via create → upload → start → **race the promote call**
  (never wait for `running`); **≥60 s between samples, including before
  sample #0**; coldness proven from the deployment's own boot log (2 s
  cross-clock margin), never inferred from latency; `bug-gone` requires 14
  confirmed cold-start holds (20% target close rate, ≤5% false-clean); any
  close is decisive; first close exits early; `MAX_RUN_MS` self-stop under
  the job timeout; requirable exits (present → 0, gone → 1 with the cleanup
  message, inconclusive → 0 + `::warning::`).
- **Probes the target's rpc endpoint directly with a bare single-attempt
  `fetch`** carrying a manually minted key — every framework edge now
  auto-retries, so a probe through a consumer would be masked by the very
  machinery this slice ships. The raw platform behavior must stay observable.
- Rides `examples/storefront-auth`'s deployed auth service through the
  existing deploy-verify-destroy action; own `-classify.ts` + unit tests; own
  job in `e2e-deploy.yml`; NOT required until Will adds it.

## Verification bar

Client tests (counts asserted at a stub transport, the streams append-test
pattern — assert what the transport received, not what the client claims):

- 503-then-success → resolves, **exactly two** requests, **same key on both**.
- Two separate logical calls → **different** keys.
- 404 → rejects after **exactly one** request; re-assert after a settle
  window so a background retry would be caught.
- Thrown network error then success → resolves.

Server tests:

- Repeated key after completion → handler ran **once**, response replayed
  byte-identically.
- Concurrent same-key → **one** execution (single-flight).
- Keyless → 400 naming the header.
- 5xx not cached → a same-key retry re-executes.
- LRU bound evicts.
- A replay can never answer a different method.
- Over-limit body → 413, including when `content-length` is absent or lies.
- A handler throw → 500 whose body does **not** contain the exception
  message, with the real error logged.
- Input-validation failure → 400 that **does** carry its detail.

Type-level (`test-d`): existing two-argument handlers `(input, deps)` still
typecheck; `ctx.idempotencyKey` is typed on the three-argument form.

Each of the above has its teeth confirmed by mutation — break the behavior,
watch that specific test fail, restore. Explicitly including: delete the
retry; mint a fresh key per attempt instead of per call; cache 5xx; return
the exception message.

Also green: `turbo run typecheck test`, `pnpm lint` (exit 0), `pnpm
lint:casts` (**delta ≤ 0**), `pnpm lint:deps`, `pnpm test:scripts`, and both
RPC-consuming example suites (`examples/store`, `examples/storefront-auth`)
passing **unchanged** — proof the handler-context argument is non-breaking.

Live: canary against a fresh deploy, raw output only. Expected verdict today
is `bug-present`; a clean run today means a broken canary — investigate, do
not report it as a result.

## Records to write (orchestrator, in this PR — never a docs-only PR)

- **ADR-0037** (0033–0036 are taken): service-RPC calls carry an idempotency
  key; the framework dedupes; retries are protocol semantics.
- `docs/design/10-domains/connection-contracts.md`: the protocol section
  gains the key, the dedupe behavior, and the named residual.
- `gotchas.md`: PRO-217's entry gains the service-RPC face and the canary's
  removal guard.

## Out of scope

- Durable (cross-instance) idempotency storage — the handler's option via
  `ctx.idempotencyKey`, never a framework requirement here.
- Middleware, metadata, streaming, rich errors — declined for this kind by
  the scope statement.
- Adding the canary to the required-checks list (Will's manual step).
- The streams follow-ups (typed `streamDef`, audit debt items).
