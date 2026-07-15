/**
 * An in-memory `ObjectStore` for the protocol tests — the same contract the
 * Postgres store (D3) implements. Test-only; never wired into a deployed
 * service. Not re-exported from the authoring barrel.
 */
import { createHash } from 'node:crypto';
import type {
  GetResult,
  HeadResult,
  ListOptions,
  ListResult,
  ObjectStore,
  PutResult,
} from './store.ts';

const DEFAULT_MAX_KEYS = 1000;

function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}

interface Entry {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly contentType: string;
}

export class MemoryObjectStore implements ObjectStore {
  private readonly entries = new Map<string, Entry>();

  private id(bucket: string, key: string): string {
    return `${bucket}\x00${key}`;
  }

  async put(
    bucket: string,
    key: string,
    bytes: Uint8Array,
    opts: { contentType?: string } = {},
  ): Promise<PutResult> {
    const copy = bytes.slice();
    const etag = etagOf(copy);
    this.entries.set(this.id(bucket, key), {
      bytes: copy,
      etag,
      contentType: opts.contentType ?? 'application/octet-stream',
    });
    return { etag };
  }

  async get(
    bucket: string,
    key: string,
    opts: { range?: { start: number; end?: number } } = {},
  ): Promise<GetResult | null> {
    const entry = this.entries.get(this.id(bucket, key));
    if (!entry) return null;
    const size = entry.bytes.byteLength;
    if (opts.range) {
      const start = opts.range.start;
      const end = opts.range.end === undefined ? size - 1 : Math.min(opts.range.end, size - 1);
      const slice = start > end ? new Uint8Array(0) : entry.bytes.slice(start, end + 1);
      return { bytes: slice, etag: entry.etag, contentType: entry.contentType, size };
    }
    return { bytes: entry.bytes.slice(), etag: entry.etag, contentType: entry.contentType, size };
  }

  async head(bucket: string, key: string): Promise<HeadResult | null> {
    const entry = this.entries.get(this.id(bucket, key));
    if (!entry) return null;
    return { etag: entry.etag, size: entry.bytes.byteLength, contentType: entry.contentType };
  }

  async delete(bucket: string, key: string): Promise<void> {
    this.entries.delete(this.id(bucket, key));
  }

  async list(bucket: string, opts: ListOptions = {}): Promise<ListResult> {
    const prefix = opts.prefix ?? '';
    const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
    const token = opts.continuationToken;
    const prefixHit = `${bucket}\x00${prefix}`;
    const matching = [...this.entries.keys()]
      .filter((id) => id.startsWith(prefixHit))
      .map((id) => id.slice(bucket.length + 1))
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
  }
}
