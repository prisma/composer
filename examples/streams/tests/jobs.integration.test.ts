/**
 * The jobs app's integration test: drives the consumer against the streams
 * module's local stand-in (`/streams/testing` — SQLite-only, loopback, no
 * cloud credentials) and asserts append → read-back and a live long-poll tail
 * through the same `createJobsApp` handler that runs behind `Bun.serve` in the
 * deployed service.
 *
 * The stand-in needs no auth, so the `apiKey` the app sends is a placeholder
 * here; in a deployment it is the value the target minted for the binding
 * (ADR-0031) and the server checks it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  app = createJobsApp({ url: server.exports.http.url, apiKey: 'local-stand-in-needs-no-auth' });
});

afterAll(async () => {
  await server?.close();
  if (prevDataRoot === undefined) delete process.env['DS_LOCAL_DATA_ROOT'];
  else process.env['DS_LOCAL_DATA_ROOT'] = prevDataRoot;
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('jobs app vs a cold streams service', () => {
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

  // The real platform behaviour (PRO-217): a scale-to-zero service refuses or
  // 502s the first touch while it boots. Modelled by a proxy in front of the
  // real stand-in that fails once, so the retry is exercised end to end through
  // the app rather than asserted against a mock of itself.
  const startFlakyProxy = (target: string, fail: () => Response | undefined) => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const cold = fail();
        if (cold !== undefined) return cold;
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

  test('rides out a cold 503 on the first touch and still serves the request', async () => {
    let calls = 0;
    const proxy = startFlakyProxy(coldServer.exports.http.url, () =>
      ++calls === 1 ? new Response('cold', { status: 503 }) : undefined,
    );
    try {
      const app = createJobsApp({ url: proxy.url, apiKey: 'local-stand-in-needs-no-auth' });
      const res = await app(post({ kind: 'survived-a-cold-start' }));
      expect(res.status).toBe(201);
      expect(calls).toBeGreaterThan(1); // the first call really did fail
    } finally {
      proxy.stop();
    }
  }, 15_000);

  test('a real failure is NOT retried away — a 401 surfaces as the upstream error it is', async () => {
    let calls = 0;
    const proxy = startFlakyProxy(coldServer.exports.http.url, () => {
      calls++;
      return new Response('nope', { status: 401 });
    });
    try {
      const app = createJobsApp({ url: proxy.url, apiKey: 'wrong-key' });
      const res = await app(new Request('http://app/jobs'));
      expect(res.status).toBe(502); // this app's "my upstream said no", not a 500
      expect(calls).toBe(1); // tried once, not four times
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
    const tail = app(new Request('http://app/jobs/tail?timeout=10s'));
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
