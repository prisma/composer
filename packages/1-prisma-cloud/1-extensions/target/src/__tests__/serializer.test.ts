import { beforeEach, describe, expect, test } from 'bun:test';
import { type ConfigParam, number, service, string } from '@internal/core';
import { configKey } from '../config-key.ts';
import {
  deserialize,
  encode,
  generatedParamVarName,
  inputKey,
  readOrigin,
  stashRows,
} from '../serializer.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const svc = (extra: Record<string, ConfigParam> = {}) =>
  service({
    name: 'web',
    extension: '@prisma/composer-prisma-cloud',
    type: 'compute',
    inputs: {},
    params: { appOrigin: string(), ...extra },
    build,
  });

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): Promise<T> {
  const previous = new Map(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('deserialize', () => {
  const address = 'web';
  const key = configKey(address, { owner: 'service', name: 'appOrigin' });

  beforeEach(() => {
    delete process.env[key];
  });

  test('a per-key param row is JSON-decoded and validated with the param schema', async () => {
    await withEnv({ [key]: encode('service', 'https://literal.example.com') }, () => {
      const config = deserialize(svc(), address);
      expect(config.service['appOrigin']).toBe('https://literal.example.com');
    });
  });
});

describe('the framework-resolved origin row rides stashRows; readOrigin reads it back', () => {
  const addressKey = configKey('web', { owner: 'service', name: 'ORIGIN' });
  const freeKey = configKey('', { owner: 'service', name: 'ORIGIN' });
  const bare = () =>
    service({
      name: 'web',
      extension: '@prisma/composer-prisma-cloud',
      type: 'compute',
      inputs: {},
      params: {},
      build,
    });

  test('stashRows re-emits the address-scoped ORIGIN row address-free when present — the boot half of the round-trip', () => {
    const rows = stashRows(bare(), 'web', {
      [addressKey]: encode('service', 'https://web.example.com'),
    });
    expect(rows[freeKey]).toBe(encode('service', 'https://web.example.com'));
  });

  test('stashRows writes nothing for ORIGIN when the address-scoped row is absent', () => {
    expect(freeKey in stashRows(bare(), 'web', {})).toBe(false);
  });

  test('readOrigin throws the pinned message when COMPOSER_ORIGIN is unset', async () => {
    await withEnv({ [freeKey]: undefined }, () => {
      expect(() => readOrigin()).toThrow(
        "this service's origin is not available (env COMPOSER_ORIGIN is unset) — a deployed environment writes it automatically; a local harness must supply it like any other config value (set COMPOSER_ORIGIN to the JSON-encoded origin URL).",
      );
    });
  });

  test('readOrigin returns the decoded string when COMPOSER_ORIGIN is set — the idiom a local harness supplies it by', async () => {
    await withEnv({ [freeKey]: encode('service', 'https://web.example.com') }, () => {
      expect(readOrigin()).toBe('https://web.example.com');
    });
  });
});

describe('stashRows — what run() writes, as a pure function of an environment (ADR-0056)', () => {
  const address = 'my-shop.web';
  const node = () =>
    service({
      name: 'web',
      extension: '@prisma/composer-prisma-cloud',
      type: 'compute',
      inputs: {},
      params: { port: number({ default: 3000 }), appOrigin: string() },
      input: {
        '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
      },
      build,
    });
  const env = {
    [configKey(address, { owner: 'service', name: 'port' })]: '3007',
    [configKey(address, { owner: 'service', name: 'appOrigin' })]: encode(
      'service',
      'https://shop.example',
    ),
    [inputKey(address)]: '{"apiKey":{"$platform":{"name":"STRIPE_KEY","secret":true}}}',
  };

  test('re-keys every row address-free and adds PORT and the default HOST', () => {
    expect(stashRows(node(), address, env)).toEqual({
      [configKey('', { owner: 'service', name: 'port' })]: '3007',
      [configKey('', { owner: 'service', name: 'appOrigin' })]: '"https://shop.example"',
      [inputKey('')]: '{"apiKey":{"$platform":{"name":"STRIPE_KEY","secret":true}}}',
      PORT: '3007',
      HOST: '0.0.0.0',
    });
  });

  test('keeps a HOST the environment sets', () => {
    expect(stashRows(node(), address, { ...env, HOST: '127.0.0.1' })['HOST']).toBe('127.0.0.1');
  });

  test('reads only the environment it is given, and writes nothing to process.env', async () => {
    await withEnv({ PORT: undefined, COMPOSER_PORT: undefined }, () => {
      stashRows(node(), address, env);
      expect(process.env['PORT']).toBeUndefined();
      expect(process.env['COMPOSER_PORT']).toBeUndefined();
    });
  });

  test("throws run()'s boot error for a row the service cannot read", () => {
    const { [configKey(address, { owner: 'service', name: 'appOrigin' })]: _unset, ...without } =
      env;
    expect(() => stashRows(node(), address, without)).toThrow(
      'missing required config param "appOrigin" (env COMPOSER_MY_SHOP_WEB_APPORIGIN)',
    );
  });
});

describe('COMPOSER_ keys are built from the full address', () => {
  test('configKey turns `-` in the app name into `_`', () => {
    expect(configKey('my-shop.api', { owner: 'service', name: 'port' })).toBe(
      'COMPOSER_MY_SHOP_API_PORT',
    );
  });

  test('configKey scopes an input-owned param by every address segment', () => {
    expect(configKey('my-shop.auth.api', { owner: { input: 'db' }, name: 'url' })).toBe(
      'COMPOSER_MY_SHOP_AUTH_API_DB_URL',
    );
  });

  test('generatedParamVarName turns `-` in the app name into `_`', () => {
    expect(generatedParamVarName('my-shop.api', 'session.secret')).toBe(
      'COMPOSER_MY_SHOP_API_SESSION_SECRET_GENERATED',
    );
  });

  test('an empty address yields the address-free key', () => {
    expect(configKey('', { owner: 'service', name: 'port' })).toBe('COMPOSER_PORT');
  });
});
