import type { Contract, DependencyEnd, ResourceNode } from '@internal/core';
import { dependency, resource, string } from '@internal/core';

export interface BucketConfig {
  readonly url: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The contract a provisioned Bucket provides — deliberately kind-equal to the
 * storage module's `s3Contract` (`kind: 's3'`). `satisfies` compares KIND,
 * not identity (mirrors `rawPostgresContract`): a real bucket and the emulator
 * are interchangeable at every `s3()` dependency slot. Cross-layer import of
 * the storage module's contract is not allowed (layering: 2-shared-modules
 * depends on 1-extensions, not the reverse), which is exactly the design
 * rationale for kind-equality — the two contracts cooperate through their
 * shared kind string, not through object identity.
 */
export const bucketContract: Contract<'s3', BucketConfig> = Object.freeze({
  kind: 's3',
  __cmp: { url: '', bucket: '', accessKeyId: '', secretAccessKey: '' },
  satisfies: (required: Contract<'s3', unknown>) => required.kind === 's3',
});

/**
 * The one Bucket factory; the argument shape picks the role.
 *
 * `{ name }` — the resource identity a module provisions: the ONE place the
 * bucket exists, providing `bucketContract`. Return type declared explicitly
 * so nothing widens.
 */
export function bucket(opts: { name: string }): ResourceNode<typeof bucketContract>;
/**
 * `bucket()` — a service's dependency on a real bucket. Its binding (what
 * `load()` returns) is the typed connection config `BucketConfig` itself —
 * `{ url, bucket, accessKeyId, secretAccessKey }`. The app constructs its own
 * S3 client from that config (ADR-0015). The kind `'s3'` makes this slot
 * interchangeable with the storage emulator's `s3()` dependency: any provider
 * whose contract has `kind === 's3'` — whether a real bucket or the emulator
 * — will wire here.
 */
export function bucket(): DependencyEnd<BucketConfig, typeof bucketContract>;
export function bucket(opts?: {
  name: string;
}): ResourceNode<typeof bucketContract> | DependencyEnd<BucketConfig, typeof bucketContract> {
  if (opts?.name !== undefined) {
    return resource({
      name: opts.name,
      extension: '@prisma/composer-prisma-cloud',
      provides: bucketContract,
    });
  }
  return dependency({
    type: 's3',
    connection: {
      params: {
        url: string(),
        bucket: string(),
        accessKeyId: string(),
        secretAccessKey: string(),
      },
      // The binding IS the typed config: hydrate is the identity on its values.
      // The app constructs its own S3 client.
      hydrate: (v): BucketConfig => v,
    },
    required: bucketContract,
  });
}
