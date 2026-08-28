/**
 * The pack's identity constants — the ONE place each value lives, so
 * adopting Prisma ORM's own Better Auth extension later is a contained
 * swap. Import-light on purpose: the runtime side (authDb's pack
 * requirement, the store's schema qualification) reads these without
 * pulling the descriptor's migration-tools dependency into an app bundle.
 */
import contractJson from './contract.json' with { type: 'json' };

/** The extension pack id — also the contract-space id and the on-disk `migrations/<id>/` directory name. */
export const AUTH_PACK_ID = 'auth';

/** The Postgres schema the Better Auth tables live in (PSL namespace → PG schema). */
export const AUTH_SCHEMA = 'auth';

/** The emitted contract's head storage hash — what `authDb()`'s pack requirement pins. */
export const AUTH_PACK_HEAD_HASH: string = contractJson.storage.storageHash;
