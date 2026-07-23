/**
 * The `AuthStore` behind the `session`/`admin` port handlers — DB-direct SQL
 * against the auth schema, one method per port operation. Row→record
 * mapping (Date → ISO string, `banExpires` column → `banExpiresAt` field,
 * effective-ban applied to `banned`) happens in the implementation, in one
 * place; this module also owns the pieces both sides share: the effective-ban
 * predicate, the keyset cursor codec, and the ILIKE escaping.
 */
import type { SessionRecord, UserRecord } from './contract.ts';

/** `getUser`'s exactly-one-of selector (both ports; email match is case-insensitive). */
export type UserSelector = { readonly id: string } | { readonly email: string };

/** The decoded form of an opaque `listUsers` cursor: the `(createdAt, id)` keyset position. */
export interface UserCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface ListUsersFilters {
  /** ILIKE `%query%` against email OR name (escaped — see {@link escapeLike}). */
  readonly query?: string;
  /** Filters on the EFFECTIVE ban state, both ways. */
  readonly banned?: boolean;
  /** Keyset position to resume after (`createdAt DESC, id DESC` order). */
  readonly after?: UserCursor;
  readonly limit: number;
}

export interface ListUsersPage {
  /** Newest-first (`createdAt desc, id desc`), already trimmed to `limit`. */
  readonly users: readonly UserRecord[];
  readonly hasMore: boolean;
}

export interface AuthStore {
  /**
   * The session lookup behind `session.getSession`: `null` when the token is
   * unknown, the session is expired, or the owning user is effectively
   * banned — one shape, no error. A revoked session is a deleted row, so
   * this is also the instant-logout read.
   */
  getSession(token: string): Promise<{ session: SessionRecord; user: UserRecord } | null>;
  /** By primary key or case-insensitive email equality; `null` when absent. */
  getUser(selector: UserSelector): Promise<UserRecord | null>;
  listUsers(filters: ListUsersFilters): Promise<ListUsersPage>;
  listSessions(userId: string): Promise<SessionRecord[]>;
  /** DELETE by id; `false` = no such session (idempotent). */
  revokeSession(sessionId: string): Promise<boolean>;
  /** DELETE all the user's sessions; returns the count (idempotent). */
  revokeUserSessions(userId: string): Promise<number>;
  /**
   * Sets the ban columns AND deletes all the user's sessions, atomically
   * (ban implies revoke). `null` when the user is absent.
   */
  banUser(
    userId: string,
    reason: string | null,
    expiresAt: string | null,
  ): Promise<UserRecord | null>;
  /** Clears the three ban columns; revokes nothing. `null` when absent. */
  unbanUser(userId: string): Promise<UserRecord | null>;
}

/**
 * The effective-ban predicate (used by `userRecord.banned`, `getSession`,
 * and `listUsers`' banned filter): banned AND the ban has not lapsed.
 * `pg-auth-store.ts` mirrors this in SQL — the two must agree.
 */
export function isEffectivelyBanned(row: {
  readonly banned: boolean | null;
  readonly banExpiresAt: string | null;
}): boolean {
  if (row.banned !== true) return false;
  return row.banExpiresAt === null || new Date(row.banExpiresAt).getTime() > Date.now();
}

/** Not documented to consumers as parseable — treat the string as opaque outside this pair. */
export function encodeCursor(cursor: UserCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf-8').toString('base64url');
}

export function decodeCursor(value: string): UserCursor {
  const decoded = Buffer.from(value, 'base64url').toString('utf-8');
  const separatorIndex = decoded.indexOf('|');
  if (separatorIndex === -1) {
    throw new Error(`invalid listUsers cursor: ${value}`);
  }
  return {
    createdAt: decoded.slice(0, separatorIndex),
    id: decoded.slice(separatorIndex + 1),
  };
}

/** Escapes `%`, `_`, and `\` so a `query` filter matches them literally inside `ILIKE '%'||q||'%'`. */
export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
