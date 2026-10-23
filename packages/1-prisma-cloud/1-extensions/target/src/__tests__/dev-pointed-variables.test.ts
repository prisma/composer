/** The local Deployment provider reads the serializer's pointer formats with its own copy of them; the two must agree. */
import { expect, test } from 'bun:test';
import { service } from '@internal/core';
import { pointedVariableNames } from '@internal/local-target';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { envSecret } from '../secret.ts';
import { configKey, encodeParamPointer, serializeInput } from '../serializer.ts';

const anySchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

const billing = service({
  name: 'billing',
  extension: '@prisma/composer-prisma-cloud',
  type: 'compute',
  inputs: {},
  params: {},
  input: anySchema,
  build: {
    extension: '@prisma/composer/node',
    type: 'node',
    module: 'file:///s.ts',
    entry: 's.js',
  },
});

test('the local provider finds exactly the variables the serializer writes pointers to', () => {
  const input = serializeInput(
    billing,
    'shop.billing',
    {
      stripeKey: envSecret('STRIPE_SECRET_KEY'),
      nested: [{ webhook: envSecret('STRIPE_WEBHOOK_SECRET') }],
      userData: { $secret: 'NOT_A_POINTER' },
    },
    {},
  );
  if (input === undefined) throw new Error('expected an input row');
  const rows = {
    [input.key]: input.value,
    [configKey('shop.billing', { owner: 'service', name: 'origin' })]:
      encodeParamPointer('APP_ORIGIN'),
  };

  expect([...pointedVariableNames(rows, 'shop.billing')].sort()).toEqual([
    'APP_ORIGIN',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ]);
});
