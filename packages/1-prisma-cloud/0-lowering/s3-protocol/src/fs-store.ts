/**
 * A disk-backed `ObjectStore` (local-dev spec § 1) — the bucket emulator's
 * backing, and independently the seam a developer can drop files into. Object
 * bytes live at `<bucketDir>/<key>`; a JSON sidecar at
 * `<bucketDir>/.meta/<key>.json` carries `{ contentType, etag }`. Writes go
 * temp-then-rename through `<bucketDir>/.tmp/<uuid>` so a concurrent read
 * never observes a partial object.
 *
 * `resolveBucketDir` maps a wire bucket name to its directory; `undefined`
 * means an unknown bucket. Reads of an unknown bucket degrade exactly like a
 * missing key (null / empty list / no-op delete) — from the wire handler's
 * point of view that IS the no-such-key 404 path, since path-style S3
 * addressing never distinguishes "no such bucket" from "no such key". A
 * write has no such graceful shape (there is nowhere to put the bytes), so
 * `put` throws. A syntactically invalid bucket name (the store's own
 * `/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/` check, independent of what the
 * resolver would say) is treated the same as "unknown".
 *
 * A malformed or escaping key (`..` segments, an absolute path, an empty
 * segment, or a segment literally `.meta`/`.tmp`) is a different failure: not
 * "this doesn't exist yet" but "this input is not a valid key at all", so
 * every operation given one throws rather than degrading.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  GetResult,
  HeadResult,
  ListOptions,
  ListResult,
  ObjectStore,
  PutResult,
} from './store.ts';

/** `list`'s default page size when the caller passes no `maxKeys` — exported so tests can pin it directly instead of inferring it from a large fixture. */
export const DEFAULT_MAX_KEYS = 1000;
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const TMP_DIR_NAME = '.tmp';
const META_DIR_NAME = '.meta';
const RESERVED_SEGMENTS = new Set([TMP_DIR_NAME, META_DIR_NAME]);
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

interface Sidecar {
  readonly contentType: string;
  readonly etag: string;
}

function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isEnoent(err: unknown): boolean {
  return isErrnoException(err) && err.code === 'ENOENT';
}

/**
 * Splits a key into its `/` segments, rejecting anything that could escape
 * the bucket dir or collide with the reserved `.tmp`/`.meta` namespaces:
 * `..` segments, an empty segment (leading/trailing/doubled `/`, which also
 * catches a leading-slash "absolute" key), or a segment literally `.tmp` or
 * `.meta` at any depth.
 */
function keySegments(key: string): readonly string[] {
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || RESERVED_SEGMENTS.has(segment)) {
      throw new Error(`invalid object key: "${key}"`);
    }
  }
  return segments;
}

/** `<bucketDir>/<key's segments>`, double-checked to still resolve inside `bucketDir`. */
function objectPath(bucketDir: string, key: string): string {
  const target = path.join(bucketDir, ...keySegments(key));
  const resolvedRoot = path.resolve(bucketDir) + path.sep;
  if (!(path.resolve(target) + path.sep).startsWith(resolvedRoot)) {
    throw new Error(`invalid object key: "${key}"`);
  }
  return target;
}

/** `<bucketDir>/.meta/<key's segments>.json` — mirrors `objectPath`'s tree under `.meta`. */
function sidecarPath(bucketDir: string, key: string): string {
  const segments = keySegments(key);
  const last = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  return path.join(bucketDir, META_DIR_NAME, ...dirs, `${last}.json`);
}

/** Write-temp-then-rename: never leaves a reader observing a partial file. */
async function writeAtomic(finalPath: string, tmpRoot: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(tmpRoot, { recursive: true });
  const tmpPath = path.join(tmpRoot, randomUUID());
  await fs.writeFile(tmpPath, bytes);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.rename(tmpPath, finalPath);
}

function isSidecar(value: unknown): value is Sidecar {
  return (
    typeof value === 'object' &&
    value !== null &&
    'contentType' in value &&
    typeof value.contentType === 'string' &&
    'etag' in value &&
    typeof value.etag === 'string'
  );
}

async function readSidecar(sidecar: string): Promise<Sidecar | null> {
  let raw: string;
  try {
    raw = await fs.readFile(sidecar, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isSidecar(parsed)) return parsed;
  } catch {
    // Falls through to treat a corrupt sidecar the same as a missing one —
    // dropped-file adoption already has to tolerate an absent sidecar, so
    // tolerating an unreadable one is the same policy, not a new one.
  }
  return null;
}

/** Read the object's bytes plus its metadata — adopting a sidecar-less file (dropped in by a developer) by computing and lazily persisting one. `null` when the object is missing. */
async function readObject(
  bucketDir: string,
  key: string,
): Promise<{ readonly bytes: Buffer; readonly meta: Sidecar } | null> {
  const target = objectPath(bucketDir, key);
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(target);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  const existing = await readSidecar(sidecarPath(bucketDir, key));
  if (existing) return { bytes, meta: existing };

  const meta: Sidecar = { contentType: DEFAULT_CONTENT_TYPE, etag: etagOf(bytes) };
  await writeAtomic(
    sidecarPath(bucketDir, key),
    path.join(bucketDir, TMP_DIR_NAME),
    Buffer.from(JSON.stringify(meta)),
  );
  return { bytes, meta };
}

/** Remove now-empty directories from `startDir` up to (never including) `root`. */
async function pruneEmptyDirs(root: string, startDir: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let dir = path.resolve(startDir);
  while (dir !== resolvedRoot && dir.startsWith(resolvedRoot + path.sep)) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if (isEnoent(err)) {
        dir = path.dirname(dir);
        continue;
      }
      throw err;
    }
    if (entries.length > 0) break;
    try {
      await fs.rmdir(dir);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    dir = path.dirname(dir);
  }
}

/** Recursively lists every object key under `dir`, skipping `.tmp`/`.meta` at any depth. */
async function walkKeys(dir: string): Promise<string[]> {
  const keys: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    for (const entry of entries) {
      if (RESERVED_SEGMENTS.has(entry.name)) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), rel);
      } else if (entry.isFile()) {
        keys.push(rel);
      }
    }
  }
  await walk(dir, '');
  return keys;
}

/**
 * A disk-backed `ObjectStore`: object bytes and a metadata sidecar under a
 * per-bucket directory the caller resolves. See the module doc for the
 * unknown-bucket / invalid-key failure shapes.
 */
export function fsStore(resolveBucketDir: (bucket: string) => string | undefined): ObjectStore {
  function resolveDir(bucket: string): string | undefined {
    if (!BUCKET_NAME_RE.test(bucket)) return undefined;
    return resolveBucketDir(bucket);
  }

  return {
    async put(
      bucket: string,
      key: string,
      bytes: Uint8Array,
      opts: { contentType?: string } = {},
    ): Promise<PutResult> {
      const dir = resolveDir(bucket);
      if (dir === undefined) throw new Error(`no such bucket: "${bucket}"`);
      const target = objectPath(dir, key);
      const tmpRoot = path.join(dir, TMP_DIR_NAME);
      const etag = etagOf(bytes);
      const contentType = opts.contentType ?? DEFAULT_CONTENT_TYPE;

      await writeAtomic(target, tmpRoot, bytes);
      await writeAtomic(
        sidecarPath(dir, key),
        tmpRoot,
        Buffer.from(JSON.stringify({ contentType, etag } satisfies Sidecar)),
      );
      return { etag };
    },

    async get(
      bucket: string,
      key: string,
      opts: { range?: { start: number; end?: number } } = {},
    ): Promise<GetResult | null> {
      const dir = resolveDir(bucket);
      if (dir === undefined) return null;
      const found = await readObject(dir, key);
      if (!found) return null;
      const { bytes, meta } = found;
      const size = bytes.byteLength;

      if (opts.range) {
        const start = opts.range.start;
        const end = opts.range.end === undefined ? size - 1 : Math.min(opts.range.end, size - 1);
        const slice = start > end ? new Uint8Array(0) : bytes.subarray(start, end + 1);
        return { bytes: slice, etag: meta.etag, contentType: meta.contentType, size };
      }
      return { bytes: new Uint8Array(bytes), etag: meta.etag, contentType: meta.contentType, size };
    },

    async head(bucket: string, key: string): Promise<HeadResult | null> {
      const dir = resolveDir(bucket);
      if (dir === undefined) return null;
      const found = await readObject(dir, key);
      if (!found) return null;
      return {
        etag: found.meta.etag,
        size: found.bytes.byteLength,
        contentType: found.meta.contentType,
      };
    },

    async delete(bucket: string, key: string): Promise<void> {
      const dir = resolveDir(bucket);
      if (dir === undefined) return;
      const target = objectPath(dir, key);
      const sidecar = sidecarPath(dir, key);

      try {
        await fs.unlink(target);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      try {
        await fs.unlink(sidecar);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      await pruneEmptyDirs(dir, path.dirname(target));
      await pruneEmptyDirs(path.join(dir, META_DIR_NAME), path.dirname(sidecar));
    },

    async list(bucket: string, opts: ListOptions = {}): Promise<ListResult> {
      const dir = resolveDir(bucket);
      if (dir === undefined) return { keys: [], isTruncated: false };

      const prefix = opts.prefix ?? '';
      const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
      const token = opts.continuationToken;

      const all = await walkKeys(dir);
      const matching = all
        .filter((key) => key.startsWith(prefix))
        .sort()
        .filter((key) => (token === undefined ? true : key > token));

      const page = matching.slice(0, maxKeys);
      const isTruncated = matching.length > maxKeys;
      const last = page.at(-1);
      return {
        keys: page,
        isTruncated,
        ...(isTruncated && last !== undefined ? { nextContinuationToken: last } : {}),
      };
    },
  };
}
