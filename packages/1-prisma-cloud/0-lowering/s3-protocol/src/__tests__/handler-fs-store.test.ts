/**
 * The S3 wire handler driven by a real `@aws-sdk/client-s3`, backed by
 * `fsStore` over a real temp directory instead of the in-memory store — the
 * disk-store-specific proof the local-dev spec § 1 asks for: bytes really
 * round-trip through the filesystem (temp-then-rename, the metadata
 * sidecar), and presigned GET/PUT work against it too.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fsStore } from '../fs-store.ts';
import { createS3Handler } from '../handler.ts';

const CREDENTIALS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretkey123' };
const BUCKET = 'bucket';
const TEXT = new TextEncoder();

let root: string;
let bucketDir: string;
let server: ReturnType<typeof Bun.serve>;
let client: S3Client;
let endpoint: string;

async function collect(body: unknown): Promise<Uint8Array> {
  const stream = body as { transformToByteArray(): Promise<Uint8Array> };
  return stream.transformToByteArray();
}

// One handler for the whole suite, bound to a fixed bucketDir path — each
// test wipes and recreates that directory on disk (below), so the store
// stays pointed at the same place without ever needing to reload the server.
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-s3-protocol-handler-'));
  bucketDir = path.join(root, 'bucket');
  fs.mkdirSync(bucketDir, { recursive: true });

  const store = fsStore((name) => (name === BUCKET ? bucketDir : undefined));
  const handler = createS3Handler({ store, credentials: CREDENTIALS });
  server = Bun.serve({ port: 0, fetch: (req) => handler(req) });
  endpoint = `http://127.0.0.1:${server.port}`;
  client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: CREDENTIALS,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1,
  });
});

afterAll(() => {
  server.stop(true);
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(bucketDir, { recursive: true, force: true });
  fs.mkdirSync(bucketDir, { recursive: true });
});

describe('PUT + GET', () => {
  test('round-trips an object through the filesystem and returns a quoted sha256 ETag', async () => {
    const put = await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'streams/a',
        Body: TEXT.encode('hello world'),
        ContentType: 'text/plain',
      }),
    );
    expect(put.ETag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(fs.existsSync(path.join(bucketDir, 'streams/a'))).toBe(true);
    expect(fs.existsSync(path.join(bucketDir, '.meta/streams/a.json'))).toBe(true);

    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'streams/a' }));
    expect(new TextDecoder().decode(await collect(got.Body))).toBe('hello world');
    expect(got.ContentType).toBe('text/plain');
    expect(got.ETag).toBe(put.ETag);
  });

  test('a file dropped directly on disk is readable through the app (droppable buckets)', async () => {
    fs.writeFileSync(path.join(bucketDir, 'dropped.txt'), TEXT.encode('dropped by hand'));
    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'dropped.txt' }));
    expect(new TextDecoder().decode(await collect(got.Body))).toBe('dropped by hand');
    expect(got.ContentType).toBe('application/octet-stream');
  });
});

describe('HEAD', () => {
  test('returns etag, size, and content-type', async () => {
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'obj',
        Body: TEXT.encode('12345'),
        ContentType: 'text/plain',
      }),
    );
    const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'obj' }));
    expect(head.ContentLength).toBe(5);
    expect(head.ContentType).toBe('text/plain');
    expect(head.ETag).toMatch(/^"[0-9a-f]{64}"$/);
  });
});

describe('DELETE', () => {
  test('removes the object plus its sidecar and is idempotent for a missing key', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'obj', Body: TEXT.encode('x') }));
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'obj' }));
    expect(fs.existsSync(path.join(bucketDir, 'obj'))).toBe(false);
    await expect(
      client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'obj' })),
    ).rejects.toThrow();
    const second = await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'obj' }));
    expect(second.$metadata.httpStatusCode).toBe(204);
  });
});

describe('ListObjectsV2', () => {
  beforeEach(async () => {
    for (const key of ['streams/a', 'streams/b', 'streams/c', 'other/d']) {
      await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: TEXT.encode(key) }));
    }
  });

  test('paginates across pages via the continuation token', async () => {
    const page1 = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'streams/', MaxKeys: 2 }),
    );
    expect((page1.Contents ?? []).map((c) => c.Key)).toEqual(['streams/a', 'streams/b']);
    expect(page1.IsTruncated).toBe(true);

    const page2 = await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'streams/',
        MaxKeys: 2,
        ContinuationToken: page1.NextContinuationToken,
      }),
    );
    expect((page2.Contents ?? []).map((c) => c.Key)).toEqual(['streams/c']);
    expect(page2.IsTruncated).toBe(false);
  });
});

describe('presigned URLs against the running server', () => {
  test('a presigned PUT then a presigned GET round-trip through the filesystem', async () => {
    const putUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: BUCKET, Key: 'presigned/obj' }),
      { expiresIn: 900 },
    );
    const putRes = await fetch(putUrl, { method: 'PUT', body: TEXT.encode('presigned body') });
    expect(putRes.status).toBe(200);
    expect(fs.existsSync(path.join(bucketDir, 'presigned/obj'))).toBe(true);

    const getUrl = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: BUCKET, Key: 'presigned/obj' }),
      { expiresIn: 900 },
    );
    const getRes = await fetch(getUrl);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('presigned body');
  });

  test('an unsigned request is rejected with 403', async () => {
    const res = await fetch(`${endpoint}/${BUCKET}/streams/a`);
    expect(res.status).toBe(403);
  });
});
