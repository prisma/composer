import node from '@prisma/composer/node';
import { bucket, compute } from '@prisma/composer-prisma-cloud';

/**
 * The blob-store service: a plain HTTP app that stores and serves objects,
 * backed directly by a Prisma Object Store bucket. Its `store` slot is a
 * `bucket()` dependency — same `s3` contract kind as the storage module's
 * `s3()`, so `load()` hands it `{ url, bucket, accessKeyId, secretAccessKey }`.
 * The root wires the `bucket` resource's binding into this slot.
 */
export default compute({
  name: 'blobs',
  deps: { store: bucket() },
  build: node({ module: import.meta.url, entry: '../../dist/blobs/server.mjs' }),
});
