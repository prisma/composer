import {
  module,
  type ParamSource,
  type RuntimeValue,
  resolve,
  type SecretSource,
  type SecretString,
  type Value,
} from '@internal/core';
import { field, secretString } from '@internal/foundation/arktype';
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
    SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>
  >();
  expectTypeOf(generatedParam()).toEqualTypeOf<
    ParamSource<GeneratedParamPayload> & RuntimeValue<SecretString>
  >();
  expectTypeOf(generatedParam({ redacted: false })).toEqualTypeOf<
    ParamSource<GeneratedParamPayload> & RuntimeValue<string>
  >();
  expectTypeOf(serviceOrigin('shop.web')).toEqualTypeOf<
    ParamSource<OriginParamPayload> & RuntimeValue<string>
  >();
});

test("each source fits a module's input field of its type, and envParam() a service param", () => {
  const relay = module(
    'relay',
    {
      input: type({
        origin: 'string',
        token: secretString(),
        base: field(type('string')),
        plainToken: field(type('string')),
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
        plainToken: generatedParam({ redacted: false }),
        key: envSecret('KEY'),
      },
    });
    provision(compute({ name: 'web', deps: {}, build }), {
      id: 'web',
      params: { port: envParam('PORT') },
    });
  });
});

test('a runtime value does not fit a plain field, and a secret one does not fit a wrapped text field', () => {
  const relay = module(
    'relay',
    { input: type({ host: 'string', from: field(type('string')) }) },
    () => {},
  );
  module('shop', ({ provision }) => {
    // @ts-expect-error serviceOrigin() is a runtime value; a plain field takes deploy-time data only
    provision(relay, { input: { host: serviceOrigin('shop.web'), from: 'x' } });
    // @ts-expect-error a plain generatedParam() is a runtime value; a plain field takes deploy-time data only
    provision(relay, { input: { host: generatedParam({ redacted: false }), from: 'x' } });
    // @ts-expect-error envSecret() is a secret runtime value; a wrapped text field takes a plain pointer only
    provision(relay, { input: { host: 'h', from: envSecret('KEY') } });
  });
});

test('resolve() lists envParam(), and refuses envSecret(), generatedParam() and serviceOrigin()', () => {
  resolve([envParam('GREETING')], ([greeting]) => greeting.toUpperCase());
  // @ts-expect-error envSecret() is known only at boot; a resolve() dependency must be a deploy-time value
  resolve([envSecret('KEY')], () => 'x');
  // @ts-expect-error generatedParam() is known only at boot; a resolve() dependency must be a deploy-time value
  resolve([generatedParam()], () => 'x');
  // @ts-expect-error a plain generatedParam() is known only at boot; a resolve() dependency must be a deploy-time value
  resolve([generatedParam({ redacted: false })], () => 'x');
  // @ts-expect-error serviceOrigin() is known only at boot; a resolve() dependency must be a deploy-time value
  resolve([serviceOrigin('shop.web')], () => 'x');
});

test("each source fits a service's input field of its type", () => {
  const relay = compute({
    name: 'relay',
    deps: {},
    build,
    input: type({
      origin: 'string',
      token: secretString(),
      base: field(type('string')),
      plainToken: field(type('string')),
      key: secretString(),
    }),
  });
  module('shop', ({ provision }) => {
    provision(relay, {
      input: {
        origin: envParam('ORIGIN'),
        token: generatedParam(),
        base: serviceOrigin('shop.web'),
        plainToken: generatedParam({ redacted: false }),
        key: envSecret('KEY'),
      },
    });
  });
});

test("a service's binding refuses a wrong literal, a runtime value in a plain field, envSecret() in a wrapped text field and serviceOrigin() in a secret field", () => {
  const relay = compute({
    name: 'relay',
    deps: {},
    build,
    input: type({ host: 'string', from: field(type('string')), key: secretString() }),
  });
  module('shop', ({ provision }) => {
    // @ts-expect-error host is text, not a number
    provision(relay, { input: { host: 4, from: 'x', key: envSecret('KEY') } });
    provision(relay, {
      // @ts-expect-error serviceOrigin() is a runtime value; a plain field takes deploy-time data only
      input: { host: serviceOrigin('shop.web'), from: 'x', key: envSecret('KEY') },
    });
    // @ts-expect-error envSecret() is a runtime value; a plain field takes deploy-time data only
    provision(relay, { input: { host: envSecret('HOST'), from: 'x', key: envSecret('KEY') } });
    // @ts-expect-error envSecret() is a secret runtime value; a wrapped text field takes a plain pointer only
    provision(relay, { input: { host: 'h', from: envSecret('FROM'), key: envSecret('KEY') } });
    // @ts-expect-error serviceOrigin() is a plain runtime value; a secretString() field takes a secret only
    provision(relay, { input: { host: 'h', from: 'x', key: serviceOrigin('shop.web') } });
  });
});
