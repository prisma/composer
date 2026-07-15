# Slice: Streams as a composed module (S6)

## At a glance

Durable append-only event streams as a `@prisma/composer-prisma-cloud/streams`
module: the production `prisma-streams` server (npm `@prisma/streams-server`
0.1.11, unmodified) wrapped as a Compute service behind a typed contract, with
the shipped `storage` module as its durable tier and a root-bound bearer-key
secret. First real module-depends-on-module consumer of `storage`; the
open-chat port (S7) is its first consumer. Entry brief: operator agent brief
(2026-07-15). Scoping-spike output:
[`packages/1-prisma-cloud/2-shared-modules/streams/SCOPE.md`](../../../../packages/1-prisma-cloud/2-shared-modules/streams/SCOPE.md).

## Chosen design

Settled in the scoping spike (SCOPE.md is the authoritative record):

- **Contract** `streamsContract` (`kind: 'streams'`), binding `{ url }` only;
  consumers build their own Durable Streams HTTP client (ADR-0015). The bearer
  key is NOT in the binding — secret values never travel through framework
  config (ADR-0029); a consumer binds its own `secret()` slot to the same
  platform variable. `{ url }` resolves from compute's existing deploy
  outputs, so no new lowering/descriptor is needed.
- **Module** `streams()`: boundary dep `store: s3()` (wire a `storage()`
  module's port in at the root), secret slot `apiKey`, expose
  `{ streams: streamsContract }`; one owned `compute()` service.
- **Entrypoint** adapts framework wiring onto the server's env/argv surface
  (open-chat's production defaults): maps `S3Config` → `DURABLE_STREAMS_R2_*`
  (the server's SigV4 client uses exactly storage's supported S3 subset),
  `API_KEY` from the SecretBox, `--auth-strategy api-key`,
  `--bootstrap-from-r2` on a fresh disk, 8 MiB segment cap (storage caps
  objects ~16 MiB), worker threads off (cannot spawn from a single-file
  bundle).
- **Local dev** `/testing` embeds `@prisma/streams-local` — SQLite-only,
  loopback, no auth, no cloud creds.
- **Packaging** mirrors storage exactly: `@internal/streams` three-pass tsdown
  (index+service / fully-inlined entrypoint / testing), re-exported by the
  `@prisma/composer-prisma-cloud` umbrella as `/streams`,
  `/streams/streams-entrypoint`, `/streams/testing`.

## Coherence rationale

One module boundary delivered whole: contract + module + entrypoint + local
stand-in + umbrella wiring + deploy proof are one reviewable unit — shipping
the package without the deployed-conformance proof would land an unverified
module, and the example harness is meaningless without the module. Rolls back
as one unit (new package + additive umbrella exports). One reviewer holds "is
the server wrapped behind the boundary correctly?" in one sitting.

## Scope

**In:** `packages/1-prisma-cloud/2-shared-modules/streams` (contract, module,
service, entrypoint, testing, tests, conformance harnesses); umbrella
re-exports; an `examples/streams` deploy harness (smoke pattern); deployed
conformance + consumer smoke (append, read-from-offset, SSE tail, long-poll,
cold-start bootstrap, segment upload, restore); module README.

**Deliberately out:**
- Websockets (the live path is SSE + long-poll, verified end to end).
- Forking/reimplementing the server; new streams features.
- Alternative durable tiers (the `s3()` dep permits swaps later).
- The open-chat port itself (S7).
- Upstreaming open-chat's bootstrap-performance patch (recorded as deferred).

## Pre-investigated edge cases

| Case | Handling |
| --- | --- |
| Server default 16 MiB segment sits exactly on storage's ~16 MiB object cap | Module default `DS_SEGMENT_MAX_BYTES=8388608`. |
| Worker threads (`segmenter_worker.ts`, `processor_worker.ts`) resolve module URLs relative to the source tree | Cannot spawn from a single-file bundle: `DS_TOUCH_WORKERS=0` (matches the server's own conformance harness); segmenter already defaults in-process (`DS_SEGMENTER_WORKERS=0`). |
| Server's request-timeout timers are never cleared; each keeps the process alive after SIGTERM until it fires | Harmless on Compute (platform kills the instance); tests override `DS_OBJECTSTORE_TIMEOUT_MS`. |
| `@prisma/streams-server` ships raw TS that fails this repo's strict tsc | Typecheck-only tsconfig shadows `…/compute` with an empty declaration; bun/tsdown must resolve the real files (tsconfig `paths` poisons BOTH — keep it out of `tsconfig.json`). |
| Conformance suite has no auth option | Deployed harness wraps global fetch to inject the bearer header. |
| All endpoints incl. `/health` are bearer-protected | Acceptable on Compute — open-chat runs this way in production. |

## Done conditions (slice-specific)

- Deployed to real Prisma Cloud with `storage()` as the durable tier; the
  conformance suite passes against the deployed URL; consumer smoke proves
  append / read-from-offset / SSE tail / long-poll; cold-start
  bootstrap-from-store observed.
- Local: same module definition runs against the embedded stand-in with no
  cloud creds; local conformance passes.
- README documents contract scope, wiring (storage dep + bearer secret), and
  local dev.

## Open questions

— none; design settled in the scoping spike.

## References

- [SCOPE.md](../../../../packages/1-prisma-cloud/2-shared-modules/streams/SCOPE.md) (Step-0 spike output, committed with the module)
- ADR-0005, ADR-0013/0015/0016, ADR-0027/0028, ADR-0029
- Prior art: `packages/1-prisma-cloud/2-shared-modules/storage` (mirrored)
- Server source: `~/Projects/prisma/streams`; open-chat streams app
  (`src/streams-app/index.ts`) — the module body's origin
