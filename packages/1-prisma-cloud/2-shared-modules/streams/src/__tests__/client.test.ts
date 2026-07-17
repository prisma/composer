/**
 * The streams client against the local stand-in: every method a consumer's
 * hydrated binding exposes, driven over the real protocol — create (and its
 * ensure semantics on a second create), JSON append framing, read from the
 * beginning and from an opaque mid-stream cursor, and a long-poll tail that
 * delivers an event appended after it opened (and times out cleanly when
 * nothing arrives). The stand-in has no auth, so the bearer header the client
 * always sends is simply ignored.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStreamsClient, type StreamsClient } from '../client.ts';
import { type LocalStreamsServer, startLocalStreamsServer } from '../testing.ts';

let server: LocalStreamsServer;
let client: StreamsClient;
let dataRoot: string;
let prevDataRoot: string | undefined;

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'streams-client-test-'));
  prevDataRoot = process.env['DS_LOCAL_DATA_ROOT'];
  process.env['DS_LOCAL_DATA_ROOT'] = dataRoot;
  server = await startLocalStreamsServer({ name: 'streams-client-test', port: 0 });
  client = createStreamsClient({
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

describe("the append contract's sharp edges (a counting proxy in front of the stand-in)", () => {
  // The wire client's DEFAULT behavior is the hazard these tests pin: its
  // shared backoff retries any non-4xx failure indefinitely — on every
  // method, appends included — and its default batching coalesces concurrent
  // appends into shared POSTs. A 4xx-based test cannot pin the first
  // property (Electric throws 4xx before the retry branch at ANY
  // maxRetries), so these drive a 503 and concurrency through a proxy that
  // counts what actually reached the wire.
  const startCountingProxy = (
    target: string,
    interceptPost?: (n: number) => Response | undefined,
  ) => {
    let posts = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (req.method === 'POST') {
          posts++;
          const intercepted = interceptPost?.(posts);
          if (intercepted !== undefined) return intercepted;
          // A little latency so concurrent appends overlap in flight — the
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
      posts: () => posts,
      stop: () => server.stop(true),
    };
  };

  test('a 503 on an append REJECTS after exactly ONE POST — appends enter no retry branch', async () => {
    // 503 is IN Electric's HTTP_RETRY_STATUS_CODES: with its default
    // maxRetries (Infinity) this append would be silently re-POSTed until
    // the proxy stopped failing. NO_RETRY_BACKOFF is what makes it throw
    // instead — remove it and this test goes red (the append resolves on
    // the proxy's second POST, and two POSTs arrive).
    const proxy = startCountingProxy(server.exports.http.url, (n) =>
      n === 1 ? new Response('cold', { status: 503 }) : undefined,
    );
    try {
      const flaky = createStreamsClient({ url: proxy.url, apiKey: 'unused' });
      await flaky.create('retry-pin');
      expect(flaky.append('retry-pin', { n: 1 })).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 300)); // a retry would land here
      expect(proxy.posts()).toBe(1);
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
      const counted = createStreamsClient({ url: proxy.url, apiKey: 'unused' });
      await counted.create('batch-pin');
      await Promise.all(Array.from({ length: 5 }, (_, i) => counted.append('batch-pin', { n: i })));
      expect(proxy.posts()).toBe(5);
      const readBack = await counted.read('batch-pin');
      expect(readBack.events).toHaveLength(5);
    } finally {
      proxy.stop();
    }
  }, 15_000);
});

describe('createStreamsClient (against the local stand-in)', () => {
  test('create is ensure-style: a second create of the same stream succeeds', async () => {
    await client.create('log');
    await client.create('log');
  });

  test('append then read round-trips events, and a mid-stream cursor resumes correctly', async () => {
    await client.append('log', { n: 1 });

    const first = await client.read('log');
    expect(first.events).toEqual([{ n: 1 }]);
    expect(first.nextOffset).not.toBe('');

    await client.append('log', { n: 2 });
    await client.append('log', { n: 3 });

    const all = await client.read('log');
    expect(all.events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    const rest = await client.read('log', { offset: first.nextOffset });
    expect(rest.events).toEqual([{ n: 2 }, { n: 3 }]);
  });

  test('tail delivers an event appended after it opened', async () => {
    await client.create('live');
    const tail = client.tail('live', { timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await client.append('live', { kind: 'ping' });

    const result = await tail;
    expect(result.timedOut).toBe(false);
    expect(result.events).toEqual([{ kind: 'ping' }]);
  }, 15_000);

  test('tail times out cleanly when nothing arrives', async () => {
    await client.create('quiet');
    const result = await client.tail('quiet', { timeoutMs: 1_000 });
    expect(result.timedOut).toBe(true);
    expect(result.events).toEqual([]);
  }, 10_000);

  test('a real protocol error surfaces immediately (read of a missing stream)', async () => {
    expect(client.read('never-created')).rejects.toThrow();
  });
});
