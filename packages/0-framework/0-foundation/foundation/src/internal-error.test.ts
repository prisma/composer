// Duplicated from the prisma/prisma error foundation pending extraction into a shared package — keep byte-close to the donor; recognition is structural, so the copies interoperate. (The donor's assertions-rebuilt-on-InternalError block does not travel: composer's assertions throw plain Errors.)
import { describe, expect, it } from 'bun:test';
import { assertNever, InternalError, isInternalError } from './internal-error.ts';
import { structuredError } from './structured-error.ts';

describe('InternalError', () => {
  it('is an Error with name InternalError', () => {
    const error = new InternalError('bug');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('InternalError');
    expect(error.message).toBe('bug');
  });

  it('carries cause when passed', () => {
    const cause = new Error('root cause');
    const error = new InternalError('bug', { cause });
    expect(error.cause).toBe(cause);
  });
});

describe('isInternalError', () => {
  it('true for an InternalError', () => {
    expect(isInternalError(new InternalError('bug'))).toBe(true);
  });

  it('false for a plain Error', () => {
    expect(isInternalError(new Error('x'))).toBe(false);
  });

  it('false for a structuredError', () => {
    expect(isInternalError(structuredError('CONTRACT.MARKER_MISSING', 'm'))).toBe(false);
  });

  it('false for null', () => {
    expect(isInternalError(null)).toBe(false);
  });
});

describe('assertNever', () => {
  it('throws an InternalError', () => {
    expect(() => assertNever('unexpected' as never)).toThrow(InternalError);
  });

  it('throws with the given message', () => {
    expect(() => assertNever('unexpected' as never, 'custom message')).toThrow('custom message');
  });
});
