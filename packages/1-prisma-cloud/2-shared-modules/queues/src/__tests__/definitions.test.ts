import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { defineQueues, fixedBackoff } from '../exports/index.ts';

describe('queue retry policy', () => {
  test('defines a fixed retry delay on one queue', () => {
    const definitions = defineQueues({
      messages: {
        message: type({ text: 'string' }),
        retry: { maxAttempts: 5, delay: fixedBackoff({ delay: '5s' }) },
      },
    });

    expect(definitions.messages.retry).toEqual({
      maxAttempts: 5,
      delay: { kind: 'fixed', delaySeconds: 5 },
    });
  });

  test('rejects retry delays outside one second through 24 hours', () => {
    expect(() => fixedBackoff({ delay: '0s' })).toThrow('between 1 second and 24 hours');
    expect(() => fixedBackoff({ delay: '25h' })).toThrow('between 1 second and 24 hours');
  });

  test('rejects an invalid maximum attempt count while defining queues', () => {
    expect(() =>
      defineQueues({
        messages: {
          message: type({ text: 'string' }),
          retry: { maxAttempts: 0, delay: fixedBackoff({ delay: '5s' }) },
        },
      }),
    ).toThrow('maxAttempts must be an integer from 1 through 100');
  });
});
