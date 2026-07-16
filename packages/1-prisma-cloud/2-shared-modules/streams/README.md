# `@prisma/composer-prisma-cloud/streams`

Durable append-only event streams as a Prisma Composer module. It wraps the
production `@prisma/streams-server` runtime (npm, unmodified) as a Compute
service behind a typed boundary: the module's `store` dependency takes a
`storage()` module's port as its durable tier, and it exposes a single
`streams` port. Consumers get a `{ url, apiKey }` binding — the key minted by
the deploy — and speak the **Durable Streams HTTP protocol** directly.

Ships as the `@prisma/composer-prisma-cloud/streams` subpath (like `/storage`).

## Contract scope

The binding is the endpoint URL plus the minted bearer key:

```ts
interface StreamsConfig {
  readonly url: string;
  readonly apiKey: string;
}
```

Consumers build their own HTTP client (ADR-0015) against the Durable Streams
surface:

| Op | Notes |
| --- | --- |
| `PUT /v1/stream/{name}` | create (idempotent; `content-type` fixes the stream's type) |
| `POST /v1/stream/{name}` | append a JSON array of events (`stream-closed: true` header closes) |
| `GET /v1/stream/{name}?offset=…` | read from an offset; `-1` = start; `format=json` |
| `GET …&live=long-poll&timeout=…` | held read — returns when fresh events arrive or timeout |
| `GET …&live=sse` | SSE tail (see the deployed live path note below) |

Offsets are **opaque cursors**, not numeric indices: take them from the
`stream-next-offset` response header and pass them back verbatim.

**Auth rides the binding.** The bearer key is not an ADR-0029 secret (there
is no external value to bind) and not a producer output. The `apiKey`
connection param declares an [ADR-0031](../../../../docs/design/90-decisions/ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md)
**provisioning need**: the deploy target mints the value, keeps it stable in
deploy state, and fills the param like any other input. Declaring a
`durableStreams()` dependency is the whole of the wiring — there is no secret
slot and nothing to bind at the root. Every endpoint, including `/health`,
requires `Authorization: Bearer <key>`.

Two consequences worth knowing:

- **One key per streams module.** The provisioner mints per provider, not per
  edge, because `@prisma/streams-server` authenticates a single `API_KEY` —
  every consumer of one `streams()` instance holds the same value. Cardinality
  is provisioner policy (ADR-0031), so per-edge keys are later a change of
  that policy plus an accepted-set landing once the upstream server takes a
  key set: no resource to add, no core change, nothing here to delete.
- **No consumers, no key.** The need lives on the consumer's edge, so a
  `streams()` module nothing depends on never gets a key minted, and its
  server refuses to boot rather than serve unauthenticated. Wire a consumer,
  or drop the module.

## Wiring

The root provisions `storage()` as the durable tier and wires its `store`
port into `streams()` — the key needs no wiring at all:

```ts
// module.ts — the deploy root
import { module } from '@prisma/composer';
import { storage } from '@prisma/composer-prisma-cloud/storage';
import { streams } from '@prisma/composer-prisma-cloud/streams';
import worker from './src/worker/service.ts';

export default module('my-app', ({ provision }) => {
  const store = provision(storage());
  const events = provision(streams(), { deps: { store: store.store } });
  provision(worker, { deps: { streams: events.streams } });
});
```

```ts
// src/worker/service.ts — the consumer. Declaring the dependency is what
// causes the key to be minted; nothing names it.
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { durableStreams } from '@prisma/composer-prisma-cloud/streams';

export default compute({
  name: 'worker',
  deps: { streams: durableStreams() },
  build: node({ module: import.meta.url, entry: '../../dist/worker/server.mjs' }),
});
```

```ts
// src/worker/server.ts — append, then long-poll for what follows
import service from './service.ts';

const { streams } = service.load(); // StreamsConfig: { url, apiKey }
const authed = { authorization: `Bearer ${streams.apiKey}` };

await fetch(`${streams.url}/v1/stream/jobs`, {
  method: 'POST',
  headers: { ...authed, 'content-type': 'application/json' },
  body: JSON.stringify([{ kind: 'created' }]),
});

const head = await fetch(`${streams.url}/v1/stream/jobs?offset=-1&format=json`, {
  headers: authed,
});
const offset = head.headers.get('stream-next-offset');
const next = await fetch(
  `${streams.url}/v1/stream/jobs?offset=${offset}&format=json&live=long-poll&timeout=20s`,
  { headers: authed },
); // resolves when a fresh append lands (or 204 on timeout)
```

[`examples/streams`](../../../../examples/streams) is the worked example — the
module deployed to Prisma Cloud with `storage()` as its tier and a `jobs`
service consuming the binding, plus local integration tests and a deployed
consumer smoke script.

## Local development

`@prisma/composer-prisma-cloud/streams/testing` embeds the local stand-in
(`@prisma/streams-local`): SQLite-only, loopback, **no auth, no object store,
no cloud credentials** — the same protocol surface.

```ts
import { startLocalStreamsServer } from '@prisma/composer-prisma-cloud/streams/testing';

const server = await startLocalStreamsServer({ name: 'dev', port: 0 });
// server.exports.http.url is a Durable Streams endpoint (no Authorization needed).
// await server.close() when done.
```

The stand-in persists under `DS_LOCAL_DATA_ROOT`; tests point that at a
throwaway directory. The full conformance suite runs against it with no
credentials: `pnpm test:conformance:local` (and against a deployment:
`CONFORMANCE_TEST_URL=… STREAMS_API_KEY=… pnpm test:conformance:deployed`).

## Deployed live path: use long-poll

The Compute ingress currently buffers HTTP responses until the upstream
response completes. An open `?live=sse` tail therefore never delivers through
a deployment's public URL — the client sees zero bytes and the edge returns a
504 after ~60s — while the same request works locally and against the
stand-in. `?live=long-poll` completes per response and delivers live events
end to end through the ingress; use it for deployed live tailing. The deployed
conformance harness keeps the SSE tests, so they flip green when the platform
supports streaming responses.
