/**
 * `buildAuthOptions()` — the ONE Better Auth configuration, used by the
 * service entrypoint AND (S4) `createEmbeddedAuth`, so the two shapes stay
 * behaviorally identical (D13). Every option value here is pinned by the
 * spec (§ Better Auth configuration); change them there first.
 *
 * S1 email posture: no real sends. `sendEmail` is the seam — absent (the
 * deployed S1 service), each Better Auth send callback logs the pinned
 * message and returns; present (the testing export), the callback forwards
 * `{ purpose, to, url }` so local flows can read their live links. S2
 * replaces this seam with the email-module template sender and flips
 * `requireEmailVerification` to true.
 */
import type { BetterAuthOptions } from 'better-auth';
import { admin, bearer, jwt, magicLink } from 'better-auth/plugins';
import pg from 'pg';
import { AUTH_SCHEMA } from './pack/constants.ts';

/** One auth email touchpoint, as the S1 seam reports it. */
export interface AuthEmailEvent {
  readonly purpose: 'verification' | 'passwordReset' | 'magicLink';
  readonly to: string;
  /** The live link (verification / reset / magic). */
  readonly url: string;
}

/** The S1 send seam — the testing export captures through this; S2 replaces it with real template sends. */
export type AuthEmailSender = (event: AuthEmailEvent) => void | Promise<void>;

export interface AuthOptionsInputs {
  readonly databaseUrl: string;
  readonly secret: string;
  /** The PUBLIC origin of the consumer app (scheme+host, no trailing slash, no path) — D11. */
  readonly baseUrl: string;
  /** S1: absent in the deployed service (callbacks log and return); the testing export injects a capturing sender. */
  readonly sendEmail?: AuthEmailSender;
}

/**
 * The pool over the wired db url, with the target's connection-hardening
 * values reimplemented locally (the module may not import target
 * internals): bounded connect wait, short idle timeout (Prisma Postgres
 * closes idle direct connections well under 30 s), and an `error` listener —
 * the server closing an idle pooled client emits an async 'error' that
 * would otherwise crash the process; the pool already discards the dead
 * client and reconnects on the next acquire.
 */
function hardenedPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    // Better Auth is schema-unqualified; every query runs against the auth
    // schema via search_path — the same posture the conformance test pins.
    options: `-c search_path=${AUTH_SCHEMA}`,
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => console.error('pg pool idle client error', err));
  return pool;
}

export function buildAuthOptions(inputs: AuthOptionsInputs): BetterAuthOptions {
  const send = (purpose: AuthEmailEvent['purpose'], to: string, url: string): Promise<void> => {
    if (inputs.sendEmail === undefined) {
      // S1: delivery is not wired yet — never throw (a down mail path must
      // not brick signup); the pinned log line is the operational record.
      console.log(`auth: email delivery not wired (slice S2): ${purpose} for ${to}`);
      return Promise.resolve();
    }
    return Promise.resolve(inputs.sendEmail({ purpose, to, url }));
  };

  return {
    appName: 'auth',
    baseURL: inputs.baseUrl,
    basePath: '/api/auth',
    secret: inputs.secret,
    trustedOrigins: [inputs.baseUrl],
    database: hardenedPool(inputs.databaseUrl),
    emailAndPassword: {
      enabled: true,
      // S1: no real sends, so verification cannot complete — S2 flips this.
      requireEmailVerification: false,
      sendResetPassword: ({ user, url }) => send('passwordReset', user.email, url),
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendVerificationEmail: ({ user, url }) => send('verification', user.email, url),
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
    },
    // Better Auth's own defaults, stated explicitly so they are pinned.
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: true },
    // NO advanced.database.generateId override (spec erratum, verified at
    // better-auth 1.6.24): `generateId: false` DISABLES generation and
    // expects a database default the pack schema deliberately lacks —
    // signup fails with "Failed to create user". Omitting it gives the
    // spec's stated intent: Better Auth's default generator, text ids.
    plugins: [
      jwt({ jwt: { expirationTime: '15m' }, jwks: {} }),
      bearer(),
      admin(),
      magicLink({
        sendMagicLink: ({ email, url }) => send('magicLink', email, url),
        expiresIn: 300,
        disableSignUp: false,
      }),
    ],
  };
}
