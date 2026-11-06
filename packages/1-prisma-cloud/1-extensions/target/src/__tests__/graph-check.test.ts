import { describe, expect, test } from 'bun:test';
import { Load, module } from '@internal/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { prismaCloud } from '../exports/control.ts';
import { compute } from '../exports/index.ts';
import { checkGraph } from '../graph-check.ts';
import { envParam } from '../param.ts';
import { envSecret } from '../secret.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const anySchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

const web = () => compute({ name: 'web', deps: {}, input: anySchema, build });

const thrown = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the check to throw');
};

describe('the Prisma Cloud graph check', () => {
  test('the extension registers it', () => {
    expect(prismaCloud().checkGraph).toBe(checkGraph);
  });

  test('refuses a name that envParam() in a binding and a root input field both use, naming both', () => {
    const root = module(
      'shop',
      { input: type({ APP_ORIGIN: 'string' }) },
      ({ input, provision }) => {
        provision(web(), { id: 'site', input: { origin: input.APP_ORIGIN } });
        provision(web(), { id: 'api', input: { links: { origin: envParam('APP_ORIGIN') } } });
      },
    );
    const graph = Load(root, { configuration: { APP_ORIGIN: 'https://shop.example' } });

    expect(thrown(() => checkGraph(graph))).toBe(
      `envParam('APP_ORIGIN') in the input of service "shop.api", field "links.origin" and input.APP_ORIGIN of root module "shop" both use the name "APP_ORIGIN". A name has one meaning in an app: read "APP_ORIGIN" either with envParam() or as a field of the root's input, not both, or give one of them a different name.`,
    );
  });

  test('refuses a name that envParam() in per-key params and a root input field both use', () => {
    const root = module(
      'shop',
      { input: type({ PORT_NUMBER: 'string' }) },
      ({ input, provision }) => {
        provision(web(), { id: 'site', input: { port: input.PORT_NUMBER } });
        provision(compute({ name: 'api', deps: {}, build }), {
          id: 'api',
          params: { port: envParam('PORT_NUMBER') },
        });
      },
    );
    const graph = Load(root, { configuration: { PORT_NUMBER: '3000' } });

    expect(thrown(() => checkGraph(graph))).toBe(
      `envParam('PORT_NUMBER') in param "port" of service "shop.api" and input.PORT_NUMBER of root module "shop" both use the name "PORT_NUMBER". A name has one meaning in an app: read "PORT_NUMBER" either with envParam() or as a field of the root's input, not both, or give one of them a different name.`,
    );
  });

  test('allows one envParam() name in two bindings and one envSecret() name in two bindings', () => {
    const root = module('shop', ({ provision }) => {
      provision(web(), {
        id: 'site',
        input: { origin: envParam('APP_ORIGIN'), key: envSecret('API_KEY') },
      });
      provision(web(), {
        id: 'api',
        input: { origin: envParam('APP_ORIGIN'), key: envSecret('API_KEY') },
      });
    });
    const graph = Load(root, { configuration: { APP_ORIGIN: 'https://shop.example' } });

    expect(() => checkGraph(graph)).not.toThrow();
  });

  test('allows a root input field and an envParam() of different names', () => {
    const root = module('shop', { input: type({ FROM: 'string' }) }, ({ input, provision }) => {
      provision(web(), { id: 'site', input: { from: input.FROM, origin: envParam('APP_ORIGIN') } });
    });
    const graph = Load(root, { configuration: { FROM: 'shop@example.com', APP_ORIGIN: 'x' } });

    expect(() => checkGraph(graph)).not.toThrow();
  });
});
