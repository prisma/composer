import { field as arkField, secretString as arkSecretString } from '@internal/foundation/arktype';
import { POINTER } from '@internal/foundation/pointer';
import { field as zodField, secretString as zodSecretString } from '@internal/foundation/zod';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { expectTypeOf, test } from 'vitest';
import { z } from 'zod';
import type {
  InputValueOf,
  ModuleInputField,
  Pointer,
  RuntimeValue,
  SecretString,
  Value,
} from '../exports/index.ts';
import { isPlainPointer, isSecretPointer, module, service } from '../exports/index.ts';
import type { LoadOverrides } from '../exports/testing.ts';

declare const plainRuntime: RuntimeValue<string>;
declare const secretRuntime: RuntimeValue<SecretString>;
declare const text: Value<string>;
declare const secretValue: Value<SecretString>;

const arkSchema = type({
  from: arkField(type('string')),
  port: arkField(type('string.integer.parse')),
  host: 'string',
  key: arkSecretString(),
});
const zodSchema = z.object({
  from: zodField(z.string()),
  port: zodField(z.string().transform(Number)),
  host: z.string(),
  key: zodSecretString(),
});

const arkChild = module('ark-child', { input: arkSchema }, () => {});
const zodChild = module('zod-child', { input: zodSchema }, () => {});

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

type In<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;
type Out<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

test("ArkType: a wrapped field's input is In | Pointer<In> and its output Out | Pointer<In>", () => {
  expectTypeOf<In<typeof arkSchema>['from']>().toEqualTypeOf<string | Pointer<string>>();
  expectTypeOf<In<typeof arkSchema>['port']>().toEqualTypeOf<string | Pointer<string>>();
  expectTypeOf<In<typeof arkSchema>['host']>().toEqualTypeOf<string>();
  expectTypeOf<Out<typeof arkSchema>['from']>().toEqualTypeOf<string | Pointer<string>>();
  expectTypeOf<Out<typeof arkSchema>['port']>().toEqualTypeOf<number | Pointer<string>>();
  expectTypeOf<Out<typeof arkSchema>['host']>().toEqualTypeOf<string>();
});

test("Zod: a wrapped field's input is In | Pointer<In> and its output Out | Pointer<In>", () => {
  expectTypeOf<In<typeof zodSchema>['from']>().toEqualTypeOf<string | Pointer<string>>();
  expectTypeOf<In<typeof zodSchema>['port']>().toEqualTypeOf<string | Pointer<string>>();
  expectTypeOf<In<typeof zodSchema>['host']>().toEqualTypeOf<string>();
  expectTypeOf<Out<typeof zodSchema>['from']>().toEqualTypeOf<string | Pointer<string>>();
  expectTypeOf<Out<typeof zodSchema>['port']>().toEqualTypeOf<number | Pointer<string>>();
  expectTypeOf<Out<typeof zodSchema>['host']>().toEqualTypeOf<string>();
});

test('a plain field takes no pointer', () => {
  // @ts-expect-error a plain field takes no pointer
  const ark: In<typeof arkSchema>['host'] = {} as Pointer<string>;
  // @ts-expect-error a plain field takes no pointer
  const zod: In<typeof zodSchema>['host'] = {} as Pointer<string>;
  void [ark, zod];
});

test('a wrapped field of another type takes no pointer to text', () => {
  const arkNumber = arkField(type('number'));
  const zodNumber = zodField(z.number());
  // @ts-expect-error a wrapped number field takes a Pointer<number>, not a Pointer<string>
  const ark: In<typeof arkNumber> = {} as Pointer<string>;
  // @ts-expect-error a wrapped number field takes a Pointer<number>, not a Pointer<string>
  const zod: In<typeof zodNumber> = {} as Pointer<string>;
  void [ark, zod];
});

test('a wrapped text field takes no secret pointer', () => {
  // @ts-expect-error a wrapped text field takes no secret pointer
  const ark: In<typeof arkSchema>['from'] = {} as Pointer<SecretString>;
  // @ts-expect-error a wrapped text field takes no secret pointer
  const zod: In<typeof zodSchema>['from'] = {} as Pointer<SecretString>;
  void [ark, zod];
});

test('secretString() reads as a SecretString or a secret pointer in both libraries', () => {
  const ark = arkSecretString();
  const zod = zodSecretString();
  expectTypeOf<In<typeof ark>>().toEqualTypeOf<SecretString | Pointer<SecretString>>();
  expectTypeOf<Out<typeof ark>>().toEqualTypeOf<SecretString | Pointer<SecretString>>();
  expectTypeOf<In<typeof zod>>().toEqualTypeOf<SecretString | Pointer<SecretString>>();
  expectTypeOf<Out<typeof zod>>().toEqualTypeOf<SecretString | Pointer<SecretString>>();
});

test('ArkType: a default outside the wrapper keeps the wrapped output', () => {
  const schema = type({ from: arkField(type('string')).default('d') });
  expectTypeOf<Out<typeof schema>['from']>().toEqualTypeOf<string | Pointer<string>>();
});

test('in a module body a wrapped field is a value of Out | Pointer<In>', () => {
  module('m', { input: arkSchema }, ({ input }) => {
    expectTypeOf(input.from).toEqualTypeOf<ModuleInputField<string | Pointer<string>>>();
    expectTypeOf(input.port).toEqualTypeOf<ModuleInputField<number | Pointer<string>>>();
    expectTypeOf(input.host).toEqualTypeOf<ModuleInputField<string>>();
  });
  module('m', { input: zodSchema }, ({ input }) => {
    expectTypeOf(input.from).toEqualTypeOf<ModuleInputField<string | Pointer<string>>>();
    expectTypeOf(input.port).toEqualTypeOf<ModuleInputField<number | Pointer<string>>>();
    expectTypeOf(input.host).toEqualTypeOf<ModuleInputField<string>>();
  });
});

test("a wrapped field's binding takes a literal, a deploy-time value and a plain runtime value", () => {
  module('shop', ({ provision }) => {
    provision(arkChild, { id: 'a', input: { from: 'x', port: '1', host: 'h', key: secretValue } });
    provision(arkChild, {
      id: 'b',
      input: { from: text, port: text, host: 'h', key: secretValue },
    });
    provision(arkChild, {
      id: 'c',
      input: { from: plainRuntime, port: plainRuntime, host: 'h', key: secretValue },
    });
    provision(zodChild, { id: 'd', input: { from: 'x', port: '1', host: 'h', key: secretValue } });
    provision(zodChild, {
      id: 'e',
      input: { from: text, port: text, host: 'h', key: secretValue },
    });
    provision(zodChild, {
      id: 'f',
      input: { from: plainRuntime, port: plainRuntime, host: 'h', key: secretValue },
    });
  });
});

test("a wrapped field's binding refuses a secret runtime value", () => {
  module('shop', ({ provision }) => {
    provision(arkChild, {
      id: 'a',
      // @ts-expect-error a wrapped text field takes no secret runtime value
      input: { from: secretRuntime, port: '1', host: 'h', key: secretValue },
    });
    provision(zodChild, {
      id: 'b',
      // @ts-expect-error a wrapped text field takes no secret runtime value
      input: { from: secretRuntime, port: '1', host: 'h', key: secretValue },
    });
  });
});

test("a plain field's binding refuses a runtime value", () => {
  module('shop', ({ provision }) => {
    provision(arkChild, {
      id: 'a',
      // @ts-expect-error a plain field takes no runtime value
      input: { from: 'x', port: '1', host: plainRuntime, key: secretValue },
    });
    provision(zodChild, {
      id: 'b',
      // @ts-expect-error a plain field takes no runtime value
      input: { from: 'x', port: '1', host: plainRuntime, key: secretValue },
    });
  });
});

test("a secretString() field's binding refuses a plain runtime value", () => {
  module('shop', ({ provision }) => {
    provision(arkChild, {
      // @ts-expect-error a secret field takes no plain runtime value
      input: { from: 'x', port: '1', host: 'h', key: plainRuntime },
    });
  });
});

test("a wrapped module field passes on into a service's input binding", () => {
  const sink = service({
    name: 'sink',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: {},
    input: type({ from: arkField(type('string')) }),
    build,
  });
  module('m', { input: type({ from: arkField(type('string')) }) }, ({ input, provision }) => {
    provision(sink, { input: { from: input.from } });
  });
});

test('RuntimeValue<T> is Value<Pointer<T>>', () => {
  expectTypeOf<RuntimeValue<string>>().toEqualTypeOf<Value<Pointer<string>>>();
});

test('isPlainPointer() narrows to Pointer<string>, isSecretPointer() to Pointer<SecretString>', () => {
  const x: unknown = undefined;
  if (isPlainPointer(x)) expectTypeOf(x).toEqualTypeOf<Pointer<string>>();
  if (isSecretPointer(x)) expectTypeOf(x).toEqualTypeOf<Pointer<SecretString>>();
});

test('the two kinds of pointer do not fit each other', () => {
  // @ts-expect-error a secret pointer is not a plain pointer
  const a: Pointer<string> = {} as Pointer<SecretString>;
  // @ts-expect-error a plain pointer is not a secret pointer
  const b: Pointer<SecretString> = {} as Pointer<string>;
  void [a, b];
});

test("a pointer's kind follows its type", () => {
  expectTypeOf<Pointer<string>[typeof POINTER]>().toEqualTypeOf<'plain'>();
  expectTypeOf<Pointer<number>[typeof POINTER]>().toEqualTypeOf<'plain'>();
  expectTypeOf<Pointer<SecretString>[typeof POINTER]>().toEqualTypeOf<'secret'>();
  expectTypeOf<Pointer<unknown>[typeof POINTER]>().toEqualTypeOf<'secret' | 'plain'>();
  // @ts-expect-error a Pointer<string> cannot say its variable holds a secret
  const plain: Pointer<string> = { [POINTER]: 'secret' };
  // @ts-expect-error a Pointer<SecretString> cannot say its variable holds plain text
  const secret: Pointer<SecretString> = { [POINTER]: 'plain' };
  const either: Pointer<unknown> = {} as Pointer<SecretString>;
  void [plain, secret, either];
});

const arkNested = type({
  smtp: { user: arkField(type('string')), password: arkSecretString() },
  'replyTo?': arkField(type('string')),
  tags: arkField(type('string')).array(),
});
const zodNested = z.object({
  smtp: z.object({ user: zodField(z.string()), password: zodSecretString() }),
  replyTo: zodField(z.string()).optional(),
  tags: z.array(zodField(z.string())),
});

test("ArkType: service.input() is the schema's output with every pointer removed", () => {
  expectTypeOf<InputValueOf<typeof arkSchema>>().toEqualTypeOf<{
    from: string;
    port: number;
    host: string;
    key: SecretString;
  }>();
  expectTypeOf<InputValueOf<typeof arkNested>>().toEqualTypeOf<{
    smtp: { user: string; password: SecretString };
    replyTo?: string;
    tags: string[];
  }>();
});

test("Zod: service.input() is the schema's output with every pointer removed", () => {
  expectTypeOf<InputValueOf<typeof zodSchema>>().toEqualTypeOf<{
    from: string;
    port: number;
    host: string;
    key: SecretString;
  }>();
  expectTypeOf<InputValueOf<typeof zodNested>>().toEqualTypeOf<{
    smtp: { user: string; password: SecretString };
    replyTo?: string | undefined;
    tags: string[];
  }>();
});

test('a schema without type information still reads as unknown', () => {
  expectTypeOf<InputValueOf<StandardSchemaV1>>().toEqualTypeOf<unknown>();
});

test("mockService()'s input double takes the shape service.input() returns, with no pointer", () => {
  expectTypeOf<LoadOverrides<Record<never, never>, typeof arkSchema>['input']>().toEqualTypeOf<
    InputValueOf<typeof arkSchema>
  >();
  // @ts-expect-error a test double holds the text the service reads, never a pointer
  const double: LoadOverrides<Record<never, never>, typeof arkSchema>['input']['from'] =
    {} as Pointer<string>;
  void double;
});

test('a secretString() field of a module takes a secret runtime value, and the body sees it as a value of SecretString | Pointer<SecretString>', () => {
  module('shop', ({ provision }) => {
    provision(arkChild, {
      id: 'a',
      input: { from: 'x', port: '1', host: 'h', key: secretRuntime },
    });
    provision(zodChild, {
      id: 'b',
      input: { from: 'x', port: '1', host: 'h', key: secretRuntime },
    });
  });
  module('m', { input: arkSchema }, ({ input }) => {
    expectTypeOf(input.key).toEqualTypeOf<ModuleInputField<SecretString | Pointer<SecretString>>>();
  });
});
