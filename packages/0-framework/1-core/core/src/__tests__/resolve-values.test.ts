import { describe, expect, test } from 'bun:test';
import { string } from '../config.ts';
import { Load, LoadError } from '../graph.ts';
import {
  dependency,
  type ModuleBuilder,
  module,
  paramNeed,
  secret,
  secretSource,
  service,
} from '../node.ts';
import { resolve, type Value } from '../value.ts';
import { anyInputSchema, conn } from './helpers.ts';

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

const plainService = () =>
  service({
    name: 'plain',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: {},
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

const forgedValue = (): Value<unknown> & { dependencies: unknown[] } => {
  const dependencies: unknown[] = [];
  const value = {
    [Symbol.for('prisma:value')]: true,
    [Symbol.for('prisma:value-origin')]: { kind: 'computed', dependencies, compute: () => 'x' },
    dependencies,
  };
  return value as unknown as Value<unknown> & { dependencies: unknown[] };
};

describe("Load's second pass", () => {
  test('a value over environment.name is substituted into a service input binding', () => {
    const root = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], ([name]) => `hello from ${name}`);
      provision(echoService(), { input: { greeting } });
    });

    const graph = Load(root, staging);

    expect(graph.inputBindings[0]?.binding).toEqual({ greeting: 'hello from staging' });
  });

  test('a value over environment.name is substituted into a service param binding', () => {
    const root = module('shop', ({ environment, provision }) => {
      const label = resolve([environment.name], ([name]) => `label-${name}`);
      provision(echoService(), { input: {}, params: { label } });
    });

    const graph = Load(root, staging);

    expect(graph.params[0]?.binding).toBe('label-staging');
  });

  test('a value nested inside objects and arrays in an input binding is substituted', () => {
    const root = module('shop', ({ environment, provision }) => {
      const value = resolve([environment.name], ([name]) => `${name}.example`);
      provision(echoService(), { input: { hosts: [value], nested: { label: value } } });
    });

    const graph = Load(root, staging);

    expect(graph.inputBindings[0]?.binding).toEqual({
      hosts: ['staging.example'],
      nested: { label: 'staging.example' },
    });
  });

  test('a value inside a class instance in a binding is left where it is', () => {
    class Holder {
      constructor(readonly held: unknown) {}
    }
    let holder: Holder | undefined;
    let value: Value<string> | undefined;
    const root = module('shop', ({ environment, provision }) => {
      value = resolve([environment.name], ([name]) => name);
      holder = new Holder(value);
      provision(echoService(), { input: { holder } as never });
    });

    const graph = Load(root, staging);

    const binding = graph.inputBindings[0]?.binding as unknown as { holder: Holder };
    expect(binding.holder).toBe(holder as Holder);
    expect(binding.holder.held).toBe(value);
  });

  test('a value bound in two places runs once', () => {
    let runs = 0;
    const root = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], ([name]) => {
        runs += 1;
        return `hello from ${name}`;
      });
      provision(echoService(), { id: 'one', input: { greeting } });
      provision(echoService(), { id: 'two', input: { greeting } });
    });

    const graph = Load(root, staging);

    expect(graph.inputBindings.map((b) => b.binding)).toEqual([
      { greeting: 'hello from staging' },
      { greeting: 'hello from staging' },
    ]);
    expect(runs).toBe(1);
  });

  test("a value's dependencies run before it, through two levels", () => {
    const root = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], ([name]) => `hello from ${name}`);
      const shout = resolve([greeting], ([text]) => text.toUpperCase());
      provision(echoService(), { input: { greeting: shout } });
    });

    const graph = Load(root, staging);

    expect(graph.inputBindings[0]?.binding).toEqual({ greeting: 'HELLO FROM STAGING' });
  });

  test('a binding with no value is returned by reference', () => {
    const original = { greeting: 'hi' };
    const root = module('shop', ({ provision }) => {
      provision(echoService(), { input: original });
    });

    const graph = Load(root, staging);

    expect(graph.inputBindings[0]?.binding).toBe(original);
  });

  test('Load without an environment loads a graph that binds no value', () => {
    const root = module('shop', ({ provision }) => {
      provision(echoService(), { input: { greeting: 'hi' }, params: { label: 'x' } });
    });

    const graph = Load(root);

    expect(graph.inputBindings[0]?.binding).toEqual({ greeting: 'hi' });
    expect(graph.params[0]?.binding).toBe('x');
  });

  test('Load without an environment fails on a value over environment.name', () => {
    const root = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], ([name]) => name);
      provision(echoService(), { input: { greeting } });
    });

    expect(loadError(() => Load(root)).message).toBe(
      'input key "greeting" of service "shop.echo" depends on environment.name, but Load was ' +
        'given no environment. Pass { environment: { name } } to Load; the deploy and dev commands do.',
    );
  });

  test('fn returning undefined fails naming the binding', () => {
    const top = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], () => undefined);
      provision(echoService(), { input: { greeting: greeting as never } });
    });
    expect(loadError(() => Load(top, staging)).message).toBe(
      'The resolve() function for input key "greeting" of service "shop.echo" returned undefined. ' +
        'Return a result for every environment; Composer never picks a default.',
    );

    const nested = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], () => ({ a: undefined }));
      provision(echoService(), { input: { greeting: greeting as never } });
    });
    expect(loadError(() => Load(nested, staging)).message).toBe(
      'The resolve() function for input key "greeting" of service "shop.echo" returned undefined ' +
        'at "a". Return a result for every environment; Composer never picks a default.',
    );
  });

  test('fn returning a value fails naming the binding', () => {
    const top = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], () => environment.name);
      provision(echoService(), { input: { greeting: greeting as never } });
    });
    expect(loadError(() => Load(top, staging)).message).toBe(
      'The resolve() function for input key "greeting" of service "shop.echo" returned a value, ' +
        'not a real value. List that value as a dependency; fn receives its real value.',
    );

    const nested = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], () => ({ hosts: [environment.name] }));
      provision(echoService(), { input: { greeting: greeting as never } });
    });
    expect(loadError(() => Load(nested, staging)).message).toBe(
      'The resolve() function for input key "greeting" of service "shop.echo" returned a value at ' +
        '"hosts.0", not a real value. List that value as a dependency; fn receives its real value.',
    );
  });

  test('fn returning a Promise fails naming the binding', () => {
    const root = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], async ([name]) => name);
      provision(echoService(), { input: { greeting: greeting as never } });
    });

    expect(loadError(() => Load(root, staging)).message).toBe(
      'The resolve() function for input key "greeting" of service "shop.echo" returned a Promise. ' +
        'resolve() runs synchronously at Load.',
    );
  });

  test('fn returning a secret source, a function, or a class instance fails naming the binding', () => {
    const returning = (result: unknown) =>
      module('shop', ({ environment, provision }) => {
        const greeting = resolve([environment.name], () => result);
        provision(echoService(), { input: { greeting: greeting as never } });
      });

    expect(loadError(() => Load(returning(secretSource({ name: 'X' })), staging)).message).toBe(
      'The resolve() function for input key "greeting" of service "shop.echo" returned a secret or ' +
        'param source. Bind envSecret() or envParam() directly; resolve() returns plain data.',
    );
    expect(
      loadError(() =>
        Load(
          returning(() => 'x'),
          staging,
        ),
      ).message,
    ).toBe(
      'The resolve() function for input key "greeting" of service "shop.echo" returned a function. ' +
        'resolve() returns plain data: strings, finite numbers, booleans, null, arrays and plain objects.',
    );
    expect(loadError(() => Load(returning(new Date(0)), staging)).message).toBe(
      'The resolve() function for input key "greeting" of service "shop.echo" returned an object ' +
        'that is not plain data. resolve() returns plain data: strings, finite numbers, booleans, ' +
        'null, arrays and plain objects.',
    );
  });

  test('an error thrown by fn is wrapped once with the thrown error as cause', () => {
    class GreetingError extends Error {}
    const thrown = new GreetingError('no greeting for staging');
    const root = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], () => {
        throw thrown;
      });
      provision(echoService(), { input: { greeting: greeting as never } });
    });

    const error = loadError(() => Load(root, staging));

    expect(error.message).toBe(
      'The resolve() function for input key "greeting" of service "shop.echo" threw: no greeting for staging',
    );
    expect(error.cause).toBe(thrown);
  });

  test("a failing dependency's fn is named as a dependency", () => {
    const root = module('shop', ({ environment, provision }) => {
      const inner = resolve([environment.name], () => undefined);
      const greeting = resolve([inner], ([text]) => String(text));
      provision(echoService(), { input: { greeting } });
    });

    expect(
      loadError(() => Load(root, staging)).message.startsWith(
        'A resolve() function that input key "greeting" of service "shop.echo" depends on returned undefined',
      ),
    ).toBe(true);
  });

  test('a cycle between values fails naming the binding', () => {
    const value = forgedValue();
    value.dependencies.push(value);
    const root = module('shop', ({ provision }) => {
      provision(echoService(), { input: { greeting: value as never } });
    });

    expect(loadError(() => Load(root, staging)).message).toBe(
      'input key "greeting" of service "shop.echo" depends on itself: a computed value\'s ' +
        'dependencies lead back to it. Remove the cycle.',
    );
  });

  test('provision() inside fn fails with the structure error', () => {
    const root = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], ([name]) => {
        provision(plainService());
        return name;
      });
      provision(echoService(), { input: { greeting } });
    });

    expect(loadError(() => Load(root, staging)).message).toBe(
      'provision() was called after module "shop" was loaded, from inside a resolve() function. ' +
        'resolve() computes values, never structure: the graph is the same whatever inputs ' +
        'Composer is given (ADR-0062). Provision the node in the module body and pass the value into it.',
    );
  });

  test('provision() inside fn of a nested module fails the same way', () => {
    const inner = module('inner', ({ environment, provision }) => {
      const greeting = resolve([environment.name], ([name]) => {
        provision(plainService());
        return name;
      });
      provision(echoService(), { input: { greeting } });
    });
    const root = module('shop', ({ provision }) => {
      provision(inner);
    });

    expect(loadError(() => Load(root, staging)).message).toBe(
      'provision() was called after module "inner" was loaded, from inside a resolve() function. ' +
        'resolve() computes values, never structure: the graph is the same whatever inputs ' +
        'Composer is given (ADR-0062). Provision the node in the module body and pass the value into it.',
    );
  });

  test("a nested module's provision leaked to the root through a closure is sealed too", () => {
    let leaked: ModuleBuilder['provision'] | undefined;
    const inner = module('inner', ({ provision }) => {
      leaked = provision;
    });
    const root = module('shop', ({ environment, provision }) => {
      provision(inner);
      const greeting = resolve([environment.name], ([name]) => {
        leaked?.(plainService());
        return name;
      });
      provision(echoService(), { input: { greeting } });
    });

    expect(loadError(() => Load(root, staging)).message).toBe(
      'provision() was called after module "inner" was loaded, from inside a resolve() function. ' +
        'resolve() computes values, never structure: the graph is the same whatever inputs ' +
        'Composer is given (ADR-0062). Provision the node in the module body and pass the value into it.',
    );
  });

  test('Loading the same root twice resolves values both times', () => {
    const root = module('shop', ({ environment, provision }) => {
      const greeting = resolve([environment.name], ([name]) => `hello from ${name}`);
      provision(echoService(), { input: { greeting } });
    });

    expect(Load(root, staging).inputBindings[0]?.binding).toEqual({
      greeting: 'hello from staging',
    });
    expect(Load(root, { environment: { name: 'production' } }).inputBindings[0]?.binding).toEqual({
      greeting: 'hello from production',
    });
  });

  test('a value as provision() id fails', () => {
    const root = module('shop', ({ environment, provision }) => {
      provision(plainService(), { id: resolve([environment.name], ([name]) => name) as never });
    });

    expect(loadError(() => Load(root, staging)).message).toBe(
      'provision() received a value as its id (module "shop"). A value can configure a node, never ' +
        'decide its address: the graph is the same whatever inputs Composer is given (ADR-0062).',
    );
  });

  test("a value in a service's deps fails", () => {
    const web = service({
      name: 'web',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: {
        db: dependency({ type: 'fake/db', connection: conn({ url: string() }, () => ({})) }),
      },
      params: {},
      build,
    });
    const root = module('shop', ({ environment, provision }) => {
      provision(web, { deps: { db: resolve([environment.name], ([name]) => name) } });
    });

    expect(loadError(() => Load(root, staging)).message).toBe(
      'The deps for "shop.web.db" are bound to a value. A value can configure a node, never ' +
        'decide its edges: the graph is the same whatever inputs Composer is given (ADR-0062).',
    );
  });

  test('a value as a module secrets binding fails', () => {
    const auth = module('auth', { secrets: { signingKey: secret() } }, ({ secrets, provision }) => {
      provision(echoService(), { input: { key: secrets.signingKey } });
      return {};
    });
    const root = module('shop', ({ environment, provision }) => {
      provision(auth, {
        secrets: { signingKey: resolve([environment.name], ([name]) => name) as never },
      });
    });

    expect(loadError(() => Load(root, staging)).message).toBe(
      'The secrets for "shop.auth" bind "signingKey" to a value. A value is not a secret source; ' +
        "bind envSecret('NAME') or a forwarded ctx.secrets ref.",
    );
  });

  test('a value as a module params binding fails', () => {
    const auth = module('auth', { params: { region: paramNeed() } }, ({ params, provision }) => {
      provision(echoService(), { input: {}, params: { label: params.region } });
      return {};
    });
    const root = module('shop', ({ environment, provision }) => {
      provision(auth, {
        params: { region: resolve([environment.name], ([name]) => name) as never },
      });
    });

    expect(loadError(() => Load(root, staging)).message).toBe(
      'The params for "shop.auth" bind "region" to a value. A module param slot takes a param ' +
        "source; bind envParam('NAME') or a forwarded ctx.params ref.",
    );
  });
});
