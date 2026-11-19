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

/** A module `email` whose `input` schema is `schema` and whose body passes each of `keys` on to `echo` by name. */
const forwarding = (schema: StandardSchemaV1, keys: readonly string[]): ModuleNode =>
  module('email', { input: schema }, ({ input, provision }) => {
    const fields = input as never as Record<string, unknown>;
    provision(echoService(), {
      input: Object.fromEntries(keys.map((key) => [key, fields[key]])) as never,
    });
  });

const bindingOf = (graph: Graph, index = 0): Record<string, unknown> =>
  graph.inputBindings[index]?.binding as unknown as Record<string, unknown>;

const pointer = (name: string) => secretSource({ name }, { label: `the secret "${name}"` });
const variable = (name: string) => paramSource({ name }, { label: `the variable "${name}"` });

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
});

describe("a source in a service's param", () => {
  const refusal = (label: string) =>
    `Service "shop.echo" binds its param "label" to ${label}, a value known only at boot. A param takes a literal or a value the deploy has. Bind the value to a field of the service's input instead.`;

  test('a param source a cast gets past the types fails Load', () => {
    const root = module('shop', ({ provision }) => {
      provision(echoService(), { input: {}, params: { label: variable('G') as never } });
    });

    expect(() => Load(root)).toThrow(refusal('the variable "G"'));
  });

  test('a source built without a label is named "a source"', () => {
    const root = module('shop', ({ provision }) => {
      provision(echoService(), { input: {}, params: { label: paramSource({}) as never } });
    });

    expect(() => Load(root)).toThrow(refusal('a source'));
  });

  test('a secret source a cast gets past the types fails Load', () => {
    const root = module('shop', ({ provision }) => {
      provision(echoService(), { input: {}, params: { label: pointer('K') as never } });
    });

    expect(() => Load(root)).toThrow(refusal('the secret "K"'));
  });

  test('a source that reaches a param through a module input field fails Load', () => {
    const relay = module('relay', { input: anyInputSchema }, ({ input, provision }) => {
      const fields = input as never as Record<string, unknown>;
      provision(echoService(), { input: {}, params: { label: fields['label'] as never } });
    });
    const root = module('shop', ({ provision }) => {
      provision(relay, { id: 'relay', input: { label: variable('G') } as never });
    });

    expect(() => Load(root)).toThrow(
      refusal('the variable "G"').replace('"shop.echo"', '"shop.relay.echo"'),
    );
  });
});

describe('a resolve() function that returns a source', () => {
  test('a resolve() function that returns a source fails', () => {
    const root = module('shop', ({ environment, provision }) => {
      const key = resolve([environment.name], () => ({ a: paramSource({ name: 'X' }) }));
      provision(echoService(), { input: { key: key as never } });
    });

    expect(loadError(() => Load(root, staging)).message).toBe(
      'The resolve() function for input key "key" of service "shop.echo" returned a source at ' +
        '"a", a value known only at boot. resolve() returns plain data; bind the source directly.',
    );
  });
});

describe("a module's input and runtime param sources", () => {
  test("a runtime param source in a module's input is checked as its pointer and reaches the service as the same source", () => {
    const seen: unknown[] = [];
    const base = origin();

    const graph = Load(shopWith(forwarding(recording(seen), ['base']), { base }));

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

    const graph = Load(shopWith(forwarding(anyInputSchema, ['from']), { from }));

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

  test('a field of an input whose schema outputs a runtime param source fails, saying the schema must output an object', () => {
    const email = module('email', { input: anyInputSchema }, ({ input, provision }) => {
      provision(echoService(), { input: { from: (input as never as { from: never }).from } });
    });

    expect(loadError(() => Load(shopWith(email, origin()))).message).toBe(
      'input.from of module "shop.email" does not exist: input stands for a value only the ' +
        "platform has at boot, so it has no fields. The module's input schema must output a " +
        'plain object for its body to read fields.',
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

  test("a runtime source in a resource's props fails", () => {
    expect(loadError(() => Load(site({ url: pointer('K') }))).message).toBe(
      `prop "url" of resource "shop.site" is bound to the secret "K", which is known only at ` +
        "boot. A resource's props are read at deploy; bind a value known at deploy.",
    );
  });

  test("a secret source a resolve() in a resource's props lists fails at Load", () => {
    const url = resolve([pointer('K')], () => 'https://shop.example');

    expect(loadError(() => Load(site({ url }))).message).toBe(
      `The resolve() function for prop "url" of resource "shop.site" lists the secret "K", ` +
        'which is known only at boot. A resolve() dependency must be a deploy-time value. Bind ' +
        'the secret "K" directly into the input of the service that reads it.',
    );
  });
});

describe('the secret list and forwarded slots', () => {
  test('graph.secretSources lists every secret source a binding names', () => {
    const live = pointer('LIVE');
    const test = pointer('TEST');

    const graph = Load(echoWith({ live, test }));

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

    const graph = Load(shopWith(forwarding(type({ key: secretString() }), ['key']), { key }));

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

describe('what Load reads from the app configuration', () => {
  const secret = (key: string) =>
    secretSource({ key }, { label: `secret('${key}')`, secretsKey: key });

  test("the graph records the root's input fields its body passes on, and a param source reads nothing", () => {
    const greeting = variable('G');
    const root = module('shop', { input: type({ FROM: 'string' }) }, ({ input, provision }) => {
      provision(echoService(), { input: { from: input.FROM, greeting } });
    });

    const graph = Load(root, { configuration: { FROM: 'shop@example.com', G: 'hi' } });

    expect(graph.appConfigurationRead).toEqual({
      rootInput: [{ path: ['FROM'], value: 'shop@example.com' }],
    });
    expect(bindingOf(graph)['greeting']).toBe(greeting);
  });

  test('a root input field named as a secrets key fails at Load, and the message holds no value', () => {
    const root = module('shop', { input: anyInputSchema }, ({ input, provision }) => {
      provision(echoService(), { id: 'plain', input: { key: (input as never)['API_KEY'] } });
      provision(echoService(), { id: 'secret', input: { key: secret('API_KEY') } });
    });
    const run = () => Load(root, { configuration: { API_KEY: 'sk_live_supersecret' } });

    const message = loadError(run).message;
    expect(message).toBe(
      `input.API_KEY of root module "shop" reads "API_KEY" from the app configuration, and secret('API_KEY') names "API_KEY" as a secret. A name is a plain value or a secret, not both: a root input field is a plain value, which \`prisma deploy\` sends to the platform as plain configuration and \`prisma dev\` gives to the local services as plain configuration. Read the secret with secret('API_KEY') only, or give the plain value a different name.`,
    );
    expect(message).not.toContain('sk_live_supersecret');
  });
});
