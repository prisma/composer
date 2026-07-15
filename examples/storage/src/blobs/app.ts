/**
 * A tiny blob store/serve app that uses the storage module as its object store.
 * It `load()`s an `S3Config` from an `s3()` slot and builds an
 * `@aws-sdk/client-s3` client (path-style, region `auto`,
 * `requestChecksumCalculation: 'WHEN_REQUIRED'` — the store rejects aws-chunked
 * PUTs) to talk to the storage service over HTTP.
 *
 *   PUT    /blobs/:key   store the request body (content-type preserved)
 *   GET    /blobs/:key   return it (honors `Range` → 206)
 *   DELETE /blobs/:key   remove it (idempotent)
 *   GET    /blobs        list keys (optional `?prefix=`)
 *
 * `createBlobApp` returns a plain `Request → Response` handler so the same app
 * runs behind `Bun.serve` in the deployed service and inside the integration
 * test with no server.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3Config } from '@prisma/compose-prisma-cloud/storage';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

async function collect(body: unknown): Promise<Uint8Array> {
  if (
    typeof body === 'object' &&
    body !== null &&
    'transformToByteArray' in body &&
    typeof body.transformToByteArray === 'function'
  ) {
    return body.transformToByteArray();
  }
  throw new Error('response body is not an aws-sdk byte stream');
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return undefined;
  const meta = error.$metadata;
  if (typeof meta !== 'object' || meta === null || !('httpStatusCode' in meta)) return undefined;
  return typeof meta.httpStatusCode === 'number' ? meta.httpStatusCode : undefined;
}

export function createBlobApp(config: S3Config): (req: Request) => Promise<Response> {
  const client = new S3Client({
    region: 'auto',
    endpoint: config.url,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
  });
  const bucket = config.bucket;

  const list = async (url: URL): Promise<Response> => {
    const prefix = url.searchParams.get('prefix') ?? undefined;
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ...(prefix !== undefined ? { Prefix: prefix } : {}),
      }),
    );
    const keys = (res.Contents ?? []).map((c) => c.Key).filter((k): k is string => k !== undefined);
    return Response.json({ keys, truncated: res.IsTruncated ?? false });
  };

  const put = async (key: string, req: Request): Promise<Response> => {
    const body = new Uint8Array(await req.arrayBuffer());
    const contentType = req.headers.get('content-type') ?? DEFAULT_CONTENT_TYPE;
    const res = await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return Response.json({ key, etag: res.ETag, size: body.byteLength }, { status: 201 });
  };

  const get = async (key: string, req: Request): Promise<Response> => {
    const range = req.headers.get('range') ?? undefined;
    try {
      const res = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(range !== undefined ? { Range: range } : {}),
        }),
      );
      const bytes = await collect(res.Body);
      const headers = new Headers({ 'content-type': res.ContentType ?? DEFAULT_CONTENT_TYPE });
      if (res.ETag !== undefined) headers.set('etag', res.ETag);
      if (res.ContentRange !== undefined) {
        headers.set('content-range', res.ContentRange);
        return new Response(bytes, { status: 206, headers });
      }
      return new Response(bytes, { status: 200, headers });
    } catch (error) {
      if (statusOf(error) === 404) return new Response('not found', { status: 404 });
      throw error;
    }
  };

  const del = async (key: string): Promise<Response> => {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return new Response(null, { status: 204 });
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/' || path === '/health') {
      return new Response('blob store — PUT/GET/DELETE /blobs/:key, GET /blobs\n', { status: 200 });
    }
    if (path === '/blobs' && req.method === 'GET') return list(url);

    if (path.startsWith('/blobs/')) {
      const key = decodeURIComponent(path.slice('/blobs/'.length));
      if (key.length === 0) return new Response('missing key', { status: 400 });
      switch (req.method) {
        case 'PUT':
          return put(key, req);
        case 'GET':
          return get(key, req);
        case 'DELETE':
          return del(key);
        default:
          return new Response('method not allowed', { status: 405 });
      }
    }
    return new Response('not found', { status: 404 });
  };
}
