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

  test('rejects an empty name', () => {
    expect(() => envParam('')).toThrow(
      "envParam() requires a non-empty platform variable name, e.g. envParam('API_KEY').",
    );
  });

  test.each(['api_key', 'Api_Key', '_TOKEN', '1TOKEN', 'API-KEY'])(
    'rejects %s, which is not an upper-case platform variable name',
    (name) => {
      expect(() => envParam(name)).toThrow(
        `envParam name "${name}" is not a platform variable name: it must match ^[A-Z][A-Z0-9_]*$, an upper-case letter followed by upper-case letters, digits and underscores. The platform accepts only upper-case letters, digits and underscores in a key. Refusing a leading underscore, which the platform accepts, is Composer's own rule: shells and tools use names that start with an underscore for their own variables.`,
      );
    },
  );

  test.each([
    ['COMPOSER_X', "names starting with COMPOSER_ are Composer's own platform variables."],
    [
      'DATABASE_URL',
      'Prisma Cloud sets and manages DATABASE_URL and DATABASE_URL_POOLED itself. Declare the database your service uses and read its url from that connection.',
    ],
    [
      'DATABASE_URL_POOLED',
      'Prisma Cloud sets and manages DATABASE_URL and DATABASE_URL_POOLED itself. Declare the database your service uses and read its url from that connection.',
    ],
    ['PORT', "boot sets PORT to the service's port."],
    [
      'PATH',
      'under prisma dev the local target sets PATH and HOME from your shell, so a value on the platform would never be seen locally.',
    ],
    [
      'HOME',
      'under prisma dev the local target sets PATH and HOME from your shell, so a value on the platform would never be seen locally.',
    ],
  ])('rejects the reserved name %s, saying why', (name, reason) => {
    expect(() => envParam(name)).toThrow(`envParam name "${name}" is reserved: ${reason}`);
  });

  test('accepts HOST and a name with digits and underscores', () => {
    expect(() => envParam('HOST')).not.toThrow();
    expect(() => envParam('STRIPE_KEY_2')).not.toThrow();
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
  test("envParam() in a module's input is the variable's value in the app configuration", () => {
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

    const graph = Load(root, { configuration: { APP_ORIGIN: 'https://shop.example' } });

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
