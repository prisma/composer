/**
 * End-to-end proof of the deploy entrypoint against a real storage stand-in:
 * boots `streams-entrypoint.ts` as a child process with the env the framework
 * serializer would write, drives the Durable Streams protocol through bearer
 * auth (append, read from an offset, long-poll, SSE tail), watches a segment
 * + manifest land in the storage module, then kills the instance, wipes its
 * disk, and asserts a cold start restores the events from the store.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPgStore, startStorageServer } from '@internal/storage/testing';
import { createTestDatabase, startTestPostgres, type TestDatabase } from './pg-harness.ts';

const postgres = startTestPostgres();

const API_KEY = 'streams-integration-key';
const PACKAGE_ROOT = new URL('../..', import.meta.url).pathname;

let db: TestDatabase;
let storageServer: { url: string; stop: () => void };
let store: Awaited<ReturnType<typeof createPgStore>>;
let child: ChildProcess | undefined;
let dsRoot: string;
let port: number;
let baseUrl: string;

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMPOSER_STORE_URL: storageServer.url,
    COMPOSER_STORE_BUCKET: 'streams',
    COMPOSER_STORE_ACCESSKEYID: 'local',
    COMPOSER_STORE_SECRETACCESSKEY: 'local-secret',
    COMPOSER_PORT: JSON.stringify(port),
    // The target stores the provisioned key address-scoped and compute's `run`
    // validates and re-stashes it address-free (JSON-encoded, the same wire
    // format any service-own literal param takes); this child boots the
    // entrypoint directly, so it sets the address-free name the entrypoint
    // reads, already in that encoding.
    COMPOSER_STREAMS_API_KEY: JSON.stringify(API_KEY),
    DS_ROOT: dsRoot,
    DS_HOST: '127.0.0.1',
    // Seal + upload fast so durability is observable within the test.
    DS_SEGMENT_MAX_INTERVAL_MS: '250',
    DS_UPLOAD_CHECK_MS: '250',
    // The server's request-timeout timers are never cleared, and each keeps
    // the process alive after SIGTERM until it fires — the entrypoint's 60s
    // default would stall shutdown (and this suite) for a minute.
    DS_OBJECTSTORE_TIMEOUT_MS: '2000',
  };
}

function startServer(): ChildProcess {
  const proc = spawn('bun', ['src/exports/streams-entrypoint.ts'], {
    cwd: PACKAGE_ROOT,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[streams] ${chunk.toString()}`);
  });
  return proc;
}

async function stopServer(proc: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill('SIGTERM');
  await exited;
}

const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...init.headers, authorization: `Bearer ${API_KEY}` },
});

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/health`, authed());
      if (res.ok) return;
    } catch {
      // still booting
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for the streams server');
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  if (postgres === undefined) return;
  db = await createTestDatabase(postgres.url);
  store = await createPgStore(db.url);
  storageServer = startStorageServer({
    store,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local-secret' },
    bucket: 'streams',
    port: 0,
  });
  dsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'streams-entrypoint-'));
  port = 20000 + Math.floor(Math.random() * 20000);
  baseUrl = `http://127.0.0.1:${port}`;
  child = startServer();
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  if (child !== undefined) await stopServer(child);
  storageServer?.stop();
  await db?.drop();
  postgres?.stop();
  if (dsRoot !== undefined) fs.rmSync(dsRoot, { recursive: true, force: true });
});

describe.skipIf(postgres === undefined)('streams entrypoint against the storage stand-in', () => {
  const stream = '/v1/stream/integration';
  const events = [{ n: 1 }, { n: 2 }, { n: 3 }];

  test('rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(401);
  });

  test('append and read from an offset', async () => {
    const put = await fetch(`${baseUrl}${stream}`, {
      ...authed({ method: 'PUT' }),
      headers: { ...authed().headers, 'content-type': 'application/json' },
    });
    expect([200, 201]).toContain(put.status);

    for (const event of events) {
      const post = await fetch(`${baseUrl}${stream}`, {
        method: 'POST',
        headers: { ...authed().headers, 'content-type': 'application/json' },
        body: JSON.stringify([event]),
      });
      expect([200, 204]).toContain(post.status);
    }

    const read = await fetch(`${baseUrl}${stream}?offset=-1&format=json`, authed());
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(events);
    expect(read.headers.get('stream-next-offset')).not.toBeNull();
  });

  test('long-poll delivers a new append', async () => {
    const head = await fetch(`${baseUrl}${stream}?offset=-1&format=json`, authed());
    const offset = head.headers.get('stream-next-offset');
    expect(offset).not.toBeNull();

    const poll = fetch(
      `${baseUrl}${stream}?offset=${offset}&format=json&live=long-poll&timeout=10s`,
      authed(),
    );
    await new Promise((r) => setTimeout(r, 300));
    await fetch(`${baseUrl}${stream}`, {
      method: 'POST',
      headers: { ...authed().headers, 'content-type': 'application/json' },
      body: JSON.stringify([{ n: 4 }]),
    });

    const res = await poll;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ n: 4 }]);
  }, 15_000);

  test('SSE tail delivers a new append', async () => {
    const head = await fetch(`${baseUrl}${stream}?offset=-1`, authed());
    const offset = head.headers.get('stream-next-offset');

    const res = await fetch(`${baseUrl}${stream}?offset=${offset}&live=sse`, authed());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toStartWith('text/event-stream');
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('SSE response has no body');

    await fetch(`${baseUrl}${stream}`, {
      method: 'POST',
      headers: { ...authed().headers, 'content-type': 'application/json' },
      body: JSON.stringify([{ n: 5 }]),
    });

    const decoder = new TextDecoder();
    let received = '';
    const deadline = Date.now() + 10_000;
    while (!received.includes('"n":5') && Date.now() < deadline) {
      const next = await reader.read();
      if (next.done) break;
      received += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel();
    expect(received).toContain('"n":5');
  }, 15_000);

  test('segments and a manifest land in the storage module', async () => {
    const deadline = Date.now() + 20_000;
    let keys: readonly string[] = [];
    while (Date.now() < deadline) {
      keys = (await store.list('streams', { prefix: 'streams/' })).keys;
      if (keys.some((k) => k.endsWith('manifest.json')) && keys.some((k) => k.endsWith('.bin')))
        break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(keys.some((k) => k.endsWith('manifest.json'))).toBe(true);
    expect(keys.some((k) => k.endsWith('.bin'))).toBe(true);
  }, 25_000);

  test('a cold start with a fresh disk restores the stream from the store', async () => {
    if (child === undefined) throw new Error('no running server to restart');
    // Everything above is published by now (previous test saw the manifest);
    // give the uploader one more beat for the tail appends, then restart on a
    // wiped disk — the entrypoint must take its bootstrap-from-store path.
    await new Promise((r) => setTimeout(r, 1_500));
    await stopServer(child);
    fs.rmSync(dsRoot, { recursive: true, force: true });
    fs.mkdirSync(dsRoot, { recursive: true });

    child = startServer();
    await waitForHealth();

    const read = await fetch(`${baseUrl}${stream}?offset=-1&format=json`, authed());
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual([...events, { n: 4 }, { n: 5 }]);
  }, 60_000);
});
