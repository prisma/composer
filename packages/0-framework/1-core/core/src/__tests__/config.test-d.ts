/**
 * Type-level rules for the input vocabulary (ADR-0042): `secretSource()` is a
 * source, a service's declared input schema makes the provision-time `input`
 * binding required, and a schema-less service rejects one. Type-only (vitest
 * `--typecheck`, never executed).
 */
import { expectTypeOf, test } from 'vitest';
import type { BuildAdapter, SecretNeed, SecretSource } from '../node.ts';
import { module, secret, secretSource, service } from '../node.ts';
import { anyInputSchema } from './helpers.ts';

const build: BuildAdapter = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

test('secret() is a SecretNeed; secretSource() is a SecretSource', () => {
  expectTypeOf(secret()).toEqualTypeOf<SecretNeed>();
  expectTypeOf(secretSource('AUTH_SIGNING_KEY')).toEqualTypeOf<SecretSource<string>>();
});

test('provisioning a service with an input schema requires the input binding', () => {
  const svc = service({
    name: 'auth',
    extension: 'test/pack',
    type: 'fake/app',
    inputs: {},
    params: {},
    input: anyInputSchema,
    build,
  });

  module('root', ({ provision }) => {
    // @ts-expect-error a declared input schema must be bound
    provision(svc, { id: 'auth' });
    provision(svc, { id: 'auth', input: { signingKey: secretSource('AUTH_SIGNING_KEY') } });
  });
});

test('provisioning a schema-less service rejects an input binding', () => {
  const svc = service({
    name: 'plain',
    extension: 'test/pack',
    type: 'fake/app',
    inputs: {},
    params: {},
    build,
  });

  module('root', ({ provision }) => {
    provision(svc, { id: 'plain' });
    // @ts-expect-error no input schema declared — nothing to bind
    provision(svc, { id: 'plain2', input: {} });
  });
});
