import { describe, expect, test } from 'bun:test';
import { dataLine } from '../data-lines.ts';

describe('dataLine', () => {
  test('joins fields with tabs and keeps an absent field as an empty one', () => {
    expect(dataLine(['gateway', null, 'service', 3, undefined, true])).toBe(
      'gateway\t\tservice\t3\t\ttrue',
    );
  });

  test.each([
    ['a backslash', 'a\\b', 'a\\\\b'],
    ['a tab', 'a\tb', 'a\\tb'],
    ['a newline', 'a\nb', 'a\\nb'],
    ['a carriage return', 'a\rb', 'a\\rb'],
  ])('escapes %s inside a field', (_name, value, escaped) => {
    expect(dataLine(['x', value, 'y'])).toBe(`x\t${escaped}\ty`);
  });

  test('escapes a backslash before the characters it introduces', () => {
    expect(dataLine(['\\n\n'])).toBe('\\\\n\\n');
  });
});
