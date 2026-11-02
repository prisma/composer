import type { StandardSchemaV1 } from '@standard-schema/spec';
import { expectTypeOf, test } from 'vitest';
import { string } from '../config.ts';
import type {
  InputBinding,
  ModuleContext,
  ModuleInputField,
  ModuleNode,
  SecretString,
  Value,
} from '../exports/index.ts';
import { module, resolve, resource, SecretBox, secretSource, service } from '../exports/index.ts';
import type { INPUT_DICTIONARY, NotInputDictionary } from '../value.ts';

type ShopOut = {
  EMAIL_FROM: string;
  SITE_HOSTNAME?: string;
  smtp: { host: string; port: number; tls?: { ca: string } };
  tags: string[];
  signingKey: SecretString;
  count: number;
};
type ShopIn = Omit<ShopOut, 'count' | 'signingKey'> & { count: string; signingKey: unknown };
type EmailIn = { from: string; key: SecretString; replyTo?: string };

declare const shopSchema: StandardSchemaV1<ShopIn, ShopOut>;
declare const emailSchema: StandardSchemaV1<EmailIn, EmailIn>;
declare const unionSchema: StandardSchemaV1<
  unknown,
  { on: false } | { on: true; key: SecretString }
>;
declare const flagSchema: StandardSchemaV1<unknown, { flag: boolean; kind: 'a' | 'b' }>;
declare const fitsSchema: StandardSchemaV1<{ EMAIL_FROM: string }>;
declare const plainSchema: StandardSchemaV1<unknown, { host: string; port: number }>;

let otherField!: ModuleInputField<string>;

/** What `resolve()`'s `fn` receives for a value: its real-value type. */
type RealValue<V> = V extends Value<infer T> ? T : never;

const email = module('email', { input: emailSchema }, () => {});

test("each input field is a value typed from the schema's output", () => {
  module('shop', { input: shopSchema }, ({ input }) => {
    expectTypeOf(input.EMAIL_FROM).toEqualTypeOf<ModuleInputField<string>>();
    expectTypeOf<RealValue<typeof input.SITE_HOSTNAME>>().toEqualTypeOf<string | undefined>();
    expectTypeOf<RealValue<typeof input.smtp.tls.ca>>().toEqualTypeOf<string | undefined>();
    expectTypeOf(input.tags).toEqualTypeOf<ModuleInputField<string[]>>();
    expectTypeOf(input.tags).toEqualTypeOf<Value<string[]>>();
    // @ts-expect-error an array field has no element access
    void input.tags[0];
    expectTypeOf<RealValue<typeof input.signingKey>>().toEqualTypeOf<SecretString>();
    // @ts-expect-error a secret field has no members
    void input.signingKey.expose;
    expectTypeOf<RealValue<typeof input.count>>().toEqualTypeOf<number>();
    expectTypeOf(input).not.toExtend<Value<unknown>>();
    // @ts-expect-error the schema has no such field
    void input.nope;
    // @ts-expect-error an input field is read-only
    input.EMAIL_FROM = otherField;
  });
});

test('a union schema exposes only the keys every member has', () => {
  module('shop', { input: unionSchema }, ({ input }) => {
    expectTypeOf<RealValue<typeof input.on>>().toEqualTypeOf<boolean>();
    // @ts-expect-error only one member has `key`
    void input.key;
  });
});

test('a module that declares no input receives undefined', () => {
  expectTypeOf<
    ModuleContext<Record<never, never>, undefined>['input']
  >().toEqualTypeOf<undefined>();
  module('plain', {}, ({ input }) => {
    expectTypeOf(input).toEqualTypeOf<undefined>();
  });
});

test('comparing an input field with a literal does not compile', () => {
  module('shop', { input: flagSchema }, ({ input }) => {
    // @ts-expect-error a value never equals a literal
    if (input.flag === true) return;
    switch (input.kind) {
      // @ts-expect-error a value never matches a literal case
      case 'a':
        break;
    }
  });
});

test("a module's input binding takes data, values of the field's type, and secret sources", () => {
  module('shop', { input: shopSchema }, ({ input, provision }) => {
    provision(email, { input: { from: input.EMAIL_FROM, key: input.signingKey } });
    provision(email, { id: 'two', input: { from: 'a', key: secretSource({ name: 'KEY' }) } });
    // @ts-expect-error a secret's value never sits in the code
    provision(email, { id: 'three', input: { from: 'a', key: new SecretBox('x') } });
    // @ts-expect-error a secret field takes no plain string
    provision(email, { id: 'four', input: { from: 'a', key: 'plain' } });
  });
});

test('an optional value fits only an optional field, and a value only a field of its type', () => {
  module('shop', { input: shopSchema }, ({ input, provision }) => {
    provision(email, {
      input: { from: input.EMAIL_FROM, key: input.signingKey, replyTo: input.SITE_HOSTNAME },
    });
    // @ts-expect-error a required field takes no value that may be undefined
    provision(email, { id: 'two', input: { from: input.SITE_HOSTNAME, key: input.signingKey } });
    // @ts-expect-error a string field takes no number
    provision(email, { id: 'three', input: { from: input.count, key: input.signingKey } });
  });
});

test('provision() requires input exactly when the module declares it', () => {
  const plainModule = module('plain', {}, () => {});
  module('shop', ({ provision }) => {
    // @ts-expect-error the module declares input
    provision(email);
    // @ts-expect-error the module declares input
    provision(email, {});
    // @ts-expect-error the module declares no input
    provision(plainModule, { input: {} });
  });
});

test('no binding accepts the whole input, even where its fields would fit', () => {
  const fits = module('fits', { input: fitsSchema }, () => {});
  const echo = service({
    name: 'echo',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: { label: string() },
    input: plainSchema,
    build: {
      extension: '@prisma/composer/node',
      type: 'node',
      module: 'file:///s.ts',
      entry: 's.js',
    },
  });
  module('shop', { input: shopSchema }, ({ input, provision }) => {
    provision(fits, { input: { EMAIL_FROM: input.EMAIL_FROM } });
    // @ts-expect-error the whole input is not a value
    provision(fits, { id: 'two', input });
  });
  module('shop', { input: plainSchema }, ({ input, provision }) => {
    provision(echo, { input: { host: input.host }, params: { label: input.host } });
    resolve([input.host], ([host]) => host);
    resource({ name: 'site', extension: 'test/pack', props: { host: input.host } });
    // @ts-expect-error the whole input is not a value
    provision(echo, { id: 'two', input });
    // @ts-expect-error the whole input is not a value, at any depth
    provision(echo, { id: 'three', input: { all: [input] } });
    // @ts-expect-error the whole input is not a value
    provision(echo, { id: 'four', input: {}, params: { label: input } });
    // @ts-expect-error the whole input is not a value
    resolve([input], () => 'x');
    // @ts-expect-error the whole input is not a value
    resource({ name: 'two', extension: 'test/pack', props: input });
    // @ts-expect-error the whole input is not a value, at any depth
    resource({ name: 'three', extension: 'test/pack', props: { all: { nested: input } } });
  });
});

test('the type error says to pass the fields on by name', () => {
  expectTypeOf<
    NonNullable<NotInputDictionary[typeof INPUT_DICTIONARY]>
  >().toEqualTypeOf<'the whole input of a module is not a value; pass its fields on by name'>();
});

test("a service's input binding takes values standing for a secret, an optional field, or a nested object holding a secret", () => {
  expectTypeOf<{ k: Value<SecretString> }>().toExtend<InputBinding>();
  expectTypeOf<{ k: Value<string | undefined> }>().toExtend<InputBinding>();
  expectTypeOf<{ smtp: Value<{ host: string; key: SecretString }> }>().toExtend<InputBinding>();
});

test('a module with an input schema is a ModuleNode', () => {
  expectTypeOf(email).toExtend<ModuleNode>();
});

test('an input field is a value', () => {
  expectTypeOf<ModuleInputField<string>>().toExtend<Value<string>>();
});
