import type { SecretString } from '@internal/foundation/secret';
import { expectTypeOf, test } from 'vitest';
import type {
  InputBinding,
  ParamSource,
  ResourcePropsMember,
  SecretSource,
  Value,
} from '../exports/index.ts';
import { paramSource, secretSource } from '../exports/index.ts';

const secretValue = secretSource<{ name: string }, SecretString>({ name: 'K' });
const paramValue = paramSource<{ name: string }, string>({ name: 'G' }, { configurationKey: 'G' });

test('a secret source is a SecretSource and a Value of its type', () => {
  expectTypeOf(secretValue).toExtend<SecretSource>();
  expectTypeOf(secretValue).toExtend<Value<SecretString>>();
});

test('a param source fits a binding field of its type, and a bare ParamSource fits none', () => {
  expectTypeOf({ from: paramValue }).toExtend<InputBinding<{ from: string }>>();
  expectTypeOf({ n: paramValue }).not.toExtend<InputBinding<{ n: number }>>();
  let bare!: ParamSource;
  expectTypeOf({ from: bare }).not.toExtend<InputBinding<{ from: string }>>();
});

test('a Value<SecretString> that is not a source is not a SecretSource', () => {
  let field!: Value<SecretString>;
  expectTypeOf(field).not.toExtend<SecretSource>();
});

test("a resource's props take a param source of a plain type, never a secret source", () => {
  expectTypeOf(paramValue).toExtend<ResourcePropsMember>();
  expectTypeOf(secretValue).not.toExtend<ResourcePropsMember>();
});
