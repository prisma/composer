/**
 * `buildAuthOptions()` — the ONE Better Auth configuration, used by the
 * service entrypoint AND (eventually) `createEmbeddedAuth`, so the two
 * shapes stay behaviorally identical. Every option value here is pinned by
 * the spec (§ Better Auth configuration); change them there first.
 *
 * Email posture: every Better Auth send callback calls the matching `email`
 * template method (`email.verification`/`.passwordReset`/`.magicLink`) with a
 * deterministic idempotency key, so a Better Auth retry of the same event
 * dedups to one outbox row instead of minting a second one. A callback never
 * throws: `safeLink`'s origin check, template validation, and the send RPC
 * itself are all wrapped in one try/catch — Better Auth treats a callback
 * throw as a request failure, and a down mail path (or an off-origin link)
 * must not brick signup/reset/magic-link. `requireEmailVerification: true`:
 * real delivery is what makes that setting usable at all.
 */
import type { EmailSender } from '@internal/email';
import type { BetterAuthOptions } from 'better-auth';
import { admin, bearer, jwt, magicLink } from 'better-auth/plugins';
import pg from 'pg';
import { AUTH_SCHEMA } from './pack/constants.ts';
import type { AuthTemplates } from './templates.ts';
import { safeLink } from './templates.ts';

export interface AuthOptionsInputs {
  readonly databaseUrl: string;
  readonly secret: string;
  /** The PUBLIC origin of the consumer app (scheme+host, no trailing slash, no path) — what browsers see and `trustedOrigins` allows. */
  readonly baseUrl: string;
  /** The hydrated `emailSender(authTemplates)` boundary dependency — one method per template. */
  readonly email: EmailSender<AuthTemplates>;
}

/** sha256 of `input`, lowercase hex — Web Crypto only, no `node:` import, so this file stays reachable from the embedded export's shared plane. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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
    // `options` applies it at connection startup on Prisma Postgres, but the
    // local `prisma-composer dev` emulator (and poolers such as pgbouncer)
    // drop the startup `options` param, so it is also set per connection below.
    options: `-c search_path=${AUTH_SCHEMA}`,
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => console.error('pg pool idle client error', err));
  // Portable search_path: an in-session SET runs on every new connection, so
  // it holds even where the startup `options` param is ignored (the dev
  // emulator). Without it, Better Auth's unqualified queries resolve against
  // `public` there and fail with `relation "user" does not exist`.
  pool.on('connect', (client) => {
    void client
      .query(`SET search_path TO ${AUTH_SCHEMA}`)
      .catch((err) => console.error('auth: failed to set search_path', err));
  });
  return pool;
}

export function buildAuthOptions(inputs: AuthOptionsInputs): BetterAuthOptions {
  const send = async (
    purpose: keyof AuthTemplates,
    to: string,
    url: string,
    token: string,
  ): Promise<void> => {
    try {
      const link = safeLink(url, inputs.baseUrl);
      const idempotencyKey = await sha256Hex(`${purpose}:${to}:${token}`);
      const result = await inputs.email[purpose]({
        to,
        data: { url: link, appName: 'auth' },
        idempotencyKey,
      });
      if (result.status === 'failed') {
        console.error(
          `auth: ${purpose} email to ${to} failed to send: ${result.error ?? 'unknown error'}`,
        );
      }
    } catch (error) {
      // Better Auth treats a callback throw as a request failure — a down
      // mail path, or a link safeLink rejected, must not brick
      // signup/reset/magic-link. The attempt is logged; nothing is thrown.
      console.error(`auth: ${purpose} email to ${to} did not send`, error);
    }
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
      requireEmailVerification: true,
      sendResetPassword: ({ user, url, token }) => send('passwordReset', user.email, url, token),
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendVerificationEmail: ({ user, url, token }) => send('verification', user.email, url, token),
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
      jwt({
        jwt: {
          expirationTime: '15m',
          // The default payload is the user object ALONE — no session claim
          // at better-auth 1.6.24. The wire contract pins `sid`
          // (VerifiedSession.sessionId; the per-call instant-logout opt-in
          // resolves it against the session port), so the payload is the
          // default shape plus that one claim.
          definePayload: ({ user, session }) => ({ ...user, sid: session.id }),
        },
        jwks: {},
      }),
      bearer(),
      admin(),
      magicLink({
        sendMagicLink: ({ email, url, token }) => send('magicLink', email, url, token),
        expiresIn: 300,
        disableSignUp: false,
      }),
    ],
  };
}
