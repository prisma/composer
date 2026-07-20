/**
 * The streams client against the local stand-in: every operation a
 * consumer's hydrated handle exposes, driven over the real protocol —
 * ensure-create memoized across repeated operations, JSON append framing,
 * read from the beginning and from an opaque mid-stream cursor, a long-poll
 * tail that delivers an event appended after it opened (and times out
 * cleanly when nothing arrives), and the 404 heal that re-creates a stream
 * deleted out from under a handle. The stand-in has no auth, so the bearer
 * header the client always sends is simply ignored.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamsClient } from '../client.ts';
import { type LocalStreamsServer, startLocalStreamsServer } from '../exports/testing.ts';

let server: LocalStreamsServer;
let client: StreamsClient;
let dataRoot: string;
let prevDataRoot: string | undefined;

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'streams-client-test-'));
  prevDataRoot = process.env['DS_LOCAL_DATA_ROOT'];
  process.env['DS_LOCAL_DATA_ROOT'] = dataRoot;
  server = await startLocalStreamsServer({ name: 'streams-client-test', port: 0 });
  client = new StreamsClient({
    url: server.exports.http.url,
    apiKey: 'local-stand-in-needs-no-auth',
  });
});

afterAll(async () => {
  await server?.close();
  if (prevDataRoot === undefined) delete process.env['DS_LOCAL_DATA_ROOT'];
  else process.env['DS_LOCAL_DATA_ROOT'] = prevDataRoot;
  rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * A proxy in front of the stand-in that counts requests of one HTTP method,
 * optionally intercepting the Nth match — used to pin behavior a mock of
 * the wire client itself couldn't prove (what actually reached the wire).
 */
const startCountingProxy = (
  target: string,
  opts: { method?: string; intercept?: (n: number) => Response | undefined } = {},
) => {
  const method = opts.method ?? 'POST';
  let count = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === method) {
        count++;
        const intercepted = opts.intercept?.(count);
        if (intercepted !== undefined) return intercepted;
        // A little latency so concurrent requests overlap in flight — the
        // window Electric's batching coalesces in.
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      const url = new URL(req.url);
      return fetch(`${target}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        ...(req.method === 'POST' || req.method === 'PUT' ? { body: await req.text() } : {}),
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    count: () => count,
    stop: () => server.stop(true),
  };
};

describe("the append contract's sharp edges (a counting proxy in front of the stand-in)", () => {
  // The wire client's DEFAULT behavior is the hazard these tests pin: its
  // shared backoff retries any non-4xx failure indefinitely — on every
  // method, appends included — and its default batching coalesces concurrent
  // appends into shared POSTs. A 4xx-based test cannot pin the first
  // property (Electric throws 4xx before the retry branch at ANY
  // maxRetries), so these drive a 503 and concurrency through a proxy that
  // counts what actually reached the wire.
  test('a 503 on an append REJECTS after exactly ONE POST — appends enter no retry branch', async () => {
    // 503 is IN Electric's HTTP_RETRY_STATUS_CODES: with its default
    // maxRetries (Infinity) this append would be silently re-POSTed until
    // the proxy stopped failing. NO_RETRY_BACKOFF is what makes it throw
    // instead — remove it and this test goes red (the append resolves on
    // the proxy's second POST, and two POSTs arrive). A 503 is not the
    // handle's 404 heal target either, so no retry comes from that path.
    const proxy = startCountingProxy(server.exports.http.url, {
      intercept: (n) => (n === 1 ? new Response('cold', { status: 503 }) : undefined),
    });
    try {
      const flaky = new StreamsClient({ url: proxy.url, apiKey: 'unused' });
      expect(flaky.stream('retry-pin').append({ n: 1 })).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 300)); // a retry would land here
      expect(proxy.count()).toBe(1);
    } finally {
      proxy.stop();
    }
  }, 15_000);

  test('N concurrent appends are N POSTs — never coalesced into shared requests', async () => {
    // With Electric's default batching, appends 2..5 would buffer behind the
    // in-flight first and drain as ONE shared POST (2 total): a failure
    // would then be ambiguous across several callers' events. batching:
    // false is what makes one append one POST — remove it and this goes red.
    const proxy = startCountingProxy(server.exports.http.url);
    try {
      const counted = new StreamsClient({ url: proxy.url, apiKey: 'unused' });
      const handle = counted.stream('batch-pin');
      await Promise.all(Array.from({ length: 5 }, (_, i) => handle.append({ n: i })));
      expect(proxy.count()).toBe(5);
      const readBack = await handle.read();
      expect(readBack.events).toHaveLength(5);
    } finally {
      proxy.stop();
    }
  }, 15_000);
});

describe('StreamHandle ensure-create (against a counting proxy)', () => {
  test('repeated operations on the same handle issue exactly one create', async () => {
    // Every operation calls the handle's ensure-create first; the memo is
    // what collapses three calls into one PUT — remove it and this goes red
    // (three PUTs, one per operation).
    const proxy = startCountingProxy(server.exports.http.url, { method: 'PUT' });
    try {
      const client = new StreamsClient({ url: proxy.url, apiKey: 'unused' });
      const handle = client.stream('memo-pin');
      await handle.append({ n: 1 });
      await handle.append({ n: 2 });
      await handle.read();
      expect(proxy.count()).toBe(1);
    } finally {
      proxy.stop();
    }
  }, 15_000);
});

describe('StreamHandle (against the local stand-in)', () => {
  test('using a handle is sufficient to create its stream — no explicit create call', async () => {
    // The accepted consequence of ensure-create: a handle nothing ever
    // explicitly created still works, reading back an empty log rather than
    // 404ing.
    const result = await client.stream('never-explicitly-created').read();
    expect(result.events).toEqual([]);
  });

  test('append then read round-trips events, and a mid-stream cursor resumes correctly', async () => {
    const log = client.stream('log');
    await log.append({ n: 1 });

    const first = await log.read();
    expect(first.events).toEqual([{ n: 1 }]);
    expect(first.nextOffset).not.toBe('');

    await log.append({ n: 2 });
    await log.append({ n: 3 });

    const all = await log.read();
    expect(all.events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    const rest = await log.read({ offset: first.nextOffset });
    expect(rest.events).toEqual([{ n: 2 }, { n: 3 }]);
  });

  test('tail delivers an event appended after it opened', async () => {
    const live = client.stream('live');
    const tail = live.tail({ timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await live.append({ kind: 'ping' });

    const result = await tail;
    expect(result.timedOut).toBe(false);
    expect(result.events).toEqual([{ kind: 'ping' }]);
  }, 15_000);

  test('tail times out cleanly when nothing arrives', async () => {
    const quiet = client.stream('quiet');
    const result = await quiet.tail({ timeoutMs: 1_000 });
    expect(result.timedOut).toBe(true);
    expect(result.events).toEqual([]);
  }, 10_000);

  test('a stream lost from the durable tier heals: the handle re-creates and the append lands', async () => {
    const handle = client.stream('heals');
    await handle.append({ kind: 'before-loss' });
    // Delete the stream out from under the handle's memoized create (the
    // stand-in needs no auth). A fresh streams instance restoring an older
    // store is the deployed shape of the same loss.
    const del = await fetch(`${server.exports.http.url}/v1/stream/heals`, { method: 'DELETE' });
    expect(del.ok).toBe(true);

    // The append 404s (the stream is gone), which the handle heals by
    // dropping its memo, re-creating, and retrying this append once — remove
    // the heal body and this test goes red (the append rejects).
    await handle.append({ kind: 'after-loss' });
    const read = await handle.read<{ kind: string }>();
    expect(read.events.map((e) => e.kind)).toEqual(['after-loss']);
  });
});
