/**
 * `@internal/s3-protocol`'s surface: the S3-compatible wire protocol pieces
 * (spec local-dev § 1) — the `ObjectStore` contract, SigV4 verification and
 * key minting, the wire handler, and both `ObjectStore` implementations
 * (in-memory and disk-backed). Pure protocol: no server, no daemon, node
 * built-ins only.
 */

export { fsStore } from '../fs-store.ts';
export type { S3HandlerOptions } from '../handler.ts';
export { createS3Handler } from '../handler.ts';
export { MemoryObjectStore } from '../memory-store.ts';
export type { Credentials, VerifyResult } from '../sigv4.ts';
export { mintKeyPair, verifyRequest } from '../sigv4.ts';
export type {
  GetRange,
  GetResult,
  HeadResult,
  ListOptions,
  ListResult,
  ObjectStore,
  PutResult,
} from '../store.ts';
