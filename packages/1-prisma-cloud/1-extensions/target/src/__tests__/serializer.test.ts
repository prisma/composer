/**
 * The env-sourced param wire: pointer-row encode/decode, and the boot-side
 * double-lookup + schema validation `deserialize`/`coerce` runs for a param
 * bound to `envParam(...)` (as opposed to a literal, unchanged, param).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { type ConfigParam, number, param, service, string } from '@internal/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  configKey,
  decodeParamPointer,
  deserialize,
  encode,
  encodeParamPointer,
  inputKey,
  isParamPointerRow,
  readOrigin,
  stashRows,
} from '../serializer.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

/** A string schema that rejects the empty string — used to prove empty-string handling is schema-driven, not hardcoded. */
const nonEmptyString: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value: unknown) =>
      typeof value === 'string' && value.length > 0
        ? { value }
        : { issues: [{ message: 'must be non-empty' }] },
  },
};

// Raw core service(): the env-sourced param wire is now exercised only by
// extension-RESERVED params (ADR-0042 removed user params from compute()),
// but the serializer machinery is param-name-agnostic — a plain node with a
// declared param proves it.
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

describe('param pointer rows', () => {
  test('encodeParamPointer/decodeParamPointer round-trip; isParamPointerRow recognizes only pointer rows', () => {
    const row = encodeParamPointer('APP_ORIGIN');
    expect(isParamPointerRow(row)).toBe(true);
    expect(decodeParamPointer(row)).toBe('APP_ORIGIN');
  });

  test('a JSON-encoded literal is never mistaken for a pointer row', () => {
    expect(isParamPointerRow(encode('service', 'https://example.com'))).toBe(false);
    expect(isParamPointerRow(encode('service', 42))).toBe(false);
    expect(isParamPointerRow(encode('service', true))).toBe(false);
    expect(isParamPointerRow(encode('service', { a: 1 }))).toBe(false);
  });
});

describe('deserialize — env-sourced param boot resolution', () => {
  const address = 'web';
  const key = configKey(address, { owner: 'service', name: 'appOrigin' });
  const portKey = configKey(address, { owner: 'service', name: 'port' });

  beforeEach(() => {
    delete process.env[key];
    delete process.env[portKey];
    delete process.env['PLATFORM_APP_ORIGIN'];
  });

  test('resolves a pointer row via double-lookup and validates the raw string with the param schema', async () => {
    await withEnv(
      {
        [key]: encodeParamPointer('PLATFORM_APP_ORIGIN'),
        PLATFORM_APP_ORIGIN: 'https://example.com',
      },
      () => {
        const config = deserialize(svc(), address);
        expect(config.service['appOrigin']).toBe('https://example.com');
      },
    );
  });

  test('an unset platform var fails loudly, naming the param and the platform var', async () => {
    await withEnv({ [key]: encodeParamPointer('PLATFORM_APP_ORIGIN') }, () => {
      expect(() => deserialize(svc(), address)).toThrow(
        /env-sourced config param "appOrigin".*PLATFORM_APP_ORIGIN.*unset/,
      );
    });
  });

  test('an empty platform var passes through when the schema accepts empty strings', async () => {
    await withEnv(
      { [key]: encodeParamPointer('PLATFORM_APP_ORIGIN'), PLATFORM_APP_ORIGIN: '' },
      () => {
        const config = deserialize(svc(), address);
        expect(config.service['appOrigin']).toBe('');
      },
    );
  });

  test('an empty platform var fails when the schema rejects empty strings', async () => {
    const node = svc({ appOrigin: param(nonEmptyString) });
    await withEnv(
      { [key]: encodeParamPointer('PLATFORM_APP_ORIGIN'), PLATFORM_APP_ORIGIN: '' },
      () => {
        expect(() => deserialize(node, address)).toThrow(
          /invalid value for env-sourced config param "appOrigin"/,
        );
      },
    );
  });

  test('a literal-encoded row is unaffected — still JSON-decoded and validated as before', async () => {
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
  const address = 'web';
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
    [configKey(address, { owner: 'service', name: 'appOrigin' })]: encodeParamPointer('APP_ORIGIN'),
    APP_ORIGIN: 'https://shop.example',
    [inputKey(address)]: '{"apiKey":{"$secret":"STRIPE_KEY"}}',
  };

  test('re-keys every row address-free and adds PORT and the default HOST', () => {
    expect(stashRows(node(), address, env)).toEqual({
      [configKey('', { owner: 'service', name: 'port' })]: '3007',
      [configKey('', { owner: 'service', name: 'appOrigin' })]: '"https://shop.example"',
      [inputKey('')]: '{"apiKey":{"$secret":"STRIPE_KEY"}}',
      PORT: '3007',
      HOST: '0.0.0.0',
    });
  });

  test('keeps a HOST the environment sets', () => {
    expect(stashRows(node(), address, { ...env, HOST: '127.0.0.1' })['HOST']).toBe('127.0.0.1');
  });

  test('reads only the environment it is given, and writes nothing to process.env', async () => {
    await withEnv({ APP_ORIGIN: undefined, PORT: undefined, COMPOSER_PORT: undefined }, () => {
      stashRows(node(), address, env);
      expect(process.env['PORT']).toBeUndefined();
      expect(process.env['COMPOSER_PORT']).toBeUndefined();
    });
  });

  test("throws run()'s boot error for a row the service cannot read", () => {
    const { APP_ORIGIN: _unset, ...withoutPlatformVar } = env;
    expect(() => stashRows(node(), address, withoutPlatformVar)).toThrow(
      /env-sourced config param "appOrigin".*APP_ORIGIN.*is unset/,
    );
  });
});
