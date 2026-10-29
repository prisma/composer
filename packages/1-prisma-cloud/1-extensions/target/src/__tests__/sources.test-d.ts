import {
  module,
  type ParamSource,
  paramNeed,
  type SecretSource,
  type SecretString,
  secret,
  type Value,
} from '@internal/core';
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

test("each source still fits a module's params or secrets slot, and envParam() a number param", () => {
  const relay = module(
    'relay',
    {
      params: { origin: paramNeed(), token: paramNeed(), base: paramNeed() },
      secrets: { key: secret() },
    },
    () => {},
  );
  module('shop', ({ provision }) => {
    provision(relay, {
      params: {
        origin: envParam('ORIGIN'),
        token: generatedParam(),
        base: serviceOrigin('shop.web'),
      },
      secrets: { key: envSecret('KEY') },
    });
    provision(compute({ name: 'web', deps: {}, build }), {
      id: 'web',
      params: { port: envParam('PORT') },
    });
  });
});
