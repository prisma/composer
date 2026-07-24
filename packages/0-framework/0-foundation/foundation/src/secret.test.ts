import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { isSecretString, SecretBox } from './secret.ts';

// What a second copy of secret.ts in a bundle produces: a different class
// object whose instances carry the same registered brand.
const SECRET_BOX: unique symbol = Symbol.for('prisma:secret-box') as never;

class DuplicatedModuleSecretBox<T> {
  readonly [SECRET_BOX] = true;
  readonly #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  expose(): T {
    return this.#value;
  }
  toString(): string {
    return '[REDACTED]';
  }
}

describe('SecretBox', () => {
  test('expose() round-trips the wrapped value', () => {
    expect(new SecretBox('sk_live_abc').expose()).toBe('sk_live_abc');
    expect(new SecretBox(42).expose()).toBe(42);
  });

  test('String() and template interpolation redact', () => {
    const box = new SecretBox('sk_live_abc');
    expect(String(box)).toBe('[REDACTED]');
    expect(`${box}`).toBe('[REDACTED]');
    expect(box.toString()).toBe('[REDACTED]');
  });

  test('valueOf redacts (arithmetic/coercion never sees the value)', () => {
    const box = new SecretBox('sk_live_abc');
    expect(box.valueOf()).toBe('[REDACTED]');
    // biome-ignore lint/style/useTemplate: exercising `+` coercion (valueOf) on purpose.
    expect(box + '').toBe('[REDACTED]');
  });

  test('JSON.stringify redacts', () => {
    const box = new SecretBox('sk_live_abc');
    expect(JSON.stringify(box)).toBe('"[REDACTED]"');
    expect(JSON.stringify({ key: box })).toBe('{"key":"[REDACTED]"}');
  });

  test('console/util.inspect redacts (so an accidental log cannot leak it)', () => {
    const box = new SecretBox('sk_live_abc');
    expect(inspect(box)).toBe('[REDACTED]');
    expect(inspect({ key: box })).toContain('[REDACTED]');
    expect(inspect(box)).not.toContain('sk_live');
  });
});

describe('isSecretString', () => {
  test('true for a SecretBox instance', () => {
    expect(isSecretString(new SecretBox('sk_live_abc'))).toBe(true);
    expect(isSecretString(new SecretBox(''))).toBe(true);
  });

  test('true for a box built by a duplicated copy of this module', () => {
    expect(isSecretString(new DuplicatedModuleSecretBox('sk_live_abc'))).toBe(true);
  });

  test('false for an unbranded look-alike that exposes and redacts', () => {
    const lookalike = {
      expose: () => 'sk_live_abc',
      toString: () => '[REDACTED]',
    };
    expect(isSecretString(lookalike)).toBe(false);
  });

  test('false for plain values and non-redacting lookalikes', () => {
    expect(isSecretString('sk_live_abc')).toBe(false);
    expect(isSecretString(undefined)).toBe(false);
    expect(isSecretString(null)).toBe(false);
    expect(isSecretString({})).toBe(false);
    expect(isSecretString({ expose: () => 'x', toString: () => 'x' })).toBe(false);
  });
});
