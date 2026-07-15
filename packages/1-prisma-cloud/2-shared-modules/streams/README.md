# `@prisma/composer-prisma-cloud/streams`

Durable append-only event streams as a Prisma Composer module. It wraps the
production `@prisma/streams-server` runtime (npm, unmodified) as a Compute
service behind a typed boundary: the module's `store` dependency takes a
`storage()` module's port as its durable tier, its `apiKey` secret slot holds
the bearer key, and it exposes a single `streams` port. Consumers get a
`{ url }` binding and speak the **Durable Streams HTTP protocol** directly.

Ships as the `@prisma/composer-prisma-cloud/streams` subpath (like `/storage`).

## Contract scope

The binding is the endpoint URL only:

```ts
interface StreamsConfig {
  readonly url: string;
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

**Auth is not in the binding.** The bearer key is an ADR-0029 secret — its
value never travels through framework config, so `{ url }` cannot carry it. A
consumer that calls the service declares its **own** `secret()` slot, and the
root binds both slots to the same platform variable. Every endpoint, including
`/health`, requires `Authorization: Bearer <key>`.

## Wiring

The root provisions `storage()` as the durable tier, wires its `store` port
into `streams()`, and binds the bearer key by name:

```ts
// module.ts — the deploy root
import { module } from '@prisma/composer';
import { envSecret } from '@prisma/composer-prisma-cloud';
import { storage } from '@prisma/composer-prisma-cloud/storage';
import { streams } from '@prisma/composer-prisma-cloud/streams';
import worker from './src/worker/service.ts';

export default module('my-app', ({ provision }) => {
  const store = provision(storage());
  const events = provision(streams(), {
    deps: { store: store.store },
    secrets: { apiKey: envSecret('STREAMS_API_KEY') },
  });
  provision(worker, {
    deps: { streams: events.streams },
    // The consumer's own secret slot, bound to the SAME platform variable —
    // this is how the key reaches a caller without entering the binding.
    secrets: { streamsKey: envSecret('STREAMS_API_KEY') },
  });
});
```

```ts
// src/worker/service.ts — the consumer
import node from '@prisma/composer/node';
import { secret } from '@prisma/composer';
import { compute } from '@prisma/composer-prisma-cloud';
import { durableStreams } from '@prisma/composer-prisma-cloud/streams';

export default compute({
  name: 'worker',
  deps: { streams: durableStreams() },
  secrets: { streamsKey: secret() },
  build: node({ module: import.meta.url, entry: '../../dist/worker/server.mjs' }),
});
```

```ts
// src/worker/server.ts — append, then long-poll for what follows
import service from './service.ts';

const { streams } = service.load(); // StreamsConfig: { url }
const { streamsKey } = service.secrets();
const authed = { authorization: `Bearer ${streamsKey.expose()}` };

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
module deployed to Prisma Cloud with `storage()` as its tier, plus a local
integration test and a deployed consumer smoke script.

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
