import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { SecretBox } from './secret.ts';

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
