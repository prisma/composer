import { describe, expect, test } from 'bun:test';
import { appRoot, isPlainPointer, isSecretPointer, Load, paramSource } from '@internal/core';
import { generatedParam, paramBindingFor, paramName, serviceOrigin } from '../param.ts';
import { variable } from '../platform-variable.ts';

const NOT_A_PLATFORM_VARIABLE =
  'param slot "appOrigin" of service "web" is bound to a source that is not a platform variable. Provision variable() or variable.secret() from @prisma/composer-prisma-cloud in the app root and pass its value down.';

describe('paramName', () => {
  test('reads the name of the plain platform variable a slot is bound to', () => {
    let appOrigin: unknown;
    Load(
      appRoot('shop', ({ provision }) => {
        appOrigin = provision(variable({ name: 'APP_ORIGIN' }));
      }),
    );
    expect(paramName({ serviceAddress: 'web', slot: 'appOrigin', binding: appOrigin })).toBe(
      'APP_ORIGIN',
    );
  });

  test('refuses a slot bound to a source that is not a platform variable, naming the slot and the service', () => {
    const source = paramSource('APP_ORIGIN');
    expect(() => paramName({ serviceAddress: 'web', slot: 'appOrigin', binding: source })).toThrow(
      NOT_A_PLATFORM_VARIABLE,
    );
  });

  test('refuses a literal-bound slot', () => {
    expect(() =>
      paramName({ serviceAddress: 'web', slot: 'appOrigin', binding: 'https://example.com' }),
    ).toThrow(NOT_A_PLATFORM_VARIABLE);
  });
});

describe('paramBindingFor', () => {
  test('finds the manifest entry by address and slot', () => {
    const entry = { serviceAddress: 'web', slot: 'appOrigin', binding: serviceOrigin('shop.web') };
    expect(paramBindingFor([entry], 'web', 'appOrigin')).toBe(entry);
  });

  test('throws loudly when the manifest has no matching entry', () => {
    expect(() => paramBindingFor([], 'web', 'appOrigin')).toThrow(
      /param slot "appOrigin" of "web" resolved to a source but has no bound entry/,
    );
  });
});

describe('the kind of pointer each source is', () => {
  test('serviceOrigin() and a plain generatedParam() are plain pointers, and a redacted generatedParam() is a secret pointer', () => {
    expect(isPlainPointer(serviceOrigin('shop.web'))).toBe(true);
    expect(isPlainPointer(generatedParam({ redacted: false }))).toBe(true);
    expect(isSecretPointer(generatedParam())).toBe(true);
  });
});

describe('paramName and a platform secret', () => {
  test('refuses a slot a cast bound to a platform secret, saying a per-key param takes a plain platform variable', () => {
    let key: unknown;
    Load(
      appRoot('shop', ({ provision }) => {
        key = provision(variable.secret({ name: 'API_KEY' }));
      }),
    );
    expect(() => paramName({ serviceAddress: 'web', slot: 'token', binding: key })).toThrow(
      'param slot "token" of service "web" is bound to the platform secret "API_KEY", and a per-key param takes a plain platform variable.',
    );
  });
});
