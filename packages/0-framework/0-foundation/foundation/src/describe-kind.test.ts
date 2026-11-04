import { describe, expect, it } from 'bun:test';
import { describeKind } from './describe-kind.ts';

describe('describeKind', () => {
  it('describeKind names each kind and never the value', () => {
    const cases: [unknown, string][] = [
      [undefined, 'nothing'],
      [null, 'null'],
      [['secret'], 'an array'],
      [() => 'secret', 'a function'],
      [{ secret: 'secret' }, 'an object'],
      ['secret', 'a string'],
      [918273645, 'a number'],
      [true, 'a boolean'],
      [918273645n, 'a bigint'],
      [Symbol('secret'), 'a symbol'],
    ];
    for (const [value, kind] of cases) {
      expect(describeKind(value)).toBe(kind);
    }
  });
});
