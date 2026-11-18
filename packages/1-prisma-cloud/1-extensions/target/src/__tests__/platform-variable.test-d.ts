import {
  appRoot,
  type ParamSource,
  type RuntimeValue,
  type SecretSource,
  type SecretString,
  type ValueResourceNode,
} from '@internal/core';
import { expectTypeOf, test } from 'vitest';
import { type PlatformVariablePayload, variable } from '../exports/index.ts';

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
