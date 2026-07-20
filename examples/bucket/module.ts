import { module } from '@prisma/composer';
import { bucket } from '@prisma/composer-prisma-cloud';
import blobsService from './src/blobs/service.ts';

/**
 * The bucket example: a small blob-store app backed by a raw
 * `bucket()` resource (a Prisma Object Store bucket with minted S3 credentials).
 *
 * The blobs service declares `deps: { store: bucket() }` — the same `s3` kind
 * used by the storage module's `s3()` helper — so a raw bucket is a drop-in
 * wherever a storage emulator's store port would be wired.
 */
export default module('bucket-example', ({ provision }) => {
  const store = provision(bucket({ name: 'files' }));
  provision(blobsService, { deps: { store } });
});
