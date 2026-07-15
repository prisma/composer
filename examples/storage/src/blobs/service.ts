import node from '@prisma/compose/node';
import { compute } from '@prisma/compose-prisma-cloud';
import { s3 } from '@prisma/compose-prisma-cloud/storage';

/**
 * The blob-store service: a plain HTTP app that stores and serves objects,
 * backed by the storage module. Its `store` slot is an `s3()` dependency, so
 * `load()` hands it the `S3Config` (endpoint URL, bucket, minted credentials);
 * the app builds its own aws-sdk client from that. The root wires the storage
 * module's `store` port into this slot.
 */
export default compute({
  name: 'blobs',
  deps: { store: s3() },
  build: node({ module: import.meta.url, entry: '../../dist/blobs/server.mjs' }),
});
