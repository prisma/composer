import { describe, expect, test } from 'bun:test';
import { dependency, Load, type ModuleNode, module, string } from '@internal/core';
import { findEnvKeyClashes } from '../env-key-clash.ts';
import { compute } from '../exports/index.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const service = (name: string) => compute({ name, deps: {}, build });

type EmptyModule = ModuleNode<Record<never, never>, Record<never, never>, undefined>;

/** Modules with these ids, each inside the one before, the last holding a service `x`. */
const xInside = (id: string, ...inner: string[]): EmptyModule =>
  module(id, ({ provision }) => {
    const [next, ...rest] = inner;
    if (next === undefined) provision(service('x'), { id: 'x' });
    else provision(xInside(next, ...rest), { id: next });
  });

/** The app `app` with a service `x` directly below the root, and another inside the modules `id`, then `inner`. */
const appWithNestedX = (app: string, id: string, ...inner: string[]) =>
  Load(
    module(app, ({ provision }) => {
      provision(service('x'), { id: 'x' });
      provision(xInside(id, ...inner), { id });
    }),
  );

const clashKeys = (graph: ReturnType<typeof Load>) =>
  findEnvKeyClashes(graph).map(({ key, newOwner, oldOwner }) => ({ key, newOwner, oldOwner }));

describe('findEnvKeyClashes', () => {
  test("a module named like the app: one node's new key is the other node's old key", () => {
    expect(clashKeys(appWithNestedX('shop', 'shop'))).toContainEqual({
      key: 'COMPOSER_SHOP_X_ORIGIN',
      newOwner: 'shop.x',
      oldOwner: 'shop.shop.x',
    });
  });

  test('a module named like the app in another letter case', () => {
    expect(clashKeys(appWithNestedX('shop', 'Shop'))).toContainEqual({
      key: 'COMPOSER_SHOP_X_ORIGIN',
      newOwner: 'shop.x',
      oldOwner: 'shop.Shop.x',
    });
  });

  test('an app name with `-` whose parts modules spell', () => {
    expect(clashKeys(appWithNestedX('my-shop', 'my', 'shop'))).toContainEqual({
      key: 'COMPOSER_MY_SHOP_X_ORIGIN',
      newOwner: 'my-shop.x',
      oldOwner: 'my-shop.my.shop.x',
    });
  });

  test('an app name with `_` whose parts modules spell', () => {
    expect(clashKeys(appWithNestedX('my_shop', 'my', 'shop'))).toContainEqual({
      key: 'COMPOSER_MY_SHOP_X_ORIGIN',
      newOwner: 'my_shop.x',
      oldOwner: 'my_shop.my.shop.x',
    });
  });

  test('a service directly under the root named like the app, with a dependency input named like a sibling', () => {
    const dep = dependency({
      type: 'test',
      connection: { params: { origin: string() }, hydrate: (v) => v },
    });
    const graph = Load(
      module('shop', ({ provision }) => {
        const x = provision(service('x'), { id: 'x' });
        provision(compute({ name: 'shop', deps: { x: dep }, build }), {
          id: 'shop',
          deps: { x },
        });
      }),
    );

    expect(clashKeys(graph)).toContainEqual({
      key: 'COMPOSER_SHOP_X_ORIGIN',
      newOwner: 'shop.x',
      oldOwner: 'shop.shop',
    });
  });

  test("names the key the old owner's row moves to", () => {
    const clash = findEnvKeyClashes(appWithNestedX('shop', 'shop')).find(
      (c) => c.key === 'COMPOSER_SHOP_X_ORIGIN',
    );

    expect(clash?.oldOwnerNewKey).toBe('COMPOSER_SHOP_SHOP_X_ORIGIN');
  });

  test('an app without the clash has none', () => {
    const graph = Load(
      module('shop', ({ provision }) => {
        provision(service('x'), { id: 'x' });
        provision(
          module('catalog', ({ provision: p }) => {
            p(service('x'), { id: 'x' });
          }),
          { id: 'catalog' },
        );
      }),
    );

    expect(findEnvKeyClashes(graph)).toEqual([]);
  });
});
