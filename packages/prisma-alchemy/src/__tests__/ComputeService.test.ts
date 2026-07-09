import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';
import { deleteSafeRetrySchedule, isDeleteNotSafeYet } from '../compute/ComputeService.ts';
import { PrismaApiError } from '../http.ts';

const deleteNotSafeError = new PrismaApiError({
  status: 409,
  message: JSON.stringify({
    error: {
      code: 'client-error',
      message: 'The deployment did not reach a delete-safe state after stop',
      hint: 'The resource already exists or is in a conflicting state.',
    },
  }),
});

describe('isDeleteNotSafeYet', () => {
  test('classifies the delete-safe-after-stop error as retryable', () => {
    expect(isDeleteNotSafeYet(deleteNotSafeError)).toBe(true);
  });

  test('does not classify an unrelated API error as retryable', () => {
    const unauthorized = new PrismaApiError({ status: 401, message: '{"error":"unauthorized"}' });
    const notFound = new PrismaApiError({ status: 404, message: '{"error":"not found"}' });
    const serverError = new PrismaApiError({ status: 500, message: '{"error":"internal error"}' });

    expect(isDeleteNotSafeYet(unauthorized)).toBe(false);
    expect(isDeleteNotSafeYet(notFound)).toBe(false);
    expect(isDeleteNotSafeYet(serverError)).toBe(false);
  });
});

describe('delete retry wiring (Effect.retry({ schedule, while }))', () => {
  // Exercises the same `{ schedule, while: isDeleteNotSafeYet }` composition
  // ComputeService's delete uses, swapping in a millisecond-scale schedule so
  // the test doesn't wait on the real 2s-to-5min production backoff.
  const fastSchedule = Schedule.spaced('1 millis');

  test('retries a delete-not-safe-yet failure until it succeeds', async () => {
    let attempts = 0;
    const flaky = Effect.gen(function* () {
      attempts++;
      if (attempts < 3) return yield* Effect.fail(deleteNotSafeError);
      return 'deleted';
    });

    const result = await Effect.runPromise(
      flaky.pipe(Effect.retry({ schedule: fastSchedule, while: isDeleteNotSafeYet })),
    );

    expect(result).toBe('deleted');
    expect(attempts).toBe(3);
  });

  test('does not retry a different error — it fails on the first attempt', async () => {
    let attempts = 0;
    const alwaysUnauthorized = Effect.gen(function* () {
      attempts++;
      return yield* Effect.fail(
        new PrismaApiError({ status: 401, message: '{"error":"unauthorized"}' }),
      );
    });

    const outcome = await Effect.runPromiseExit(
      alwaysUnauthorized.pipe(Effect.retry({ schedule: fastSchedule, while: isDeleteNotSafeYet })),
    );

    expect(outcome._tag).toBe('Failure');
    expect(attempts).toBe(1);
  });

  test('gives up once the delete-safe error persists past the overall timeout', async () => {
    // A near-zero overall cap makes the "generous timeout" boundary itself
    // fast to test: it should retry a couple of times and then still fail.
    let attempts = 0;
    const alwaysNotSafe = Effect.gen(function* () {
      attempts++;
      return yield* Effect.fail(deleteNotSafeError);
    });

    const shortCappedSchedule = Schedule.both(
      Schedule.spaced('1 millis'),
      Schedule.during('20 millis'),
    );

    const outcome = await Effect.runPromiseExit(
      alwaysNotSafe.pipe(
        Effect.retry({ schedule: shortCappedSchedule, while: isDeleteNotSafeYet }),
      ),
    );

    expect(outcome._tag).toBe('Failure');
    expect(attempts).toBeGreaterThan(1);
  });
});

describe('deleteSafeRetrySchedule', () => {
  test('is a Schedule value wired into the delete provider', () => {
    expect(Schedule.isSchedule(deleteSafeRetrySchedule)).toBe(true);
  });
});
