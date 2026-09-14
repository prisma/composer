// Duplicated from the prisma/prisma error foundation (the CliStructuredError blocks of its control.test.ts) pending extraction into a shared package — keep byte-close to the donor; recognition is structural, so the copies interoperate.
import { describe, expect, it } from 'bun:test';
import { CliStructuredError } from './cli-structured-error.ts';

describe('CliStructuredError', () => {
  it('creates error with all properties', () => {
    const error = new CliStructuredError('CONFIG.FILE_NOT_FOUND', 'Test error', {
      severity: 'error',
      why: 'This is why',
      fix: 'This is how to fix',
      where: { path: '/path/to/file.ts', line: 42 },
      meta: { key: 'value' },
      docsUrl: 'https://example.com/docs',
    });

    expect(error.code).toBe('CONFIG.FILE_NOT_FOUND');
    expect(error.message).toBe('Test error');
    expect(error.severity).toBe('error');
    expect(error.why).toBe('This is why');
    expect(error.fix).toBe('This is how to fix');
    expect(error.where).toEqual({ path: '/path/to/file.ts', line: 42 });
    expect(error.meta).toEqual({ key: 'value' });
    expect(error.docsUrl).toBe('https://example.com/docs');
  });

  it('creates error with defaults', () => {
    const error = new CliStructuredError('CONFIG.FILE_NOT_FOUND', 'Test error');

    expect(error.code).toBe('CONFIG.FILE_NOT_FOUND');
    expect(error.message).toBe('Test error');
    expect(error.severity).toBe('error');
    expect(error.why).toBeUndefined();
    expect(error.fix).toBeUndefined();
    expect(error.where).toBeUndefined();
    expect(error.meta).toBeUndefined();
    expect(error.docsUrl).toBeUndefined();
  });

  it('forwards cause to Error when passed', () => {
    const cause = new Error('root cause');
    const error = new CliStructuredError('CONFIG.FILE_NOT_FOUND', 'Test error', { cause });
    expect(error.cause).toBe(cause);
  });

  it('leaves cause unset when not passed, and toEnvelope() never serializes it', () => {
    const bare = new CliStructuredError('CONFIG.FILE_NOT_FOUND', 'Test error');
    expect(bare.cause).toBeUndefined();

    const caused = new CliStructuredError('CONFIG.FILE_NOT_FOUND', 'Test error', {
      cause: new Error('root cause'),
    });
    expect('cause' in caused.toEnvelope()).toBe(false);
  });

  it('converts to envelope carrying the dotted code as-is', () => {
    const error = new CliStructuredError('CONFIG.FILE_NOT_FOUND', 'Test error');
    const envelope = error.toEnvelope();

    expect(envelope.code).toBe('CONFIG.FILE_NOT_FOUND');
    expect(envelope.summary).toBe('Test error');
  });

  it('converts to envelope for a different namespace', () => {
    const error = new CliStructuredError('CONTRACT.MARKER_MISSING', 'Test error');
    const envelope = error.toEnvelope();

    expect(envelope.code).toBe('CONTRACT.MARKER_MISSING');
    expect(envelope.summary).toBe('Test error');
  });

  it('normalizes fix when fix equals why', () => {
    const error = new CliStructuredError('CONFIG.FILE_NOT_FOUND', 'Test error', {
      why: 'Same message',
      fix: 'Same message',
    });
    const envelope = error.toEnvelope();

    expect(error.fix).toBeUndefined();
    expect(envelope.fix).toBeUndefined();
  });

  describe('is() type guard', () => {
    it('returns true for CliStructuredError instances', () => {
      const error = new CliStructuredError('CONFIG.FILE_NOT_FOUND', 'Test error');
      expect(CliStructuredError.is(error)).toBe(true);
    });

    it('returns true for CliStructuredError from any namespace', () => {
      const error = new CliStructuredError('CONTRACT.VERIFY_FAILED', 'Test error');
      expect(CliStructuredError.is(error)).toBe(true);
    });

    it('returns false for non-Error values', () => {
      expect(CliStructuredError.is(null)).toBe(false);
      expect(CliStructuredError.is(undefined)).toBe(false);
      expect(CliStructuredError.is('string')).toBe(false);
      expect(CliStructuredError.is(123)).toBe(false);
      expect(CliStructuredError.is({})).toBe(false);
    });

    it('returns false for plain Error', () => {
      const error = new Error('Plain error');
      expect(CliStructuredError.is(error)).toBe(false);
    });

    it('returns false for Error with wrong name', () => {
      const error = new Error('Test error') as unknown as Record<string, unknown>;
      error['code'] = 'CONFIG.FILE_NOT_FOUND';
      error['toEnvelope'] = () => ({});
      expect(CliStructuredError.is(error)).toBe(false);
    });

    it('returns false for Error with missing code', () => {
      const error = new Error('Test error') as unknown as Record<string, unknown>;
      error['name'] = 'CliStructuredError';
      error['toEnvelope'] = () => ({});
      expect(CliStructuredError.is(error)).toBe(false);
    });

    it('returns false for Error without toEnvelope method', () => {
      const error = new Error('Test error') as unknown as Record<string, unknown>;
      error['name'] = 'CliStructuredError';
      error['code'] = 'CONFIG.FILE_NOT_FOUND';
      expect(CliStructuredError.is(error)).toBe(false);
    });
  });
});
