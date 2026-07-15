# `@prisma/compose-prisma-cloud/storage`

S3-compatible object storage as a Prisma Compose module. It is an ordinary
module: a Compute service that speaks the **S3 wire protocol**, backed by a
module-provisioned Prisma Postgres (objects live in a single `bytea` column),
with SigV4 credentials minted at deploy. Consumers wire the module's `store`
port into an `s3()` slot and get an `S3Config` binding; they build their own
S3 client (aws-sdk, or a hand-rolled SigV4 client) from it.

Ships as the `@prisma/compose-prisma-cloud/storage` subpath (like `/cron`).

## Contract scope

The contract **is** the S3 wire protocol — but only the subset a real consumer
needs, not S3-compatibility maximalism. In scope:

| Op | Notes |
| --- | --- |
| `PUT /{bucket}/{key}` | `content-type` optional; returns a quoted SHA-256 ETag (opaque to consumers) |
| `GET /{bucket}/{key}` | optional `Range: bytes=a-b` (inclusive end; open end `a-`) → `206`; missing → `404` |
| `HEAD /{bucket}/{key}` | `etag` + `content-length`; missing → `404` |
| `DELETE /{bucket}/{key}` | idempotent (a missing key is success) |
| `GET /{bucket}?list-type=2` | `prefix`, `continuation-token`, `max-keys` (default 1000); ListObjectsV2 XML |
| Presigned GET/PUT | query-param SigV4, expiry enforced |

Auth is SigV4 (`AWS4-HMAC-SHA256`), **path-style addressing only**, any region
string (`auto` is fine). Bucket names simply namespace keys — there is no
bucket CRUD.

**Out of scope**: multipart upload, `CopyObject`, batch `DeleteObjects`,
conditional requests, flexible checksums / `aws-chunked` framing (rejected with
`501` — see the wiring note below), bucket CRUD, ACLs, versioning, lifecycle.

See [`CONTRACT-SCOPE.md`](./CONTRACT-SCOPE.md) for the full op semantics and the
exact out-of-scope list.

## Envelope

Objects up to **~16 MiB**. Each object is one row's `bytea` value; ranged reads
use SQL `substring(...)` so a range request never loads the whole object. This
is comfortably within Postgres `bytea`/TOAST for the target workload — it is
**not** a general-purpose large-blob store, and larger objects are unsupported.

## Wiring

Provision `storage()` in a module and wire its `store` port into a consumer's
`s3()` slot:

```ts
// module.ts — the deploy root
import { module } from '@prisma/compose';
import { storage } from '@prisma/compose-prisma-cloud/storage';
import blobs from './src/blobs/service.ts';

export default module('my-app', ({ provision }) => {
  const store = provision(storage()); // owns its Postgres + minted credentials
  provision(blobs, { deps: { store: store.store } });
});
```

```ts
// src/blobs/service.ts — the consumer declares an s3() dependency
import node from '@prisma/compose/node';
import { compute } from '@prisma/compose-prisma-cloud';
import { s3 } from '@prisma/compose-prisma-cloud/storage';

export default compute({
  name: 'blobs',
  deps: { store: s3() },
  build: node({ module: import.meta.url, entry: '../../dist/blobs/server.mjs' }),
});
```

```ts
// src/blobs/server.ts — the consumer's entry builds its own client (ADR-0015)
import { S3Client } from '@aws-sdk/client-s3';
import service from './service.ts';

const { store } = service.load(); // S3Config: { url, bucket, accessKeyId, secretAccessKey }

const client = new S3Client({
  region: 'auto',
  endpoint: store.url, // path-style; no virtual-host addressing
  forcePathStyle: true,
  credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey },
  // The store rejects aws-chunked / flexible-checksum PUTs with 501 — send plain
  // signed payloads.
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
```

The `S3Config` binding is the whole surface a consumer sees:

```ts
interface S3Config {
  readonly url: string; // the store's endpoint
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}
```

[`examples/storage`](../../../../examples/storage) is the worked example — a
small blob store/serve app that consumes `storage()` and deploys to Prisma
Cloud.

## Local development

The same module runs locally against local Postgres — no cloud, no minted
credentials. `@prisma/compose-prisma-cloud/storage/testing` exposes the store
and server directly:

```ts
import { createPgStore, startStorageServer } from '@prisma/compose-prisma-cloud/storage/testing';

const store = await createPgStore(process.env.DATABASE_URL!); // applies the schema
const server = startStorageServer({
  store,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local-secret' },
  bucket: 'my-bucket',
  port: 0, // ephemeral
});

// server.url is an S3 endpoint — point an aws-sdk client (path-style) at it.
// server.stop() when done.
```

The module's own tests, and `examples/storage`'s integration test, boot exactly
this stand-in over a throwaway Postgres: they honor `STATE_TEST_DATABASE_URL`
when set, otherwise self-spawn an ephemeral Homebrew `postgresql@15` cluster
(`initdb`/`pg_ctl`); they skip on a dev machine with no Postgres and fail on CI
if none is available.

## Credentials

The SigV4 key pair is **minted once at deploy** (a random keypair persisted in
deploy state) and delivered to consumers through the `S3Config` binding — it is
never printed and never surfaces outside the deployment. Consumers are
therefore **in-deployment services** that receive the credentials via `load()`,
not arbitrary external clients. An external-access path (reading the minted
credentials from outside the deploy) is a recorded platform ask, not something
this module solves.
