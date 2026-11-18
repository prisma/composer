import type { Pointer } from '@internal/foundation/pointer';
import type { SecretString } from '@internal/foundation/secret';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { expectTypeOf, test } from 'vitest';
import type {
  ParamSource,
  RuntimeValue,
  SecretSource,
  ServiceNode,
  SourceValue,
  VALUE_RESOURCE,
  ValueResourceNode,
} from '../exports/index.ts';
import {
  appRoot,
  module,
  paramSource,
  resource,
  secretSource,
  valueResource,
} from '../exports/index.ts';

interface Payload {
  readonly name: string;
}

const plain = valueResource({
  name: 'greeting',
  extension: 'test/pack',
  type: 'test-value',
  value: paramSource<Payload, Pointer<string>>({ name: 'GREETING' }),
});
const secret = valueResource({
  name: 'apiKey',
  extension: 'test/pack',
  type: 'test-value',
  value: secretSource<Payload, Pointer<SecretString>>({ name: 'API_KEY' }),
});
const store = resource({ name: 'store', extension: 'test/pack', type: 'store' });
const child = module('child', () => {});
declare const greetingSchema: StandardSchemaV1<{ greeting: string }>;
const childWithInput = module('child', { input: greetingSchema }, () => {});
declare const web: ServiceNode<
  Record<never, never>,
  Record<never, never>,
  Record<never, never>,
  undefined
>;

type Plain = ParamSource<Payload> & RuntimeValue<string>;
type Secret = SecretSource<Payload> & RuntimeValue<SecretString>;

test('valueResource() builds a value resource that holds its value under the value resource key', () => {
  expectTypeOf(plain).toEqualTypeOf<ValueResourceNode<Plain>>();
  expectTypeOf(secret).toEqualTypeOf<ValueResourceNode<Secret>>();
  expectTypeOf<ValueResourceNode[typeof VALUE_RESOURCE]>().toEqualTypeOf<SourceValue>();
  // @ts-expect-error the value is held under a core-only key, not a public member
  void plain.value;
  // @ts-expect-error the value must be a source
  valueResource({ name: 'x', extension: 'test/pack', type: 'test-value', value: 'text' });
});

test('in an appRoot() body, provision() returns the value with its id', () => {
  appRoot('shop', ({ provision }) => {
    expectTypeOf(provision(plain)).toEqualTypeOf<Plain & { readonly id: string }>();
    expectTypeOf(provision(plain, { id: 'other' })).toEqualTypeOf<
      Plain & { readonly id: string }
    >();
    expectTypeOf(provision(secret)).toEqualTypeOf<Secret & { readonly id: string }>();
    expectTypeOf(provision(secret, { id: 'other' })).toEqualTypeOf<
      Secret & { readonly id: string }
    >();
  });
});

test('in an appRoot() body, a value resource takes only an id', () => {
  appRoot('shop', ({ provision }) => {
    // @ts-expect-error a value resource takes no input
    provision(plain, { id: 'x', input: {} });
    // @ts-expect-error a value resource takes no deps
    provision(secret, { deps: {} });
    // @ts-expect-error the id is text
    provision(plain, { id: 5 });
  });
});

test('a module() body, at the root or below it, cannot provision a value resource', () => {
  module('shop', ({ provision }) => {
    // @ts-expect-error only appRoot() can provision a value resource
    provision(plain);
    // @ts-expect-error only appRoot() can provision a value resource
    provision(plain, { id: 'x' });
    // @ts-expect-error only appRoot() can provision a value resource
    provision(secret);
    // @ts-expect-error only appRoot() can provision a value resource
    provision(secret, { id: 'x' });
  });
});

test('a resource, a service and a module still provision in both bodies', () => {
  appRoot('shop', ({ provision }) => {
    expectTypeOf(provision(store)).toExtend<{ readonly id: string }>();
    provision(web);
    provision(child, { id: 'other' });
    provision(childWithInput, { input: { greeting: 'hello' } });
  });
  module('shop', ({ provision }) => {
    expectTypeOf(provision(store)).toExtend<{ readonly id: string }>();
    provision(web);
    provision(child, { id: 'other' });
    provision(childWithInput, { input: { greeting: 'hello' } });
  });
});
