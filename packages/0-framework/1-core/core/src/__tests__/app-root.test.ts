import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { string } from '../config.ts';
import { Load, LoadError } from '../graph.ts';
import type { AppRootContext } from '../node.ts';
import { appRoot, dependency, module, resource, service } from '../node.ts';
import { anyInputSchema, conn, providerContract } from './helpers.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const echo = service({
  name: 'echo',
  extension: 'test/pack',
  type: 'fake/compute',
  inputs: {},
  params: {},
  input: anyInputSchema,
  build,
});

const dbContract = providerContract('fake/db', { url: '' });

const api = service({
  name: 'api',
  extension: 'test/pack',
  type: 'fake/compute',
  inputs: {
    db: dependency({
      name: 'db',
      type: 'fake/db',
      connection: conn({ url: string() }, (v) => ({ url: v.url })),
      required: dbContract,
    }),
  },
  params: {},
  input: anyInputSchema,
  build,
});

const catalog = module('catalog', {}, ({ provision }) => {
  const db = provision(resource({ name: 'db', extension: 'test/pack', provides: dbContract }));
  provision(api, { deps: { db }, input: { greeting: 'hello' } });
});

const shopBody = ({ provision }: AppRootContext<undefined>) => {
  provision(catalog);
};

const loadError = (run: () => unknown): LoadError => {
  try {
    run();
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error('expected a LoadError');
};

describe('appRoot()', () => {
  test('builds a frozen module node whose isRoot() is true', () => {
    const root = appRoot('shop', shopBody);

    expect(root.kind).toBe('module');
    expect(root.name).toBe('shop');
    expect(root.isRoot()).toBe(true);
    expect(Object.isFrozen(root)).toBe(true);
  });

  test("a module() node's isRoot() is false", () => {
    expect(module('shop', shopBody).isRoot()).toBe(false);
    expect(catalog.isRoot()).toBe(false);
  });

  test('Load of an app root gives the same graph as the same body written with module()', () => {
    const fromAppRoot = Load(appRoot('shop', shopBody));
    const fromModule = Load(module('shop', shopBody));

    const shape = (graph: typeof fromAppRoot) => ({
      nodes: graph.nodes.map(({ id, parent, node }) => ({ id, parent, kind: node.kind })),
      edges: graph.edges,
      ports: graph.ports,
      authoredEdges: graph.authoredEdges,
      inputBindings: graph.inputBindings,
    });
    expect(shape(fromAppRoot)).toEqual(shape(fromModule));
  });

  test("the body receives the root's input, the environment and provision, and no deps", () => {
    const keys: string[][] = [];
    const root = appRoot('shop', { input: type({ GREETING: 'string' }) }, (ctx) => {
      keys.push(Object.keys(ctx).sort());
      ctx.provision(echo, { input: { greeting: ctx.input.GREETING } });
    });

    const graph = Load(root, { configuration: { GREETING: 'hello' } });

    expect(keys).toEqual([['environment', 'input', 'provision']]);
    expect(graph.inputBindings).toEqual([
      { serviceAddress: 'shop.echo', binding: { greeting: 'hello' } },
    ]);
  });

  test('a root without options receives undefined as its input', () => {
    const seen: unknown[] = [];
    Load(
      appRoot('shop', ({ input }) => {
        seen.push(input);
      }),
    );

    expect(seen).toEqual([undefined]);
  });

  test('throws when the body is missing', () => {
    expect(() => appRoot('shop', {}, undefined as never)).toThrow(
      'appRoot("shop") requires a body function.',
    );
    expect(() => module('shop', {}, undefined as never)).toThrow(
      'module("shop") requires a body function.',
    );
  });

  test('checks the name first, then the body, then deps and expose', () => {
    expect(() => appRoot('', { deps: {} } as never, undefined as never)).toThrow(
      'appRoot() requires a non-empty name.',
    );
    expect(() => module('', {}, undefined as never)).toThrow('module() requires a non-empty name.');
    expect(() => appRoot('shop', { deps: {} } as never, undefined as never)).toThrow(
      'appRoot("shop") requires a body function.',
    );
    expect(() => appRoot('shop', { expose: {} } as never, undefined as never)).toThrow(
      'appRoot("shop") requires a body function.',
    );
  });

  test('throws when the options declare deps', () => {
    expect(() => appRoot('shop', { deps: {} } as never, () => {})).toThrow(
      'appRoot("shop") declares `deps`, which an app root cannot have: nothing provisions the root, so nothing can wire a dependency into it. Provision the resource inside the root\'s body instead.',
    );
  });

  test('throws when the options declare expose', () => {
    expect(() => appRoot('shop', { expose: {} } as never, () => {})).toThrow(
      'appRoot("shop") declares `expose`, which an app root cannot have: nothing provisions the root, so nothing can consume what it exposes.',
    );
  });

  test('refuses params, secrets and a non-schema input as module() does', () => {
    expect(() => appRoot('shop', { params: {} } as never, () => {})).toThrow(
      /^appRoot\("shop"\) declares `params`/,
    );
    expect(() => appRoot('shop', { secrets: {} } as never, () => {})).toThrow(
      /^appRoot\("shop"\) declares `secrets`/,
    );
    expect(() => appRoot('shop', { input: {} as never }, () => {})).toThrow(
      /^appRoot\(\) `input` must be a Standard Schema/,
    );
  });
});

describe('Load refuses an app root below the root', () => {
  test('a module body that provisions an app root through a cast fails, naming both', () => {
    const nested = appRoot('storefront', () => {});
    const shop = module('shop', ({ provision }) => {
      provision(nested as never);
    });

    const error = loadError(() => Load(shop));

    expect(error.code).toBe('COMPOSE.GRAPH_INVALID');
    expect(error.message).toBe(
      'Module "shop" provisions the app root "storefront". An app root is the deploy\'s entry and cannot be provisioned. Build the module with module() instead.',
    );
  });

  test('names the provisioning module by its address', () => {
    const nested = appRoot('storefront', () => {});
    const inner = module('inner', {}, ({ provision }) => {
      provision(nested as never);
    });

    const error = loadError(() => Load(appRoot('shop', ({ provision }) => provision(inner))));

    expect(error.message).toStartWith('Module "shop.inner" provisions the app root "storefront".');
  });
});
