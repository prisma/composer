/**
 * Type-level rules for the retired module slots: `module()` and `provision()`
 * of a module take no `params` or `secrets`, and `ModuleNode` has three type
 * parameters. Type-only (vitest `--typecheck`, never executed).
 */
import { type } from 'arktype';
import { expectTypeOf, test } from 'vitest';
import type * as Core from '../exports/index.ts';
import { module } from '../exports/index.ts';
import type { ModuleNode } from '../node.ts';

test('module() takes no params or secrets key', () => {
  // @ts-expect-error a module has no params slot
  module('m', { params: {} }, () => {});
  // @ts-expect-error a module has no secrets slot
  module('m', { secrets: {} }, () => {});
});

test('provision() of a module takes no params or secrets map', () => {
  const m = module('m', { input: type({ from: 'string' }) }, () => {});
  module('root', ({ provision }) => {
    // @ts-expect-error a module takes no params map
    provision(m, { input: { from: 'a' }, params: {} });
    // @ts-expect-error a module takes no secrets map
    provision(m, { input: { from: 'a' }, secrets: {} });
  });
});

test('a module body has no secrets or params', () => {
  // @ts-expect-error the body receives no secrets
  module('m', {}, ({ secrets }) => {});
  // @ts-expect-error the body receives no params
  module('m', {}, ({ params }) => {});
});

test('ModuleNode takes three type parameters', () => {
  expectTypeOf<
    ModuleNode<Record<never, never>, Record<never, never>, undefined>['inputSchema']
  >().toEqualTypeOf<undefined>();
  // @ts-expect-error a fourth type argument is one too many
  type FourArguments = ModuleNode<
    Record<never, never>,
    Record<never, never>,
    undefined,
    Record<never, never>
  >;
  expectTypeOf<FourArguments>().not.toBeNever();
});

test('the removed types are not exported', () => {
  // @ts-expect-error ParamNeed is removed
  expectTypeOf<Core.ParamNeed>();
  // @ts-expect-error ParamNeeds is removed
  expectTypeOf<Core.ParamNeeds>();
  // @ts-expect-error ParamNeedBindings is removed
  expectTypeOf<Core.ParamNeedBindings>();
  // @ts-expect-error SecretNeed is removed
  expectTypeOf<Core.SecretNeed>();
  // @ts-expect-error Secrets is removed
  expectTypeOf<Core.Secrets>();
  // @ts-expect-error SecretBindings is removed
  expectTypeOf<Core.SecretBindings>();
});
