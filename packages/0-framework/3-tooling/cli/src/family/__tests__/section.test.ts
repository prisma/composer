/**
 * The `composer` section's validator. Two properties matter beyond the field
 * rules: it must accept `undefined` (absence is the common case and is the
 * validator's to own, not the engine's), and it must never throw — the engine
 * turns a throwing validator into an internal error, which would report a
 * user's typo as a bug in composer.
 */
import { describe, expect, test } from 'bun:test';
import { composerSection } from '../section.ts';

describe('composerSection.validate()', () => {
  test('absence is valid and yields an empty section', () => {
    const result = composerSection.validate(undefined);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({});
    expect(result.diagnostics).toEqual([]);
  });

  test('an empty section is valid — every field is optional', () => {
    const result = composerSection.validate({});
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({});
  });

  test('a configPath comes through', () => {
    const result = composerSection.validate({ configPath: './app/prisma-composer.config.ts' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ configPath: './app/prisma-composer.config.ts' });
  });

  test('a non-object section fails with a field diagnostic', () => {
    for (const raw of ['nope', 42, [], null]) {
      const result = composerSection.validate(raw);
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]?.code).toBe('CONFIG.FIELD_INVALID');
      expect(result.diagnostics[0]?.severity).toBe('error');
    }
  });

  test('a non-string or empty configPath fails', () => {
    for (const configPath of [42, '', {}, true]) {
      const result = composerSection.validate({ configPath });
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]?.summary).toContain('configPath');
    }
  });

  test('an unrecognized field warns but does not fail — a newer config still runs', () => {
    const result = composerSection.validate({ configPath: 'x.ts', stage: 'prod' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ configPath: 'x.ts' });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.severity).toBe('warn');
    expect(result.diagnostics[0]?.summary).toContain('stage');
  });

  test('every diagnostic carries the nextActions the engine renders', () => {
    const result = composerSection.validate({ configPath: 42 });
    expect(result.diagnostics[0]?.nextActions.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.nextActions[0]?.label).toBeTruthy();
  });

  test('the validator never throws, whatever it is handed', () => {
    const hostile = [
      Symbol('x'),
      () => undefined,
      new Proxy({}, { get: () => undefined }),
      Object.create(null),
      // Traps that throw rather than answer: reading the fields is itself
      // what fails, so a validator that inspects before it guards dies here.
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('ownKeys trap');
          },
        },
      ),
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('get trap');
          },
        },
      ),
    ];
    for (const raw of hostile) {
      expect(() => composerSection.validate(raw)).not.toThrow();
    }
  });

  test('a section whose own fields cannot be read fails with a field diagnostic', () => {
    const result = composerSection.validate(
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('ownKeys trap');
          },
        },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('CONFIG.FIELD_INVALID');
    expect(result.diagnostics[0]?.severity).toBe('error');
  });

  test('the section is named `composer`', () => {
    expect(composerSection.name).toBe('composer');
  });
});
