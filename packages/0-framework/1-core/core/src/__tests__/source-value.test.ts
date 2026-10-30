import { describe, expect, test } from 'bun:test';
import { string } from '../config.ts';
import { Load, LoadError } from '../graph.ts';
import {
  isParamSource,
  isRuntimeValue,
  isSecretSource,
  module,
  paramSource,
  secretSource,
  service,
} from '../node.ts';
import { environmentFacts, isValue, resolve } from '../value.ts';
import { anyInputSchema } from './helpers.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const echoService = () =>
  service({
    name: 'echo',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: { label: string() },
    input: anyInputSchema,
    build,
  });

const loadError = (run: () => unknown): LoadError => {
  try {
    run();
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error('expected a LoadError');
};

const pointer = (name: string) => secretSource({ name }, { label: `envSecret('${name}')` });
const variable = (name: string) =>
  paramSource({ name }, { label: `envParam('${name}')`, poolKey: name });

describe('building a source', () => {
  test('secretSource() and paramSource() return values that are also sources', () => {
    const secret = pointer('X');
    const param = variable('Y');

    expect([isValue(secret), isSecretSource(secret)]).toEqual([true, true]);
    expect([isValue(param), isParamSource(param)]).toEqual([true, true]);
    expect(secret.payload).toEqual({ name: 'X' });
    expect(param.payload).toEqual({ name: 'Y' });
    expect(Object.keys(secret)).toEqual(['payload']);
    expect(Object.keys(param)).toEqual(['payload']);
    expect(Object.isFrozen(secret)).toBe(true);
    expect(Object.isFrozen(param)).toBe(true);
  });

  test("a source's JSON is what it was before sources were values", () => {
    expect(JSON.stringify(secretSource({ name: 'X' }))).toBe('{"payload":{"name":"X"}}');
  });

  test('a spread copy of a source is still a value and a source', () => {
    const copy = { ...pointer('X'), extra: 1 };

    expect(isValue(copy)).toBe(true);
    expect(isSecretSource(copy)).toBe(true);
    expect(copy.payload).toEqual({ name: 'X' });
  });

  test('paramSource() refuses a pool key beside redacted, and an empty label or pool key', () => {
    expect(() => paramSource({}, { poolKey: 'X', redacted: true })).toThrow(
      'paramSource() takes poolKey, for a value known at deploy, or redacted, for a secret known only at boot, not both.',
    );
    expect(() => paramSource({}, { label: '' })).toThrow(
      'paramSource() label must be a non-empty string.',
    );
    expect(() => secretSource({}, { label: '' })).toThrow(
      'secretSource() label must be a non-empty string.',
    );
    expect(() => paramSource({}, { poolKey: '' })).toThrow(
      'paramSource() poolKey must be a non-empty string.',
    );
  });

  test('isRuntimeValue() is true for a secret source and a param source without a pool key, and false otherwise', () => {
    expect(isRuntimeValue(pointer('X'))).toBe(true);
    expect(isRuntimeValue(paramSource({}, { redacted: true }))).toBe(true);
    expect(isRuntimeValue(paramSource({ name: 'X' }))).toBe(true);
    expect(isRuntimeValue(variable('X'))).toBe(false);
    expect(isRuntimeValue(environmentFacts.name)).toBe(false);
    expect(isRuntimeValue(resolve([environmentFacts.name], ([name]) => name))).toBe(false);
    expect(isRuntimeValue('X')).toBe(false);
    expect(isRuntimeValue(null)).toBe(false);
    expect(isRuntimeValue({ payload: { name: 'X' } })).toBe(false);
  });
});

describe('reading a source', () => {
  test('turning a pointer into text or a number fails naming it and saying it is known only at boot', () => {
    const s = pointer('X') as never as { toString(): string; valueOf(): unknown };
    const message = (what: string) =>
      `envSecret('X') is known only at boot: the deploy holds a pointer to it, never its value, and ${what}. ` +
      'A module body can only pass it on, into a provision() binding; to compute with the value, do it in the service that reads it.';
    const text = 'it was turned into text (a template literal or String())';
    const operations: [() => unknown, string][] = [
      [() => String(s), text],
      [() => `${s}`, text],
      [
        () => (s as never as number) * 2,
        'it was turned into a number (arithmetic, or a comparison such as <)',
      ],
      [() => (s as never as number) + 1, 'it was combined with + or compared with =='],
      [() => s.toString(), 'its toString() was called'],
      [() => s.valueOf(), 'its valueOf() was called'],
    ];

    for (const [operation, what] of operations) {
      const error = loadError(operation);
      expect(error.message).toBe(message(what));
    }
  });

  test('turning envParam() into text in a module body fails as a value', () => {
    const root = module('shop', ({ provision }) => {
      provision(echoService(), { input: { greeting: `${variable('G')}` as never } });
    });

    expect(loadError(() => Load(root)).message).toBe(
      "envParam('G') is a value, not its real value, and it was turned into text (a template " +
        'literal or String()). A module body can only pass it on: into a provision() binding or ' +
        "as a resolve() dependency. To compute with it, list it: resolve([envParam('G')], ([v]) => …).",
    );
  });
});
