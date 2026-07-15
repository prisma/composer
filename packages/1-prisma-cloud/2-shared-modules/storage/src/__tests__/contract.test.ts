import { describe, expect, test } from 'bun:test';
import { s3Contract } from '../contract.ts';

describe('s3Contract.satisfies', () => {
  test('accepts a contract of the same kind', () => {
    const other = { kind: 's3' as const, __cmp: undefined, satisfies: () => true };
    expect(s3Contract.satisfies(other)).toBe(true);
  });

  test('rejects a contract of a different kind', () => {
    // Cast is test-only: the mismatched kind literal is the point of the test.
    const other = {
      kind: 'postgres',
      __cmp: undefined,
      satisfies: () => true,
    } as unknown as typeof s3Contract;
    expect(s3Contract.satisfies(other)).toBe(false);
  });
});
