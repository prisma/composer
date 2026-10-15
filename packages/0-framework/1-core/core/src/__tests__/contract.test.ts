import { describe, expect, test } from 'bun:test';
import { contractStyleOf } from '../contract.ts';

describe('contractStyleOf()', () => {
  test.each([
    ['request-response', { style: 'request-response' }, 'request-response'],
    ['stream', { style: 'stream' }, 'stream'],
    ['an unknown style string', { style: 'bogus' }, undefined],
    ['a non-string style', { style: 42 }, undefined],
    ['a missing style', {}, undefined],
    ['null', null, undefined],
    ['a non-object', 'request-response', undefined],
  ])('%s', (_label, contract, expected) => {
    expect(contractStyleOf(contract)).toBe(expected);
  });
});
