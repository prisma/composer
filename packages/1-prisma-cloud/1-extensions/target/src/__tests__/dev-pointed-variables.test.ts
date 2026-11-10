import { expect, test } from 'bun:test';
import { service } from '@internal/core';
import { encodeParamPointer } from '@internal/input-document';
import { pointedVariables } from '@internal/local-target';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { configKey } from '../config-key.ts';
import { envSecret } from '../secret.ts';
import { serializeInput } from '../serializer.ts';

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

test('the local provider finds exactly the variables the serializer writes markers for', () => {
  const input = serializeInput(
    billing,
    'shop.billing',
    {
      stripeKey: envSecret('STRIPE_SECRET_KEY'),
      nested: [{ webhook: envSecret('STRIPE_WEBHOOK_SECRET') }],
      userData: { $platform: { name: 'NOT_A_MARKER', secret: true }, $secret: 'OLD_USER_KEY' },
    },
    { env: {} },
  );
  if (input === undefined) throw new Error('expected an input row');
  const rows = {
    [input.key]: input.value,
    [configKey('shop.billing', { owner: 'service', name: 'origin' })]:
      encodeParamPointer('APP_ORIGIN'),
  };

  const pointed = pointedVariables(rows, 'shop.billing');

  expect([...pointed.params]).toEqual(['APP_ORIGIN']);
  expect([...pointed.secrets].sort()).toEqual(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
});
