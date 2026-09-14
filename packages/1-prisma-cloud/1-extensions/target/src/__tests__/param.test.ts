import { describe, expect, test } from 'bun:test';
import { isParamSource, paramSource } from '@internal/core';
import { envParam, isEnvParamSource, paramBindingFor, paramName } from '../param.ts';

describe('envParam (Prisma Cloud param source)', () => {
  test('builds an opaque param source; paramName reads its env-var name back', () => {
    const source = envParam('APP_ORIGIN');
    expect(isParamSource(source)).toBe(true);
    expect(isEnvParamSource(source)).toBe(true);
    expect(paramName({ serviceAddress: 'web', slot: 'appOrigin', binding: source })).toBe(
      'APP_ORIGIN',
    );
  });

  test('rejects empty, COMPOSER_-prefixed, and reserved DATABASE_URL names — parity with envSecret', () => {
    expect(() => envParam('')).toThrow(/non-empty/);
    expect(() => envParam('COMPOSER_X')).toThrow(/COMPOSER_/);
    expect(() => envParam('DATABASE_URL')).toThrow(/reserved/);
    expect(() => envParam('DATABASE_URL_POOLED')).toThrow(/reserved/);
  });

  test('paramName rejects a slot bound to a source not built by envParam', () => {
    // A user who bypasses envParam and binds a raw core paramSource: the
    // payload has no envParam brand, so there is no platform name to read.
    const source = paramSource('APP_ORIGIN');
    const read = () => paramName({ serviceAddress: 'web', slot: 'appOrigin', binding: source });
    expect(read).toThrow(/param slot "appOrigin" of service "web".*not created by envParam/);
    expect(read).toThrow(/envParam\('NAME'\) from @prisma\/composer-prisma-cloud/);
  });

  test('paramName rejects a literal-bound slot', () => {
    const read = () =>
      paramName({ serviceAddress: 'web', slot: 'appOrigin', binding: 'https://example.com' });
    expect(read).toThrow(/not created by envParam/);
  });

  test('isEnvParamSource is false for a literal, a foreign paramSource, and a raw value', () => {
    expect(isEnvParamSource('https://example.com')).toBe(false);
    expect(isEnvParamSource(paramSource('APP_ORIGIN'))).toBe(false);
    expect(isEnvParamSource(undefined)).toBe(false);
  });

  test('paramBindingFor finds the manifest entry by address + slot', () => {
    const source = envParam('APP_ORIGIN');
    const entry = { serviceAddress: 'web', slot: 'appOrigin', binding: source };
    expect(paramBindingFor([entry], 'web', 'appOrigin')).toBe(entry);
  });

  test('paramBindingFor throws loudly when the manifest has no matching entry', () => {
    expect(() => paramBindingFor([], 'web', 'appOrigin')).toThrow(
      /param slot "appOrigin" of "web" resolved to a source but has no bound entry/,
    );
  });
});
