import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { POINTER } from './pointer.ts';
import { isSecretString, SecretBox } from './secret.ts';
import { field, secretString } from './zod.ts';

const plain = Object.freeze({ [POINTER]: 'plain' as const });
const secret = Object.freeze({ [POINTER]: 'secret' as const });

const messages = (schema: z.ZodType, value: unknown): string[] => {
  const out = schema.safeParse(value);
  return out.success ? [] : out.error.issues.map((issue) => issue.message);
};

const inners = {
  string: () => z.string(),
  url: () => z.string().url(),
  transform: () => z.string().transform(Number),
  mode: () => z.enum(['resend', 'smtp', 'none']),
  number: () => z.number(),
  min: () => z.string().min(3),
};

const wrongTypes = [3, true, { a: 1 }, new SecretBox('x'), secret];
const refused: [() => z.ZodType, string][] = [
  [inners.url, 'no'],
  [inners.mode, 'smpt'],
  [inners.min, 'no'],
];

const wrappedMessages = (inner: () => z.ZodType, value: unknown) =>
  messages(z.object({ u: field(inner()) }), value);

const compare = (inner: () => z.ZodType, value: unknown) => {
  expect(wrappedMessages(inner, value)).toEqual(messages(z.object({ u: inner() }), value));
};

describe('secretString', () => {
  const schema = z.object({ k: secretString() });

  test('accepts a secret box, and the validated field is a box that exposes its value', () => {
    const { k } = schema.parse({ k: new SecretBox('v') });
    if (!isSecretString(k)) throw new Error('expected a SecretString box');
    expect(k.expose()).toBe('v');
  });

  test('accepts a secret pointer', () => {
    expect<unknown>(schema.parse({ k: secret }).k).toBe(secret);
  });

  test('refuses a plain string, naming its kind and never its value', () => {
    expect(messages(schema, { k: 'sk_live_SENTINEL' })).toEqual([
      'must be a SecretString box — bind this field to a secret (was a string)',
    ]);
    expect(JSON.stringify(schema.safeParse({ k: 'sk_live_SENTINEL' }).error?.issues)).not.toContain(
      'sk_live_SENTINEL',
    );
  });

  test('refuses a plain pointer, saying it is not a secret', () => {
    expect(messages(schema, { k: plain })).toEqual([
      'must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)',
    ]);
  });
});

describe('field', () => {
  test('a wrapped field accepts a plain pointer and returns it as itself', () => {
    expect<unknown>(z.object({ from: field(z.string()) }).parse({ from: plain }).from).toBe(plain);
  });

  test('a wrapped field passes text through the inner schema, transforms included', () => {
    expect(z.object({ port: field(z.string().transform(Number)) }).parse({ port: '4' })).toEqual({
      port: 4,
    });
  });

  test("a value of the wrong type gets the plain field's error", () => {
    for (const inner of Object.values(inners)) {
      for (const value of wrongTypes) {
        compare(inner, { u: value });
      }
    }
  });

  test("a value the inner schema refuses gets the plain field's error", () => {
    for (const [inner, value] of refused) compare(inner, { u: value });
    expect(messages(z.object({ u: field(inners.url()) }), { u: 'no' })).toEqual(['Invalid URL']);
  });

  test("a missing key gets the plain field's error", () => {
    for (const inner of Object.values(inners)) compare(inner, {});
    expect(messages(z.object({ u: field(inners.string()) }), {})).toEqual([
      'Invalid input: expected string, received undefined',
    ]);
  });

  test('a wrong type names the inner type', () => {
    expect(messages(z.object({ from: field(z.string()) }), { from: 3 })).toEqual([
      'Invalid input: expected string, received number',
    ]);
  });

  test('no message names a Composer class', () => {
    const seen: string[] = [];
    for (const inner of Object.values(inners)) {
      for (const value of wrongTypes) seen.push(...wrappedMessages(inner, { u: value }));
      seen.push(...wrappedMessages(inner, {}));
    }
    for (const [inner, value] of refused) seen.push(...wrappedMessages(inner, { u: value }));
    expect(seen.length).toBeGreaterThan(30);
    for (const message of seen) {
      expect(message).not.toContain('Pointer');
      expect(message).not.toContain('Source');
    }
  });

  test('optional works inside and outside the wrapper', () => {
    expect(z.object({ from: field(z.string()).optional() }).parse({})).toEqual({});
    expect<unknown>(z.object({ from: field(z.string().optional()) }).parse({})).toEqual({});
  });

  test('a default works outside the wrapper', () => {
    expect(z.object({ from: field(z.string()).default('d') }).parse({})).toEqual({ from: 'd' });
  });
});
