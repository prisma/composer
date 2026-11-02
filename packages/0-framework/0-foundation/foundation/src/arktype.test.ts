import { describe, expect, test } from 'bun:test';
import { type Type, type } from 'arktype';
import { field, secretString } from './arktype.ts';
import { isPlainPointer, POINTER } from './pointer.ts';
import { isSecretString, SecretBox } from './secret.ts';

const plain = Object.freeze({ [POINTER]: 'plain' as const });
const secret = Object.freeze({ [POINTER]: 'secret' as const });

const messages = (schema: (value: unknown) => unknown, value: unknown): string[] => {
  const out = schema(value);
  return out instanceof type.errors ? out.map((error) => error.message) : [];
};

const inners = {
  string: () => type('string'),
  url: () => type('string.url'),
  integer: () => type('string.integer.parse'),
  mode: () => type("'resend' | 'smtp' | 'none'"),
  number: () => type('number'),
};
const allInners = Object.values(inners) as (() => Type<unknown>)[];

describe('secretString', () => {
  const schema = type({ signingKey: secretString() });

  test('accepts a secret box, and the validated field is a box that exposes its value', () => {
    const out = schema({ signingKey: new SecretBox('sk_live_abc') });
    if (out instanceof type.errors) throw new Error(out.summary);
    const { signingKey } = out;
    if (!isSecretString(signingKey)) throw new Error('expected a SecretString box');
    expect(signingKey.expose()).toBe('sk_live_abc');
  });

  test('rejects a plain string — a credential cannot arrive unboxed', () => {
    const out = schema({ signingKey: 'sk_live_abc' });
    expect(out).toBeInstanceOf(type.errors);
    expect(String(out)).toContain('signingKey must be a SecretString box');
  });

  test("the refusal names the value's kind, never the value", () => {
    const out = schema({ signingKey: 'sk_live_SENTINEL' });
    expect(String(out)).toBe(
      'signingKey must be a SecretString box — bind this field to a secret (was a string)',
    );
  });

  test('rejects an unbranded look-alike', () => {
    const lookalike = { expose: () => 'sk_live_abc', toString: () => '[REDACTED]' };
    expect(schema({ signingKey: lookalike })).toBeInstanceOf(type.errors);
  });

  test('accepts a secret pointer', () => {
    const out = schema({ signingKey: secret });
    if (out instanceof type.errors) throw new Error(out.summary);
    expect<unknown>(out.signingKey).toBe(secret);
  });

  test('refuses a plain pointer, saying it is not a secret', () => {
    expect(String(schema({ signingKey: plain }))).toBe(
      'signingKey must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)',
    );
  });
});

describe('field', () => {
  test('a wrapped field accepts a plain pointer and returns it as itself', () => {
    const out = type({ from: field(type('string')) })({ from: plain });
    if (out instanceof type.errors) throw new Error(out.summary);
    expect<unknown>(out.from).toBe(plain);
  });

  test('a wrapped field passes text through the inner schema, transforms included', () => {
    expect(type({ port: field(type('string.integer.parse')) })({ port: '4' })).toEqual({ port: 4 });
  });

  test("a value of the wrong type gets the plain field's error", () => {
    for (const inner of allInners) {
      for (const value of [3, true, { a: 1 }, new SecretBox('x'), secret]) {
        expect(messages(type({ u: field(inner()) }), { u: value })).toEqual(
          messages(type({ u: inner() }), { u: value }),
        );
      }
    }
  });

  test("a value the inner schema refuses gets the plain field's error", () => {
    const cases = [
      [inners.url, 'no'],
      [inners.integer, 'no'],
      [inners.mode, 'smpt'],
    ] as [() => Type<unknown>, string][];
    for (const [inner, value] of cases) {
      expect(messages(type({ u: field(inner()) }), { u: value })).toEqual(
        messages(type({ u: inner() }), { u: value }),
      );
    }
    expect(messages(type({ u: field(inners.url()) }), { u: 'no' })).toEqual([
      'u must be a URL string (was "no")',
    ]);
  });

  test('a wrong type names the inner type, not a Composer class', () => {
    expect(messages(type({ from: field(type('string')) }), { from: 3 })).toEqual([
      'from must be a string (was a number)',
    ]);
  });

  test('a missing key names both branches, and no Composer class', () => {
    expect(messages(type({ from: field(type('string')) }), {})).toEqual([
      'from must be a string or an object (was missing)',
    ]);
    for (const inner of allInners) {
      const found = messages(type({ u: field(inner()) }), {});
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('(was missing)');
      for (const word of ['Pointer', 'Source', 'instance of']) {
        expect(found[0]).not.toContain(word);
      }
    }
  });

  test('a transforming leaf can be wrapped', () => {
    expect(() => field(type('string.integer.parse'))).not.toThrow();
    expect(() => field(type('string.trim'))).not.toThrow();
  });

  test('a default goes outside the wrapper', () => {
    expect(type({ from: field(type('string')).default('d') })({})).toEqual({ from: 'd' });
  });

  test('an optional key can be left out', () => {
    expect(type({ 'from?': field(type('string')) })({})).toEqual({});
  });

  test('a copy ArkType makes of a pointer keeps its kind', () => {
    const out = type({ from: field(type('string')), n: 'string.integer.parse' })({
      from: plain,
      n: '1',
    });
    if (out instanceof type.errors) throw new Error(out.summary);
    expect<unknown>(out.from).not.toBe(plain);
    expect(isPlainPointer(out.from)).toBe(true);
  });

  test('an object schema with a transform inside cannot be wrapped', () => {
    expect(() => field(type({ port: 'string.integer.parse' }))).toThrow(
      'An unordered union of a type including a morph and a type with overlapping input is indeterminate',
    );
  });

  test('a wrapped object schema reports where inside it the error is', () => {
    const inner = () => type({ a: 'string', 'b?': { c: 'number' }, 'l?': 'number[]' });
    expect(messages(type({ u: field(inner()) }), { u: { a: 1 } })).toEqual([
      'u.a must be a string (was a number)',
    ]);
    expect(
      messages(type({ x: { u: field(inner()) } }), { x: { u: { a: 'y', l: [1, 'z'] } } }),
    ).toEqual(['x.u.l[1] must be a number (was a string)']);
    expect(messages(type({ u: field(inner()) }), { u: { a: 1, b: { c: 'x' } } })).toEqual([
      'u.a must be a string (was a number); u.b.c must be a number (was a string)',
    ]);
    for (const value of [{ u: { a: 1 } }, { u: 3 }, {}]) {
      expect(messages(type({ u: field(inner()) }), value)).toEqual(
        messages(type({ u: inner() }), value),
      );
    }
  });
});
