import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { secretString } from './arktype.ts';
import { POINTER } from './pointer.ts';
import { SecretBox } from './secret.ts';

const plain = Object.freeze({ [POINTER]: 'plain' as const });
const secret = Object.freeze({ [POINTER]: 'secret' as const });

describe('secretString', () => {
  const schema = type({ signingKey: secretString() });

  test('accepts a secret box, and the validated field reads back as a SecretString', () => {
    const out = schema({ signingKey: new SecretBox('sk_live_abc') });
    if (out instanceof type.errors) throw new Error(out.summary);
    // `.expose()` compiles only because the field's inferred type is SecretString.
    expect(out.signingKey.expose()).toBe('sk_live_abc');
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
