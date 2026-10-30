import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { POINTER } from './pointer.ts';
import { SecretBox } from './secret.ts';
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

const seen: string[] = [];
const compare = (inner: () => z.ZodType, value: unknown) => {
  const wrapped = messages(z.object({ u: field(inner()) }), value);
  seen.push(...wrapped);
  expect(wrapped).toEqual(messages(z.object({ u: inner() }), value));
};

describe('secretString', () => {
  const schema = z.object({ k: secretString() });

  test('accepts a secret box, and the validated field reads back as a SecretString', () => {
    expect(schema.parse({ k: new SecretBox('v') }).k.expose()).toBe('v');
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
      for (const value of [3, true, { a: 1 }, new SecretBox('x'), secret]) {
        compare(inner, { u: value });
      }
    }
  });

  test("a value the inner schema refuses gets the plain field's error", () => {
    compare(inners.url, { u: 'no' });
    compare(inners.mode, { u: 'smpt' });
    compare(inners.min, { u: 'no' });
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
    expect(seen.length).toBeGreaterThan(0);
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
