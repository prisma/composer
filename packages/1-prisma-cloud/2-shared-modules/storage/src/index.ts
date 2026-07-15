/**
 * `@internal/storage`'s authoring surface (S5): the S3-compatible object
 * storage contract, the `storage()` module, and its service node. The runtime
 * engine (handler, sigv4, pg-store, storage-server, storage-entrypoint) stays
 * OUT of this barrel — it is imported only by the entrypoint and tests, so a
 * consumer graph that imports this module never bundles a `bun`/`node:` token.
 */
export type { S3Config, S3Contract } from './contract.ts';
export { s3, s3Contract } from './contract.ts';
export { storage } from './storage-module.ts';
export { storageService } from './storage-service.ts';
