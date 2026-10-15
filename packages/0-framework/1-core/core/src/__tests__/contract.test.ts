import { describe, expect, test } from 'bun:test';
import { type ContractStyle, contractStyleOf } from '../contract.ts';

const cases: [string, unknown, ContractStyle | undefined][] = [
  ['request-response', { style: 'request-response' }, 'request-response'],
  ['stream', { style: 'stream' }, 'stream'],
  ['an unknown style string', { style: 'bogus' }, undefined],
  ['a non-string style', { style: 42 }, undefined],
  ['a missing style', {}, undefined],
  ['null', null, undefined],
  ['a non-object', 'request-response', undefined],
];

describe('contractStyleOf()', () => {
  test.each(cases)('%s', (_label, contract, expected) => {
    expect(contractStyleOf(contract)).toBe(expected);
  });
});
