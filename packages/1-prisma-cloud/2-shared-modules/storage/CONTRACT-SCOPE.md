# `@internal/storage` contract scope

The S3-compatible wire protocol this module implements. Scope is exactly what
`@prisma/streams-server` calls against S3 (its object-store client and
cold-start bootstrap paths, and their tests) plus presigned URLs — not general
S3 compatibility.

## Binding

`s3()` (a consumer's dependency) resolves to:

```ts
export interface S3Config {
  readonly url: string; // endpoint; path-style addressing
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}
```

The app builds its own client (aws-sdk, hand-rolled SigV4, whatever) from
these four fields. No `region` in the binding — the server accepts whatever
region string the client signed (streams-server signs `auto`).

## Wire operations

| Op | Semantics required |
| --- | --- |
| `PUT /{bucket}/{key}` | Body ≤ the envelope. `content-type` optional, defaults to `application/octet-stream`. Returns an ETag — opaque to consumers; this module uses a quoted SHA-256 hex digest. |
| `GET /{bucket}/{key}` | Optional `Range: bytes=a-b` (inclusive end; open end `bytes=a-` allowed) → `206`. Missing key → `404`. |
| `HEAD /{bucket}/{key}` | Returns `etag` + `content-length`. Missing key → `404`. |
| `DELETE /{bucket}/{key}` | Idempotent — a missing key is success (both `404` and `204` are accepted by consumers). |
| `GET /{bucket}?list-type=2` | `prefix`, `continuation-token`, `max-keys` (default 1000). XML response with `Key`, `NextContinuationToken`, `IsTruncated`. No `delimiter`/`start-after`. |
| Presigned GET/PUT | Query-param SigV4 (`X-Amz-Signature` et al.), expiry enforced — same verification math as header-signed requests. |

## Auth

SigV4 (`AWS4-HMAC-SHA256`). `x-amz-content-sha256` is verified when it names a
real payload hash — streams-server always signs the real hash;
`UNSIGNED-PAYLOAD` is also accepted (aws-sdk sends it for streaming PUTs). Any
region string is accepted; service is `s3`. Path-style addressing only.

## ETag semantics

Opaque to consumers — they hash content themselves and never parse the ETag.
This module returns a quoted SHA-256 hex digest of the object bytes.

## 404 semantics

A missing object on `GET`/`HEAD` is `404`. A missing object on `DELETE` is
success (idempotent delete; consumers accept `404` or `204`). Consumers map
`404` to `null`/success client-side and must see it correctly — it is not a
transient condition. Transient `5xx` is retried by consumers 3x with a 5s
client timeout.

## Out of scope

Multipart upload, `CopyObject`, batch `DeleteObjects`, conditional requests
(`If-Match`/`If-None-Match`/etc.), checksums (`x-amz-checksum-*`), bucket CRUD
(any bucket name simply namespaces keys), ACLs, versioning, lifecycle
policies, and full S3-compatibility generally.

aws-chunked / flexible-checksum PUTs (`content-encoding: aws-chunked`,
`x-amz-content-sha256: STREAMING-…`) are rejected with `501` rather than
stored — decoding the chunk framing is out of scope, so aws-sdk consumers set
`requestChecksumCalculation: 'WHEN_REQUIRED'`.

## Envelope

Objects up to ~16 MiB — the streams segment cap (`DS_SEGMENT_MAX_BYTES`), the
canonical workload this module serves. This is comfortably within a single
Postgres `bytea`/TOAST value; this module is not a general-purpose blob store
and larger objects are unsupported.

## Platform ask

This contract is deliberately narrow and wire-level: any object-storage
primitive that speaks this same subset of the S3 protocol (the op table
above, SigV4, path-style, these ETag/404 semantics) can replace this module as
a resource with no change to a consumer's code — the consumer never sees
`@internal/storage`, only the four `S3Config` fields and the wire protocol
behind them. A native Prisma platform primitive satisfying this contract,
with credentials minted by the primitive itself at provision time, would let
this module retire without a migration.
