import {
  module,
  type ParamSource,
  type SecretSource,
  type SecretString,
  type Value,
} from '@internal/core';
import { secretString } from '@internal/foundation/arktype';
import { type } from 'arktype';
import { expectTypeOf, test } from 'vitest';
import { compute } from '../exports/index.ts';
import {
  type EnvParamPayload,
  envParam,
  type GeneratedParamPayload,
  generatedParam,
  type OriginParamPayload,
  serviceOrigin,
} from '../param.ts';
import { type EnvSecretPayload, envSecret } from '../secret.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

test('each source constructor returns its source and a value of the type it stands for', () => {
  expectTypeOf(envParam('X')).toEqualTypeOf<ParamSource<EnvParamPayload> & Value<string>>();
  expectTypeOf(envSecret('X')).toEqualTypeOf<
    SecretSource<EnvSecretPayload> & Value<SecretString>
  >();
  expectTypeOf(generatedParam()).toEqualTypeOf<
    ParamSource<GeneratedParamPayload> & Value<SecretString>
  >();
  expectTypeOf(generatedParam({ redacted: false })).toEqualTypeOf<
    ParamSource<GeneratedParamPayload> & Value<string>
  >();
  expectTypeOf(serviceOrigin('shop.web')).toEqualTypeOf<
    ParamSource<OriginParamPayload> & Value<string>
  >();
});

test("each source fits a module's input field of its type, and envParam() a service param", () => {
  const relay = module(
    'relay',
    {
      input: type({
        origin: 'string',
        token: secretString(),
        base: 'string',
        key: secretString(),
      }),
    },
    () => {},
  );
  module('shop', ({ provision }) => {
    provision(relay, {
      input: {
        origin: envParam('ORIGIN'),
        token: generatedParam(),
        base: serviceOrigin('shop.web'),
        key: envSecret('KEY'),
      },
    });
    provision(compute({ name: 'web', deps: {}, build }), {
      id: 'web',
      params: { port: envParam('PORT') },
    });
  });
});
