/**
 * The shared connection-resilience helpers (slice 3) — pure logic, no database.
 * A live PPG deploy is the ultimate proof of the cold-start behavior, but these
 * lock the pieces the live diagnosis pinned down:
 *   - `normalizeSslMode` — pin the deprecating `sslmode=require` (etc.) to the
 *     explicit `verify-full` it already means; a plain local DSN is untouched.
 *   - `isTransientConnectionError` — a cold-start / network / dropped-socket
 *     failure is retryable; a real query (SQL-state) error is not.
 *   - `withConnectionRetry` — retries per `shouldRetry` and gives up after
 *     `attempts`, surfacing the last error.
 *   - `retryTransientConnect` — the runtime client's seam: retry a transient
 *     cold-start on connection acquisition, surface a real query error at once.
 */
import { describe, expect, test } from 'bun:test';
import {
  isTransientConnectionError,
  normalizeSslMode,
  retryTransientConnect,
  withConnectionRetry,
} from '../exports/pg-connection.ts';

const noSleep = async (): Promise<void> => {};

describe('normalizeSslMode', () => {
  test('pins a Prisma Postgres sslmode=require DSN to verify-full', () => {
    const out = normalizeSslMode('postgres://user:pass@db.prisma.io:5432/postgres?sslmode=require');
    const u = new URL(out);
    expect(u.searchParams.get('sslmode')).toBe('verify-full');
    expect(u.username).toBe('user');
    expect(u.password).toBe('pass');
    expect(u.host).toBe('db.prisma.io:5432');
    expect(u.pathname).toBe('/postgres');
  });

  test('preserves other query params while pinning sslmode', () => {
    const out = normalizeSslMode('postgresql://u:p@h:5432/db?sslmode=require&connection_limit=5');
    const params = new URL(out).searchParams;
    expect(params.get('sslmode')).toBe('verify-full');
    expect(params.get('connection_limit')).toBe('5');
  });

  test('pins prefer and verify-ca (the other deprecating modes) to verify-full', () => {
    for (const mode of ['prefer', 'verify-ca']) {
      const out = normalizeSslMode(`postgres://u:p@h:5432/db?sslmode=${mode}`);
      expect(new URL(out).searchParams.get('sslmode')).toBe('verify-full');
    }
  });

  test('leaves verify-full, no-verify, disable, and no-sslmode DSNs untouched', () => {
    for (const url of [
      'postgres://u:p@h:5432/db?sslmode=verify-full',
      'postgres://u:p@h:5432/db?sslmode=no-verify',
      'postgres://u:p@h:5432/db?sslmode=disable',
      'postgres://postgres@127.0.0.1:22801/postgres',
    ]) {
      expect(normalizeSslMode(url)).toBe(url);
    }
  });

  test('returns an unparseable connection string unchanged', () => {
    expect(normalizeSslMode('not a url')).toBe('not a url');
  });
});

describe('isTransientConnectionError', () => {
  test('true for the PPG cold-start upstream reject (no err.code)', () => {
    expect(
      isTransientConnectionError(
        new Error('Failed to connect to upstream database. Contact Prisma'),
      ),
    ).toBe(true);
  });

  test('true for network-level socket codes', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']) {
      expect(isTransientConnectionError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  test('true for pool/server-close transients', () => {
    for (const msg of [
      'Connection terminated unexpectedly',
      'terminating connection due to idle',
    ]) {
      expect(isTransientConnectionError(new Error(msg))).toBe(true);
    }
  });

  test('false for a real query error (SQL-state), and non-errors', () => {
    expect(
      isTransientConnectionError(
        Object.assign(new Error('syntax error at or near "slect"'), { code: '42601' }),
      ),
    ).toBe(false);
    expect(isTransientConnectionError(new Error('relation "widget" does not exist'))).toBe(false);
    expect(isTransientConnectionError(null)).toBe(false);
    expect(isTransientConnectionError('boom')).toBe(false);
  });
});

describe('withConnectionRetry', () => {
  test('returns the result when the operation succeeds first try', async () => {
    let calls = 0;
    const result = await withConnectionRetry(
      async () => {
        calls++;
        return 'ok';
      },
      { sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries a transient failure and returns once it succeeds', async () => {
    let calls = 0;
    const result = await withConnectionRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('Failed to connect to upstream database');
        return 'connected';
      },
      { attempts: 5, sleep: noSleep },
    );
    expect(result).toBe('connected');
    expect(calls).toBe(3);
  });

  test('gives up after `attempts` and throws the last error', async () => {
    let calls = 0;
    const boom = new Error('Failed to connect to upstream database');
    await expect(
      withConnectionRetry(
        async () => {
          calls++;
          throw boom;
        },
        { attempts: 4, sleep: noSleep },
      ),
    ).rejects.toBe(boom);
    expect(calls).toBe(4);
  });

  test('does NOT retry when shouldRetry returns false — surfaces at once', async () => {
    let calls = 0;
    const err = new Error('real, non-transient failure');
    await expect(
      withConnectionRetry(
        async () => {
          calls++;
          throw err;
        },
        { attempts: 5, sleep: noSleep, shouldRetry: () => false },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  test('honours a shouldRetry predicate (isTransientConnectionError)', async () => {
    let calls = 0;
    const queryError = Object.assign(new Error('syntax error'), { code: '42601' });
    await expect(
      withConnectionRetry(
        async () => {
          calls++;
          throw queryError;
        },
        { attempts: 5, sleep: noSleep, shouldRetry: isTransientConnectionError },
      ),
    ).rejects.toBe(queryError);
    expect(calls).toBe(1);
  });
});

describe('retryTransientConnect (the runtime client seam)', () => {
  test('retries a transient cold-start on acquire, then returns the connection', async () => {
    let calls = 0;
    const connection = { released: false };
    const acquire = async () => {
      calls++;
      if (calls < 3) throw new Error('Failed to connect to upstream database');
      return connection;
    };
    const result = await retryTransientConnect(acquire, { attempts: 5, sleep: noSleep });
    expect(result).toBe(connection);
    expect(calls).toBe(3);
  });

  test('surfaces a real query error immediately — no retry', async () => {
    let calls = 0;
    const queryError = Object.assign(new Error('syntax error at or near "slect"'), {
      code: '42601',
    });
    const acquire = async () => {
      calls++;
      throw queryError;
    };
    await expect(retryTransientConnect(acquire, { attempts: 5, sleep: noSleep })).rejects.toBe(
      queryError,
    );
    expect(calls).toBe(1);
  });
});
