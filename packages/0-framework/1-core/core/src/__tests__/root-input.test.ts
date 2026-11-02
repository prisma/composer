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
  paramSource({ name }, { label: `envParam('${name}')`, configurationKey: name });

const bindingOf = (graph: Graph, index = 0): Record<string, unknown> =>
  graph.inputBindings[index]?.binding as unknown as Record<string, unknown>;

/** A root `shop` whose input schema is `schema` and whose body binds `{ [key]: input[field] }` on `echo`. */
const shopBinding = (schema: StandardSchemaV1, key: string, field: string) =>
  module('shop', { input: schema }, ({ input, provision }) => {
    provision(echoService(), { input: { [key]: (input as never)[field] } });
  });

describe("a root's input is the app configuration", () => {
  test('a root that declares input receives the app configuration as its input', () => {
    const seen: unknown[] = [];
    const configuration = { EMAIL_FROM: 'a@shop.example' };

    const graph = Load(shopBinding(recording(seen), 'from', 'EMAIL_FROM'), { configuration });

    expect(bindingOf(graph)).toEqual({ from: 'a@shop.example' });
    expect(seen).toEqual([configuration]);
  });

  test("the root's schema output is the real value", () => {
    const root = shopBinding(type({ N: 'string.integer.parse' }), 'n', 'N');

    const graph = Load(root, { configuration: { N: '4' } });

    expect(bindingOf(graph)['n']).toBe(4);
  });

  test('an optional root key the app configuration lacks is a key left out', () => {
    const root = shopBinding(type({ 'SITE?': 'string' }), 'site', 'SITE');

    const graph = Load(root, { configuration: {} });

    expect('site' in bindingOf(graph)).toBe(false);
  });

  test("configuration keys the root's schema does not declare reach the schema, which decides", () => {
    const configuration = { A: 'x', PATH: '/bin' };

    const ignoring = Load(shopBinding(type({ A: 'string' }), 'a', 'A'), { configuration });
    expect(bindingOf(ignoring)).toEqual({ a: 'x' });

    const rejecting = shopBinding(type({ '+': 'reject', A: 'string' }), 'a', 'A');
    const message = loadError(() => Load(rejecting, { configuration })).message;
    expect(message).toStartWith(
      'The input of root module "shop" does not match its input schema: ',
    );
    expect(message).toContain('PATH');
  });

  test('a root input the schema refuses fails naming the root and the environment', () => {
    const root = shopBinding(refusing('EMAIL_FROM must be a string (was missing)'), 'from', 'X');

    expect(loadError(() => Load(root, { ...staging, configuration: {} })).message).toBe(
      'The input of root module "shop" does not match its input schema: EMAIL_FROM must be a ' +
        "string (was missing). A root's input is the values the `config` adapters in " +
        'prisma.config.ts return for the environment "staging".',
    );
  });

  test("without an environment the root's message leaves the environment out", () => {
    const root = shopBinding(refusing('EMAIL_FROM must be a string (was missing)'), 'from', 'X');

    expect(loadError(() => Load(root, { configuration: {} })).message).toBe(
      'The input of root module "shop" does not match its input schema: EMAIL_FROM must be a ' +
        "string (was missing). A root's input is the values the `config` adapters in " +
        'prisma.config.ts return.',
    );
  });

  test('a root that declares input fails when Load has no app configuration', () => {
    const root = shopBinding(anyInputSchema, 'from', 'EMAIL_FROM');

    expect(loadError(() => Load(root)).message).toBe(
      'Module "shop" declares input and is being deployed as the root, but Load was given no ' +
        'app configuration to fill it from. Pass { configuration } to Load; ' +
        'prisma deploy and prisma dev ' +
        'pass the values the `config` adapters return.',
    );
  });

  test("a root's secretString() field refuses a plain string from the app configuration", () => {
    const root = shopBinding(type({ KEY: secretString() }), 'key', 'KEY');

    const message = loadError(() =>
      Load(root, { configuration: { KEY: 'sk_live_SENTINEL' } }),
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
    const email = module('email', { input: labelled('email') }, () => {});
    const root = module('shop', { input: labelled('shop') }, ({ input, provision }) => {
      provision(email as never, { input: { from: (input as never)['EMAIL_FROM'] } } as never);
    });

    Load(root, { configuration: { EMAIL_FROM: 'a@shop.example' } });

    expect(order).toEqual(['shop', 'email']);
  });

  test("resolve() over a root input field receives the app configuration's value", () => {
    const root = module('shop', { input: type({ HOST: 'string' }) }, ({ input, provision }) => {
      provision(echoService(), {
        input: { url: resolve([input.HOST], ([h]) => `https://${h}`) },
      });
    });

    const graph = Load(root, { configuration: { HOST: 'shop.example' } });

    expect(bindingOf(graph)['url']).toBe('https://shop.example');
  });
});

describe("the root's whole input never reaches a binding", () => {
  const schema = type({ GREETING: 'string' });
  const configuration = { GREETING: 'hi', STRIPE_KEY: 'sk_live_SENTINEL' };
  const refusal = (site: string) =>
    `${site} depends on the whole input of module "shop". A module body's input is a ` +
    "dictionary of values, not a value, so it cannot be passed on whole. The root's input is " +
    'every value the `config` adapters return, which by default is every variable of the ' +
    'process environment, secrets included. Pass its fields on by name, such as input.from.';

  test("a service binding that is the root's whole input is refused", () => {
    const root = module('shop', { input: schema }, ({ input, provision }) => {
      provision(echoService(), { input: input as never });
    });

    expect(loadError(() => Load(root, { configuration })).message).toBe(
      refusal('the input binding of service "shop.echo"'),
    );
  });

  test("the root's whole input nested inside a binding is refused", () => {
    const root = module('shop', { input: schema }, ({ input, provision }) => {
      provision(echoService(), { input: { settings: { all: input } } as never });
    });

    expect(loadError(() => Load(root, { configuration })).message).toBe(
      refusal('input key "settings.all" of service "shop.echo"'),
    );
  });

  test("the root's whole input as a resolve() dependency is refused", () => {
    const root = module('shop', { input: schema }, ({ input, provision }) => {
      provision(echoService(), { input: { all: resolve([input as never], ([i]) => i) } as never });
    });

    expect(loadError(() => Load(root, { configuration })).message).toBe(
      refusal('input key "all" of service "shop.echo"'),
    );
  });

  test("the root's whole input bound to a child module is refused", () => {
    const email = module('email', { input: anyInputSchema }, () => {});
    const root = module('shop', { input: schema }, ({ input, provision }) => {
      provision(email as never, { input: { config: input } } as never);
    });

    expect(loadError(() => Load(root, { configuration })).message).toBe(
      refusal('input key "config" of module "shop.email"'),
    );
  });

  test('a module that is not the root cannot pass its whole input on either', () => {
    const email = module('email', { input: anyInputSchema }, ({ input, provision }) => {
      provision(echoService(), { input: input as never });
    });
    const root = module('shop', { input: schema }, ({ input, provision }) => {
      provision(email as never, { input: { greeting: input.GREETING } } as never);
    });

    expect(loadError(() => Load(root, { configuration })).message).toBe(
      'the input binding of service "shop.email.echo" depends on the whole input of module ' +
        '"shop.email". A module body\'s input is a dictionary of values, not a value, so it ' +
        'cannot be passed on whole. Pass its fields on by name, such as input.from.',
    );
  });
});

describe('a source with a configuration key reads text', () => {
  test('a source with a configuration key whose app configuration value is not text fails naming its kind', () => {
    const email = module('email', { input: anyInputSchema }, () => {});
    const root = module('shop', ({ provision }) => {
      provision(email as never, { input: { n: variable('N') } } as never);
    });

    expect(loadError(() => Load(root, { configuration: { N: 4 } })).message).toBe(
      'input key "n" of module "shop.email" depends on envParam(\'N\'), which reads "N" from the ' +
        'values the `config` adapters return, but they return a number for it, not text. ' +
        "envParam('N') reads text; to pass other data, declare it in the root module's input.",
    );
  });
});

describe('what Load reads from the app configuration', () => {
  const schema = type({ A: 'string', 'B?': 'string', C: 'string.integer.parse', D: 'string' });
  const rootOf = (rootSchema: StandardSchemaV1) =>
    module('shop', { input: rootSchema }, ({ input, provision }) => {
      const fields = input as never as Record<string, never>;
      provision(echoService(), { input: { a: fields['A'], b: fields['B'], c: fields['C'] } });
    });
  const configuration = { A: 'a', C: '4', D: 'unused', PATH: '/bin' };
  const byPath = (left: { path: readonly string[] }, right: { path: readonly string[] }) =>
    left.path.join('.').localeCompare(right.path.join('.'));

  test('the graph records each root field the body names, with its checked value, and no other', () => {
    const graph = Load(rootOf(schema), { configuration });

    expect([...graph.checkedConfiguration.rootInput].sort(byPath)).toEqual([
      { path: ['A'], value: 'a' },
      { path: ['B'] },
      { path: ['C'], value: 4 },
    ]);
  });

  test('a root field JSON cannot hold exactly fails the Load, naming it', () => {
    const dated = service({
      name: 'echo',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: {},
      params: {},
      input: type({ when: 'Date' }),
      build,
    });
    const root = module(
      'shop',
      { input: type({ WHEN: type('string').pipe((text) => new Date(text)) }) },
      ({ input, provision }) => {
        provision(dated, { input: { when: input.WHEN } });
      },
    );

    expect(loadError(() => Load(root, { configuration: { WHEN: '2026-01-01' } })).message).toBe(
      'input.WHEN of root module "shop" holds an object that is not plain data, which JSON cannot hold exactly. The deploy hands the root\'s checked input to its second process in a JSON file, so a field the root\'s body passes on must hold text, a finite number, a boolean, null, or arrays and plain objects of these.',
    );
  });

  test("the second process takes each root field from the checked configuration, without running the root's schema", () => {
    const calls: unknown[] = [];
    const counting: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => {
          calls.push(value);
          return { value: {} };
        },
      },
    };

    const graph = Load(rootOf(counting), {
      checkedConfiguration: {
        rootInput: [
          { path: ['A'], value: 'from-file' },
          { path: ['B'] },
          { path: ['C'], value: 4 },
        ],
        values: {},
      },
    });

    expect(calls).toEqual([]);
    expect(bindingOf(graph)).toEqual({ a: 'from-file', c: 4 });
  });

  test('a root field missing from the checked configuration fails, saying the two processes built different graphs', () => {
    const run = () =>
      Load(rootOf(schema), {
        checkedConfiguration: { rootInput: [{ path: ['A'], value: 'a' }], values: {} },
      });

    expect(loadError(run).message).toBe(
      'input.B of root module "shop" is not in the configuration file. The first process\'s root body did not pass it on, so the deploy\'s two processes built different graphs. A module body must build the same graph every time; one that reads the process environment, a file or the clock can build a different one.',
    );
  });

  test('Load refuses configuration and checkedConfiguration together', () => {
    const run = () =>
      Load(rootOf(schema), {
        configuration,
        checkedConfiguration: { rootInput: [], values: {} },
      });

    expect(loadError(run).message).toBe(
      'Load takes configuration, in the first process, or checkedConfiguration, in the second, not both.',
    );
  });

  test('a root with no input records no fields', () => {
    const root = module('shop', ({ provision }) => {
      provision(echoService(), { input: {} });
    });

    expect(Load(root, { configuration: {} }).checkedConfiguration).toEqual({
      rootInput: [],
      values: {},
    });
  });
});
