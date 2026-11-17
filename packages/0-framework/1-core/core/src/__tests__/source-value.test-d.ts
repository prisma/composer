import type { SecretString } from '@internal/foundation/secret';
import { expectTypeOf, test } from 'vitest';
import type {
  InputBinding,
  ParamSource,
  Pointer,
  ResourcePropsMember,
  SecretSource,
  Value,
} from '../exports/index.ts';
import { paramSource, secretSource } from '../exports/index.ts';

const secretValue = secretSource<{ name: string }, Pointer<SecretString>>({ name: 'K' });
const paramValue = paramSource<{ name: string }, Pointer<string>>({ name: 'G' });

test('paramSource() takes no configurationKey', () => {
  // @ts-expect-error a param source reads no app configuration key; read a deploy-time value through a root input field
  paramSource({ name: 'G' }, { configurationKey: 'G' });
});

test('a secret source is a SecretSource and a Value of its type', () => {
  expectTypeOf(secretValue).toExtend<SecretSource>();
  expectTypeOf(secretValue).toExtend<Value<Pointer<SecretString>>>();
});

test('a param source fits a wrapped binding field of its type, not a plain one, and a bare ParamSource fits none', () => {
  expectTypeOf({ from: paramValue }).toExtend<InputBinding<{ from: string | Pointer<string> }>>();
  expectTypeOf({ from: paramValue }).not.toExtend<InputBinding<{ from: string }>>();
  expectTypeOf({ n: paramValue }).not.toExtend<InputBinding<{ n: number | Pointer<number> }>>();
  let bare!: ParamSource;
  expectTypeOf({ from: bare }).not.toExtend<InputBinding<{ from: string | Pointer<string> }>>();
});

test('a Value<SecretString> that is not a source is not a SecretSource', () => {
  let field!: Value<SecretString>;
  expectTypeOf(field).not.toExtend<SecretSource>();
});

test("a resource's props take neither a param source nor a secret source", () => {
  expectTypeOf(paramValue).not.toExtend<ResourcePropsMember>();
  expectTypeOf(secretValue).not.toExtend<ResourcePropsMember>();
});
