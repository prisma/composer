/**
 * `buildAuthOptions()`'s pinned values (spec § Better Auth configuration) —
 * asserted field by field so a drift in any pinned option fails HERE with
 * its name, plus the S1 email seam: absent sender → the pinned no-op log;
 * present sender → `{ purpose, to, url }` forwarded (what the testing
 * export's capture rides on).
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';
import { type AuthEmailEvent, buildAuthOptions } from '../auth-options.ts';

const inputs = {
  databaseUrl: 'postgres://user:pass@db.example:5432/app',
  secret: 'unit-test-secret-thirty-two-chars!!',
  baseUrl: 'https://app.example',
};

describe('buildAuthOptions — pinned values', () => {
  const options = buildAuthOptions(inputs);

  test('identity: appName, baseURL, basePath, secret, trustedOrigins', () => {
    expect(options.appName).toBe('auth');
    expect(options.baseURL).toBe('https://app.example');
    expect(options.basePath).toBe('/api/auth');
    expect(options.secret).toBe(inputs.secret);
    expect(options.trustedOrigins).toEqual(['https://app.example']);
  });

  test('database: a pg.Pool with search_path=auth and the hardening values', () => {
    expect(options.database).toBeInstanceOf(pg.Pool);
    const pool = options.database as pg.Pool;
    expect(pool.options.connectionTimeoutMillis).toBe(20_000);
    expect(pool.options.idleTimeoutMillis).toBe(5_000);
    expect(pool.options.options).toBe('-c search_path=auth');
    // The error listener is attached — an idle-client error must not crash.
    expect(pool.listenerCount('error')).toBe(1);
  });

  test('emailAndPassword: enabled, S1 verification off, reset revokes sessions', () => {
    expect(options.emailAndPassword?.enabled).toBe(true);
    expect(options.emailAndPassword?.requireEmailVerification).toBe(false);
    expect(options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
    expect(typeof options.emailAndPassword?.sendResetPassword).toBe('function');
  });

  test('emailVerification: sends on signup, auto-signin after verification', () => {
    expect(options.emailVerification?.sendOnSignUp).toBe(true);
    expect(options.emailVerification?.autoSignInAfterVerification).toBe(true);
    expect(typeof options.emailVerification?.sendVerificationEmail).toBe('function');
  });

  test('session TTLs and rate limiting', () => {
    expect(options.session?.expiresIn).toBe(604_800);
    expect(options.session?.updateAge).toBe(86_400);
    expect(options.rateLimit?.enabled).toBe(true);
  });

  test('NO generateId override (spec erratum): Better Auth generates the text ids', () => {
    // `advanced.database.generateId: false` at the pinned version disables
    // generation entirely and breaks signup against the pack schema (no DB
    // default) — verified empirically; the conformance path relies on BA's
    // own generator.
    expect(options.advanced?.database?.generateId).toBeUndefined();
  });

  test('plugins, in order: jwt, bearer, admin, magic-link', () => {
    expect(options.plugins?.map((p) => p.id)).toEqual(['jwt', 'bearer', 'admin', 'magic-link']);
  });
});

describe('the S1 email seam', () => {
  test('with a sender: the three callbacks forward { purpose, to, url }', async () => {
    const events: AuthEmailEvent[] = [];
    const options = buildAuthOptions({ ...inputs, sendEmail: (e) => void events.push(e) });

    await options.emailVerification?.sendVerificationEmail?.(
      verificationArgs('v@example.com', 'https://app.example/verify?token=t1'),
    );
    await options.emailAndPassword?.sendResetPassword?.(
      resetArgs('r@example.com', 'https://app.example/reset?token=t2'),
    );
    expect(events).toEqual([
      { purpose: 'verification', to: 'v@example.com', url: 'https://app.example/verify?token=t1' },
      { purpose: 'passwordReset', to: 'r@example.com', url: 'https://app.example/reset?token=t2' },
    ]);
  });

  test('without a sender: callbacks log the pinned S1 line and resolve', async () => {
    const options = buildAuthOptions(inputs);
    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => void logged.push(args.join(' '));
    try {
      await options.emailVerification?.sendVerificationEmail?.(
        verificationArgs('x@example.com', 'https://app.example/verify'),
      );
    } finally {
      console.log = realLog;
    }
    expect(logged).toEqual([
      'auth: email delivery not wired (slice S2): verification for x@example.com',
    ]);
  });
});

// Better Auth's callback argument shapes, reduced to what the callbacks read.
function verificationArgs(email: string, url: string) {
  return {
    user: baUser(email),
    url,
    token: 't',
  } as Parameters<
    NonNullable<
      NonNullable<ReturnType<typeof buildAuthOptions>['emailVerification']>['sendVerificationEmail']
    >
  >[0];
}

function resetArgs(email: string, url: string) {
  return {
    user: baUser(email),
    url,
    token: 't',
  } as Parameters<
    NonNullable<
      NonNullable<ReturnType<typeof buildAuthOptions>['emailAndPassword']>['sendResetPassword']
    >
  >[0];
}

function baUser(email: string) {
  return {
    id: 'u1',
    email,
    emailVerified: false,
    name: 'U',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
