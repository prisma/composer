/**
 * The bucket emulator daemon (local-dev spec § 2 `buckets-main.ts`): the S3
 * wire protocol (`@internal/s3-protocol`'s handler + `fsStore`) over
 * registered bucket instances. Each instance is keyed by an id this daemon
 * generates, which is also its bucket name on the S3 wire; its objects live
 * in the data root its creator registers, a path stored verbatim and never
 * interpreted, as are its labels. Credentials are registered per instance.
 * Admin lives under `/_pcdev/` (the underscore can't collide with a valid
 * bucket name). Plain `node:http`.
 *
 * Runs as its own OS process, started by `daemon.ts`'s `ensureDaemon` via
 * `process.execPath <this file> --port <n> --state-dir <dir>`.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { type Credentials, createS3Handler, fsStore } from '@internal/s3-protocol';
import { readOwnVersion } from './daemon.ts';
import { readJsonFile, StateFile } from './state-file.ts';

const STATE_MODE = 0o600;

const MULTIPART_MESSAGE = 'multipart upload is not supported by the local dev bucket emulator yet';

/** Also the bucket's name on the S3 wire, so it uses only characters a bucket name allows. */
const INSTANCE_ID_RE = /^bkt-[0-9a-f]{16}$/;

function newInstanceId(): string {
  return `bkt-${randomBytes(8).toString('hex')}`;
}

interface BucketRecord {
  readonly id: string;
  readonly labels: Record<string, string>;
  /** Where the bucket's objects live, as its creator registered it. */
  readonly dir: string;
}

interface CredentialRecord {
  readonly instanceId: string;
  readonly secretAccessKey: string;
}

interface BucketsState {
  instances: Record<string, BucketRecord>;
  credentials: Record<string, CredentialRecord>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

function isBucketRecord(value: unknown): value is BucketRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'labels' in value &&
    isStringRecord(value.labels) &&
    'dir' in value &&
    typeof value.dir === 'string'
  );
}

function isCredentialRecord(value: unknown): value is CredentialRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'instanceId' in value &&
    typeof value.instanceId === 'string' &&
    'secretAccessKey' in value &&
    typeof value.secretAccessKey === 'string'
  );
}

function isBucketsState(value: unknown): value is BucketsState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'instances' in value &&
    typeof value.instances === 'object' &&
    value.instances !== null &&
    Object.values(value.instances).every(isBucketRecord) &&
    'credentials' in value &&
    typeof value.credentials === 'object' &&
    value.credentials !== null &&
    Object.values(value.credentials).every(isCredentialRecord)
  );
}

interface CreateBody {
  readonly labels: Record<string, string>;
  readonly dir: string;
}

function isCreateBody(value: unknown): value is CreateBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'labels' in value &&
    isStringRecord(value.labels) &&
    'dir' in value &&
    typeof value.dir === 'string'
  );
}

interface CredentialsBody {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

function isCredentialsBody(value: unknown): value is CredentialsBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'accessKeyId' in value &&
    typeof value.accessKeyId === 'string' &&
    'secretAccessKey' in value &&
    typeof value.secretAccessKey === 'string'
  );
}

function parseArgs(argv: readonly string[]): { readonly port: number; readonly stateDir: string } {
  let port: number | undefined;
  let stateDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[i + 1]);
    else if (argv[i] === '--state-dir') stateDir = argv[i + 1];
  }
  if (port === undefined || Number.isNaN(port)) {
    throw new Error('buckets-main: --port <n> is required');
  }
  if (stateDir === undefined) {
    throw new Error('buckets-main: --state-dir <dir> is required');
  }
  return { port, stateDir };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function toWebHeaders(nodeHeaders: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

async function sendWebResponse(res: http.ServerResponse, webRes: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webRes.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.writeHead(webRes.status, headers);
  res.end(buf);
}

function main(): void {
  const { port, stateDir } = parseArgs(process.argv.slice(2));
  const ownVersion = readOwnVersion();
  const statePath = path.join(stateDir, 'instances.json');
  const stateFile = new StateFile<BucketsState>(statePath, STATE_MODE);

  let state: BucketsState = { instances: {}, credentials: {} };

  const store = fsStore((bucket) => state.instances[bucket]?.dir);

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function text(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  function noContent(res: http.ServerResponse): void {
    res.writeHead(204);
    res.end();
  }

  async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const raw = await readBody(req);
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return undefined;
    }
  }

  function instanceView(bucket: BucketRecord): unknown {
    return { id: bucket.id, labels: bucket.labels, dir: bucket.dir };
  }

  async function handleCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (!isCreateBody(body)) {
      return text(
        res,
        400,
        'malformed body: expected { "labels": Record<string, string>, "dir": string }',
      );
    }
    await fs.promises.mkdir(body.dir, { recursive: true });
    const id = newInstanceId();
    const bucket: BucketRecord = { id, labels: { ...body.labels }, dir: body.dir };
    state.instances[id] = bucket;
    await stateFile.write(state);
    return json(res, 201, instanceView(bucket));
  }

  async function handlePutCredentials(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bucket: BucketRecord,
  ): Promise<void> {
    const body = await readJsonBody(req);
    if (!isCredentialsBody(body)) {
      return text(
        res,
        400,
        'malformed credentials body: expected { "accessKeyId", "secretAccessKey" }',
      );
    }
    const existing = state.credentials[body.accessKeyId];
    if (existing && existing.instanceId !== bucket.id) {
      return text(
        res,
        409,
        `accessKeyId "${body.accessKeyId}" is already registered for another bucket`,
      );
    }
    state.credentials[body.accessKeyId] = {
      instanceId: bucket.id,
      secretAccessKey: body.secretAccessKey,
    };
    await stateFile.write(state);
    noContent(res);
  }

  /** Removes the bucket's registration and credentials; its objects stay where its creator put them. */
  async function handleDelete(res: http.ServerResponse, id: string): Promise<void> {
    delete state.instances[id];
    for (const [key, cred] of Object.entries(state.credentials)) {
      if (cred.instanceId === id) delete state.credentials[key];
    }
    await stateFile.write(state);
    noContent(res);
  }

  /** Path-style addressing: the bucket is the first non-empty path segment. Mirrors the handler's own `parseTarget`, which isn't exported. */
  function bucketFromPath(pathname: string): string | undefined {
    const first = pathname.split('/').find((s) => s.length > 0);
    return first !== undefined ? decodeURIComponent(first) : undefined;
  }

  /**
   * Credentials accepted for THIS request's target bucket only. An unknown
   * bucket or one with no registered credentials yields no candidates, which
   * still resolves through the real 403 path below — never a bespoke
   * "unknown bucket" shortcut that would reveal anything.
   */
  function credentialsForBucket(bucket: string | undefined): Credentials[] {
    if (bucket === undefined || state.instances[bucket] === undefined) return [];
    return Object.entries(state.credentials)
      .filter(([, rec]) => rec.instanceId === bucket)
      .map(([accessKeyId, rec]) => ({ accessKeyId, secretAccessKey: rec.secretAccessKey }));
  }

  async function handleS3Wire(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (
      url.searchParams.has('uploads') ||
      url.searchParams.has('uploadId') ||
      url.searchParams.has('partNumber')
    ) {
      return text(res, 501, MULTIPART_MESSAGE);
    }

    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const bodyBuf = hasBody ? await readBody(req) : undefined;
    const host = req.headers.host ?? `127.0.0.1:${String(port)}`;
    const fullUrl = `http://${host}${req.url ?? '/'}`;
    const headers = toWebHeaders(req.headers);

    const candidates: Credentials[] = credentialsForBucket(bucketFromPath(url.pathname));
    // No candidate for this bucket: fall through to a single verification
    // attempt against an unusable pair, so the request still resolves
    // through the real 403 path. A valid signature from ANOTHER bucket's
    // credential never reaches this list, so it fails exactly the same way.
    if (candidates.length === 0) candidates.push({ accessKeyId: '', secretAccessKey: '' });

    let last: Response | undefined;
    for (const credentials of candidates) {
      const webReq = new Request(fullUrl, {
        method,
        headers,
        ...(bodyBuf && bodyBuf.length > 0 ? { body: bodyBuf } : {}),
      });
      const handler = createS3Handler({ store, credentials });
      const webRes = await handler(webReq);
      if (webRes.status !== 403) return sendWebResponse(res, webRes);
      last = webRes;
    }
    if (last) await sendWebResponse(res, last);
  }

  async function handleAdmin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    segments: readonly string[],
  ): Promise<void> {
    const method = req.method ?? 'GET';
    // segments[0] === '_pcdev'
    if (method === 'GET' && segments.length === 2 && segments[1] === 'health') {
      return json(res, 200, { version: ownVersion, pid: process.pid });
    }
    if (segments[1] !== 'instances') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (segments.length === 2) {
      if (method === 'GET') return json(res, 200, Object.values(state.instances).map(instanceView));
      if (method === 'POST') return handleCreate(req, res);
    }
    const id = segments[2];
    if (id !== undefined && !INSTANCE_ID_RE.test(id)) {
      return text(res, 400, `invalid instance id "${id}"`);
    }
    if (method === 'DELETE' && segments.length === 3 && id !== undefined) {
      return handleDelete(res, id);
    }
    const bucket = id === undefined ? undefined : state.instances[id];
    if (!bucket) return text(res, 404, `no such instance: "${id ?? ''}"`);
    if (method === 'GET' && segments.length === 3) return json(res, 200, instanceView(bucket));
    if (method === 'PUT' && segments.length === 4 && segments[3] === 'credentials') {
      return handlePutCredentials(req, res, bucket);
    }
    res.writeHead(404);
    res.end();
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { version: ownVersion, pid: process.pid });
    }

    if (url.pathname.startsWith('/_pcdev/')) {
      const segments = url.pathname
        .split('/')
        .filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s));
      return handleAdmin(req, res, segments);
    }

    return handleS3Wire(req, res, url);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(err instanceof Error ? err.message : String(err));
    });
  });

  // Wait for every already-queued state write to actually land on disk
  // before exiting — otherwise a SIGTERM arriving right after a mutation
  // (e.g. an ensureDaemon version-skew restart) can race the write and
  // silently lose it.
  async function shutdown(): Promise<void> {
    await stateFile.flush();
    server.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  discardStateFromEarlierVersions(stateDir, statePath)
    .then(() => readJsonFile(statePath, isBucketsState))
    .then((loaded) => {
      if (loaded) state = loaded;
      // A single, unambiguous line into the daemon's own stdio log once
      // actually bound and accepting connections — the daemon's own
      // portable evidence that exactly one instance is listening (tests
      // count occurrences of this line rather than inspecting OS processes,
      // whose command-line rendering/flags differ across platforms).
      server.once('error', (err) => {
        console.error(`buckets-main: cannot listen on 127.0.0.1:${String(port)}`, err);
        process.exit(1);
      });
      server.listen(port, '127.0.0.1', () => {
        console.log(`[dev-emulators] buckets-main listening on 127.0.0.1:${String(port)}`);
      });
    })
    .catch((err: unknown) => {
      console.error('buckets-main: failed to load state', err);
      process.exit(1);
    });
}

/**
 * Removes state files this version does not write. Local dev state is never
 * migrated across versions; buckets registered by an earlier version are
 * gone, and their objects stay where they were.
 */
async function discardStateFromEarlierVersions(stateDir: string, statePath: string): Promise<void> {
  const files = await fs.promises.readdir(stateDir).catch(() => []);
  await Promise.all(
    files
      .map((name) => path.join(stateDir, name))
      .filter((file) => file.endsWith('.json') && file !== statePath)
      .map((file) => fs.promises.rm(file, { force: true })),
  );
}

main();
