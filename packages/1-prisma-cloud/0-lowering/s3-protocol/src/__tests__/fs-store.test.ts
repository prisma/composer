/**
 * `fsStore`'s contract (local-dev spec § 1): object bytes + a metadata
 * sidecar under a per-bucket directory, dropped-file adoption, path-escape
 * and bucket-name rejection, list pagination, and delete's empty-dir
 * pruning. Driven directly against the returned `ObjectStore`, against a
 * real temp directory — no server involved.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MAX_KEYS, fsStore } from '../fs-store.ts';
import type { ObjectStore } from '../store.ts';

const TEXT = new TextEncoder();
const BUCKET = 'my-bucket';

let root: string;
let bucketDir: string;
let store: ObjectStore;

function resolver(name: string): string | undefined {
  return name === BUCKET ? bucketDir : undefined;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-s3-protocol-'));
  bucketDir = path.join(root, 'bucket');
  fs.mkdirSync(bucketDir, { recursive: true });
  store = fsStore(resolver);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('put returns a quoted sha256-hex ETag and get round-trips the bytes', async () => {
  const bytes = TEXT.encode('hello world');
  const { etag } = await store.put(BUCKET, 'k', bytes, { contentType: 'text/plain' });
  expect(etag).toBe(`"${createHash('sha256').update(bytes).digest('hex')}"`);

  const got = await store.get(BUCKET, 'k');
  expect(got).not.toBeNull();
  expect(new TextDecoder().decode(got?.bytes)).toBe('hello world');
  expect(got?.etag).toBe(etag);
  expect(got?.contentType).toBe('text/plain');
  expect(got?.size).toBe(bytes.byteLength);
});

test('put writes bytes at <bucketDir>/<key> and a sidecar at <bucketDir>/.meta/<key>.json', async () => {
  await store.put(BUCKET, 'a/b/c', TEXT.encode('x'), { contentType: 'text/plain' });
  expect(fs.existsSync(path.join(bucketDir, 'a/b/c'))).toBe(true);
  const sidecar = JSON.parse(fs.readFileSync(path.join(bucketDir, '.meta/a/b/c.json'), 'utf8'));
  expect(sidecar.contentType).toBe('text/plain');
  expect(typeof sidecar.etag).toBe('string');
});

test('content-type defaults to application/octet-stream', async () => {
  await store.put(BUCKET, 'k', TEXT.encode('x'));
  const got = await store.get(BUCKET, 'k');
  expect(got?.contentType).toBe('application/octet-stream');
});

describe('dropped-file adoption', () => {
  test('a file with no sidecar is a valid object: default content-type, computed etag, sidecar written lazily', async () => {
    const bytes = TEXT.encode('dropped in by hand');
    fs.writeFileSync(path.join(bucketDir, 'dropped'), bytes);
    expect(fs.existsSync(path.join(bucketDir, '.meta/dropped.json'))).toBe(false);

    const got = await store.get(BUCKET, 'dropped');
    expect(got).not.toBeNull();
    expect(got?.contentType).toBe('application/octet-stream');
    expect(got?.etag).toBe(`"${createHash('sha256').update(bytes).digest('hex')}"`);

    expect(fs.existsSync(path.join(bucketDir, '.meta/dropped.json'))).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(path.join(bucketDir, '.meta/dropped.json'), 'utf8'));
    expect(sidecar.etag).toBe(got?.etag);
  });

  test('head() also adopts a sidecar-less file', async () => {
    fs.writeFileSync(path.join(bucketDir, 'dropped'), TEXT.encode('abc'));
    const head = await store.head(BUCKET, 'dropped');
    expect(head?.size).toBe(3);
    expect(head?.contentType).toBe('application/octet-stream');
    expect(fs.existsSync(path.join(bucketDir, '.meta/dropped.json'))).toBe(true);
  });
});

describe('ranged get', () => {
  beforeEach(async () => {
    await store.put(BUCKET, 'k', TEXT.encode('0123456789'));
  });

  test('a closed range returns the slice and the TOTAL size', async () => {
    const got = await store.get(BUCKET, 'k', { range: { start: 2, end: 5 } });
    expect(new TextDecoder().decode(got?.bytes)).toBe('2345');
    expect(got?.size).toBe(10);
  });

  test('an open-ended range reads to the end', async () => {
    const got = await store.get(BUCKET, 'k', { range: { start: 7 } });
    expect(new TextDecoder().decode(got?.bytes)).toBe('789');
  });
});

test('get/head of a missing key is null', async () => {
  expect(await store.get(BUCKET, 'missing')).toBeNull();
  expect(await store.head(BUCKET, 'missing')).toBeNull();
});

describe('unknown bucket', () => {
  test('get/head/list degrade gracefully; delete is a no-op', async () => {
    expect(await store.get('no-such-bucket', 'k')).toBeNull();
    expect(await store.head('no-such-bucket', 'k')).toBeNull();
    expect(await store.list('no-such-bucket')).toEqual({ keys: [], isTruncated: false });
    await expect(store.delete('no-such-bucket', 'k')).resolves.toBeUndefined();
  });

  test('put throws — there is nowhere to write the bytes', async () => {
    await expect(store.put('no-such-bucket', 'k', TEXT.encode('x'))).rejects.toThrow();
  });
});

describe('bucket name validation', () => {
  test('a syntactically invalid bucket name is treated as unknown', async () => {
    expect(await store.get('UP', 'k')).toBeNull();
    expect(await store.get('ab', 'k')).toBeNull(); // too short
    await expect(store.put('UP', 'k', TEXT.encode('x'))).rejects.toThrow();
  });
});

describe('path-escape rejection', () => {
  const badKeys = [
    '../evil',
    'a/../../evil',
    '/etc/passwd',
    'a//b',
    'a/.meta/b',
    '.tmp/x',
    'a/.tmp',
  ];

  for (const key of badKeys) {
    test(`put rejects the key "${key}"`, async () => {
      await expect(store.put(BUCKET, key, TEXT.encode('x'))).rejects.toThrow();
    });

    test(`get rejects the key "${key}"`, async () => {
      await expect(store.get(BUCKET, key)).rejects.toThrow();
    });
  }

  test('no file ever lands outside the bucket dir for a rejected key', async () => {
    await expect(store.put(BUCKET, '../escaped', TEXT.encode('x'))).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'escaped'))).toBe(false);
  });
});

describe('list', () => {
  beforeEach(async () => {
    for (const k of ['s/a', 's/b', 's/c', 'other/d']) await store.put(BUCKET, k, TEXT.encode(k));
  });

  test('filters by prefix and sorts lexicographically', async () => {
    const res = await store.list(BUCKET, { prefix: 's/' });
    expect(res.keys).toEqual(['s/a', 's/b', 's/c']);
    expect(res.isTruncated).toBe(false);
    expect(res.nextContinuationToken).toBeUndefined();
  });

  test('maxKeys truncates and hands back the last key as the continuation token', async () => {
    const page1 = await store.list(BUCKET, { prefix: 's/', maxKeys: 2 });
    expect(page1.keys).toEqual(['s/a', 's/b']);
    expect(page1.isTruncated).toBe(true);
    const token = page1.nextContinuationToken;
    if (token === undefined) throw new Error('expected a continuation token');
    expect(token).toBe('s/b');

    const page2 = await store.list(BUCKET, { prefix: 's/', maxKeys: 2, continuationToken: token });
    expect(page2.keys).toEqual(['s/c']);
    expect(page2.isTruncated).toBe(false);
  });

  test('maxKeys defaults to DEFAULT_MAX_KEYS (1000), not merely "big enough for this fixture"', async () => {
    expect(DEFAULT_MAX_KEYS).toBe(1000);

    const implicit = await store.list(BUCKET, { prefix: 's/' });
    expect(implicit.keys).toEqual(['s/a', 's/b', 's/c']);
    expect(implicit.isTruncated).toBe(false);

    // Passing the constant explicitly must behave identically to omitting
    // it — proving the default really is DEFAULT_MAX_KEYS, not some other
    // value that merely happens to exceed this fixture's 3 keys.
    const explicit = await store.list(BUCKET, { prefix: 's/', maxKeys: DEFAULT_MAX_KEYS });
    expect(explicit).toEqual(implicit);
  });

  test('list never descends into .tmp or .meta', async () => {
    const res = await store.list(BUCKET, {});
    expect(res.keys.every((k) => !k.includes('.tmp') && !k.includes('.meta'))).toBe(true);
  });
});

describe('delete', () => {
  test('removes the object and its sidecar, and is idempotent for a missing key', async () => {
    await store.put(BUCKET, 'k', TEXT.encode('x'));
    await store.delete(BUCKET, 'k');
    expect(await store.head(BUCKET, 'k')).toBeNull();
    expect(fs.existsSync(path.join(bucketDir, '.meta/k.json'))).toBe(false);
    await expect(store.delete(BUCKET, 'k')).resolves.toBeUndefined();
  });

  test('prunes now-empty parent directories up to (not including) the bucket dir', async () => {
    await store.put(BUCKET, 'a/b/c/obj', TEXT.encode('x'));
    await store.delete(BUCKET, 'a/b/c/obj');

    expect(fs.existsSync(path.join(bucketDir, 'a'))).toBe(false);
    expect(fs.existsSync(bucketDir)).toBe(true);
    expect(fs.existsSync(path.join(bucketDir, '.meta/a'))).toBe(false);
    expect(fs.existsSync(path.join(bucketDir, '.meta'))).toBe(true);
  });

  test('does not prune a directory a sibling object still occupies', async () => {
    await store.put(BUCKET, 'a/one', TEXT.encode('x'));
    await store.put(BUCKET, 'a/two', TEXT.encode('y'));
    await store.delete(BUCKET, 'a/one');

    expect(fs.existsSync(path.join(bucketDir, 'a'))).toBe(true);
    expect(fs.existsSync(path.join(bucketDir, 'a/two'))).toBe(true);
  });
});

test('writes are temp-then-rename: a concurrent read never observes a partial object', async () => {
  const oldBytes = nodeRandomBytes(2_000_000);
  const newBytes = nodeRandomBytes(3_000_000);
  await store.put(BUCKET, 'big', oldBytes);

  const putDone = store.put(BUCKET, 'big', newBytes);
  const reads = await Promise.all(Array.from({ length: 25 }, () => store.get(BUCKET, 'big')));
  await putDone;

  for (const read of reads) {
    if (read === null) throw new Error('expected the object to exist');
    expect([oldBytes.byteLength, newBytes.byteLength]).toContain(read.bytes.byteLength);
  }

  const tmpDir = path.join(bucketDir, '.tmp');
  const leftovers = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
  expect(leftovers).toEqual([]);
});
