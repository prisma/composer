/**
 * The blob-store example app's integration test: drives the app against the
 * storage module's local stand-in (the `/storage/testing` `createPgStore` +
 * `startStorageServer` over a throwaway Postgres) and asserts store → retrieve
 * round-trips through the real S3 wire protocol. The same `createBlobApp`
 * handler runs behind `Bun.serve` in the deployed service.
 *
 * Skipped only on a dev machine with no Postgres; on CI the harness throws.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPgStore, startStorageServer } from '@prisma/compose-prisma-cloud/storage/testing';
import { createBlobApp } from '../src/blobs/app.ts';
import { startTestPostgres, type TestPostgres } from './pg-harness.ts';

const CREDENTIALS = { accessKeyId: 'AKIALOCALEXAMPLE', secretAccessKey: 'local-example-secret' };
const BUCKET = 'storage';
const TEXT = new TextEncoder();

const pg = startTestPostgres();
const suite = pg ? describe : describe.skip;

suite('blob store example app (against the local storage stand-in)', () => {
  let postgres: TestPostgres;
  let server: ReturnType<typeof startStorageServer>;
  let app: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    if (!pg) throw new Error('no Postgres available');
    postgres = pg;
    const store = await createPgStore(postgres.url);
    server = startStorageServer({ store, credentials: CREDENTIALS, bucket: BUCKET, port: 0 });
    app = createBlobApp({
      url: server.url,
      bucket: BUCKET,
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: CREDENTIALS.secretAccessKey,
    });
  });

  afterAll(() => {
    server?.stop();
    postgres?.stop();
  });

  test('PUT then GET round-trips a blob exactly', async () => {
    const put = await app(
      new Request('http://app/blobs/greeting.txt', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: TEXT.encode('hello world'),
      }),
    );
    expect(put.status).toBe(201);

    const got = await app(new Request('http://app/blobs/greeting.txt'));
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('text/plain');
    expect(await got.text()).toBe('hello world');
  });

  test('GET with a Range returns a 206 slice', async () => {
    await app(
      new Request('http://app/blobs/digits', { method: 'PUT', body: TEXT.encode('0123456789') }),
    );
    const got = await app(
      new Request('http://app/blobs/digits', { headers: { range: 'bytes=2-5' } }),
    );
    expect(got.status).toBe(206);
    expect(got.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await got.text()).toBe('2345');
  });

  test('GET /blobs lists stored keys (with a prefix filter)', async () => {
    for (const key of ['photos/a.png', 'photos/b.png', 'docs/readme.md']) {
      await app(new Request(`http://app/blobs/${key}`, { method: 'PUT', body: TEXT.encode(key) }));
    }
    const res = await app(new Request('http://app/blobs?prefix=photos/'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[] };
    expect(body.keys).toEqual(['photos/a.png', 'photos/b.png']);
  });

  test('DELETE removes a blob; a later GET is 404', async () => {
    await app(new Request('http://app/blobs/temp', { method: 'PUT', body: TEXT.encode('x') }));
    const del = await app(new Request('http://app/blobs/temp', { method: 'DELETE' }));
    expect(del.status).toBe(204);
    const got = await app(new Request('http://app/blobs/temp'));
    expect(got.status).toBe(404);
  });

  test('GET of a missing blob is 404', async () => {
    const got = await app(new Request('http://app/blobs/never-stored'));
    expect(got.status).toBe(404);
  });
});
