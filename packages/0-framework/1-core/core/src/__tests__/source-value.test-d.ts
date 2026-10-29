import type { SecretString } from '@internal/foundation/secret';
import { expectTypeOf, test } from 'vitest';
import type {
  ModuleInputBinding,
  ParamSource,
  ResourcePropsMember,
  SecretBindings,
  SecretNeed,
  SecretSource,
  Value,
} from '../exports/index.ts';
import { isRuntimeValue, paramSource, resolve, secretSource } from '../exports/index.ts';

const secretValue = secretSource<{ name: string }, SecretString>({ name: 'K' });
const paramValue = paramSource<{ name: string }, string>({ name: 'G' }, { poolKey: 'G' });

test('a secret source is a SecretSource and a Value of its type, and resolve() receives that type', () => {
  expectTypeOf(secretValue).toExtend<SecretSource>();
  expectTypeOf(secretValue).toExtend<Value<SecretString>>();
  resolve([secretValue], ([v]) => {
    expectTypeOf(v).toEqualTypeOf<SecretString>();
    return 'x';
  });
});

test('a param source fits a module input field of its type, and a bare ParamSource fits none', () => {
  expectTypeOf({ from: paramValue }).toExtend<ModuleInputBinding<{ from: string }>>();
  expectTypeOf({ n: paramValue }).not.toExtend<ModuleInputBinding<{ n: number }>>();
  let bare!: ParamSource;
  expectTypeOf({ from: bare }).not.toExtend<ModuleInputBinding<{ from: string }>>();
});

test("a Value<SecretString> that is not a source does not fit a module's secrets slot", () => {
  let field!: Value<SecretString>;
  expectTypeOf(field).not.toExtend<SecretSource>();
  expectTypeOf({ key: field }).not.toExtend<SecretBindings<{ key: SecretNeed }>>();
});

test("a resource's props take a param source of a plain type, never a secret source", () => {
  expectTypeOf(paramValue).toExtend<ResourcePropsMember>();
  expectTypeOf(secretValue).not.toExtend<ResourcePropsMember>();
});

test('isRuntimeValue() narrows to a source', () => {
  const x: unknown = secretValue;
  if (isRuntimeValue(x)) expectTypeOf(x).toEqualTypeOf<ParamSource | SecretSource>();
});
