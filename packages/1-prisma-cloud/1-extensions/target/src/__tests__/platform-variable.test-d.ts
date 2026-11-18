import {
  appRoot,
  type ParamSource,
  type RuntimeValue,
  type SecretSource,
  type SecretString,
  type ValueResourceNode,
} from '@internal/core';
import { field as arkField } from '@internal/foundation/arktype';
import { field as zodField } from '@internal/foundation/zod';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { expectTypeOf, test } from 'vitest';
import { z } from 'zod';
import { compute, type PlatformVariablePayload, variable } from '../exports/index.ts';
import type { PlainVariableValue } from '../platform-variable.ts';

type Plain = ParamSource<PlatformVariablePayload> & RuntimeValue<string>;
type Secret = SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString>;

test('variable() and variable.secret() build value resources holding a plain and a secret platform variable', () => {
  expectTypeOf(variable({ name: 'X' })).toEqualTypeOf<ValueResourceNode<Plain>>();
  expectTypeOf(variable.secret({ name: 'X' })).toEqualTypeOf<ValueResourceNode<Secret>>();
});

test('provisioning a node in an appRoot() body gives its value with an id', () => {
  appRoot('shop', ({ provision }) => {
    expectTypeOf(provision(variable({ name: 'X' }))).toEqualTypeOf<
      Plain & { readonly id: string }
    >();
    expectTypeOf(provision(variable.secret({ name: 'X' }), { id: 'x' })).toEqualTypeOf<
      Secret & { readonly id: string }
    >();
  });
});

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const serviceWith = <S extends StandardSchemaV1>(input: S) =>
  compute({ name: 'mailer', deps: {}, build, input });

test('variable({ name, schema }) is a runtime value of the type the schema gives', () => {
  expectTypeOf(variable({ name: 'X', schema: type('number') })).toEqualTypeOf<
    ValueResourceNode<PlainVariableValue<number>>
  >();
  expectTypeOf(variable({ name: 'X', schema: z.number() })).toEqualTypeOf<
    ValueResourceNode<PlainVariableValue<number>>
  >();
  expectTypeOf(variable({ name: 'X' })).toEqualTypeOf<
    ValueResourceNode<PlainVariableValue<string>>
  >();
});

test('a typed variable fits a field of its type and no other, and an untyped one the reverse', () => {
  const arkNumber = serviceWith(type({ port: arkField(type('number')) }));
  const arkText = serviceWith(type({ port: arkField(type('string')) }));
  const zodNumber = serviceWith(z.object({ port: zodField(z.number()) }));
  const zodText = serviceWith(z.object({ port: zodField(z.string()) }));
  appRoot('shop', ({ provision }) => {
    const arkPort = provision(variable({ name: 'SMTP_PORT', schema: type('number') }));
    const zodPort = provision(variable({ name: 'SMTP_PORT', schema: z.number() }));
    const text = provision(variable({ name: 'SMTP_PORT' }));
    provision(arkNumber, { input: { port: arkPort } });
    provision(zodNumber, { input: { port: zodPort } });
    provision(arkText, { input: { port: text } });
    provision(zodText, { input: { port: text } });
    // @ts-expect-error a variable typed number does not fit a text field
    provision(arkText, { input: { port: arkPort } });
    // @ts-expect-error a variable typed number does not fit a text field
    provision(zodText, { input: { port: zodPort } });
    // @ts-expect-error a variable with no schema is text, which does not fit a number field
    provision(arkNumber, { input: { port: text } });
    // @ts-expect-error a variable with no schema is text, which does not fit a number field
    provision(zodNumber, { input: { port: text } });
  });
});

test('an object variable fits a field of the same object type, with ArkType and with Zod', () => {
  const arkSmtp = type({ host: 'string', port: 'number' });
  const zodSmtp = z.object({ host: z.string(), port: z.number() });
  const arkService = serviceWith(type({ smtp: arkField(arkSmtp) }));
  const zodService = serviceWith(z.object({ smtp: zodField(zodSmtp) }));
  appRoot('shop', ({ provision }) => {
    provision(arkService, {
      input: { smtp: provision(variable({ name: 'SMTP', schema: arkSmtp })) },
    });
    provision(zodService, {
      input: { smtp: provision(variable({ name: 'SMTP', schema: zodSmtp })) },
    });
    provision(arkService, {
      // @ts-expect-error a variable typed number does not fit an object field
      input: { smtp: provision(variable({ name: 'SMTP', schema: type('number') })) },
    });
  });
});

test('variable.secret() takes no schema, and a schema must implement Standard JSON Schema', () => {
  // @ts-expect-error a platform secret has no schema
  variable.secret({ name: 'API_KEY', schema: type('string') });
  const validateOnly: StandardSchemaV1<number> = {
    '~standard': { version: 1, vendor: 'x', validate: (value) => ({ value: Number(value) }) },
  };
  // @ts-expect-error a schema without ~standard.jsonSchema does not compile
  variable({ name: 'X', schema: validateOnly });
});
