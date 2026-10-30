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
  PlainData,
  Pointer,
  RuntimeValue,
  SecretString,
  Value,
} from '../exports/index.ts';
import { isPlainPointer, isSecretPointer, module, resolve, service } from '../exports/index.ts';
import type { LoadOverrides } from '../exports/testing.ts';

declare const plainRuntime: RuntimeValue<string>;
declare const secretRuntime: RuntimeValue<SecretString>;
declare const text: Value<string>;
declare const secretValue: Value<SecretString>;
declare const plainData: Value<PlainData>;

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

const arkDated = type({ when: 'string.date.parse', from: arkField(type('string')) });
const zodDated = z.object({
  when: z.coerce.date(),
  seen: z.map(z.string(), z.number()),
  from: zodField(z.string()),
});
declare const arkDatedInput: InputValueOf<typeof arkDated>;
declare const zodDatedInput: InputValueOf<typeof zodDated>;

test('service.input() keeps a class instance in the output, such as a Date or a Map', () => {
  expectTypeOf<InputValueOf<typeof arkDated>>().toEqualTypeOf<{ when: Date; from: string }>();
  expectTypeOf<InputValueOf<typeof zodDated>>().toEqualTypeOf<{
    when: Date;
    seen: Map<string, number>;
    from: string;
  }>();
  expectTypeOf(arkDatedInput.when.getTime()).toEqualTypeOf<number>();
  expectTypeOf(zodDatedInput.when.getTime()).toEqualTypeOf<number>();
});

const NOT_DEPLOY_TIME =
  'a resolve() dependency must be a deploy-time value, never a value known only at boot or a field wrapped with field(); to compute with an input field, declare it plain' as const;

/** The type `resolve()` requires of the dependency tuple `D`. */
type Dependencies<D extends readonly Value<unknown>[]> = Parameters<typeof resolve<D, string>>[0];

test('resolve() lists deploy-time values: a plain field, a computed value, and a field typed unknown or any', () => {
  const untyped = z.object({ meta: z.unknown(), loose: z.any() });
  module('m', { input: arkSchema }, ({ input, environment }) => {
    resolve([input.host, environment.name, text], (values) => {
      expectTypeOf(values).toEqualTypeOf<readonly [string, string, string]>();
      return values[0];
    });
  });
  module('m', { input: untyped }, ({ input }) => {
    resolve([input.meta, input.loose], ([meta, loose]) => {
      expectTypeOf(meta).toEqualTypeOf<unknown>();
      expectTypeOf(loose).toBeAny();
      return 'x';
    });
  });
});

test('resolve() lists a dependency whose type is recursive, such as PlainData or a JSON field', () => {
  resolve([plainData], ([data]) => {
    expectTypeOf(data).toEqualTypeOf<PlainData>();
    return 'x';
  });
  module('m', { input: z.object({ meta: z.json() }) }, ({ input }) => {
    resolve([input.meta], () => 'x');
  });
});

test('listing a runtime value or a wrapped field in resolve() fails to compile', () => {
  // @ts-expect-error a plain runtime value is not a deploy-time value
  resolve([plainRuntime], () => 'x');
  // @ts-expect-error a secret runtime value is not a deploy-time value
  resolve([secretRuntime], () => 'x');
  module('m', { input: arkSchema }, ({ input }) => {
    // @ts-expect-error a wrapped field may hold a pointer
    resolve([input.from], () => 'x');
    // @ts-expect-error a wrapped transforming field may hold a pointer
    resolve([input.port], () => 'x');
    // @ts-expect-error a secretString() field may hold a secret pointer
    resolve([input.key], () => 'x');
  });
  module('m', { input: zodSchema }, ({ input }) => {
    // @ts-expect-error a wrapped field may hold a pointer
    resolve([input.from], () => 'x');
    // @ts-expect-error a secretString() field may hold a secret pointer
    resolve([input.key], () => 'x');
  });
  module('m', { input: arkNested }, ({ input }) => {
    // @ts-expect-error an object field whose leaves are wrapped may hold a pointer
    resolve([input.smtp], () => 'x');
    // @ts-expect-error an array of wrapped fields may hold a pointer
    resolve([input.tags], () => 'x');
  });
});

test('the type error says a dependency must be a deploy-time value', () => {
  expectTypeOf<Dependencies<readonly [Value<string>, RuntimeValue<string>]>>().toEqualTypeOf<
    readonly [Value<string>, typeof NOT_DEPLOY_TIME]
  >();
  expectTypeOf<
    Dependencies<readonly [Value<{ smtp: { user: string | Pointer<string> } }>]>
  >().toEqualTypeOf<readonly [typeof NOT_DEPLOY_TIME]>();
});
