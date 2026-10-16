/**
 * `@internal/auth`'s authoring surface: the two rpc port contracts
 * (`session`, `admin`; the `api` port is raw HTTP), the wire record schemas,
 * the `jwtVerifier()` dependency a consumer wires, and the module's own db
 * claim (`authDb()`). arktype throughout; dates cross
 * the wire as ISO-8601 UTC strings (email's convention).
 */
import type { DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';
import { rawHttpContract } from '@internal/http';
import { requiredPackHead } from '@internal/prisma-cloud';
// Type-only, and type-only it must stay: the value surface of ./orm
// carries pg (node: imports), which this authoring barrel must never bundle.
import type { PostgresContract } from '@internal/prisma-cloud/orm';
import { contract, rpc } from '@internal/service-rpc';
import { type } from 'arktype';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { AUTH_PACK_HEAD_HASH, AUTH_PACK_ID } from './pack/constants.ts';

export const userRecord = type({
  id: 'string',
  email: 'string',
  emailVerified: 'boolean',
  name: 'string | null',
  image: 'string | null',
  role: 'string | null',
  banned: 'boolean',
  banReason: 'string | null',
  banExpiresAt: 'string | null',
  createdAt: 'string',
  updatedAt: 'string',
});

export const sessionRecord = type({
  id: 'string',
  userId: 'string',
  expiresAt: 'string',
  ipAddress: 'string | null',
  userAgent: 'string | null',
  createdAt: 'string',
  updatedAt: 'string',
});

export type UserRecord = typeof userRecord.infer;
export type SessionRecord = typeof sessionRecord.infer;

/**
 * Whether the browser surface accepts self-service sign-up. `'closed'` makes
 * Better Auth refuse `/sign-up/email` and a magic link for an unknown email;
 * accounts then come only from `admin.createUser`.
 */
export type SignUpMode = 'open' | 'closed';

// ——— jwtVerifier() — stateless verification over the instance's JWKS ———

export interface VerifiedSession {
  /** `sub` */
  readonly userId: string;
  /** `sid` */
  readonly sessionId: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** `exp` */
  readonly expiresAt: Date;
  /** The full verified payload. */
  readonly claims: Record<string, unknown>;
}

export interface JwtVerifier {
  /** Resolves null for ANY invalid token (bad signature, expired, malformed) — never throws on token content. */
  verify(token: string): Promise<VerifiedSession | null>;
}

/**
 * Token-content failures resolve `null`; anything else (JWKS fetch/timeout,
 * malformed JWKS response) is an operational error and throws. jose's
 * `JWKSNoMatchingKey` counts as token content — an unknown `kid` is a claim
 * the token makes about itself.
 */
function isInvalidTokenError(error: unknown): boolean {
  return (
    error instanceof errors.JOSEError &&
    !(error instanceof errors.JWKSTimeout) &&
    !(error instanceof errors.JWKSInvalid) &&
    !(error instanceof errors.JOSENotSupported)
  );
}

function claimString(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Stateless JWT verifier over the wired instance's JWKS. Signature +
 * `exp`/`nbf` only (30 s tolerance); no `iss`/`aud` — the verifier only
 * trusts keys fetched from the wired instance, and instances never share
 * keys. jose caches the JWKS and refetches on an unknown `kid`.
 */
export function jwtVerifier(): DependencyEnd<JwtVerifier, typeof rawHttpContract> {
  return dependency({
    type: 'http',
    connection: {
      params: { url: string() },
      hydrate: ({ url }): JwtVerifier => {
        const jwks = createRemoteJWKSet(new URL('/api/auth/jwks', url));
        return {
          verify: async (token) => {
            try {
              const { payload } = await jwtVerify(token, jwks, { clockTolerance: 30 });
              const userId = claimString(payload, 'sub');
              const sessionId = claimString(payload, 'sid');
              const email = claimString(payload, 'email');
              const emailVerified = payload['emailVerified'];
              // A signed token missing the session claims is still not a
              // session — token content, so null, not a throw.
              if (
                userId === undefined ||
                sessionId === undefined ||
                email === undefined ||
                typeof emailVerified !== 'boolean' ||
                typeof payload.exp !== 'number'
              ) {
                return null;
              }
              return {
                userId,
                sessionId,
                email,
                emailVerified,
                expiresAt: new Date(payload.exp * 1000),
                claims: payload,
              };
            } catch (error) {
              if (isInvalidTokenError(error)) return null;
              throw error;
            }
          },
        };
      },
    },
    required: rawHttpContract,
  });
}

// ——— Port `session` — consumer-facing online checks ———

export const authSessionContract = contract({
  getSession: rpc({
    input: type({ token: 'string' }),
    output: type({ session: sessionRecord.or('null'), user: userRecord.or('null') }),
  }),
  getUser: rpc({
    input: type({ id: 'string' }),
    output: type({ user: userRecord.or('null') }),
  }),
});

// ——— Port `admin` — the tier-1 admin path ———

export const authAdminContract = contract({
  findUser: rpc({
    input: type({ 'id?': 'string', 'email?': 'string' }),
    output: type({ user: userRecord.or('null') }),
  }),
  listUsers: rpc({
    input: type({
      'query?': 'string',
      'banned?': 'boolean',
      'cursor?': 'string',
      'limit?': '1<=number.integer<=200',
    }),
    output: type({ users: userRecord.array(), 'nextCursor?': 'string' }),
  }),
  listSessions: rpc({
    input: type({ userId: 'string' }),
    output: type({ sessions: sessionRecord.array() }),
  }),
  revokeSession: rpc({
    input: type({ sessionId: 'string' }),
    output: type({ revoked: 'boolean' }),
  }),
  revokeUserSessions: rpc({
    input: type({ userId: 'string' }),
    output: type({ revokedCount: 'number.integer' }),
  }),
  banUser: rpc({
    input: type({ userId: 'string', 'reason?': 'string', 'expiresAt?': 'string' }),
    output: type({ user: userRecord }),
  }),
  unbanUser: rpc({
    input: type({ userId: 'string' }),
    output: type({ user: userRecord }),
  }),
  createUser: rpc({
    input: type({
      // The two checks Better Auth's own sign-up applies, enforced here so
      // a caller mistake is a 400 at the rpc boundary, not a retried 500.
      email: 'string.email',
      name: 'string',
      'password?': '8 <= string <= 128',
      'emailVerified?': 'boolean',
    }),
    output: type({ user: userRecord }),
  }),
  setEmailVerified: rpc({
    input: type({ userId: 'string', emailVerified: 'boolean' }),
    output: type({ user: userRecord.or('null') }),
  }),
  removeUser: rpc({
    input: type({ userId: 'string' }),
    output: type({ removed: 'boolean' }),
  }),
});

// ——— Db dependency — the service's claim on a pack-carrying database ———

/**
 * The auth service's claim on a PN-typed database that carries the auth pack
 * at the installed package's head. Hydrates to the bare `{ url }` — Better
 * Auth builds its own pool; no PN client.
 */
export function authDb(): DependencyEnd<{ url: string }, PostgresContract> {
  return dependency({
    type: 'postgres',
    connection: {
      params: { url: string() },
      hydrate: ({ url }) => ({ url }),
    },
    required: requiredPackHead({ packId: AUTH_PACK_ID, headHash: AUTH_PACK_HEAD_HASH }),
  });
}
