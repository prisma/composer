/**
 * The S3-compatible object-storage contract (S5 § 1) — the wire-protocol
 * binding a consumer's `s3()` dependency requires, and the storage service's
 * `store` port will provide (D4). Mirrors `postgresContract`/`postgres()`
 * exactly: `satisfies` compares kind only, and the dependency's binding IS the
 * typed connection config (ADR-0015) — the app builds its own client.
 */
import type { Contract, DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';

export interface S3Config {
  readonly url: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export const s3Contract: Contract<'s3', S3Config> = Object.freeze({
  kind: 's3',
  __cmp: { url: '', bucket: '', accessKeyId: '', secretAccessKey: '' },
  satisfies: (required: Contract<'s3', unknown>) => required.kind === 's3',
});

export type S3Contract = typeof s3Contract;

/**
 * A consumer's dependency on an S3-compatible store. No `region` in the
 * binding — the server accepts whatever region string the client signed.
 */
export function s3(): DependencyEnd<S3Config, typeof s3Contract> {
  return dependency({
    type: 's3',
    connection: {
      params: {
        url: string(),
        bucket: string(),
        accessKeyId: string(),
        secretAccessKey: string(),
      },
      hydrate: (v): S3Config => v,
    },
    required: s3Contract,
  });
}
