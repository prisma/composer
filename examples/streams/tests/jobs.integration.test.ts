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
