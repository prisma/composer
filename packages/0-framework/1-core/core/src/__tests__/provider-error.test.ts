import { describe, expect, test } from 'bun:test';
import { CliStructuredError } from '@internal/foundation/errors';
import * as Data from 'effect/Data';
import { toProviderError, wrappedProviderError } from '../exports/deploy.ts';

describe('toProviderError() and wrappedProviderError()', () => {
  test('an error that has a _tag is returned as the same object', () => {
    class Tagged extends Data.TaggedError('Tagged')<{ readonly message: string }> {}
    const tagged = new Tagged({ message: 'boom' });
    const plainTagged = { _tag: 'NotAnError', message: 'plain' };

    expect(toProviderError(tagged)).toBe(tagged);
    expect(toProviderError(plainTagged)).toBe(plainTagged);
    expect(wrappedProviderError(tagged)).toBeUndefined();
    expect(wrappedProviderError(plainTagged)).toBeUndefined();
  });

  test('a plain Error is wrapped with the same message and the original as its cause', () => {
    const original = new Error('the database is still starting');

    const wrapped = toProviderError(original);

    expect(wrapped._tag).toBe('ProviderFailure');
    expect(wrapped.message).toBe('the database is still starting');
    expect(wrappedProviderError(wrapped)).toBe(original);
  });

  test('a thrown string is wrapped with the string as its message', () => {
    const wrapped = toProviderError('connection refused');

    expect(wrapped._tag).toBe('ProviderFailure');
    expect(wrapped.message).toBe('connection refused');
    expect(wrappedProviderError(wrapped)).toBe('connection refused');
  });

  test('a CliStructuredError is wrapped, and its code is still on the cause', () => {
    const structured = new CliStructuredError('DEPLOY.CONTAINER_FAILED', 'no project');

    const wrapped = toProviderError(structured);

    expect(wrapped.message).toBe('no project');
    expect(wrappedProviderError(wrapped)).toBe(structured);
  });
});
