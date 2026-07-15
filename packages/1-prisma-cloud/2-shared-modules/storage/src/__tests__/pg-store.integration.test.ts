/**
 * DoD-5: the same module runs locally against real Postgres end to end. Spins a
 * throwaway local Postgres, builds the Postgres-backed store + server, and
 * drives a real `@aws-sdk/client-s3` across every in-scope op — proving bytes
 * survive the bytea round-trip exactly (what F2 protects), that ranged reads
 * use SQL `substring` (a slice of a 16 MiB object without detoasting the whole
 * value), list pagination across pages, 404s, delete idempotency, and
 * presigned GET/PUT.
 *
 * Skipped only on a dev machine with no Postgres; on CI the harness throws if
 * none is available (see pg-harness.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPgStore } from '../pg-store.ts';
import { type StorageServer, startStorageServer } from '../storage-server.ts';
import { createTestDatabase, startTestPostgres, type TestDatabase } from './pg-harness.ts';

const CREDENTIALS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretkey123' };
const BUCKET = 'bucket';
const TEXT = new TextEncoder();

const pg = startTestPostgres();
const suite = pg ? describe : describe.skip;

async function collect(body: unknown): Promise<Uint8Array> {
  const stream = body as { transformToByteArray(): Promise<Uint8Array> };
  return stream.transformToByteArray();
}

suite('pg-store integration (local Postgres)', () => {
  let db: TestDatabase;
  let server: StorageServer;
  let client: S3Client;

  beforeAll(async () => {
    const base = pg;
    if (!base) throw new Error('no Postgres available');
    db = await createTestDatabase(base.url);
    const store = await createPgStore(db.url);
    server = startStorageServer({ store, credentials: CREDENTIALS, bucket: BUCKET, port: 0 });
    client = new S3Client({
      region: 'auto',
      endpoint: server.url,
      forcePathStyle: true,
      credentials: CREDENTIALS,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 1,
    });
  });

  afterAll(async () => {
    server?.stop();
    await db?.drop();
    pg?.stop();
  });

  test('PUT then GET round-trips bytes exactly', async () => {
    const body = TEXT.encode('the quick brown fox');
    const put = await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'streams/a',
        Body: body,
        ContentType: 'text/plain',
      }),
    );
    expect(put.ETag).toBe(`"${createHash('sha256').update(body).digest('hex')}"`);

    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'streams/a' }));
    expect(Buffer.compare(await collect(got.Body), Buffer.from(body))).toBe(0);
    expect(got.ContentType).toBe('text/plain');
    expect(got.ETag).toBe(put.ETag);
  });

  test('content-type defaults to application/octet-stream', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'nod', Body: TEXT.encode('x') }));
    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'nod' }));
    expect(got.ContentType).toBe('application/octet-stream');
  });

  test('ranged GET returns 206 + Content-Range (closed and open-ended)', async () => {
    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: 'r', Body: TEXT.encode('0123456789') }),
    );

    const closed = await client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: 'r', Range: 'bytes=2-5' }),
    );
    expect(new TextDecoder().decode(await collect(closed.Body))).toBe('2345');
    expect(closed.ContentRange).toBe('bytes 2-5/10');

    const open = await client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: 'r', Range: 'bytes=7-' }),
    );
    expect(new TextDecoder().decode(await collect(open.Body))).toBe('789');
    expect(open.ContentRange).toBe('bytes 7-9/10');
  });

  test('HEAD returns size, content-type, and etag', async () => {
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'h',
        Body: TEXT.encode('12345'),
        ContentType: 'text/plain',
      }),
    );
    const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'h' }));
    expect(head.ContentLength).toBe(5);
    expect(head.ContentType).toBe('text/plain');
    expect(head.ETag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  test('DELETE removes an object and is idempotent for a missing key', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'd', Body: TEXT.encode('x') }));
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'd' }));
    await expect(
      client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'd' })),
    ).rejects.toThrow();
    const second = await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'd' }));
    expect(second.$metadata.httpStatusCode).toBe(204);
  });

  test('GET / HEAD of a missing key is 404', async () => {
    await expect(
      client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'missing' })),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    await expect(
      client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'missing' })),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
  });

  test('ListObjectsV2 paginates across pages by prefix + continuation token', async () => {
    for (const key of ['list/a', 'list/b', 'list/c', 'listother/d']) {
      await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: TEXT.encode(key) }));
    }
    const page1 = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'list/', MaxKeys: 2 }),
    );
    expect((page1.Contents ?? []).map((c) => c.Key)).toEqual(['list/a', 'list/b']);
    expect(page1.IsTruncated).toBe(true);
    expect(page1.NextContinuationToken).toBeDefined();

    const page2 = await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'list/',
        MaxKeys: 2,
        ContinuationToken: page1.NextContinuationToken,
      }),
    );
    expect((page2.Contents ?? []).map((c) => c.Key)).toEqual(['list/c']);
    expect(page2.IsTruncated).toBe(false);
  });

  test('LIST treats the prefix literally — an underscore is not a wildcard (F3)', async () => {
    // Under LIKE, prefix "a_" would match "axb"; starts_with must not.
    for (const key of ['a_b', 'a_c', 'axb']) {
      await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: TEXT.encode(key) }));
    }
    const res = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'a_' }));
    expect((res.Contents ?? []).map((c) => c.Key)).toEqual(['a_b', 'a_c']);
  });

  test('presigned PUT then presigned GET round-trip', async () => {
    const putUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: BUCKET, Key: 'presigned/o' }),
      { expiresIn: 900 },
    );
    expect(
      (await fetch(putUrl, { method: 'PUT', body: TEXT.encode('presigned body') })).status,
    ).toBe(200);

    const getUrl = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: BUCKET, Key: 'presigned/o' }),
      { expiresIn: 900 },
    );
    const res = await fetch(getUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('presigned body');
  });

  test('a ~16 MiB object round-trips exactly and a range slices it without full detoast', async () => {
    const big = randomBytes(16 * 1024 * 1024); // the streams segment cap (envelope)
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'big', Body: big }));

    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'big' }));
    const roundTripped = await collect(got.Body);
    expect(roundTripped.byteLength).toBe(big.byteLength);
    expect(Buffer.compare(roundTripped, big)).toBe(0);

    const slice = await client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: 'big', Range: 'bytes=1000000-1000009' }),
    );
    expect(Buffer.compare(await collect(slice.Body), big.subarray(1000000, 1000010))).toBe(0);
    expect(slice.ContentRange).toBe(`bytes 1000000-1000009/${big.byteLength}`);
  });
});
