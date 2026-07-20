# Dispatch plan: streams-binding-redesign

Contract sources: [spec.md](spec.md) +
[streams-binding-design.md](../../streams-binding-design.md). Three
dispatches, sequential (one branch, PR #92). Reviewer rounds after D1 and
D2, per this branch's established loop; docs edits stay with the
orchestrator, not the implementers (the delegated-docs failure mode is on
record twice).

## D1 — Part A: provider params (target package)

**Outcome:** provider-side minted values flow through the declared-param
pipeline end to end. The registration type replaces `ProvisionLanding`
(name + schema + value-from-refs; brand-blind registry in `control.ts`);
`descriptors/compute.ts` writes the rows through the serializer's normal
encode; `deserialize` gains the reserved provider params as a second
enumeration source and the stash carries them (excluded from user `config()`
typing); `restashAddressFree` deleted; `serve()` and the streams entrypoint
read validated stash rows (absent = never provisioned, semantics unchanged);
`serviceKeyEnvName`/`streamsApiKeyEnvName` subsumed by `configKey`
derivation. No coined vocabulary in names or comments — "landing" goes away.

**Completed when:** the spec's invariant tests are green in their new homes;
the four restash tests are replaced by round-trip tests; grep shows no
`restashAddressFree` and no `Landing`; repo checks green; committed.

## D2 — Part B: contract + handles (streams package + example)

**Outcome:** `streamsContract({ jobs: streamDef(), … })` (untyped defs
only); `durableStreams(contract)` hydrates to per-stream handles;
bare `durableStreams()` hydrates to `stream(name)` dynamic handles;
`StreamsClient`/`StreamHandle` as classes; ensure-create + 404-heal
(retry-once) inside the handle; `isStreamNotFound` un-exported; append
no-retry/no-batch and `IDEMPOTENT_BACKOFF` untouched. The example app loses
`STREAM`/`ensureStream`/`withStream` and keeps routes + error mapping; the
heal test and wire-count tests move into the streams package.

**Completed when:** streams package + example tests green; both mutation
checks re-verified red in their new homes; the example has zero lifecycle
or wire-client knowledge; repo checks green; committed.

## D3 — Live re-proof, docs, thread closeout

**Outcome:** deploy/conformance/smoke/canary/destroy per the spec's bar;
gotchas + design-notes touched only where the code moved under them
(orchestrator writes docs); every open #92 thread replied-to (commit or
design-doc section) and resolved; PR body refreshed; Will's re-review
requested. No auto-merge armed; merge only on Will's word.
