# `streams` module — scope

Durable append-only event streams as a Compose module. The module wraps the
production `@prisma/streams-server` runtime (npm, v0.1.11) as a Compute
service behind a typed contract (ADR-0016). It does not reimplement or fork
the server; the module body is deployment defaults plus wiring — the same
role `src/streams-app/index.ts` plays in open-chat today.

## Shape

Mirrors `storage`: `contract.ts`, `streams-module.ts`, `streams-service.ts`,
`streams-entrypoint.ts`, `testing.ts`, published as
`@prisma/composer-prisma-cloud/streams`.

```
root module
├─ storage()                        ← durable tier (module-depends-on-module)
└─ streams()                        ← this module
   └─ service (compute)             ← @prisma/streams-server behind the boundary
      ├─ deps.store: s3()           ← wired from storage's `store` port
      └─ secrets.apiKey: secret()   ← bearer key, root-bound (ADR-0029)
```

## Contract

```ts
interface StreamsConfig {
  readonly url: string;
  readonly apiKey: string;
}
```

`streamsContract(defs)` (`kind: 'streams'`) names the streams a consumer
transports — `streamsContract({ jobs: streamDef() })` — with
`durableStreams(contract)` as the consumer dependency factory; bare
`durableStreams()` (no contract) is retained for dynamic stream names. The
wire binding is the endpoint URL plus the minted bearer key (ADR-0015);
hydration hands a `durableStreams(contract)` consumer one `StreamHandle` per
declared name (append/read/tail — wrapping `@durable-streams/client`), and
hands a bare `durableStreams()` consumer a `StreamsClient` whose surface is
`stream(name)`, returning the same kind of handle. The handle owns the
stream's lifecycle: it creates the stream on first use (memoized) and heals
a 404 by re-creating and retrying the failed operation once — no app code
names a stream lifecycle event. Protocol surface:
`PUT/POST/GET/HEAD/DELETE /v1/stream/{name}`, reads from an `offset`, live
tail via `?live=sse` and `?live=long-poll`. No websockets — the server has
none and the module adds none.

**Auth rides the binding.** The bearer key is neither an ADR-0029 secret nor
a producer output: the `apiKey` connection param declares an ADR-0031
**provisioning need** (brand + provisioner live in `@internal/prisma-cloud`'s
`streams-keys.ts` — the target sits below this module, so the brand is
imported downward). The target mints one value PER PROVIDER (the upstream
server authenticates a single `API_KEY`), keeps it stable in deploy state,
fills every consumer's param with it, and stores the same value on the streams
service itself as a reserved provider param. Per-edge keys are later a
provisioner-cardinality change plus an accepted-set provider param once
upstream accepts a key set — no resource to add, no core change. A module
with no consumers gets no key and refuses to boot.

## Config surface

- **Typed params: none** (v1). The service keeps only the reserved `port`.
- **Secrets: none.** The bearer key is provisioned by the target for the
  `durableStreams()` binding and written to this service under a reserved
  config key; the entrypoint reads it there and exports it to the runtime as
  `API_KEY` with `--auth-strategy api-key`. All endpoints including `/health`
  require `Authorization: Bearer <key>` (verified acceptable on Compute by
  open-chat's production deploy).
- **Deps: `store: s3()`** on the module boundary — the storage module's
  port. The entrypoint maps the `S3Config` binding onto the server's
  `DURABLE_STREAMS_R2_{BUCKET,ENDPOINT,ACCESS_KEY_ID,SECRET_ACCESS_KEY}` env
  (the client is a hand-rolled SigV4 client speaking exactly storage's
  supported subset: PUT/GET-range/HEAD/DELETE/ListObjectsV2, path-style, no
  multipart, no aws-chunked).
- **Fixed defaults** (internal, from open-chat production): `DS_HOST=0.0.0.0`,
  `DS_ROOT=/tmp/ds-data`, `DS_SEGMENT_MAX_INTERVAL_MS=5000`,
  `DS_OBJECTSTORE_TIMEOUT_MS=60000`, `DS_SEGMENT_MAX_BYTES=8388608` (half of
  storage's ~16 MiB object cap; the server default of 16 MiB sits exactly on
  it), `DS_TOUCH_WORKERS=0` and `DS_SEGMENTER_WORKERS=0` (worker threads
  cannot spawn from the single-file bundle; 0 is the server default for the
  segmenter and the conformance harness's setting for touch),
  `--bootstrap-from-r2` on cold start (absent `${DS_ROOT}/wal.sqlite`).

## Internal / out of scope

- The server's ~80 `DS_*` tuning knobs stay internal.
- Streams subresources (`/_schema`, `/_search`, `/_aggregate`, touch API)
  ship with the server but are not part of the documented contract.
- Alternative durable tiers; the `s3()` dep permits swaps later.
- open-chat's `patchedDependencies` patch (parallel bootstrap heads, object-
  store request timeout) is a performance patch not yet upstream; v1 runs
  the published package unpatched. Candidate upstream PR, not a fork.

## Local development

`@prisma/composer-prisma-cloud/streams/testing` re-exports the embedded local
stand-in (`@prisma/streams-local`, the runtime open-chat embeds when
`STREAMS_URL` is unset): SQLite-only, loopback, no auth, no object store, no
cloud credentials. Same protocol surface; the local conformance suite runs
against it.

## Verification

- Streams conformance suite (`@durable-streams/server-conformance-tests`)
  against the deployed module via `CONFORMANCE_TEST_URL`, with a `fetch`
  wrapper injecting the bearer header (the suite has no auth option), and
  against the local stand-in.
- Consumer smoke against the deploy: append, read from offset, SSE tail,
  long-poll — plus cold-start bootstrap-from-store and segment upload
  observed against the storage module.
