# Dispatch plan: rpc-cold-start (idempotency keys)

Contract source: [spec.md](spec.md). Branch:
`claude/streams-cold-start-rpc-37e5c1`, rebased onto main at/after `6ec2625`
(the [#131](https://github.com/prisma/compose/pull/131) service-rpc rename).
Three dispatches, sequential; hostile reviewer round after D1+D2, then D3
closes. Orchestrator owns all docs (`gotchas.md`, `docs/`, `.drive/`, and
ADR-0037) — implementers report staleness and never edit. Evidence rules from
the streams slice apply verbatim: raw program output only; every reported
number is checked against the code's real format strings before it is
believed.

## D1 — the keyed protocol, plus the three absorbed #114 fixes

**Outcome:** in `packages/0-framework/2-authoring/service-rpc/`:
`makeClient` mints one `Idempotency-Key` per logical call and reuses it
across a bounded retry (250 ms / ×2 / 5 s cap / 5 attempts / jitter; retry
network errors + 5xx + 429, never other 4xx). `serve()` enforces the key
(keyless → loud 400), single-flights per in-flight key, replays completed
2xx/4xx for ~60 s under a justified LRU bound, never caches 5xx/throws, and
passes `ctx.idempotencyKey` as an optional third handler argument after
`deps`. Absorbed in the same pass: the request body size limit (413,
enforced while reading, not trusting `content-length`), masking handler and
output-validation exception messages behind a generic 500 while logging the
real error, and deleting the client's redundant response re-validation
(with the now-unnecessary `MethodSchemas` cast if it falls out). No
prisma-cloud import; no `idempotent` flag anywhere.

**Completed when:** every client, server, and type-level test in the spec is
green with teeth confirmed red-by-mutation (including same-key-across-
attempts, fresh-key-per-call, 5xx-not-cached, and exception-message-not-
returned); both RPC-consuming example suites pass unchanged; repo checks
green with casts delta ≤ 0; committed with DCO dual sign-off.

## D2 — the canary (scripts + CI)

**Outcome:** `scripts/rpc-cold-start-canary.ts` + `-classify.ts` + unit
tests, inheriting the cold-start canary's proven contract wholesale
(promote-race trigger, ≥60 s spacing including sample #0, log-confirmed
coldness with the 2 s margin, 14-hold bug-gone budget, first-close early
exit, `MAX_RUN_MS`, requirable exits, and a bug-gone message that retires
the canary and its gotchas paragraph but NEVER the retry or keys); job in
`e2e-deploy.yml` over `examples/storefront-auth`, probing the auth service's
rpc endpoint with a bare single-attempt `fetch` and a manually minted key —
never through a framework client, which the new retry would mask.

**Completed when:** classify tests green with confirmed teeth;
`test:scripts` green; at least one live run reports `bug-present` with raw
per-sample output (a clean run today means a broken canary — stop and
report, do not ship); workspace left clean with project counts; committed.

## D3 — hostile review, live re-proof, records, PR

**Outcome:** reviewer pass over D1+D2. Attack priorities: a repeated key can
never double-execute within an instance; a replay can never leak one logical
call's answer to another, across methods or callers; keyless rejection
cannot be bypassed; the body cap holds without a truthful `content-length`;
no handler exception text reaches a caller while operators keep it; the
canary cannot be masked by the retry machinery; every reported number is
real. Findings closed. Full live round (deploy storefront-auth, canary
verify, destroy, zero leaks).

Then the orchestrator writes, in this same PR: **ADR-0037** (calls carry an
idempotency key; the framework dedupes; retries are protocol semantics, with
the named residual and the connection-contracts scope calibration as its
reasoning), the `connection-contracts.md` protocol update, and the
`gotchas.md` PRO-217 service-RPC face. PR opened against main with the slice
narrative; review requested from Will. No auto-merge; merge on his word.
