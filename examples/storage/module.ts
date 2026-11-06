import { appRoot } from '@prisma/composer';
import { storage } from '@prisma/composer-prisma-cloud/storage';
import blobsService from './src/blobs/service.ts';

/**
 * The storage example: a small blob store/serve app backed by the `storage()`
 * module. The module owns its Postgres, its minted S3 credentials, and the
 * s3-store service; the `blobs` app wires the module's `store` port into its
 * own `s3()` slot, so it talks to the store over the store's HTTP endpoint with
 * credentials that arrive through the binding.
 *
 * A closed root: no boundary argument, no return — it only provisions.
 */
export default appRoot('storage-example', ({ provision }) => {
  const store = provision(storage());
  provision(blobsService, { deps: { store: store.store } });
});
