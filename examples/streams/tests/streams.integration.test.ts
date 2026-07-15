/**
 * The streams example's local integration test: boots the module's embedded
 * local stand-in (`@prisma/composer-prisma-cloud/streams/testing` —
 * SQLite-only, loopback, no auth, no object store, no cloud credentials) and
 * drives the Durable Streams protocol a consumer would use: create a stream,
 * append events, read them back from an offset.
 *
 * No Postgres, no bearer key, no cloud creds — this is the same protocol
 * surface the deployed module exposes, minus auth and durability, which the
 * package's own entrypoint integration test and deployed conformance suite
 * cover.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type LocalStreamsServer,
  startLocalStreamsServer,
} from '@prisma/composer-prisma-cloud/streams/testing';

let server: LocalStreamsServer;
let baseUrl: string;
let dataRoot: string;
let prevDataRoot: string | undefined;

beforeAll(async () => {
  // The local stand-in persists to `DS_LOCAL_DATA_ROOT` across runs unless
  // told otherwise — use a fresh throwaway directory per run.
  dataRoot = mkdtempSync(join(tmpdir(), 'streams-example-test-'));
  prevDataRoot = process.env['DS_LOCAL_DATA_ROOT'];
  process.env['DS_LOCAL_DATA_ROOT'] = dataRoot;
  server = await startLocalStreamsServer({ name: 'streams-example-test', port: 0 });
  baseUrl = server.exports.http.url;
});

afterAll(async () => {
  await server?.close();
  if (prevDataRoot === undefined) delete process.env['DS_LOCAL_DATA_ROOT'];
  else process.env['DS_LOCAL_DATA_ROOT'] = prevDataRoot;
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('streams example (against the local stand-in)', () => {
  const stream = '/v1/stream/example';

  test('PUT creates the stream', async () => {
    const put = await fetch(`${baseUrl}${stream}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
    });
    expect([200, 201]).toContain(put.status);
  });

  test('POST appends, GET reads from offset -1, and GET from a mid-offset returns only later events', async () => {
    const append = async (event: unknown): Promise<void> => {
      const post = await fetch(`${baseUrl}${stream}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([event]),
      });
      expect([200, 204]).toContain(post.status);
    };

    await append({ n: 1 });

    // Offsets are opaque cursors, not numeric indices — capture a real
    // mid-stream cursor from a read taken between appends.
    const afterFirst = await fetch(`${baseUrl}${stream}?offset=-1&format=json`);
    expect(afterFirst.status).toBe(200);
    expect(await afterFirst.json()).toEqual([{ n: 1 }]);
    const midOffset = afterFirst.headers.get('stream-next-offset');
    expect(midOffset).not.toBeNull();

    await append({ n: 2 });
    await append({ n: 3 });

    const all = await fetch(`${baseUrl}${stream}?offset=-1&format=json`);
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    const rest = await fetch(`${baseUrl}${stream}?offset=${midOffset}&format=json`);
    expect(rest.status).toBe(200);
    expect(await rest.json()).toEqual([{ n: 2 }, { n: 3 }]);
  });
});
