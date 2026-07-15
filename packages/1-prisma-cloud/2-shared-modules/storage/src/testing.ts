/**
 * The local stand-in surface (spec § 7): boot the storage service against a
 * local Postgres without deploying. Runtime/bun code — kept out of the
 * authoring barrel and exposed only here, for a consumer's local dev and the
 * example's local smoke validation.
 */
export { createPgStore } from './pg-store.ts';
export type { StorageServer, StorageServerOptions } from './storage-server.ts';
export { startStorageServer } from './storage-server.ts';
