import { describe, expect, test } from 'bun:test';
import { secretString } from '@internal/foundation/arktype';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { string } from '../config.ts';
import { type Graph, Load, LoadError } from '../graph.ts';
import {
  isParamSource,
  isSecretSource,
  type ModuleNode,
  module,
  type ParamSource,
  paramNeed,
  paramSource,
  resource,
  type SecretSource,
  secret,
  secretSource,
  service,
} from '../node.ts';
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

const origin = () =>
  paramSource({}, { label: "serviceOrigin('shop.web')", sentinel: 'https://origin.invalid' });

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

  test("a source bound to a module's secrets slot and forwarded reaches the service with the same payload", () => {
    const auth = module('auth', { secrets: { key: secret() } }, ({ secrets, provision }) => {
      provision(echoService(), { input: { key: secrets.key } });
    });
    const key = pointer('K');
    const root = module('shop', ({ provision }) => {
      provision(auth, { secrets: { key } });
    });

    const leaf = bindingOf(Load(root))['key'];

    expect(isSecretSource(leaf)).toBe(true);
    expect((leaf as SecretSource).payload).toBe(key.payload);
  });

  test("a param source with a pool key bound to a module's params slot and forwarded reaches the service param unchanged", () => {
    const relay = module('relay', { params: { label: paramNeed() } }, ({ params, provision }) => {
      provision(echoService(), { input: {}, params: { label: params.label } });
    });
    const label = variable('G');
    const root = module('shop', ({ provision }) => {
      provision(relay, { params: { label } });
    });

    const bound = Load(root).params[0]?.binding;

    expect(isParamSource(bound)).toBe(true);
    expect((bound as ParamSource).payload).toBe(label.payload);
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
        'commands pass the process environment.',
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
  test("a param source with a string sentinel in a module's input reaches the service as the same source", () => {
    const seen: unknown[] = [];
    const base = origin();

    const graph = Load(shopWith(forwarding(recording(seen)), { base }));

    expect(seen).toEqual([{ base: 'https://origin.invalid' }]);
    expect(bindingOf(graph)['base']).toBe(base);
  });

  test('a redacted param source is checked as a SecretString and reaches the service as the same source', () => {
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

  test('a module schema that changes a field bound to a sentinel fails', () => {
    const changing: StandardSchemaV1 = {
      '~standard': { version: 1, vendor: 'test', validate: () => ({ value: { base: 'x' } }) },
    };

    expect(loadError(() => Load(shopWith(forwarding(changing), { base: origin() }))).message).toBe(
      'The input schema of module "shop.email" changed input key "base", which is bound to ' +
        "serviceOrigin('shop.web'). Its value is known only at boot, so a module's schema may " +
        'check the field but never transform it.',
    );
  });

  test("a param source with no sentinel in a module's input fails", () => {
    const root = shopWith(forwarding(anyInputSchema), { from: paramSource({ name: 'X' }) });

    expect(loadError(() => Load(root)).message).toBe(
      'input key "from" of module "shop.email" is bound to a param source a module\'s input ' +
        "cannot take: it names no sentinel for the module's schema to check in its place, as a " +
        'raw paramSource() does. Bind envParam(), generatedParam() or serviceOrigin(), or a value.',
    );
  });

  test('a path through a runtime param source fails naming the path', () => {
    const email = module('email', { input: anyInputSchema }, ({ input, provision }) => {
      const x = (input as never as { base: { x: never } }).base.x;
      provision(echoService(), { input: { x } });
    });

    expect(loadError(() => Load(shopWith(email, { base: origin() }))).message).toBe(
      'input.base.x of module "shop.email" does not exist: input.base is a value known only at ' +
        'boot, not a plain object, so it has no fields. To compute with it, list it: ' +
        'resolve([input.base], ([v]) => …).',
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

  test('graph.secretSources lists a source once, where Load first met it', () => {
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

  test('a forwarded secrets slot listed only in a resolve() dependency counts as forwarded', () => {
    const auth = module('auth', { secrets: { key: secret() } }, ({ secrets, provision }) => {
      provision(echoService(), { input: { key: resolve([secrets.key], ([key]) => key) as never } });
    });
    const source = pointer('K');
    const root = module('shop', ({ provision }) => {
      provision(auth, { secrets: { key: source } });
    });

    const graph = Load(root);

    expect(bindingOf(graph)['key']).toBe(source);
  });
});
