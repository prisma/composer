import type { StandardSchemaV1 } from '@standard-schema/spec';
import { expectTypeOf, test } from 'vitest';
import type {
  AppRootContext,
  AppRootNode,
  ModuleBuilder,
  ModuleInputField,
  ModuleNode,
  ServiceNode,
} from '../exports/index.ts';
import { appRoot, Load, module } from '../exports/index.ts';

declare const greetingSchema: StandardSchemaV1<{ GREETING: string }>;

const child = module('child', () => {});
const childWithInput = module('child', { input: greetingSchema }, () => {});
const root = appRoot('shop', () => {});
const rootWithInput = appRoot('shop', { input: greetingSchema }, () => {});

test('appRoot() without options builds an app root that takes no input', () => {
  expectTypeOf(root).toEqualTypeOf<AppRootNode<undefined>>();
  appRoot('shop', (ctx) => {
    expectTypeOf(ctx).toEqualTypeOf<AppRootContext<undefined>>();
    expectTypeOf(ctx.input).toEqualTypeOf<undefined>();
  });
});

test("appRoot() with an input schema types the body's input from it", () => {
  expectTypeOf(rootWithInput).toEqualTypeOf<AppRootNode<typeof greetingSchema>>();
  appRoot('shop', { input: greetingSchema }, ({ input }) => {
    expectTypeOf(input.GREETING).toEqualTypeOf<ModuleInputField<string>>();
  });
  appRoot('shop', {}, ({ input }) => {
    expectTypeOf(input).toEqualTypeOf<undefined>();
  });
});

test('the options take input and nothing else', () => {
  // @ts-expect-error an app root has no deps
  appRoot('shop', { deps: {} }, () => {});
  // @ts-expect-error an app root has no expose
  appRoot('shop', { expose: {} }, () => {});
  // @ts-expect-error an unknown key
  appRoot('shop', { input: greetingSchema, other: true }, () => {});
});

test("the body's context has input, environment and provision, and no deps", () => {
  expectTypeOf<keyof AppRootContext>().toEqualTypeOf<'input' | 'environment' | 'provision'>();
  expectTypeOf<AppRootContext['provision']>().toEqualTypeOf<ModuleBuilder['provision']>();
  appRoot('shop', (ctx) => {
    // @ts-expect-error an app root's body has no deps
    void ctx.deps;
  });
});

test('isRoot() is false on a module node and true on an app root node', () => {
  expectTypeOf(child.isRoot()).toEqualTypeOf<false>();
  expectTypeOf(root.isRoot()).toEqualTypeOf<true>();
  expectTypeOf<AppRootNode>().not.toExtend<ModuleNode>();
  expectTypeOf<ModuleNode>().not.toExtend<AppRootNode>();
});

test('a module provisions in an appRoot() body and in a module() body', () => {
  appRoot('shop', ({ provision }) => {
    provision(child);
    provision(child, { id: 'other' });
    provision(childWithInput, { input: { GREETING: 'hello' } });
  });
  module('shop', ({ provision }) => {
    provision(child);
    provision(child, { id: 'other' });
    provision(childWithInput, { input: { GREETING: 'hello' } });
  });
});

test('an app root does not provision in a module() body, under any overload', () => {
  module('shop', ({ provision }) => {
    // @ts-expect-error an app root cannot be provisioned
    provision(root);
    // @ts-expect-error an app root cannot be provisioned
    provision(root, { id: 'other' });
    // @ts-expect-error an app root cannot be provisioned
    provision(rootWithInput, { input: { GREETING: 'hello' } });
    // @ts-expect-error an app root cannot be provisioned
    provision(root, { deps: {} });
    // @ts-expect-error an app root cannot be provisioned
    provision(rootWithInput, { deps: {}, input: { GREETING: 'hello' } });
  });
});

test('an app root does not provision in an appRoot() body, under any overload', () => {
  appRoot('outer', ({ provision }) => {
    // @ts-expect-error an app root cannot be provisioned
    provision(root);
    // @ts-expect-error an app root cannot be provisioned
    provision(root, { id: 'other' });
    // @ts-expect-error an app root cannot be provisioned
    provision(rootWithInput, { input: { GREETING: 'hello' } });
    // @ts-expect-error an app root cannot be provisioned
    provision(root, { deps: {} });
    // @ts-expect-error an app root cannot be provisioned
    provision(rootWithInput, { deps: {}, input: { GREETING: 'hello' } });
  });
});

test("a wrapper whose parameter is a ModuleNode refuses an app root at the wrapper's call site", () => {
  const wrap = (m: ModuleNode<Record<never, never>, Record<never, never>, undefined>) =>
    module('wrapper', ({ provision }) => {
      provision(m);
    });
  const wrapAny = <N extends ServiceNode | ModuleNode>(node: N) => node;

  wrap(child);
  // @ts-expect-error an app root is not a ModuleNode
  wrap(root);
  wrapAny(child);
  // @ts-expect-error an app root is not a ModuleNode
  wrapAny(root);
});

test('Load accepts an app root', () => {
  expectTypeOf(Load).toBeCallableWith(root);
  expectTypeOf(Load).toBeCallableWith(child);
});
