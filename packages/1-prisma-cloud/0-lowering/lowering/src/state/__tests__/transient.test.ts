import { describe, expect, test } from 'bun:test';
import { StateStoreError } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';
import { isColdStartConnectError, retryColdStart } from '../transient.ts';

describe('isColdStartConnectError', () => {
  test('the PPg cold/idle-upstream rejection classifies as a cold start', () => {
    // The exact message Run 1 died on (surfaced via toStateStoreError, which
    // preserves the driver message on the StateStoreError).
    expect(
      isColdStartConnectError(
        new StateStoreError({ message: 'Failed to connect to upstream database.' }),
      ),
    ).toBe(true);
  });

  test('establishment-refusal codes classify as a cold start', () => {
    expect(isColdStartConnectError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toBe(
      true,
    );
    expect(isColdStartConnectError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' })).toBe(
      true,
    );
    expect(isColdStartConnectError({ code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN' })).toBe(
      true,
    );
  });

  test('unwraps a StateStoreError-style cause carrying the driver code', () => {
    expect(isColdStartConnectError({ message: 'wrapped', cause: { code: 'ECONNREFUSED' } })).toBe(
      true,
    );
  });

  test('a client-side dropped/terminated connection is NOT a cold start (the lost-lease signal)', () => {
    // What postgres.js throws for a query after `sql.end()` — lock.ts's
    // "lease-loss" test drives exactly this, and it must stay loud.
    expect(
      isColdStartConnectError({
        code: 'CONNECTION_ENDED',
        message: 'write CONNECTION_ENDED 127.0.0.1:1',
      }),
    ).toBe(false);
    expect(isColdStartConnectError({ code: 'ECONNRESET', message: 'read ECONNRESET' })).toBe(false);
  });

  test('a lost lease and a real query error are NOT cold starts', () => {
    expect(
      isColdStartConnectError(
        new StateStoreError({
          message: 'the state lock for s/t was lost mid-run; refusing to continue unlocked',
        }),
      ),
    ).toBe(false);
    expect(
      isColdStartConnectError({ message: 'duplicate key value violates unique constraint' }),
    ).toBe(false);
  });

  test('non-object inputs are never cold starts', () => {
    expect(isColdStartConnectError(undefined)).toBe(false);
    expect(isColdStartConnectError(null)).toBe(false);
    expect(isColdStartConnectError('upstream database')).toBe(false);
  });
});

describe('retryColdStart', () => {
  // Instant schedule (no real delay) so tests don't wait the production window.
  const instant = Schedule.recurs(10);

  test('retries past a cold-start rejection, then succeeds', async () => {
    let attempts = 0;
    const op = Effect.suspend(() => {
      attempts += 1;
      return attempts < 3
        ? Effect.fail(new StateStoreError({ message: 'Failed to connect to upstream database.' }))
        : Effect.succeed('ok');
    });

    const result = await Effect.runPromise(retryColdStart(op, instant));

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  test('does not retry a lost-lease failure — it surfaces on the first attempt', async () => {
    let attempts = 0;
    const op = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail(
        new StateStoreError({
          message: 'the state lock for s/t was lost mid-run; refusing to continue unlocked',
        }),
      );
    });

    await expect(Effect.runPromise(retryColdStart(op, instant))).rejects.toThrow(/lost mid-run/);
    expect(attempts).toBe(1);
  });
});
