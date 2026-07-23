// Hand-written "built output" for web-service.ts (S4 fixture). A real build
// would bundle web-service.ts's declaration directly into this file (as
// examples/env-param's server.ts does via a real `bun build`); this fixture
// has no bundler, so the SAME compute() shape is declared again here instead
// of importing the sibling .ts source — a relative import to a file outside
// this artifact's own copied bundle would break once the artifact is
// extracted somewhere else (confirmed the hard way: it does). VERSION is
// what the "changed artifact restarts exactly one service" proof edits
// between converges.

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import node from '@prisma/composer/node';
import { bucket, compute, postgres } from '@prisma/composer-prisma-cloud';

const service = compute({
  name: 'web',
  deps: { db: postgres(), store: bucket() },
  build: node({ module: import.meta.url, entry: 'web-server.mjs' }),
});

const VERSION = 'v1';

const { port } = service.config();
const { db, store } = service.load();

// The bucket round-trip proof (S5, acceptance criterion 4): a real
// @aws-sdk/client-s3 client against the bucket binding, exactly as
// examples/bucket's blob app does.
const s3 = new S3Client({
  region: 'auto',
  endpoint: store.url,
  forcePathStyle: true,
  credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

async function collectBytes(body) {
  return body.transformToByteArray();
}

Bun.serve({
  port,
  hostname: '0.0.0.0',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        version: VERSION,
        db: typeof db.url === 'string' && db.url.length > 0,
        store: typeof store.url === 'string' && store.url.length > 0,
        // The port-override row local dev's Deployment provider materializes
        // into this process's own env (never persisted to env.json — see
        // local-dev spec § 4) — exposed here so a test can assert on it
        // directly, through the documented HTTP contract, rather than
        // inferring it indirectly from a successful bind.
        portEnv: process.env['COMPOSER_WEB_PORT'] ?? null,
      });
    }
    if (url.pathname.startsWith('/blobs/')) {
      const key = decodeURIComponent(url.pathname.slice('/blobs/'.length));
      if (key.length === 0) return new Response('missing key', { status: 400 });
      if (request.method === 'PUT') {
        const body = new Uint8Array(await request.arrayBuffer());
        const contentType = request.headers.get('content-type') ?? 'application/octet-stream';
        await s3.send(
          new PutObjectCommand({
            Bucket: store.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
          }),
        );
        return Response.json({ key, size: body.byteLength }, { status: 201 });
      }
      if (request.method === 'GET') {
        try {
          const res = await s3.send(new GetObjectCommand({ Bucket: store.bucket, Key: key }));
          const bytes = await collectBytes(res.Body);
          return new Response(bytes, {
            status: 200,
            headers: { 'content-type': res.ContentType ?? 'application/octet-stream' },
          });
        } catch (error) {
          const status = error?.$metadata?.httpStatusCode;
          if (status === 404) return new Response('not found', { status: 404 });
          throw error;
        }
      }
      return new Response('method not allowed', { status: 405 });
    }
    return new Response('local-dev fixture: web', { status: 200 });
  },
});

console.log(`[fixture] web listening on ${port} (${VERSION})`);
