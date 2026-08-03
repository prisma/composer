/**
 * `buildAuthOptions()`'s pinned values (spec § Better Auth configuration) —
 * asserted field by field so a drift in any pinned option fails HERE with
 * its name, plus the email posture: every send callback calls the
 * matching `email` template method with a deterministic idempotency key,
 * `requireEmailVerification: true`, a `failed` result is logged (never
 * thrown), a rejecting/throwing send is caught (never thrown), and a
 * cross-origin link never reaches `email` at all.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { EmailSender } from '@internal/email';
import pg from 'pg';
import { buildAuthOptions } from '../auth-options.ts';
import type { AuthTemplates } from '../templates.ts';

const inputs = {
  databaseUrl: 'postgres://user:pass@db.example:5432/app',
  secret: 'unit-test-secret-thirty-two-chars!!',
  baseUrl: 'https://app.example',
};

interface SendCall {
  readonly template: keyof AuthTemplates;
  readonly to: string;
  readonly data: { url: string; appName: string };
  readonly idempotencyKey: string;
}

function fakeEmailSender(
  result: { status: 'sent' | 'failed'; error?: string } = { status: 'sent' },
): { email: EmailSender<AuthTemplates>; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const method =
    (template: keyof AuthTemplates) =>
    async (input: {
      readonly to: string | readonly string[];
      readonly data: { url: string; appName: string };
      readonly idempotencyKey?: string | undefined;
    }) => {
      const to = Array.isArray(input.to) ? (input.to[0] ?? '') : input.to;
      calls.push({
        template,
        to,
        data: input.data,
        idempotencyKey: input.idempotencyKey ?? '',
      });
      return { id: 'send-id', ...result };
    };
  return {
    email: {
      verification: method('verification'),
      passwordReset: method('passwordReset'),
      magicLink: method('magicLink'),
    },
    calls,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('buildAuthOptions — pinned values', () => {
  const { email } = fakeEmailSender();
  const options = buildAuthOptions({ ...inputs, email });

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

  test('onConnect: awaits SET search_path on the new client', async () => {
    const pool = options.database as pg.Pool;
    const queries: string[] = [];
    const client = {
      query: (text: string) => {
        queries.push(text);
        return Promise.resolve();
      },
    } as unknown as pg.ClientBase;
    await pool.options.onConnect?.(client);
    expect(queries).toEqual(['SET search_path TO auth']);
  });

  test('onConnect: a failed SET rejects so the pool discards the client', async () => {
    const pool = options.database as pg.Pool;
    const failure = new Error('SET failed');
    const client = {
      query: () => Promise.reject(failure),
    } as unknown as pg.ClientBase;
    await expect(pool.options.onConnect?.(client)).rejects.toBe(failure);
  });

  test('emailAndPassword: enabled, verification required, reset revokes sessions', () => {
    expect(options.emailAndPassword?.enabled).toBe(true);
    expect(options.emailAndPassword?.requireEmailVerification).toBe(true);
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

describe('the email touchpoints', () => {
  test('sendVerificationEmail calls email.verification with the link, appName, and a deterministic key', async () => {
    const { email, calls } = fakeEmailSender();
    const options = buildAuthOptions({ ...inputs, email });

    await options.emailVerification?.sendVerificationEmail?.(
      verificationArgs('v@example.com', 'https://app.example/verify?token=t1', 't1'),
    );

    expect(calls).toEqual([
      {
        template: 'verification',
        to: 'v@example.com',
        data: { url: 'https://app.example/verify?token=t1', appName: 'auth' },
        idempotencyKey: sha256Hex('verification:v@example.com:t1'),
      },
    ]);
  });

  test('sendResetPassword calls email.passwordReset the same way', async () => {
    const { email, calls } = fakeEmailSender();
    const options = buildAuthOptions({ ...inputs, email });

    await options.emailAndPassword?.sendResetPassword?.(
      resetArgs('r@example.com', 'https://app.example/reset?token=t2', 't2'),
    );

    expect(calls).toEqual([
      {
        template: 'passwordReset',
        to: 'r@example.com',
        data: { url: 'https://app.example/reset?token=t2', appName: 'auth' },
        idempotencyKey: sha256Hex('passwordReset:r@example.com:t2'),
      },
    ]);
  });

  // magicLink's own send callback is exercised end to end in
  // local-server.integration.test.ts: the magic-link plugin closes over its
  // `sendMagicLink` option internally and does not expose it on the built
  // `BetterAuthOptions.plugins` entry, so it cannot be invoked directly here
  // the way `emailVerification`/`emailAndPassword`'s callbacks can — those
  // two prove the shared `send()` closure (idempotency, failure handling,
  // safeLink) that `sendMagicLink` is a one-line call into.

  test('idempotency key is deterministic per (purpose, email, token) and distinct across each', async () => {
    const { email, calls } = fakeEmailSender();
    const options = buildAuthOptions({ ...inputs, email });

    // Same event, called twice (a Better Auth retry) — same key both times.
    await options.emailVerification?.sendVerificationEmail?.(
      verificationArgs('v@example.com', 'https://app.example/verify?token=t1', 't1'),
    );
    await options.emailVerification?.sendVerificationEmail?.(
      verificationArgs('v@example.com', 'https://app.example/verify?token=t1', 't1'),
    );
    expect(calls[0]?.idempotencyKey).toBe(calls[1]?.idempotencyKey);

    // A different token (a genuinely new event) — a different key.
    await options.emailVerification?.sendVerificationEmail?.(
      verificationArgs('v@example.com', 'https://app.example/verify?token=t9', 't9'),
    );
    expect(calls[2]?.idempotencyKey).not.toBe(calls[0]?.idempotencyKey);

    // The same token but a different purpose — still a different key (the
    // purpose is folded into the hash input).
    await options.emailAndPassword?.sendResetPassword?.(
      resetArgs('v@example.com', 'https://app.example/reset?token=t1', 't1'),
    );
    expect(calls[3]?.idempotencyKey).not.toBe(calls[0]?.idempotencyKey);
  });

  test('a failed send result is logged, never thrown', async () => {
    const { email } = fakeEmailSender({ status: 'failed', error: 'provider down' });
    const options = buildAuthOptions({ ...inputs, email });
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await expect(
        options.emailVerification?.sendVerificationEmail?.(
          verificationArgs('v@example.com', 'https://app.example/verify?token=t1', 't1'),
        ),
      ).resolves.toBeUndefined();
    } finally {
      console.error = realError;
    }
    expect(logged.some((args) => String(args[0]).includes('failed to send'))).toBe(true);
  });

  test('a send that throws is caught, logged, never thrown — a down mail path must not brick signup', async () => {
    const email: EmailSender<AuthTemplates> = {
      verification: () => Promise.reject(new Error('network unreachable')),
      passwordReset: () => Promise.reject(new Error('unused')),
      magicLink: () => Promise.reject(new Error('unused')),
    };
    const options = buildAuthOptions({ ...inputs, email });
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await expect(
        options.emailVerification?.sendVerificationEmail?.(
          verificationArgs('v@example.com', 'https://app.example/verify?token=t1', 't1'),
        ),
      ).resolves.toBeUndefined();
    } finally {
      console.error = realError;
    }
    expect(logged.length).toBeGreaterThan(0);
  });

  test('a cross-origin link is rejected by safeLink before email is ever called', async () => {
    const { email, calls } = fakeEmailSender();
    const options = buildAuthOptions({ ...inputs, email });
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await options.emailVerification?.sendVerificationEmail?.(
        verificationArgs('v@example.com', 'https://evil.example/verify?token=t1', 't1'),
      );
    } finally {
      console.error = realError;
    }
    expect(calls).toEqual([]);
    expect(logged.length).toBeGreaterThan(0);
  });
});

// Better Auth's callback argument shapes, reduced to what the callbacks read.
function verificationArgs(email: string, url: string, token: string) {
  return {
    user: baUser(email),
    url,
    token,
  } as Parameters<
    NonNullable<
      NonNullable<ReturnType<typeof buildAuthOptions>['emailVerification']>['sendVerificationEmail']
    >
  >[0];
}

function resetArgs(email: string, url: string, token: string) {
  return {
    user: baUser(email),
    url,
    token,
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
