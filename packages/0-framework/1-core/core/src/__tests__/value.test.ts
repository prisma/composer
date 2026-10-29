import { describe, expect, test } from 'bun:test';
import { secretSource } from '../node.ts';
import { environmentFacts, isValue, resolve, type Value } from '../value.ts';

const ORIGIN = Symbol.for('prisma:value-origin');

const originOf = (value: Value<unknown>) =>
  (value as unknown as Record<symbol, { readonly dependencies: readonly unknown[] }>)[ORIGIN]!;

describe('resolve()', () => {
  test('resolve() returns a frozen computed value whose dependencies are a frozen copy', () => {
    const dependencies: Value<unknown>[] = [environmentFacts.name];
    const value = resolve(dependencies, ([name]) => `hello from ${String(name)}`);

    dependencies.push(environmentFacts.name);

    expect(Object.isFrozen(value)).toBe(true);
    const origin = originOf(value);
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin.dependencies)).toBe(true);
    expect(origin.dependencies).toEqual([environmentFacts.name]);
    expect(origin.dependencies).not.toBe(dependencies);
  });

  test('resolve() rejects a non-array, a non-value dependency and a non-function', () => {
    expect(() => resolve('nope' as never, () => 'x')).toThrow(
      new Error('resolve() requires a tuple of values as its first argument.'),
    );
    expect(() => resolve([environmentFacts.name, 'plain'] as never, () => 'x')).toThrow(
      new Error(
        'resolve() dependency at index 1 is not a value — list environment.name or another resolve() result.',
      ),
    );
    expect(() => resolve([environmentFacts.name], 'nope' as never)).toThrow(
      new Error('resolve() requires a function as its second argument.'),
    );
  });
});

describe('isValue()', () => {
  test('isValue() recognises environment.name and a resolve() result and nothing else', () => {
    expect(isValue(environmentFacts.name)).toBe(true);
    expect(isValue(resolve([environmentFacts.name], ([name]) => name))).toBe(true);
    expect(isValue({ kind: 'computed' })).toBe(false);
    expect(isValue(null)).toBe(false);
    expect(isValue(secretSource({ name: 'X' }))).toBe(false);
  });
});
