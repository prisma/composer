/**
 * The `session` + `admin` rpc handler maps, DB-direct over an `AuthStore`
 * (Better Auth's admin plugin authorizes via admin sessions; our ports
 * authorize via wiring, so the handlers never call `auth.api.*`). A later
 * dispatch wires these into `serve(authService(), ...)`; `createAuthHandlers`
 * takes its store already constructed, so everything here stays testable
 * without a running service.
 */

import { type AuthStore, decodeCursor, encodeCursor } from './auth-store.ts';
import type { SessionRecord, UserRecord } from './contract.ts';

const DEFAULT_LIST_LIMIT = 50;

export interface SessionHandlers {
  getSession(input: {
    token: string;
  }): Promise<{ session: SessionRecord | null; user: UserRecord | null }>;
  getUser(input: { id: string }): Promise<{ user: UserRecord | null }>;
}

export interface AdminHandlers {
  findUser(input: { id?: string; email?: string }): Promise<{ user: UserRecord | null }>;
  listUsers(input: {
    query?: string;
    banned?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<{ users: UserRecord[]; nextCursor?: string }>;
  listSessions(input: { userId: string }): Promise<{ sessions: SessionRecord[] }>;
  revokeSession(input: { sessionId: string }): Promise<{ revoked: boolean }>;
  revokeUserSessions(input: { userId: string }): Promise<{ revokedCount: number }>;
  banUser(input: {
    userId: string;
    reason?: string;
    expiresAt?: string;
  }): Promise<{ user: UserRecord }>;
  unbanUser(input: { userId: string }): Promise<{ user: UserRecord }>;
}

export interface AuthHandlers {
  readonly session: SessionHandlers;
  readonly admin: AdminHandlers;
}

export function createAuthHandlers(store: AuthStore): AuthHandlers {
  const session: SessionHandlers = {
    // One shape, no error (spec): absent token, expired session, and banned
    // owner all come back as { session: null, user: null }. This is the
    // instant-logout path — a revoked session is a deleted row.
    async getSession({ token }) {
      const found = await store.getSession(token);
      return found === null ? { session: null, user: null } : found;
    },

    // Placement on the consumer port is settled: profile rendering off a JWT
    // `sub` must not require admin wiring.
    async getUser({ id }) {
      return { user: await store.getUser({ id }) };
    },
  };

  const admin: AdminHandlers = {
    // Named findUser (not getUser): rpc dispatch is flat across a service's
    // ports, and session.getUser already owns that method name.
    async findUser({ id, email }) {
      if ((id === undefined) === (email === undefined)) {
        throw new Error('auth admin findUser: pass exactly one of id, email');
      }
      const user = await store.getUser(id !== undefined ? { id } : { email: email ?? '' });
      return { user };
    },

    async listUsers({ query, banned, cursor, limit }) {
      const page = await store.listUsers({
        ...(query !== undefined ? { query } : {}),
        ...(banned !== undefined ? { banned } : {}),
        ...(cursor !== undefined ? { after: decodeCursor(cursor) } : {}),
        limit: limit ?? DEFAULT_LIST_LIMIT,
      });
      const last = page.users.at(-1);
      return {
        users: [...page.users],
        ...(page.hasMore && last !== undefined
          ? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) }
          : {}),
      };
    },

    async listSessions({ userId }) {
      return { sessions: await store.listSessions(userId) };
    },

    async revokeSession({ sessionId }) {
      return { revoked: await store.revokeSession(sessionId) };
    },

    async revokeUserSessions({ userId }) {
      return { revokedCount: await store.revokeUserSessions(userId) };
    },

    async banUser({ userId, reason, expiresAt }) {
      const user = await store.banUser(userId, reason ?? null, expiresAt ?? null);
      if (user === null) {
        throw new Error(`auth admin banUser: no user with id "${userId}"`);
      }
      return { user };
    },

    async unbanUser({ userId }) {
      const user = await store.unbanUser(userId);
      if (user === null) {
        throw new Error(`auth admin unbanUser: no user with id "${userId}"`);
      }
      return { user };
    },
  };

  return { session, admin };
}
