/**
 * The jobs app's integration test: the app driven through the hydrated-style
 * handle (`StreamsClient` pointed at the local stand-in, `.stream('jobs')` —
 * exactly what `load()` hands the deployed service) — append → read-back, a
 * live long-poll tail, and error mapping. The stand-in needs no auth, so the
 * key is a placeholder.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamsClient } from '@prisma/composer-prisma-cloud/streams';
import {
  type LocalStreamsServer,
  startLocalStreamsServer,
} from '@prisma/composer-prisma-cloud/streams/testing';
import { createJobsApp } from '../src/jobs/app.ts';

let server: LocalStreamsServer;
let app: (req: Request) => Promise<Response>;
let dataRoot: string;
let prevDataRoot: string | undefined;

const post = (event: unknown): Request =>
  new Request('http://app/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'jobs-example-test-'));
  prevDataRoot = process.env['DS_LOCAL_DATA_ROOT'];
  process.env['DS_LOCAL_DATA_ROOT'] = dataRoot;
  server = await startLocalStreamsServer({ name: 'jobs-example-test', port: 0 });
  const client = new StreamsClient({
    url: server.exports.http.url,
    apiKey: 'local-stand-in-needs-no-auth',
  });
  app = createJobsApp(client.stream('jobs'));
});

afterAll(async () => {
  await server?.close();
  if (prevDataRoot === undefined) delete process.env['DS_LOCAL_DATA_ROOT'];
  else process.env['DS_LOCAL_DATA_ROOT'] = prevDataRoot;
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('jobs app vs an upstream that says no', () => {
  let coldServer: LocalStreamsServer;
  let coldRoot: string;

  beforeAll(async () => {
    // Its own stand-in: this suite appends, and the suite below asserts on an
    // exact log.
    coldRoot = mkdtempSync(join(tmpdir(), 'jobs-cold-test-'));
    process.env['DS_LOCAL_DATA_ROOT'] = coldRoot;
    coldServer = await startLocalStreamsServer({ name: 'jobs-cold-test', port: 0 });
    process.env['DS_LOCAL_DATA_ROOT'] = dataRoot;
  });

  afterAll(async () => {
    await coldServer?.close();
    rmSync(coldRoot, { recursive: true, force: true });
  });

  // A stub in front of the real stand-in, so the app's own error handling is
  // exercised end to end rather than asserted against a mock of itself.
  const startFlakyProxy = (target: string, fail: () => Response | undefined) => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const refused = fail();
        if (refused !== undefined) return refused;
        const url = new URL(req.url);
        return fetch(`${target}${url.pathname}${url.search}`, {
          method: req.method,
          headers: req.headers,
          ...(req.method === 'POST' || req.method === 'PUT' ? { body: await req.text() } : {}),
        });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  };

  test('an upstream 401 surfaces as a 502 naming the cause, not an opaque 500', async () => {
    let calls = 0;
    const proxy = startFlakyProxy(coldServer.exports.http.url, () => {
      calls++;
      return new Response('nope', { status: 401 });
    });
    try {
      const client = new StreamsClient({ url: proxy.url, apiKey: 'wrong-key' });
      const app = createJobsApp(client.stream('jobs'));
      const res = await app(new Request('http://app/jobs'));
      expect(res.status).toBe(502); // this app's "my upstream said no", not a 500
      expect(calls).toBe(1); // called once — a real protocol error is never retried
    } finally {
      proxy.stop();
    }
  }, 15_000);
});

describe('jobs app (against the local streams stand-in)', () => {
  test('POST /jobs appends and GET /jobs reads the log back', async () => {
    const first = await app(post({ kind: 'created', id: 1 }));
    expect(first.status).toBe(201);
    const second = await app(post({ kind: 'started', id: 1 }));
    expect(second.status).toBe(201);

    const read = await app(new Request('http://app/jobs'));
    expect(read.status).toBe(200);
    const body = (await read.json()) as { events: unknown[]; nextOffset: string | null };
    expect(body.events).toEqual([
      { kind: 'created', id: 1 },
      { kind: 'started', id: 1 },
    ]);
    expect(body.nextOffset).not.toBeNull();
  });

  test('GET /jobs/tail long-polls and delivers an event appended after it opened', async () => {
    const tail = app(new Request('http://app/jobs/tail?timeout=10'));
    await new Promise((r) => setTimeout(r, 300));
    await app(post({ kind: 'finished', id: 1 }));

    const res = await tail;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; timedOut: boolean };
    expect(body.timedOut).toBe(false);
    expect(body.events).toEqual([{ kind: 'finished', id: 1 }]);
  }, 15_000);

  test('an unknown route is 404 and /health is served', async () => {
    expect((await app(new Request('http://app/nope'))).status).toBe(404);
    expect((await app(new Request('http://app/health'))).status).toBe(200);
  });
});
