/**
 * The env-sourced param wire: pointer-row encode/decode, and the boot-side
 * double-lookup + schema validation `deserialize`/`coerce` runs for a param
 * bound to `envParam(...)` (as opposed to a literal, unchanged, param).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { type ConfigParam, param, string } from '@internal/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { compute } from '../exports/index.ts';
import {
  configKey,
  decodeParamPointer,
  deserialize,
  encode,
  encodeParamPointer,
  isParamPointerRow,
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

const svc = (extra: Record<string, ConfigParam> = {}) =>
  compute({ name: 'web', deps: {}, params: { appOrigin: string(), ...extra }, build });

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
