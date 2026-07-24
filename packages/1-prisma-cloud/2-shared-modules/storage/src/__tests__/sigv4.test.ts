/**
 * SigV4 verification (spec § 2 auth). Two proofs:
 *  - streams-server shape: replicate the exact canonical-request construction
 *    from streams' R2 client (real payload sha256, path-style, region `auto`,
 *    dynamic signed headers) and assert the verifier accepts it; tamper and
 *    wrong-secret are rejected.
 *  - presign: a real `@aws-sdk/s3-request-presigner` URL verifies, and an
 *    expired one is rejected (deterministic via injected `now`).
 *
 * This covers the streams-server wire shape at the unit level — the verifier
 * accepts a request signed exactly the way streams' R2 client signs one.
 */

import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { verifyRequest } from '@internal/s3-protocol';

const CREDENTIALS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretkey123' };
const ENDPOINT = 'http://127.0.0.1:9000';

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function encodePathPart(part: string): string {
  return encodeURIComponent(part).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeQueryPart(part: string): string {
  return encodePathPart(part).replace(/%7E/g, '~');
}

/**
 * A faithful replica of streams' `R2ObjectStore.authorization` (its
 * `src/objectstore/r2.ts`): the request shape a real streams-server signs.
 * Signs host + content-type + x-amz-content-sha256 + x-amz-date (content-length
 * is dropped so the fixture is independent of body/undici behaviour — the
 * verifier reads the same header set back from the URL/headers).
 */
function streamsSign(opts: {
  method: string;
  url: URL;
  headers: Headers;
  payloadHash: string;
  secretAccessKey: string;
  accessKeyId: string;
  region: string;
  amzDate: string;
}): string {
  const { method, url, headers, payloadHash, secretAccessKey, accessKeyId, region, amzDate } = opts;
  const date = amzDate.slice(0, 8);
  headers.set('host', url.host);
  headers.set('x-amz-content-sha256', payloadHash);
  headers.set('x-amz-date', amzDate);

  const signedHeaderNames = [...headers.keys()].map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers.get(name)?.trim().replace(/\s+/g, ' ') ?? ''}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const queryEntries = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => {
    if (ak === bk) return av < bv ? -1 : av > bv ? 1 : 0;
    return ak < bk ? -1 : 1;
  });
  const canonicalQuery = queryEntries
    .map(([key, value]) => `${encodeQueryPart(key)}=${encodeQueryPart(value)}`)
    .join('&');
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function buildStreamsRequest(secret: string): { req: Request; authorization: string } {
  const body = new Uint8Array([1, 2, 3]);
  const url = new URL(`${ENDPOINT}/bucket/streams/a`);
  const headers = new Headers({ 'content-type': 'application/octet-stream' });
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const authorization = streamsSign({
    method: 'PUT',
    url,
    headers,
    payloadHash: sha256Hex(body),
    secretAccessKey: secret,
    accessKeyId: CREDENTIALS.accessKeyId,
    region: 'auto',
    amzDate,
  });
  // host is derived from the URL by the verifier; not set on the Request.
  const reqHeaders = new Headers({
    'content-type': 'application/octet-stream',
    'x-amz-content-sha256': sha256Hex(body),
    'x-amz-date': amzDate,
    authorization,
  });
  return { req: new Request(url.href, { method: 'PUT', headers: reqHeaders }), authorization };
}

describe('streams-server signer shape', () => {
  test('a request signed exactly as streams signs it verifies', () => {
    const { req } = buildStreamsRequest(CREDENTIALS.secretAccessKey);
    expect(verifyRequest(req, CREDENTIALS)).toEqual({ ok: true });
  });

  test('a tampered signature is rejected', () => {
    const { req, authorization } = buildStreamsRequest(CREDENTIALS.secretAccessKey);
    const tampered = new Request(req.url, {
      method: 'PUT',
      headers: (() => {
        const h = new Headers(req.headers);
        h.set(
          'authorization',
          `${authorization.slice(0, -1)}${authorization.endsWith('0') ? '1' : '0'}`,
        );
        return h;
      })(),
    });
    const result = verifyRequest(tampered, CREDENTIALS);
    expect(result.ok).toBe(false);
  });

  test('the wrong secret is rejected', () => {
    const { req } = buildStreamsRequest('the-wrong-secret');
    const result = verifyRequest(req, CREDENTIALS);
    expect(result).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  test('a missing x-amz-content-sha256 is rejected', () => {
    const { req } = buildStreamsRequest(CREDENTIALS.secretAccessKey);
    const h = new Headers(req.headers);
    h.delete('x-amz-content-sha256');
    const stripped = new Request(req.url, { method: 'PUT', headers: h });
    expect(verifyRequest(stripped, CREDENTIALS)).toEqual({
      ok: false,
      reason: 'missing x-amz-content-sha256',
    });
  });
});

describe('presigned URL verification', () => {
  const presigner = new S3Client({
    region: 'auto',
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: CREDENTIALS,
  });

  test('a fresh presigned GET verifies', async () => {
    const url = await getSignedUrl(
      presigner,
      new GetObjectCommand({ Bucket: 'bucket', Key: 'streams/a' }),
      { expiresIn: 900 },
    );
    const req = new Request(url, { method: 'GET' });
    expect(verifyRequest(req, CREDENTIALS)).toEqual({ ok: true });
  });

  test('a fresh presigned PUT verifies', async () => {
    const url = await getSignedUrl(
      presigner,
      new PutObjectCommand({ Bucket: 'bucket', Key: 'streams/a' }),
      { expiresIn: 900 },
    );
    const req = new Request(url, { method: 'PUT' });
    expect(verifyRequest(req, CREDENTIALS)).toEqual({ ok: true });
  });

  test('an expired presign is rejected', async () => {
    const url = await getSignedUrl(
      presigner,
      new GetObjectCommand({ Bucket: 'bucket', Key: 'streams/a' }),
      { expiresIn: 60 },
    );
    const req = new Request(url, { method: 'GET' });
    const later = new Date(Date.now() + 5 * 60 * 1000);
    expect(verifyRequest(req, CREDENTIALS, later)).toEqual({
      ok: false,
      reason: 'presign expired',
    });
  });

  test('a presigned URL with a tampered signature is rejected', async () => {
    const url = await getSignedUrl(
      presigner,
      new GetObjectCommand({ Bucket: 'bucket', Key: 'streams/a' }),
      { expiresIn: 900 },
    );
    const parsed = new URL(url);
    const sig = parsed.searchParams.get('X-Amz-Signature') ?? '';
    parsed.searchParams.set(
      'X-Amz-Signature',
      `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`,
    );
    const req = new Request(parsed.href, { method: 'GET' });
    expect(verifyRequest(req, CREDENTIALS).ok).toBe(false);
  });
});
