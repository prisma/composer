import { describe, expect, test } from 'bun:test';
import { secretString } from '@internal/foundation/arktype';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { string } from '../config.ts';
import { type Graph, Load, LoadError } from '../graph.ts';
import { type ModuleNode, module, paramSource, resource, secretSource, service } from '../node.ts';
import { resolve } from '../value.ts';
import { anyInputSchema, providerContract } from './helpers.ts';

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

/** A root `shop` that provisions `child` as `email` with `input`. */
const shopWith = (child: ModuleNode, input: unknown): ModuleNode =>
  module('shop', ({ provision }) => {
    provision(child as never, { id: 'email', input } as never);
  });

/** A root `shop` that provisions `echo` with `input`. */
const echoWith = (input: unknown): ModuleNode =>
  module('shop', ({ provision }) => {
    provision(echoService(), { input: input as never });
  });

/** A module `email` whose `input` schema is `schema` and whose body forwards the whole input to `echo`. */
const forwarding = (schema: StandardSchemaV1): ModuleNode =>
  module('email', { input: schema }, ({ input, provision }) => {
    provision(echoService(), { input: input as never });
  });

const bindingOf = (graph: Graph, index = 0): Record<string, unknown> =>
  graph.inputBindings[index]?.binding as unknown as Record<string, unknown>;

const pointer = (name: string) => secretSource({ name }, { label: `envSecret('${name}')` });
const variable = (name: string) =>
  paramSource({ name }, { label: `envParam('${name}')`, poolKey: name });

const origin = () => paramSource({}, { label: "serviceOrigin('shop.web')" });

const urlContract = () => providerContract('fake/url', { url: '' });

describe('sources a service takes stay in place', () => {
  test("a source in a service's input binding reaches the graph as the same object", () => {
    const key = pointer('K');
    const greeting = variable('G');

    const graph = Load(echoWith({ key, greeting }));

    expect(bindingOf(graph)['key']).toBe(key);
    expect(bindingOf(graph)['greeting']).toBe(greeting);
  });

  test("a source in a service's params reaches the graph as the same object, with no config pool", () => {
    const label = variable('G');
    const root = module('shop', ({ provision }) => {
      provision(echoService(), { input: {}, params: { label } });
    });

    const graph = Load(root);

    expect(graph.params[0]?.binding).toBe(label);
  });
});

describe('real values', () => {
  test("envParam() in a module's input is its config pool value", () => {
    const graph = Load(
      shopWith(forwarding(type({ greeting: 'string' })), { greeting: variable('G') }),
      {
        configPool: { G: 'hi' },
      },
    );

    expect(bindingOf(graph)).toEqual({ greeting: 'hi' });
  });

  test("an unset or empty variable in a module's input leaves the key out", () => {
    for (const configPool of [{}, { G: '' }]) {
      const graph = Load(
        shopWith(forwarding(type({ 'greeting?': 'string' })), { greeting: variable('G') }),
        { configPool },
      );

      expect('greeting' in bindingOf(graph)).toBe(false);
    }
  });

  test("a variable in a module's input fails when Load has no config pool", () => {
    const root = shopWith(forwarding(type({ greeting: 'string' })), { greeting: variable('G') });

    expect(loadError(() => Load(root)).message).toBe(
      `input key "greeting" of module "shop.email" depends on envParam('G'), but Load was given ` +
        'no config pool to read "G" from. Pass { configPool } to Load; the deploy and dev ' +
        'commands pass the values the `config` adapters return.',
    );
  });

  test('resolve() over envParam() receives the string', () => {
    const greeting = resolve([variable('G')], ([g]) => (g as string).toUpperCase());

    const graph = Load(echoWith({ greeting }), { configPool: { G: 'hi' } });

    expect(bindingOf(graph)['greeting']).toBe('HI');
  });

  test('resolve() over an unset variable fails naming it', () => {
    const greeting = resolve([variable('G')], ([g]) => (g as string).toUpperCase());

    expect(loadError(() => Load(echoWith({ greeting }), { configPool: {} })).message).toBe(
      'The resolve() function for input key "greeting" of service "shop.echo" lists ' +
        `envParam('G'), but "G" is unset or empty, so it has no real value. Set "G", or bind ` +
        `envParam('G') directly into an input binding, where an absent value leaves the key out ` +
        'and the schema decides.',
    );
  });

  test('resolve() over a secret source receives the source and may return it', () => {
    const source = pointer('K');

    const graph = Load(echoWith({ key: resolve([source], ([k]) => k) }));

    expect(bindingOf(graph)['key']).toBe(source);
  });

  test('resolve() may return a pointer inside its result', () => {
    const source = pointer('K');

    const graph = Load(echoWith({ key: resolve([source], ([k]) => ({ inner: k })) }));

    expect((bindingOf(graph)['key'] as Record<string, unknown>)['inner']).toBe(source);
  });

  test('resolve() may choose between two pointers it received', () => {
    const live = pointer('LIVE');
    const test = pointer('TEST');
    const root = module('shop', ({ environment, provision }) => {
      const key = resolve([live, test, environment.name], ([l, t, name]) =>
        name === 'production' ? l : t,
      );
      provision(echoService(), { input: { key: key as never } });
    });

    const graph = Load(root, staging);

    expect(bindingOf(graph)['key']).toBe(test);
  });

  test('a resolve() function that returns a source it did not receive fails', () => {
    const root = module('shop', ({ environment, provision }) => {
      const key = resolve([environment.name], () => ({ a: paramSource({ name: 'X' }) }));
      provision(echoService(), { input: { key: key as never } });
    });

    expect(loadError(() => Load(root, staging)).message).toBe(
      'The resolve() function for input key "key" of service "shop.echo" returned a source at ' +
        '"a" it did not receive, such as envSecret() or envParam() called inside the function. ' +
        'A resolve() function may return a pointer it received from a dependency, unchanged; ' +
        'bind any other source directly.',
    );
  });

  test('a pointer turned into text inside resolve() fails naming the binding and the pointer', () => {
    const key = resolve([pointer('K')], ([k]) => `Bearer ${k}`);

    const error = loadError(() => Load(echoWith({ key })));

    expect(error.message).toBe(
      'The resolve() function for input key "key" of service "shop.echo" threw: ' +
        "envSecret('K') is known only at boot: the deploy holds a pointer to it, never its " +
        'value, and it was turned into text (a template literal or String()). A resolve() ' +
        'function may return the pointer, or put it in its result, unchanged; to compute with ' +
        'the value, do it in the service that reads it.',
    );
    expect(error.cause).toBeInstanceOf(LoadError);
  });
});

describe("a module's input and runtime param sources", () => {
  test("a runtime param source in a module's input is checked as its pointer and reaches the service as the same source", () => {
    const seen: unknown[] = [];
    const base = origin();

    const graph = Load(shopWith(forwarding(recording(seen)), { base }));

    expect((seen[0] as Record<string, unknown>)['base']).toBe(base);
    expect(bindingOf(graph)['base']).toBe(base);
  });

  test('a redacted param source is checked as a secret pointer and reaches the service as the same source', () => {
    const email = module(
      'email',
      { input: type({ key: secretString(), n: 'string.integer.parse' }) },
      ({ input, provision }) => {
        provision(echoService(), { input: { key: input.key, n: input.n } });
      },
    );
    const key = paramSource({}, { label: 'generatedParam()', redacted: true });

    const graph = Load(shopWith(email, { key, n: '4' }));

    expect(bindingOf(graph)['key']).toBe(key);
  });

  test("a raw param source in a module's input is a plain pointer and reaches the service as the same source", () => {
    const from = paramSource({ name: 'X' });

    const graph = Load(shopWith(forwarding(anyInputSchema), { from }));

    expect(bindingOf(graph)['from']).toBe(from);
  });

  test('a path through a runtime param source fails naming the path', () => {
    const email = module('email', { input: anyInputSchema }, ({ input, provision }) => {
      const x = (input as never as { base: { x: never } }).base.x;
      provision(echoService(), { input: { x } });
    });

    expect(loadError(() => Load(shopWith(email, { base: origin() }))).message).toBe(
      'input.base.x of module "shop.email" does not exist: input.base stands for a value only ' +
        'the platform has at boot, so it has no fields and can only be passed on unchanged.',
    );
  });
});

describe('props', () => {
  const site = (props: Record<string, unknown>) =>
    module('shop', ({ provision }) => {
      provision(
        resource({
          name: 'site',
          extension: 'test/pack',
          provides: urlContract(),
          props: props as never,
        }),
        { id: 'site' },
      );
    });

  test("envParam() in a resource's props is its config pool value", () => {
    const graph = Load(site({ url: variable('U') }), { configPool: { U: 'https://shop.example' } });

    const node = graph.nodes.find((entry) => entry.id === 'shop.site')?.node;
    expect(node?.kind === 'resource' ? node.props['url'] : undefined).toBe('https://shop.example');
  });

  test("a runtime source in a resource's props fails", () => {
    expect(loadError(() => Load(site({ url: pointer('K') }))).message).toBe(
      `prop "url" of resource "shop.site" is bound to envSecret('K'), which is known only at ` +
        "boot. A resource's props are read at deploy; bind a value known at deploy.",
    );
  });

  test("a secret source a resolve() in a resource's props lists is listed under the resource", () => {
    const key = pointer('K');

    const graph = Load(site({ url: resolve([key], () => 'https://shop.example') }));

    expect(graph.secretSources).toEqual([
      { source: key, address: 'shop.site', nodeKind: 'resource' },
    ]);
  });
});

describe('the secret list and forwarded slots', () => {
  test('graph.secretSources lists every secret source a binding or a resolve() dependency names', () => {
    const live = pointer('LIVE');
    const test = pointer('TEST');
    const root = module('shop', ({ environment, provision }) => {
      const key = resolve([live, test, environment.name], ([l, t, name]) =>
        name === 'production' ? l : t,
      );
      provision(echoService(), { input: { key: key as never } });
    });

    const graph = Load(root, staging);

    expect(graph.secretSources).toEqual([
      { source: live, address: 'shop.echo', nodeKind: 'service' },
      { source: test, address: 'shop.echo', nodeKind: 'service' },
    ]);
    expect(graph.secretSources[0]?.source).toBe(live);
    expect(graph.secretSources[1]?.source).toBe(test);
  });

  test("a secret source in a module's input that no service receives is listed under the module", () => {
    const email = module('email', { input: type({ 'key?': secretString() }) }, () => {});
    const key = pointer('K');

    const graph = Load(shopWith(email, { key }));

    expect(graph.secretSources).toEqual([
      { source: key, address: 'shop.email', nodeKind: 'module' },
    ]);
    expect(graph.secretSources[0]?.source).toBe(key);
  });

  test("a secret source a service receives through a module's input is listed under the service", () => {
    const key = pointer('K');

    const graph = Load(shopWith(forwarding(type({ key: secretString() })), { key }));

    expect(graph.secretSources).toEqual([
      { source: key, address: 'shop.email.echo', nodeKind: 'service' },
    ]);
    expect(graph.secretSources[0]?.source).toBe(key);
  });

  test('graph.secretSources lists a source once, under the first service that receives it', () => {
    const key = pointer('K');
    const root = module('shop', ({ provision }) => {
      provision(echoService(), { id: 'one', input: { key } });
      provision(echoService(), { id: 'two', input: { key } });
    });

    const graph = Load(root);

    expect(graph.secretSources).toEqual([
      { source: key, address: 'shop.one', nodeKind: 'service' },
    ]);
  });
});
