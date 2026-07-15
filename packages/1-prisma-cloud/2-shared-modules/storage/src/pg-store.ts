/**
 * The `ObjectStore` over Postgres `bytea` (spec § 3): one `objects` table,
 * single-row-per-object. Ranged reads use SQL `substring` so a range request
 * never detoasts the whole object. The schema is applied idempotently at init
 * behind a bounded connection retry — the first connect to a freshly
 * provisioned Postgres is rejected while the upstream is cold (FT-5226).
 *
 * Runtime engine code (`bun` SQL + `node:crypto`); NOT re-exported from the
 * authoring barrel.
 */
import { createHash } from 'node:crypto';
import { retryTransientConnect } from '@internal/prisma-cloud/connection';
import { SQL } from 'bun';
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

/** bytea comes back as a Node Buffer (a Uint8Array). Fail closed on anything else rather than returning wrong bytes. */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new TypeError(`expected bytea to decode as Uint8Array, got ${typeof value}`);
}

/** One row → GetResult (both the whole-object and ranged queries alias the payload as `bytes`; `size` is the bigint total). */
function toGetResult(row: {
  bytes: unknown;
  size: number | string;
  etag: string;
  content_type: string;
}): GetResult {
  return {
    bytes: toBytes(row.bytes),
    etag: row.etag,
    contentType: row.content_type,
    size: Number(row.size),
  };
}

class PgObjectStore implements ObjectStore {
  constructor(private readonly sql: SQL) {}

  async put(
    bucket: string,
    key: string,
    bytes: Uint8Array,
    opts: { contentType?: string } = {},
  ): Promise<PutResult> {
    const etag = etagOf(bytes);
    const contentType = opts.contentType ?? 'application/octet-stream';
    await this.sql`
      insert into objects (bucket, key, bytes, size, etag, content_type)
      values (${bucket}, ${key}, ${bytes}, ${bytes.byteLength}, ${etag}, ${contentType})
      on conflict (bucket, key) do update set
        bytes = excluded.bytes, size = excluded.size,
        etag = excluded.etag, content_type = excluded.content_type`;
    return { etag };
  }

  async get(
    bucket: string,
    key: string,
    opts: { range?: { start: number; end?: number } } = {},
  ): Promise<GetResult | null> {
    const range = opts.range;
    if (range) {
      const from = range.start + 1; // substring is 1-indexed
      const rows =
        range.end === undefined
          ? await this.sql`select substring(bytes from ${from}) as bytes, size, etag, content_type
                           from objects where bucket = ${bucket} and key = ${key}`
          : await this
              .sql`select substring(bytes from ${from} for ${range.end - range.start + 1}) as bytes,
                           size, etag, content_type
                           from objects where bucket = ${bucket} and key = ${key}`;
      const row = rows[0];
      return row === undefined ? null : toGetResult(row);
    }
    const rows = await this.sql`select bytes, size, etag, content_type
                                from objects where bucket = ${bucket} and key = ${key}`;
    const row = rows[0];
    return row === undefined ? null : toGetResult(row);
  }

  async head(bucket: string, key: string): Promise<HeadResult | null> {
    const rows = await this.sql`select size, etag, content_type
                                from objects where bucket = ${bucket} and key = ${key}`;
    const row = rows[0];
    if (row === undefined) return null;
    return { etag: row.etag, size: Number(row.size), contentType: row.content_type };
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.sql`delete from objects where bucket = ${bucket} and key = ${key}`;
  }

  async list(bucket: string, opts: ListOptions = {}): Promise<ListResult> {
    const prefix = opts.prefix ?? '';
    const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
    const token = opts.continuationToken;
    const limit = maxKeys + 1; // one extra row tells us whether more remain
    // starts_with is a literal prefix match — unlike LIKE, `_`/`%` in the prefix
    // are not wildcards, matching S3's literal-prefix semantics.
    const rows =
      token === undefined
        ? await this.sql`select key from objects
                         where bucket = ${bucket} and starts_with(key, ${prefix})
                         order by key limit ${limit}`
        : await this.sql`select key from objects
                         where bucket = ${bucket} and starts_with(key, ${prefix}) and key > ${token}
                         order by key limit ${limit}`;
    const keys: string[] = rows.map((r: { key: string }) => r.key);
    const isTruncated = keys.length > maxKeys;
    const page = isTruncated ? keys.slice(0, maxKeys) : keys;
    const last = page.at(-1);
    return {
      keys: page,
      isTruncated,
      ...(isTruncated && last !== undefined ? { nextContinuationToken: last } : {}),
    };
  }
}

/**
 * Connect (FT-5219 posture: `max: 1`, short `idleTimeout`), apply the schema
 * idempotently behind the cold-start retry, and return the store.
 */
export async function createPgStore(url: string): Promise<ObjectStore> {
  const sql = new SQL({ url, max: 1, idleTimeout: 10 });
  await retryTransientConnect(
    () => sql`
      create table if not exists objects (
        bucket text not null,
        key text not null,
        bytes bytea not null,
        size bigint not null,
        etag text not null,
        content_type text not null,
        created_at timestamptz not null default now(),
        primary key (bucket, key)
      )`,
  );
  return new PgObjectStore(sql);
}
