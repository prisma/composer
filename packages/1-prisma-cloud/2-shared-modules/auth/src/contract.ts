/**
 * `@internal/auth`'s authoring surface: the three port contracts (`api`
 * public HTTP, `session` rpc, `admin` rpc), the wire record schemas, and the
 * dependency factories a consumer wires (`authApi()`, `jwtVerifier()`) plus
 * the module's own db claim (`authDb()`). arktype throughout; dates cross
 * the wire as ISO-8601 UTC strings (email's convention).
 */
import type { Contract, DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';
import { requiredPackHead } from '@internal/prisma-cloud';
// Type-only, and type-only it must stay: the value surface of ./prisma-next
// carries pg (node: imports), which this authoring barrel must never bundle.
import type { PnPostgresContract } from '@internal/prisma-cloud/prisma-next';
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

// ——— Port `api` — the public Better Auth surface ———

export interface AuthApiConfig {
  readonly url: string;
}

/**
 * The contract of the public auth surface. Kind-only `satisfies` (storage's
 * `s3Contract` shape); the `url` connection param is the compute service's
 * own producer output, resolved by name the way `streamsProviderContract`'s
 * is.
 */
export const authApiContract: Contract<'auth-api', AuthApiConfig> = Object.freeze({
  kind: 'auth-api',
  __cmp: { url: '' },
  satisfies: (required: Contract<'auth-api', unknown>) => required.kind === 'auth-api',
});

/** Thin URL-anchored client for the public surface — what `authProxy()` consumes. */
export interface AuthApiClient {
  readonly url: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** A consumer's dependency on the public auth surface. */
export function authApi(): DependencyEnd<AuthApiClient, typeof authApiContract> {
  return dependency({
    type: 'auth-api',
    connection: {
      params: { url: string() },
      hydrate: ({ url }): AuthApiClient => ({
        url,
        fetch: (path, init) => fetch(new URL(path, url), init),
      }),
    },
    required: authApiContract,
  });
}

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
 * keys (D15). jose caches the JWKS and refetches on an unknown `kid`.
 */
export function jwtVerifier(): DependencyEnd<JwtVerifier, typeof authApiContract> {
  return dependency({
    type: 'auth-api',
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
    required: authApiContract,
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
});

// ——— Db dependency — the service's claim on a pack-carrying database ———

/**
 * The auth service's claim on a PN-typed database that carries the auth pack
 * at the installed package's head. Hydrates to the bare `{ url }` — Better
 * Auth builds its own pool; no PN client.
 */
export function authDb(): DependencyEnd<{ url: string }, PnPostgresContract> {
  return dependency({
    type: 'prisma-next',
    connection: {
      params: { url: string() },
      hydrate: ({ url }) => ({ url }),
    },
    required: requiredPackHead({ packId: AUTH_PACK_ID, headHash: AUTH_PACK_HEAD_HASH }),
  });
}
