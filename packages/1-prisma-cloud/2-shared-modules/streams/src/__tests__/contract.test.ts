import { describe, expect, test } from 'bun:test';
import { streamsContract } from '../contract.ts';

describe('streamsContract.satisfies', () => {
  test('accepts a contract of the same kind', () => {
    const other = { kind: 'streams' as const, __cmp: undefined, satisfies: () => true };
    expect(streamsContract.satisfies(other)).toBe(true);
  });

  test('rejects a contract of a different kind', () => {
    // Cast is test-only: the mismatched kind literal is the point of the test.
    const other = {
      kind: 's3',
      __cmp: undefined,
      satisfies: () => true,
    } as unknown as typeof streamsContract;
    expect(streamsContract.satisfies(other)).toBe(false);
  });
});
