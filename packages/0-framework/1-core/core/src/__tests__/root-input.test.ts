import { describe, expect, test } from 'bun:test';
import { secretString } from '@internal/foundation/arktype';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { string } from '../config.ts';
import { type Graph, Load, LoadError } from '../graph.ts';
import { module, paramSource, service } from '../node.ts';
import { resolve } from '../value.ts';
import { anyInputSchema } from './helpers.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const echoService = () =>
  service({
    name: 'echo',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: { label: string() },
    input: anyInputSchema,
    build,
  });

const staging = { environment: { name: 'staging' } };

const loadError = (run: () => unknown): LoadError => {
  try {
    run();
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error('expected a LoadError');
};

const recording = (seen: unknown[]): StandardSchemaV1 => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      seen.push(value);
      return { value };
    },
  },
});

const refusing = (message: string): StandardSchemaV1 => ({
  '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [{ message }] }) },
});

const variable = (name: string) =>
  paramSource({ name }, { label: `envParam('${name}')`, poolKey: name });

const bindingOf = (graph: Graph, index = 0): Record<string, unknown> =>
  graph.inputBindings[index]?.binding as unknown as Record<string, unknown>;

/** A root `shop` whose input schema is `schema` and whose body binds `{ [key]: input[field] }` on `echo`. */
const shopBinding = (schema: StandardSchemaV1, key: string, field: string) =>
  module('shop', { input: schema }, ({ input, provision }) => {
    provision(echoService(), { input: { [key]: (input as never)[field] } });
  });

describe("a root's input is the config pool", () => {
  test('a root that declares input receives the config pool as its input', () => {
    const seen: unknown[] = [];
    const pool = { EMAIL_FROM: 'a@shop.example' };

    const graph = Load(shopBinding(recording(seen), 'from', 'EMAIL_FROM'), { configPool: pool });

    expect(bindingOf(graph)).toEqual({ from: 'a@shop.example' });
    expect(seen).toEqual([pool]);
  });

  test("the root's schema output is the real value", () => {
    const root = shopBinding(type({ N: 'string.integer.parse' }), 'n', 'N');

    const graph = Load(root, { configPool: { N: '4' } });

    expect(bindingOf(graph)['n']).toBe(4);
  });

  test('an optional root key the pool lacks is a key left out', () => {
    const root = shopBinding(type({ 'SITE?': 'string' }), 'site', 'SITE');

    const graph = Load(root, { configPool: {} });

    expect('site' in bindingOf(graph)).toBe(false);
  });

  test("pool keys the root's schema does not declare reach the schema, which decides", () => {
    const pool = { A: 'x', PATH: '/bin' };

    const ignoring = Load(shopBinding(type({ A: 'string' }), 'a', 'A'), { configPool: pool });
    expect(bindingOf(ignoring)).toEqual({ a: 'x' });

    const rejecting = shopBinding(type({ '+': 'reject', A: 'string' }), 'a', 'A');
    const message = loadError(() => Load(rejecting, { configPool: pool })).message;
    expect(message).toStartWith(
      'The input of root module "shop" does not match its input schema: ',
    );
    expect(message).toContain('PATH');
  });

  test('a root input the schema refuses fails naming the root and the environment', () => {
    const root = shopBinding(refusing('EMAIL_FROM must be a string (was missing)'), 'from', 'X');

    expect(loadError(() => Load(root, { ...staging, configPool: {} })).message).toBe(
      'The input of root module "shop" does not match its input schema: EMAIL_FROM must be a ' +
        "string (was missing). A root's input is the config pool: the values the `config` " +
        'adapters in prisma.config.ts return for the environment "staging".',
    );
  });

  test("without an environment the root's message leaves the environment out", () => {
    const root = shopBinding(refusing('EMAIL_FROM must be a string (was missing)'), 'from', 'X');

    expect(loadError(() => Load(root, { configPool: {} })).message).toBe(
      'The input of root module "shop" does not match its input schema: EMAIL_FROM must be a ' +
        "string (was missing). A root's input is the config pool: the values the `config` " +
        'adapters in prisma.config.ts return.',
    );
  });

  test('a root that declares input fails when Load has no config pool', () => {
    const root = shopBinding(anyInputSchema, 'from', 'EMAIL_FROM');

    expect(loadError(() => Load(root)).message).toBe(
      'Module "shop" declares input and is being deployed as the root, but Load was given no ' +
        'config pool to fill it from. Pass { configPool } to Load; prisma deploy and prisma dev ' +
        'pass the values the `config` adapters return.',
    );
  });

  test("a root's secretString() field refuses a plain string from the pool", () => {
    const root = shopBinding(type({ KEY: secretString() }), 'key', 'KEY');

    const message = loadError(() =>
      Load(root, { configPool: { KEY: 'sk_live_SENTINEL' } }),
    ).message;

    expect(message).toStartWith(
      'The input of root module "shop" does not match its input schema: ',
    );
    expect(message).not.toContain('sk_live_SENTINEL');
  });

  test("the root's schema runs before any other module's", () => {
    const order: string[] = [];
    const labelled = (label: string): StandardSchemaV1 => ({
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => {
          order.push(label);
          return { value };
        },
      },
    });
    const email = module('email', { input: labelled('email') }, ({ input, provision }) => {
      provision(echoService(), { input: input as never });
    });
    const root = module('shop', { input: labelled('shop') }, ({ input, provision }) => {
      provision(email as never, { input: { from: (input as never)['EMAIL_FROM'] } } as never);
    });

    Load(root, { configPool: { EMAIL_FROM: 'a@shop.example' } });

    expect(order).toEqual(['shop', 'email']);
  });

  test("resolve() over a root input field receives the pool's value", () => {
    const root = module('shop', { input: type({ HOST: 'string' }) }, ({ input, provision }) => {
      provision(echoService(), {
        input: { url: resolve([input.HOST], ([h]) => `https://${h}`) },
      });
    });

    const graph = Load(root, { configPool: { HOST: 'shop.example' } });

    expect(bindingOf(graph)['url']).toBe('https://shop.example');
  });
});

describe('a pool-key source reads text', () => {
  test('a pool-key source whose pool value is not text fails naming its kind', () => {
    const email = module('email', { input: anyInputSchema }, ({ input, provision }) => {
      provision(echoService(), { input: input as never });
    });
    const root = module('shop', ({ provision }) => {
      provision(email as never, { input: { n: variable('N') } } as never);
    });

    expect(loadError(() => Load(root, { configPool: { N: 4 } })).message).toBe(
      'input key "n" of module "shop.email" depends on envParam(\'N\'), which reads "N" from the ' +
        'config pool, but the pool holds a number there, not text. A source with a pool key reads ' +
        "text; to pass other data, declare it in the root module's input.",
    );
  });
});
