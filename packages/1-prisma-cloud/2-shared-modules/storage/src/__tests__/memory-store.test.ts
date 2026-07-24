/**
 * The `ObjectStore` contract at the store level — the exact semantics the D3
 * Postgres store must reproduce (ETag = quoted sha256 hex, range clamping,
 * prefix + token + maxKeys pagination, idempotent delete, buckets as
 * namespaces). Exercised here against the in-memory reference.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { MemoryObjectStore } from '@internal/s3-protocol';

const TEXT = new TextEncoder();
let store: MemoryObjectStore;

beforeEach(() => {
  store = new MemoryObjectStore();
});

test('put returns a quoted sha256-hex ETag of the bytes', async () => {
  const bytes = TEXT.encode('hello');
  const { etag } = await store.put('b', 'k', bytes);
  expect(etag).toBe(`"${createHash('sha256').update(bytes).digest('hex')}"`);
});

test('get of a missing key is null; head likewise', async () => {
  expect(await store.get('b', 'missing')).toBeNull();
  expect(await store.head('b', 'missing')).toBeNull();
});

describe('ranged get', () => {
  beforeEach(async () => {
    await store.put('b', 'k', TEXT.encode('0123456789'));
  });

  test('a closed range returns the slice and the TOTAL size', async () => {
    const got = await store.get('b', 'k', { range: { start: 2, end: 5 } });
    expect(new TextDecoder().decode(got?.bytes)).toBe('2345');
    expect(got?.size).toBe(10);
  });

  test('an open-ended range reads to the end', async () => {
    const got = await store.get('b', 'k', { range: { start: 7 } });
    expect(new TextDecoder().decode(got?.bytes)).toBe('789');
  });

  test('an end past the object is clamped', async () => {
    const got = await store.get('b', 'k', { range: { start: 8, end: 999 } });
    expect(new TextDecoder().decode(got?.bytes)).toBe('89');
  });
});

test('delete is idempotent — deleting a missing key does not throw', async () => {
  await store.delete('b', 'missing');
  await store.put('b', 'k', TEXT.encode('x'));
  await store.delete('b', 'k');
  expect(await store.head('b', 'k')).toBeNull();
});

test('buckets namespace keys — same key in two buckets is independent', async () => {
  await store.put('b1', 'k', TEXT.encode('one'));
  await store.put('b2', 'k', TEXT.encode('two'));
  expect(new TextDecoder().decode((await store.get('b1', 'k'))?.bytes)).toBe('one');
  expect(new TextDecoder().decode((await store.get('b2', 'k'))?.bytes)).toBe('two');
});

describe('list', () => {
  beforeEach(async () => {
    for (const k of ['s/a', 's/b', 's/c', 'other/d']) await store.put('b', k, TEXT.encode(k));
  });

  test('filters by prefix and sorts by key', async () => {
    const res = await store.list('b', { prefix: 's/' });
    expect(res.keys).toEqual(['s/a', 's/b', 's/c']);
    expect(res.isTruncated).toBe(false);
    expect(res.nextContinuationToken).toBeUndefined();
  });

  test('maxKeys truncates and hands back the last key as the token', async () => {
    const page1 = await store.list('b', { prefix: 's/', maxKeys: 2 });
    expect(page1.keys).toEqual(['s/a', 's/b']);
    expect(page1.isTruncated).toBe(true);
    const token = page1.nextContinuationToken;
    if (token === undefined) throw new Error('expected a continuation token');
    expect(token).toBe('s/b');

    const page2 = await store.list('b', { prefix: 's/', maxKeys: 2, continuationToken: token });
    expect(page2.keys).toEqual(['s/c']);
    expect(page2.isTruncated).toBe(false);
  });

  test('maxKeys larger than the result set is not truncated', async () => {
    const res = await store.list('b', { prefix: 's/', maxKeys: 100 });
    expect(res.keys).toEqual(['s/a', 's/b', 's/c']);
    expect(res.isTruncated).toBe(false);
  });
});
