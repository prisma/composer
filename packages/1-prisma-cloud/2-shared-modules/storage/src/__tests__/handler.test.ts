/**
 * The six-op wire protocol end to end: a real `@aws-sdk/client-s3` client
 * signs and sends over HTTP to a `Bun.serve` wrapping `createS3Handler` over
 * the in-memory store. This exercises the true wire path — SigV4 header
 * verification, every op's status/headers, ranged reads, ListObjectsV2 XML that
 * aws-sdk itself parses — with no mocking. Presigned GET/PUT hit the same
 * server via plain fetch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createS3Handler, MemoryObjectStore } from '@internal/s3-protocol';

const CREDENTIALS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretkey123' };
const BUCKET = 'bucket';
const TEXT = new TextEncoder();

let store: MemoryObjectStore;
let server: ReturnType<typeof Bun.serve>;
let client: S3Client;
let endpoint: string;

async function collect(body: unknown): Promise<Uint8Array> {
  const stream = body as { transformToByteArray(): Promise<Uint8Array> };
  return stream.transformToByteArray();
}

beforeAll(() => {
  store = new MemoryObjectStore();
  const handler = createS3Handler({ store, credentials: CREDENTIALS });
  server = Bun.serve({ port: 0, fetch: (req) => handler(req) });
  endpoint = `http://127.0.0.1:${server.port}`;
  client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: CREDENTIALS,
    // Keep the body a plain signed payload (no aws-chunked checksum trailer).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1,
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  store = new MemoryObjectStore();
  const handler = createS3Handler({ store, credentials: CREDENTIALS });
  server.reload({ fetch: (req) => handler(req) });
});

describe('PUT + GET', () => {
  test('round-trips an object and returns a quoted sha256 ETag', async () => {
    const put = await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'streams/a',
        Body: TEXT.encode('hello world'),
        ContentType: 'text/plain',
      }),
    );
    expect(put.ETag).toMatch(/^"[0-9a-f]{64}"$/);

    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'streams/a' }));
    expect(new TextDecoder().decode(await collect(got.Body))).toBe('hello world');
    expect(got.ContentType).toBe('text/plain');
    expect(got.ETag).toBe(put.ETag);
  });

  test('defaults content-type to application/octet-stream', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'k', Body: TEXT.encode('x') }));
    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'k' }));
    expect(got.ContentType).toBe('application/octet-stream');
  });
});

describe('ranged GET', () => {
  beforeEach(async () => {
    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: 'obj', Body: TEXT.encode('0123456789') }),
    );
  });

  test('a closed range returns 206 with the slice and Content-Range', async () => {
    const got = await client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: 'obj', Range: 'bytes=2-5' }),
    );
    expect(new TextDecoder().decode(await collect(got.Body))).toBe('2345');
    expect(got.ContentRange).toBe('bytes 2-5/10');
    expect(got.ContentLength).toBe(4);
  });

  test('an open-ended range reads to the end', async () => {
    const got = await client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: 'obj', Range: 'bytes=7-' }),
    );
    expect(new TextDecoder().decode(await collect(got.Body))).toBe('789');
    expect(got.ContentRange).toBe('bytes 7-9/10');
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
  test('removes an object and is idempotent for a missing key', async () => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'obj', Body: TEXT.encode('x') }));
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'obj' }));
    await expect(
      client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'obj' })),
    ).rejects.toThrow();
    // Deleting the now-missing key must still succeed.
    const second = await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'obj' }));
    expect(second.$metadata.httpStatusCode).toBe(204);
  });
});

describe('404 semantics', () => {
  test('GET of a missing key rejects with a 404', async () => {
    await expect(
      client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'nope' })),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
  });

  test('HEAD of a missing key rejects with a 404', async () => {
    await expect(
      client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'nope' })),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
  });
});

describe('ListObjectsV2', () => {
  beforeEach(async () => {
    for (const key of ['streams/a', 'streams/b', 'streams/c', 'other/d']) {
      await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: TEXT.encode(key) }));
    }
  });

  test('filters by prefix', async () => {
    const res = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'streams/' }));
    expect((res.Contents ?? []).map((c) => c.Key)).toEqual(['streams/a', 'streams/b', 'streams/c']);
    expect(res.IsTruncated).toBe(false);
  });

  test('paginates across pages via the continuation token', async () => {
    const page1 = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'streams/', MaxKeys: 2 }),
    );
    expect((page1.Contents ?? []).map((c) => c.Key)).toEqual(['streams/a', 'streams/b']);
    expect(page1.IsTruncated).toBe(true);
    expect(page1.NextContinuationToken).toBeDefined();

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
  test('a presigned PUT then a presigned GET round-trip', async () => {
    const putUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: BUCKET, Key: 'presigned/obj' }),
      { expiresIn: 900 },
    );
    const putRes = await fetch(putUrl, { method: 'PUT', body: TEXT.encode('presigned body') });
    expect(putRes.status).toBe(200);

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

describe('aws-chunked / flexible-checksum PUT (F2)', () => {
  // A validly-signed PUT that declares an aws-chunked / streaming payload. The
  // verifier uses the x-amz-content-sha256 value AS the payload hash, so the
  // seed signature verifies — exactly the corruption path: without the guard the
  // handler would store the chunk framing as the object bytes. The guard must
  // reject with 501 before reading the body.
  function signStreamingPut(headers: Record<string, string>): Request {
    const url = new URL(`${endpoint}/${BUCKET}/chunked/obj`);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const region = 'auto';
    const all: Record<string, string> = {
      host: url.host,
      'x-amz-date': amzDate,
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const names = Object.keys(all).sort();
    const canonicalHeaders = names.map((n) => `${n}:${all[n]?.trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [
      'PUT',
      url.pathname,
      '',
      canonicalHeaders,
      signedHeaders,
      all['x-amz-content-sha256'] ?? '',
    ].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const hmac = (key: Buffer | string, data: string) =>
      createHmac('sha256', key).update(data).digest();
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const kSigning = hmac(
      hmac(hmac(hmac(`AWS4${CREDENTIALS.secretAccessKey}`, date), region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${CREDENTIALS.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    // host is derived from the URL by the verifier; not set on the Request.
    const reqHeaders = new Headers({ 'x-amz-date': amzDate, authorization, ...headers });
    return new Request(url.href, {
      method: 'PUT',
      headers: reqHeaders,
      body: TEXT.encode('ignored'),
    });
  }

  test('a STREAMING x-amz-content-sha256 PUT is rejected with 501', async () => {
    const req = signStreamingPut({
      'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
      'content-encoding': 'aws-chunked',
      'x-amz-decoded-content-length': '5',
    });
    const res = await fetch(req);
    expect(res.status).toBe(501);
  });

  test('a content-encoding: aws-chunked PUT is rejected with 501', async () => {
    const req = signStreamingPut({
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'content-encoding': 'aws-chunked',
    });
    const res = await fetch(req);
    expect(res.status).toBe(501);
  });
});
