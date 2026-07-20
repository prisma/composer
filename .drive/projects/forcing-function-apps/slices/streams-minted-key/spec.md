# Slice: Streams bearer key becomes a minted binding credential

## At a glance

Re-shape the streams module's consumer auth onto the ADR-0030 pattern: the
bearer key is **minted at deploy** and delivered **through the binding**, not
root-bound as an ADR-0029 secret. The binding becomes `{ url, apiKey }`; the
module's `apiKey` secret slot and the consumer-side "bind the same platform
variable twice" convention disappear. Settled in the 2026-07-15 design session
(see design-notes.md § "Streams consumer auth — settled by ADR-0030");
predecessor slice: streams-composed-module (merged, PR #84).

## Chosen design

> **Amended 2026-07-16 (design session with Will, post-#93/ADR-0031).** The
> original design below (BearerKey resource + `streams` descriptor + outputs
> rail) was built before ADR-0031 landed and is superseded.
>
> **Deciding rationale: consistency.** A module must build on the framework's
> general internals, not invent per-module ones. ADR-0031 is the framework's
> answer for a framework-minted param value; a second, streams-shaped
> mechanism beside it means two ways to audit one concept and one more thing
> a maintainer must learn per module. The narrower technical comparison
> (below) only ever showed the resource route was *possible*, never that it
> was *right*. ADR-0031's
> provisioner explicitly owns per-edge vs per-provider cardinality, and the
> zero-consumer case that seemed to require a module-owned resource is a
> configuration error, not a scenario (a streams module with no consumers
> serves nobody — the key exists only in deploy state). Settled design:
>
> - `durableStreams()`'s `apiKey` connection param carries a **ProvisionNeed**
>   (streams-owned brand, mirroring `RPC_PEER_KEY`).
> - The prisma-cloud target registers a **per-provider provisioner**: keyed on
>   `providerAddress`, mint-once 48-hex, stable in deploy state (ADR-0031
>   blesses per-provider as provisioner policy; `service-keys.ts` +
>   `serviceKeyProvisioner` are the templates).
> - The **provider landing** writes the minted value where the streams
>   entrypoint reads its key (target-owned per ADR-0019); the server still
>   receives `API_KEY`.
> - **Zero consumers = no key = the server cannot boot**; prefer a loud
>   deploy-time error over a boot loop if cheaply expressible.
> - `BearerKey` resource + the `streams` descriptor are **deleted**;
>   `streamsCompute` reverts to plain `compute()` if no extended outputs
>   remain (url alone needs no override).
> - `examples/streams` gains a small **consumer service** that exercises the
>   binding in-deployment (append + read via `load()`'s `{ url, apiKey }`),
>   which also removes the zero-consumer shape from the example.
> - Future per-edge migration = provisioner-internal cardinality flip + the
>   accepted-set landing, once upstream supports key sets.
>
> **Amendment 2 (2026-07-16, Will): compute() must be brand-blind.** The first
> cut of this rework landed streams' provider-side key by adding a second
> hardcoded block (and a second import) to `descriptors/compute.ts`, mirroring
> the one #93 added for RPC. That is a per-brand accretion in the general
> compute descriptor — the same anti-pattern ADR-0031 exists to prevent, moved
> from core into the target. ADR-0031 already assigns the fix: *"The
> provisioner owns mint, size, **aggregation**, stability, and rotation"* — so
> the provider-side landing belongs with the provisioner, not in compute.
>
> Settled: `compute.ts`'s serialize does ONE brand-blind loop over inbound
> provisioned edges grouped by `provision.brand`, handing each brand's refs to
> that brand's registered landing; the two hand-written edge scanners collapse
> into one generic `provisionedEdges(graph)`. `compute.ts` imports neither
> `service-keys.ts` nor `streams-keys.ts`. RPC's accepted-set landing migrates
> onto the same seam (in scope — the leak is not deleted while its first
> instance remains). Prefer a target-local seam over changing core, per
> ADR-0031's "landing stays the target's"; changing core's
> `ProvisionerDescriptor` is acceptable only if the target genuinely cannot
> own it, and must be reported.

Original (superseded) design, kept for the record — mirror storage's
minted-credential machinery end to end (`s3Credentials` + `s3StoreDescriptor`
are the templates):

- **Contract** (`@internal/streams/contract.ts`): `StreamsConfig` gains
  `readonly apiKey: string`; `durableStreams()` connection params become
  `{ url, apiKey }`; `__cmp` updated. README example's consumer fetch snippet
  switches from `service.secrets()` to the binding.
- **Minted resource** (`@internal/prisma-cloud`, mirror
  `s3-credentials-resource.ts`/`s3-credentials.ts`): a bearer-key credential
  — random 48-hex, minted once at deploy, stable in deploy state — kind
  distinct from slice 2's planned per-edge `ServiceKey` (that name is
  reserved by the rpc-service-key project). Provides `{ apiKey }`. Server
  minimum is 10 chars; 48 hex clears it.
- **Descriptor** (`target/descriptors`, mirror `s3-store.ts`): a `streams`
  node kind = compute's descriptor with extended outputs — `apiKey` surfaced
  from the wired credentials resource in `serialize`/`deploy` outputs, so a
  consumer's `durableStreams()` binding resolves both fields by name.
  `streamsService()` routes to it the way `s3StoreService` routes to
  `s3-store` (type override on `compute()`).
- **Module** (`streams-module.ts`): drops the `apiKey` secret slot from its
  boundary; provisions the credentials resource internally (as storage owns
  `credentials`); boundary keeps `store: s3()`. Service deps become
  `{ store, credentials }`, secrets: none.
- **Entrypoint**: `API_KEY` comes from `load().credentials.apiKey` instead of
  `secrets()`.
- **Single key per module instance** — the upstream server's auth is one
  `API_KEY`. Distinct per-edge keys (full ADR-0030 slice-2 alignment) need an
  upstream accepted-key-set change; recorded as future work, out of scope.

## Coherence rationale

One auth model swapped whole: contract, mint, descriptor, module wiring,
entrypoint, docs, and the live re-proof must move together — a partial land
would ship a binding whose `apiKey` never resolves or a server whose key
nobody holds. One reviewer holds "did the key move from secret slot to
binding rail correctly?" in one sitting; rolls back as one unit.

## Scope

**In:** contract change; the minted-key resource + `streams` descriptor in
`@internal/prisma-cloud`; module/service/entrypoint rewiring; tests
(module graph, integration, type tests) updated; `examples/streams` root
drops `envSecret` (fresh branch off main — the repo renamed to Composer);
README + SCOPE.md auth sections; live re-proof (deploy, deployed conformance,
smoke, destroy).

**Deliberately out:**
- Per-edge keys / accepted-key sets (needs upstream server change + #89
  slice 2; recorded in design-notes.md).
- External (out-of-deployment) key access — same recorded platform ask as
  storage's minted credentials. Test harnesses may read the key from deploy
  state; document that as the harness route.
- Touching rpc-service-key's surfaces or claiming the `ServiceKey` name.

## Pre-investigated edge cases

| Case | Handling |
| --- | --- |
| Deployed conformance/smoke harnesses need the minted key externally | Read it from deploy state (it is stable there), as the harness-only route; not a consumer pattern. |
| `configKey` collision: credentials dep param `apiKey` vs old secret slot `APIKEY` | Old slot is deleted in the same change; integration test env moves from `COMPOSER_APIKEY` (secret pointer) to `COMPOSER_CREDENTIALS_APIKEY` (dep param). |
| A stale consumer built against `{ url }`-only binding | Contract `satisfies` compares kind only; the new param resolves by name from producer outputs — old consumers rebuild against the new types on upgrade (pre-1.0, no compat shim). |

## Done conditions (slice-specific)

- Module tests + entrypoint integration test green with the key wired as a
  dep, not a secret; no `secret()` remains in the streams package.
- Live re-proof: deploy `examples/streams`, deployed conformance green
  modulo the known SSE-ingress failures (PRO-218), consumer smoke green
  (401 unauthenticated / authed append + read + long-poll), then destroyed.
- README/SCOPE reflect the minted model and the future per-edge note.

## References

- design-notes.md § Streams consumer auth (the settled decision)
- ADR-0030 (merged, #89); `.drive/projects/rpc-service-key/plan.md` on main
  (slice 2's reserved shape)
- Templates: `s3-credentials-resource.ts`, `s3-credentials.ts`,
  `descriptors/s3-store.ts`, `s3-store.ts` (service factory)

> **Amendment 3 (2026-07-17, Will): protocol logic ships in OUR client lib.**
> Requirement, verbatim in effect: the PR will not be accepted with Durable
> Streams protocol logic (URL layout, bearer scheme, JSON-array appends,
> offset conventions, long-poll dance) hand-rolled in a user application. It
> must live in the client library Composer offers users — the same way RPC
> users don't do their own request encoding (`rpc()` hydrates to a client via
> `makeClient`).
>
> Shape (pending the upstream check's findings): wrap
> `@durable-streams/client` (ElectricSQL's canonical protocol client;
> supports per-poll headers for auth, live long-poll/sse, pluggable fetch) in
> a streams client shipped by `@internal/streams`. `durableStreams()`
> hydrates to that client (RPC parity); the factory is also exported
> standalone so local dev/tests can wrap the stand-in URL without load().
> The wrapper is the home for platform compensations, each annotated with its
> ticket: auth from the binding, live tail defaults to long-poll while
> PRO-218 stands, cold-start retry for idempotent calls only while PRO-219
> stands (appends never retried — no idempotency key upstream). The example
> reduces to app logic over the client. Conformance harnesses stay raw-fetch
> (they test the server, not our client).
