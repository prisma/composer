#!/usr/bin/env bun
/**
 * Consumer smoke test against a DEPLOYED streams module. Exercises exactly
 * the surface a real consumer uses: create a stream, append, read from an
 * offset and from a mid-offset, live tail via SSE, live tail via long-poll,
 * and confirm an unauthenticated request is rejected.
 *
 *   STREAMS_URL=https://… STREAMS_API_KEY=… bun scripts/smoke.ts
 *
 * STREAMS_API_KEY is the bare bearer key — if you copied it out of the
 * Compute console's `COMPOSER_<ADDR>_STREAMS_API_KEY` var, strip the
 * surrounding quotes first: the stored row is JSON-encoded (ADR-0031).
 */
import { blindCast } from '@prisma/composer/casts';

const readJsonArray = async (res: Response): Promise<unknown[]> =>
  blindCast<unknown[], 'the streams read endpoint is documented to return a JSON array'>(
    await res.json(),
  );

const baseUrl = process.env['STREAMS_URL']?.replace(/\/$/, '');
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('STREAMS_URL must point at the deployed streams module');
}
const apiKey = process.env['STREAMS_API_KEY'];
if (apiKey === undefined || apiKey === '') {
  throw new Error('STREAMS_API_KEY must carry the bearer key the deploy bound');
}

const stream = `/v1/stream/smoke-${Date.now()}`;
const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...init.headers, authorization: `Bearer ${apiKey}` },
});

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  await check('unauthenticated request is rejected with 401', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check('PUT creates the stream', async () => {
    const res = await fetch(`${baseUrl}${stream}`, {
      ...authed({ method: 'PUT' }),
      headers: { ...authed().headers, 'content-type': 'application/json' },
    });
    assert([200, 201].includes(res.status), `expected 200/201, got ${res.status}`);
  });

  const append = async (event: unknown): Promise<void> => {
    const res = await fetch(`${baseUrl}${stream}`, {
      method: 'POST',
      headers: { ...authed().headers, 'content-type': 'application/json' },
      body: JSON.stringify([event]),
    });
    assert([200, 204].includes(res.status), `expected 200/204, got ${res.status}`);
  };

  const events = [{ n: 1 }, { n: 2 }, { n: 3 }];
  // Offsets are opaque cursors, not numeric indices — capture a real
  // mid-stream cursor from a read taken between appends.
  let midOffset: string | null = null;
  await check('POST appends the first event', async () => {
    await append(events[0]);
  });

  await check(
    'GET from offset -1 reads the first event and yields a mid-stream cursor',
    async () => {
      const res = await fetch(`${baseUrl}${stream}?offset=-1&format=json`, authed());
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await readJsonArray(res);
      assert(
        JSON.stringify(body) === JSON.stringify([events[0]]),
        `unexpected body: ${JSON.stringify(body)}`,
      );
      midOffset = res.headers.get('stream-next-offset');
      assert(midOffset !== null, 'expected a stream-next-offset header');
    },
  );

  await check('POST appends the remaining events', async () => {
    await append(events[1]);
    await append(events[2]);
  });

  await check('GET from offset -1 reads all events', async () => {
    const res = await fetch(`${baseUrl}${stream}?offset=-1&format=json`, authed());
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await readJsonArray(res);
    assert(
      JSON.stringify(body) === JSON.stringify(events),
      `unexpected body: ${JSON.stringify(body)}`,
    );
  });

  await check('GET from the mid-stream cursor returns only the later events', async () => {
    const rest = await fetch(`${baseUrl}${stream}?offset=${midOffset}&format=json`, authed());
    assert(rest.status === 200, `expected 200, got ${rest.status}`);
    const restBody = await readJsonArray(rest);
    assert(
      JSON.stringify(restBody) === JSON.stringify(events.slice(1)),
      `remaining events mismatch: ${JSON.stringify(restBody)}`,
    );
  });

  await check('long-poll delivers a fresh append', async () => {
    const head = await fetch(`${baseUrl}${stream}?offset=-1&format=json`, authed());
    const offset = head.headers.get('stream-next-offset');
    assert(offset !== null, 'expected a stream-next-offset header');

    const poll = fetch(
      `${baseUrl}${stream}?offset=${offset}&format=json&live=long-poll&timeout=20s`,
      authed(),
    );
    await new Promise((r) => setTimeout(r, 500));
    await fetch(`${baseUrl}${stream}`, {
      method: 'POST',
      headers: { ...authed().headers, 'content-type': 'application/json' },
      body: JSON.stringify([{ n: 'long-poll' }]),
    });

    const res = await poll;
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await readJsonArray(res);
    assert(
      JSON.stringify(body) === JSON.stringify([{ n: 'long-poll' }]),
      `unexpected body: ${JSON.stringify(body)}`,
    );
  });

  await check('SSE tail delivers a fresh append', async () => {
    const head = await fetch(`${baseUrl}${stream}?offset=-1`, authed());
    const offset = head.headers.get('stream-next-offset');
    assert(offset !== null, 'expected a stream-next-offset header');

    const res = await fetch(`${baseUrl}${stream}?offset=${offset}&live=sse`, authed());
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      (res.headers.get('content-type') ?? '').startsWith('text/event-stream'),
      `expected text/event-stream, got ${res.headers.get('content-type')}`,
    );
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('SSE response has no body');

    await fetch(`${baseUrl}${stream}`, {
      method: 'POST',
      headers: { ...authed().headers, 'content-type': 'application/json' },
      body: JSON.stringify([{ n: 'sse' }]),
    });

    const decoder = new TextDecoder();
    let received = '';
    const deadline = Date.now() + 20_000;
    while (!received.includes('"n":"sse"') && Date.now() < deadline) {
      const next = await reader.read();
      if (next.done) break;
      received += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel();
    assert(received.includes('"n":"sse"'), `SSE tail never delivered the append; got: ${received}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
