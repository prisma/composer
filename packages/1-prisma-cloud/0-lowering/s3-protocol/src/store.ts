/**
 * The minimal object store the protocol handler drives — the seam between the
 * wire protocol (D2) and its backing (the Postgres bytea store, D3). Buckets
 * are namespaces: any bucket name is accepted and simply scopes keys. The
 * store owns the ETag (quoted SHA-256 hex of the object bytes).
 */

export interface PutResult {
  readonly etag: string;
}

export interface GetRange {
  readonly start: number;
  /** Inclusive end; omitted means "to the end of the object". */
  readonly end?: number;
}

export interface GetResult {
  /** The requested slice — the whole object when no range was given. */
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly contentType: string;
  /** TOTAL object size, for `Content-Range` — not the slice length. */
  readonly size: number;
}

export interface HeadResult {
  readonly etag: string;
  readonly size: number;
  readonly contentType: string;
}

export interface ListOptions {
  readonly prefix?: string;
  readonly continuationToken?: string;
  readonly maxKeys?: number;
}

export interface ListResult {
  readonly keys: readonly string[];
  readonly nextContinuationToken?: string;
  readonly isTruncated: boolean;
}

export interface ObjectStore {
  put(
    bucket: string,
    key: string,
    bytes: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<PutResult>;
  /** `null` when the key is missing. */
  get(bucket: string, key: string, opts?: { range?: GetRange }): Promise<GetResult | null>;
  /** `null` when the key is missing. */
  head(bucket: string, key: string): Promise<HeadResult | null>;
  /** Idempotent — deleting a missing key is not an error. */
  delete(bucket: string, key: string): Promise<void>;
  list(bucket: string, opts?: ListOptions): Promise<ListResult>;
}
