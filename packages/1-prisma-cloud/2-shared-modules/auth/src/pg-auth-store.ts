/**
 * The `AuthStore` over Postgres — parameterized SQL against the auth schema,
 * every table reference qualified through the ONE `AUTH_SCHEMA` constant
 * (`"user"` is a reserved word, hence the quoting throughout). No schema
 * work at boot: the deploy migrated and marker-signed the auth space before
 * this process exists. Writes are confined to `session` deletes and the
 * three ban columns.
 *
 * Runtime engine code (Bun's `SQL`); NOT re-exported from the authoring
 * barrel.
 */
import { SQL } from 'bun';
import {
  type AuthStore,
  escapeLike,
  isEffectivelyBanned,
  type ListUsersFilters,
  type ListUsersPage,
  type UserSelector,
} from './auth-store.ts';
import type { SessionRecord, UserRecord } from './contract.ts';
import { AUTH_SCHEMA } from './pack/constants.ts';

const USER_TABLE = `"${AUTH_SCHEMA}"."user"`;
const SESSION_TABLE = `"${AUTH_SCHEMA}"."session"`;

/**
 * The effective-ban predicate in SQL — must agree with
 * `isEffectivelyBanned` (auth-store.ts).
 */
// `is true` (not `= true`): the column is nullable, and `not (null = true)`
// is NULL in SQL's three-valued logic — a plain `= true` would silently drop
// never-banned users from a `banned: false` filter.
const BANNED_SQL = `(banned is true and ("banExpires" is null or "banExpires" > now()))`;

interface PgUserRow {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly image: string | null;
  readonly role: string | null;
  readonly banned: boolean | null;
  readonly banReason: string | null;
  readonly banExpires: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

interface PgSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: unknown;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

/** timestamptz comes back as a Date; fail closed on anything else. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  throw new TypeError(`expected timestamptz to decode as a Date, got ${typeof value}`);
}

function toNullableIso(value: unknown): string | null {
  return value === null ? null : toIso(value);
}

function toUserRecord(row: PgUserRow): UserRecord {
  const banExpiresAt = toNullableIso(row.banExpires);
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.emailVerified,
    name: row.name,
    image: row.image,
    role: row.role,
    banned: isEffectivelyBanned({ banned: row.banned, banExpiresAt }),
    banReason: row.banReason,
    banExpiresAt,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toSessionRecord(row: PgSessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: toIso(row.expiresAt),
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

class PgAuthStore implements AuthStore {
  constructor(private readonly sql: SQL) {}

  async getSession(token: string): Promise<{ session: SessionRecord; user: UserRecord } | null> {
    const sessions = await this.sql.unsafe<PgSessionRow[]>(
      `select * from ${SESSION_TABLE} where token = $1 and "expiresAt" > now()`,
      [token],
    );
    const sessionRow = sessions[0];
    if (sessionRow === undefined) return null;

    // A currently-banned owner makes the session unusable — same null shape
    // as an unknown or expired token, no error (spec § session semantics).
    const users = await this.sql.unsafe<PgUserRow[]>(
      `select * from ${USER_TABLE} where id = $1 and not ${BANNED_SQL}`,
      [sessionRow.userId],
    );
    const userRow = users[0];
    if (userRow === undefined) return null;

    return { session: toSessionRecord(sessionRow), user: toUserRecord(userRow) };
  }

  async getUser(selector: UserSelector): Promise<UserRecord | null> {
    const rows =
      'id' in selector
        ? await this.sql.unsafe<PgUserRow[]>(`select * from ${USER_TABLE} where id = $1`, [
            selector.id,
          ])
        : await this.sql.unsafe<PgUserRow[]>(
            `select * from ${USER_TABLE} where lower(email) = lower($1)`,
            [selector.email],
          );
    const row = rows[0];
    return row === undefined ? null : toUserRecord(row);
  }

  async listUsers(filters: ListUsersFilters): Promise<ListUsersPage> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.query !== undefined) {
      params.push(`%${escapeLike(filters.query)}%`);
      conditions.push(`(email ilike $${params.length} or name ilike $${params.length})`);
    }
    if (filters.banned !== undefined) {
      conditions.push(filters.banned ? BANNED_SQL : `not ${BANNED_SQL}`);
    }
    if (filters.after !== undefined) {
      params.push(filters.after.createdAt, filters.after.id);
      const createdAtIdx = params.length - 1;
      const idIdx = params.length;
      conditions.push(`("createdAt", id) < ($${createdAtIdx}::timestamptz, $${idIdx})`);
    }

    const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
    params.push(filters.limit + 1); // one extra row tells us whether more remain
    const limitIdx = params.length;

    const rows = await this.sql.unsafe<PgUserRow[]>(
      `select * from ${USER_TABLE} ${where} order by "createdAt" desc, id desc limit $${limitIdx}`,
      params,
    );
    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    return { users: page.map(toUserRecord), hasMore };
  }

  async listSessions(userId: string): Promise<SessionRecord[]> {
    const rows = await this.sql.unsafe<PgSessionRow[]>(
      `select * from ${SESSION_TABLE} where "userId" = $1 order by "createdAt" desc, id desc`,
      [userId],
    );
    return rows.map(toSessionRecord);
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const rows = await this.sql.unsafe<{ id: string }[]>(
      `delete from ${SESSION_TABLE} where id = $1 returning id`,
      [sessionId],
    );
    return rows.length > 0;
  }

  async revokeUserSessions(userId: string): Promise<number> {
    const rows = await this.sql.unsafe<{ id: string }[]>(
      `delete from ${SESSION_TABLE} where "userId" = $1 returning id`,
      [userId],
    );
    return rows.length;
  }

  async banUser(
    userId: string,
    reason: string | null,
    expiresAt: string | null,
  ): Promise<UserRecord | null> {
    // Ban implies revoke, atomically: a crash between the two must not leave
    // a banned user with live sessions.
    return this.sql.begin(async (tx) => {
      const rows = await tx.unsafe<PgUserRow[]>(
        `update ${USER_TABLE}
         set banned = true, "banReason" = $2, "banExpires" = $3, "updatedAt" = now()
         where id = $1
         returning *`,
        [userId, reason, expiresAt],
      );
      const row = rows[0];
      if (row === undefined) return null;
      await tx.unsafe(`delete from ${SESSION_TABLE} where "userId" = $1`, [userId]);
      return toUserRecord(row);
    });
  }

  async unbanUser(userId: string): Promise<UserRecord | null> {
    const rows = await this.sql.unsafe<PgUserRow[]>(
      `update ${USER_TABLE}
       set banned = false, "banReason" = null, "banExpires" = null, "updatedAt" = now()
       where id = $1
       returning *`,
      [userId],
    );
    const row = rows[0];
    return row === undefined ? null : toUserRecord(row);
  }
}

/** Own pool over the wired db url (`max: 1`, email's cold-start posture). */
export function createPgAuthStore(url: string): AuthStore {
  return new PgAuthStore(new SQL({ url, max: 1, idleTimeout: 10 }));
}
