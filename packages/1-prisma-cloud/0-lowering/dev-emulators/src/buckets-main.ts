/**
 * The bucket emulator daemon (local-dev spec § 2 `buckets-main.ts`): the S3
 * wire protocol (`@internal/s3-protocol`'s handler + `fsStore`) over
 * registered per-app, per-bucket directories, multi-tenant via physical
 * names `<app>--<name>`. Admin lives under `/_pcdev/` (the underscore can't
 * collide with a valid bucket name). Plain `node:http`.
 *
 * Runs as its own OS process, started by `daemon.ts`'s `ensureDaemon` via
 * `process.execPath <this file> --port <n> --state-dir <dir>`.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { type Credentials, createS3Handler, fsStore } from '@internal/s3-protocol';
import { readOwnVersion } from './daemon.ts';
import { isValidSegment } from './segments.ts';
import { readJsonFile, StateFile } from './state-file.ts';

const STATE_MODE = 0o600;
// Mirrors `@internal/s3-protocol`'s own fs-store.ts bucket-name rule (not
// exported — it's the physical-bucket-name check this endpoint applies to
// the composed `<app>--<name>`, not a wire-level concern of the handler).
const PHYSICAL_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const MULTIPART_MESSAGE = 'multipart upload is not supported by the local dev bucket emulator yet';

interface BucketRegistration {
  readonly app: string;
  readonly name: string;
  readonly dir: string;
}

interface CredentialRecord {
  readonly app: string;
  readonly secretAccessKey: string;
}

interface BucketsState {
  buckets: Record<string, BucketRegistration>;
  credentials: Record<string, CredentialRecord>;
}

function isBucketRegistration(value: unknown): value is BucketRegistration {
  return (
    typeof value === 'object' &&
    value !== null &&
    'app' in value &&
    typeof value.app === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'dir' in value &&
    typeof value.dir === 'string'
  );
}

function isCredentialRecord(value: unknown): value is CredentialRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'app' in value &&
    typeof value.app === 'string' &&
    'secretAccessKey' in value &&
    typeof value.secretAccessKey === 'string'
  );
}

function isBucketsState(value: unknown): value is BucketsState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'buckets' in value &&
    typeof value.buckets === 'object' &&
    value.buckets !== null &&
    Object.values(value.buckets).every(isBucketRegistration) &&
    'credentials' in value &&
    typeof value.credentials === 'object' &&
    value.credentials !== null &&
    Object.values(value.credentials).every(isCredentialRecord)
  );
}

interface BucketBody {
  readonly dir: string;
}

function isBucketBody(value: unknown): value is BucketBody {
  return (
    typeof value === 'object' && value !== null && 'dir' in value && typeof value.dir === 'string'
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
  const stateJsonPath = path.join(stateDir, 'state.json');
  const stateFile = new StateFile<BucketsState>(stateJsonPath, STATE_MODE);

  let state: BucketsState = { buckets: {}, credentials: {} };

  function schedulePersist(): void {
    void stateFile.write(state);
  }

  const store = fsStore((physicalName) => state.buckets[physicalName]?.dir);

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function text(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  function badSegment(res: http.ServerResponse, segment: string): void {
    text(
      res,
      400,
      `invalid path segment "${segment}": must match /^[a-z0-9][a-z0-9-]*$/ and be at most 63 characters`,
    );
  }

  async function handlePutBucket(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    app: string,
    name: string,
  ): Promise<void> {
    const physicalName = `${app}--${name}`;
    if (!PHYSICAL_BUCKET_NAME_RE.test(physicalName)) {
      return text(
        res,
        400,
        `invalid bucket "${physicalName}" (app "${app}", name "${name}"): the physical bucket name must match /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/ and be at most 63 characters`,
      );
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return text(res, 400, 'malformed JSON body');
    }
    if (!isBucketBody(parsed))
      return text(res, 400, 'malformed bucket body: expected { "dir": string }');

    await fs.promises.mkdir(parsed.dir, { recursive: true });
    state.buckets[physicalName] = { app, name, dir: parsed.dir };
    schedulePersist();
    res.writeHead(204);
    res.end();
  }

  async function handlePutCredentials(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    app: string,
  ): Promise<void> {
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return text(res, 400, 'malformed JSON body');
    }
    if (!isCredentialsBody(parsed)) {
      return text(
        res,
        400,
        'malformed credentials body: expected { "accessKeyId", "secretAccessKey" }',
      );
    }
    const existing = state.credentials[parsed.accessKeyId];
    if (existing && existing.app !== app) {
      return text(
        res,
        409,
        `accessKeyId "${parsed.accessKeyId}" is already registered by a different app`,
      );
    }
    state.credentials[parsed.accessKeyId] = { app, secretAccessKey: parsed.secretAccessKey };
    schedulePersist();
    res.writeHead(204);
    res.end();
  }

  function handleDeleteApp(res: http.ServerResponse, app: string): void {
    for (const [key, reg] of Object.entries(state.buckets)) {
      if (reg.app === app) delete state.buckets[key];
    }
    for (const [key, cred] of Object.entries(state.credentials)) {
      if (cred.app === app) delete state.credentials[key];
    }
    schedulePersist();
    res.writeHead(204);
    res.end();
  }

  /** Path-style addressing: the bucket is the first non-empty path segment. Mirrors the handler's own `parseTarget`, which isn't exported. */
  function bucketFromPath(pathname: string): string | undefined {
    const first = pathname.split('/').find((s) => s.length > 0);
    return first !== undefined ? decodeURIComponent(first) : undefined;
  }

  /**
   * Credentials accepted for THIS request's target bucket only — its
   * owning app, derived from the bucket's registration (the authoritative
   * source for the `<app>--<name>` split; unregistered apps/names may
   * themselves contain `--`, so the registration is trusted over re-parsing
   * the string). An unknown bucket or an app with no registered credentials
   * yields no candidates, which still resolves through the real 403 path
   * below — never a bespoke "unknown bucket" shortcut that would reveal
   * anything.
   */
  function credentialsForBucket(bucket: string | undefined): Credentials[] {
    const owningApp = bucket !== undefined ? state.buckets[bucket]?.app : undefined;
    if (owningApp === undefined) return [];
    return Object.entries(state.credentials)
      .filter(([, rec]) => rec.app === owningApp)
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
    // No candidate for this bucket (unknown bucket, or its app has no
    // credentials registered): fall through to a single verification
    // attempt against an unusable pair, so the request still resolves
    // through the real 403 path instead of a bespoke shortcut. A valid
    // signature from a DIFFERENT app's credential never even reaches this
    // list, so it fails exactly the same way — same status, same body.
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

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { version: ownVersion });
    }

    if (url.pathname === '/_pcdev/health' || url.pathname.startsWith('/_pcdev/')) {
      const segments = url.pathname
        .split('/')
        .filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s));
      // segments[0] === '_pcdev'

      if (method === 'GET' && segments.length === 2 && segments[1] === 'health') {
        return json(res, 200, { version: ownVersion });
      }

      if (segments[1] === 'apps' && segments.length >= 3) {
        const app = segments[2];
        if (app === undefined || !isValidSegment(app)) return badSegment(res, app ?? '');

        if (method === 'PUT' && segments.length === 5 && segments[3] === 'buckets') {
          const name = segments[4];
          if (name === undefined || !isValidSegment(name)) return badSegment(res, name ?? '');
          return handlePutBucket(req, res, app, name);
        }

        if (method === 'PUT' && segments.length === 4 && segments[3] === 'credentials') {
          return handlePutCredentials(req, res, app);
        }

        if (method === 'DELETE' && segments.length === 3) {
          return handleDeleteApp(res, app);
        }
      }

      res.writeHead(404);
      res.end();
      return;
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

  readJsonFile(stateJsonPath, isBucketsState)
    .then((loaded) => {
      if (loaded) state = loaded;
      // A single, unambiguous line into the daemon's own stdio log once
      // actually bound and accepting connections — the daemon's own
      // portable evidence that exactly one instance is listening (tests
      // count occurrences of this line rather than inspecting OS processes,
      // whose command-line rendering/flags differ across platforms).
      server.listen(port, '127.0.0.1', () => {
        console.log(`[dev-emulators] buckets-main listening on 127.0.0.1:${String(port)}`);
      });
    })
    .catch((err: unknown) => {
      console.error('buckets-main: failed to load state', err);
      process.exit(1);
    });
}

main();
