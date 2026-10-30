import { describe, expect, test } from 'bun:test';
import {
  isParamSource,
  isPlainPointer,
  isSecretPointer,
  Load,
  module,
  paramSource,
  service,
} from '@internal/core';
import { type } from 'arktype';
import {
  envParam,
  generatedParam,
  isEnvParamSource,
  paramBindingFor,
  paramName,
  serviceOrigin,
} from '../param.ts';

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

describe('envParam() in a module input', () => {
  test("envParam() in a module's input is the variable's value in the config pool", () => {
    const web = service({
      name: 'web',
      extension: '@prisma/composer-prisma-cloud',
      type: 'compute',
      inputs: {},
      params: {},
      input: type({ appOrigin: 'string' }),
      build: {
        extension: '@prisma/composer/node',
        type: 'node',
        module: 'file:///test/service.ts',
        entry: 'server.js',
      },
    });
    const site = module(
      'site',
      { input: type({ appOrigin: 'string' }) },
      ({ input, provision }) => {
        provision(web, { input: { appOrigin: input.appOrigin } });
      },
    );
    const root = module('shop', ({ provision }) => {
      provision(site, { input: { appOrigin: envParam('APP_ORIGIN') } });
    });

    const graph = Load(root, { configPool: { APP_ORIGIN: 'https://shop.example' } });

    expect(graph.inputBindings[0]?.binding).toEqual({ appOrigin: 'https://shop.example' });
  });
});

describe('the kind of pointer each source is', () => {
  test('serviceOrigin() and a plain generatedParam() are plain pointers, a redacted generatedParam() is a secret pointer, and envParam() is no pointer', () => {
    expect(isPlainPointer(serviceOrigin('shop.web'))).toBe(true);
    expect(isPlainPointer(generatedParam({ redacted: false }))).toBe(true);
    expect(isSecretPointer(generatedParam())).toBe(true);
    expect(isPlainPointer(envParam('X'))).toBe(false);
    expect(isSecretPointer(envParam('X'))).toBe(false);
  });
});
