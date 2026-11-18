import { describe, expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import { comparableProps } from '../comparable-props.ts';
import { paramSource, secretSource } from '../node.ts';
import { environmentFacts, resolve } from '../value.ts';

const same = (a: unknown, b: unknown): boolean =>
  isDeepStrictEqual(structuredClone(comparableProps(a)), comparableProps(b));

describe('comparableProps()', () => {
  test('a param source and a secret source with the same payload differ', () => {
    const payload = { name: 'EMAIL_FROM' };

    expect(same({ source: paramSource(payload) }, { source: secretSource(payload) })).toBe(false);
    expect(
      same({ source: paramSource(payload) }, { source: paramSource(payload, { redacted: true }) }),
    ).toBe(false);
    expect(
      same(
        { source: paramSource(payload, { label: 'a' }) },
        { source: paramSource(payload, { label: 'b' }) },
      ),
    ).toBe(false);
  });

  test('two equal sources are the same after a structured clone', () => {
    const props = () => ({
      plain: paramSource({ name: 'EMAIL_FROM' }, { label: 'the sender' }),
      secret: secretSource({ name: 'API_KEY' }, { secretsKey: 'API_KEY' }),
    });

    expect(same(props(), props())).toBe(true);
  });

  test('a derived value is described as derived, unlike a source', () => {
    const derived = resolve([environmentFacts.name], ([name]) => `${name}-x`);

    expect(comparableProps({ derived })).toEqual({
      object: { derived: { value: { derived: 'computed' } } },
    });
    expect(same({ v: derived }, { v: paramSource({}) })).toBe(false);
  });

  test('dates, regular expressions, maps and sets keep their content', () => {
    expect(same({ at: new Date(1) }, { at: new Date(2) })).toBe(false);
    expect(same({ at: new Date(1) }, { at: new Date(1) })).toBe(true);
    expect(same({ match: /a/ }, { match: /b/ })).toBe(false);
    expect(same({ map: new Map([['a', 1]]) }, { map: new Map([['a', 2]]) })).toBe(false);
    expect(same({ set: new Set([1]) }, { set: new Set([2]) })).toBe(false);
    expect(same({ set: new Set([1]) }, { set: new Set([1]) })).toBe(true);
  });

  test('a tagged form never makes a plain object equal to a special value', () => {
    expect(same({ at: { date: 1 } }, { at: new Date(1) })).toBe(false);
    expect(same({ list: [1] }, { list: { 0: 1 } })).toBe(false);
  });

  test('nested plain objects compare by content', () => {
    expect(same({ schema: { type: 'string' } }, { schema: { type: 'string' } })).toBe(true);
    expect(same({ schema: { type: 'string' } }, { schema: { type: 'number' } })).toBe(false);
  });

  test('a cycle ends, and a shared object that is not a cycle is described in full each time', () => {
    const looped: Record<string, unknown> = { name: 'x' };
    looped['self'] = looped;
    const shared = { name: 'y' };

    expect(comparableProps(looped)).toEqual({
      object: { name: 'x', self: { cycle: true } },
    });
    expect(comparableProps({ a: shared, b: shared })).toEqual({
      object: { a: { object: { name: 'y' } }, b: { object: { name: 'y' } } },
    });
  });

  test('a class instance keeps its class name and fields', () => {
    class Box {
      constructor(readonly size: number) {}
    }

    expect(same({ box: new Box(1) }, { box: new Box(2) })).toBe(false);
    expect(same({ box: new Box(1) }, { box: { size: 1 } })).toBe(false);
  });
});
