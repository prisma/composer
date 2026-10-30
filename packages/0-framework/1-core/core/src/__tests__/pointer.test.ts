import { describe, expect, test } from 'bun:test';
import { field, secretString } from '@internal/foundation/arktype';
import { isPlainPointer, isSecretPointer } from '@internal/foundation/pointer';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { string } from '../config.ts';
import { type Graph, Load, LoadError } from '../graph.ts';
import {
  isSecretSource,
  type ModuleNode,
  module,
  paramSource,
  secretSource,
  service,
} from '../node.ts';
import { environmentFacts, isValue, resolve, type Value } from '../value.ts';
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

const loadError = (run: () => unknown): LoadError => {
  try {
    run();
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error('expected a LoadError');
};

/** A root `shop` that provisions `child` as `email` with `input`. */
const shopWith = (child: ModuleNode, input: unknown): ModuleNode =>
  module('shop', ({ provision }) => {
    provision(child as never, { id: 'email', input } as never);
  });

const bindingOf = (graph: Graph, index = 0): Record<string, unknown> =>
  graph.inputBindings[index]?.binding as unknown as Record<string, unknown>;

const pointer = (name: string) => secretSource({ name }, { label: `envSecret('${name}')` });

const origin = () => paramSource({}, { label: "serviceOrigin('shop.web')" });

/** An ArkType copy of `value`: a transform elsewhere in the schema makes ArkType copy its whole input. */
const copyOf = <T>(value: T): T => {
  const out = type({ value: 'object', n: 'string.integer.parse' })({ value, n: '1' });
  if (out instanceof type.errors) throw new Error(out.summary);
  return out.value as T;
};

/** A module `relay` whose `input` schema is `schema` and whose body passes `base` to `echo`. */
const relay = (schema: StandardSchemaV1<{ base: unknown }, { base: unknown }>): ModuleNode =>
  module('relay', { input: schema }, ({ input, provision }) => {
    provision(echoService(), { input: { base: input.base as never } });
  });

const kinds = (value: unknown) => [isSecretPointer(value), isPlainPointer(value)];

describe('the kind of pointer a source is', () => {
  test('secretSource() is a secret pointer', () => {
    expect(kinds(pointer('K'))).toEqual([true, false]);
  });

  test('paramSource() without a pool key is a plain pointer, or a secret pointer when redacted', () => {
    expect(kinds(paramSource({}))).toEqual([false, true]);
    expect(kinds(paramSource({}, { redacted: true }))).toEqual([true, false]);
  });

  test('paramSource() with a pool key is no pointer', () => {
    expect(kinds(paramSource({}, { poolKey: 'X' }))).toEqual([false, false]);
  });

  test('the kind is data on the source, under the registered symbol prisma:pointer', () => {
    expect(Reflect.get(pointer('K'), Symbol.for('prisma:pointer'))).toBe('secret');
    expect(Reflect.get(origin(), Symbol.for('prisma:pointer'))).toBe('plain');
    expect(Object.keys(pointer('K'))).toEqual(['payload']);
    expect(JSON.stringify(secretSource({ name: 'X' }))).toBe('{"payload":{"name":"X"}}');
  });

  test('environment.name, a resolve() result and plain data are no pointer', () => {
    for (const value of [
      environmentFacts.name,
      resolve([environmentFacts.name], ([n]) => n),
      'x',
      {},
    ]) {
      expect(kinds(value)).toEqual([false, false]);
    }
  });
});

describe('an ArkType copy of a source', () => {
  test('an ArkType copy of a source is a different object with the same brands, kind and payload', () => {
    const source = pointer('K');
    const copy = copyOf(source);

    expect(copy).not.toBe(source);
    expect([isValue(copy), isSecretSource(copy), isSecretPointer(copy)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(copy.payload).toEqual(source.payload);
  });

  test("a copy of a secret source in a service's binding is listed once, as its original", () => {
    const key = pointer('K');
    const copy = copyOf(key);
    const root = module('shop', ({ provision }) => {
      provision(echoService(), { input: { a: key, b: copy } });
    });

    const graph = Load(root);

    expect(bindingOf(graph)['b']).toBe(copy);
    expect(graph.secretSources).toEqual([
      { source: key, address: 'shop.echo', nodeKind: 'service' },
    ]);
    expect(graph.secretSources[0]?.source).toBe(key);
  });

  test("a copy of a runtime param source in a module's input reaches the service as the original", () => {
    const source = origin();

    const graph = Load(
      shopWith(relay(type({ base: field(type('string')) })), { base: copyOf(source) }),
    );

    expect(bindingOf(graph)['base']).toBe(source);
  });
});

describe('a wrapped field at Load', () => {
  test("a wrapped field reports the plain field's error at Load", () => {
    const fails = (schema: StandardSchemaV1) =>
      loadError(() =>
        Load(
          shopWith(
            module('email', { input: schema }, () => {}),
            { from: 3 },
          ),
        ),
      ).message;

    const wrapped = fails(type({ from: field(type('string')) }));

    expect(wrapped).toBe(fails(type({ from: 'string' })));
    expect(wrapped).toBe(
      'The input binding of module "shop.email" does not match the module\'s input schema: from must be a string (was a number)',
    );
  });

  test("a wrapped field takes a runtime param source's pointer at Load, and the service receives the source", () => {
    const source = origin();

    const graph = Load(shopWith(relay(type({ base: field(type('string')) })), { base: source }));

    expect(bindingOf(graph)['base']).toBe(source);
  });

  test("a secret source bound to a wrapped text field fails at Load with the plain field's error", () => {
    const fails = (schema: StandardSchemaV1<{ base: unknown }, { base: unknown }>) =>
      loadError(() => Load(shopWith(relay(schema), { base: pointer('K') }))).message;

    const wrapped = fails(type({ base: field(type('string')) }));

    expect(wrapped).toBe(fails(type({ base: 'string' })));
    expect(wrapped).toBe(
      'The input binding of module "shop.email" does not match the module\'s input schema: base must be a string (was an object)',
    );
  });
});

describe("a module's schema sees pointers at Load", () => {
  test("a module's schema receives each runtime value's pointer itself, not a stand-in", () => {
    const seen: unknown[] = [];
    const recording: StandardSchemaV1<{ base: unknown }, { base: unknown }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => {
          seen.push(value);
          return { value: value as { base: unknown } };
        },
      },
    };
    const base = origin();
    const key = pointer('K');

    Load(shopWith(relay(recording), { base, key }));

    expect((seen[0] as Record<string, unknown>)['base']).toBe(base);
    expect((seen[0] as Record<string, unknown>)['key']).toBe(key);
  });

  test("a plain field bound to a runtime value fails at Load with the plain field's message", () => {
    expect(
      loadError(() => Load(shopWith(relay(type({ base: 'string' })), { base: origin() }))).message,
    ).toBe(
      'The input binding of module "shop.email" does not match the module\'s input schema: base must be a string (was an object)',
    );
  });

  test('a plain pointer bound to a secretString() field fails at Load, saying it is not a secret', () => {
    const email = module('email', { input: type({ key: secretString() }) }, () => {});

    expect(loadError(() => Load(shopWith(email, { key: origin() }))).message).toBe(
      'The input binding of module "shop.email" does not match the module\'s input schema: key must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)',
    );
  });

  test('an ArkType module schema that copies its input passes the original pointers on', () => {
    const email = module(
      'email',
      {
        input: type({
          base: field(type('string')),
          key: secretString(),
          port: field(type('string.integer.parse')),
        }),
      },
      ({ input, provision }) => {
        provision(echoService(), {
          input: { base: input.base, key: input.key, port: input.port },
        });
      },
    );
    const base = origin();
    const key = pointer('K');

    const graph = Load(shopWith(email, { base, key, port: '4' }));

    expect(bindingOf(graph)['base']).toBe(base);
    expect(bindingOf(graph)['key']).toBe(key);
    expect(bindingOf(graph)['port']).toBe(4);
  });

  const returning = (
    output: (value: Record<string, unknown>) => { base: unknown },
  ): StandardSchemaV1<{ base: unknown }, { base: unknown }> => ({
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => ({ value: output(value as Record<string, unknown>) }),
    },
  });

  test('a module schema that replaces a field bound to a runtime value fails at Load', () => {
    expect(
      loadError(() => Load(shopWith(relay(returning(() => ({ base: 'x' }))), { base: origin() })))
        .message,
    ).toBe(
      'The input schema of module "shop.email" replaced input key "base", which is bound to serviceOrigin(\'shop.web\'). Its value is known only at boot, so a module\'s schema may check the field but never replace or move it.',
    );
  });

  test('a module schema that moves a runtime value to another key fails at Load', () => {
    const moving = relay(returning((value) => ({ base: value['key'] })));

    expect(loadError(() => Load(shopWith(moving, { base: 'x', key: pointer('K') }))).message).toBe(
      'The input schema of module "shop.email" moved envSecret(\'K\') to input key "base". Its value is known only at boot, so a module\'s schema may check the field but never replace or move it.',
    );
  });
});

describe('resolve() takes deploy-time values only', () => {
  /** A root `shop` that lists `dependency` in a resolve() bound to echo's `url`, recording each run of the function. */
  const listing = (dependency: Value<unknown>, ran: boolean[]): ModuleNode =>
    module('shop', ({ provision }) => {
      const url = resolve([dependency], () => {
        ran.push(true);
        return 'x';
      });
      provision(echoService(), { input: { url } });
    });

  test('a secret source listed in resolve() fails at Load, naming it, and the function never runs', () => {
    const ran: boolean[] = [];

    expect(loadError(() => Load(listing(pointer('K'), ran))).message).toBe(
      `The resolve() function for input key "url" of service "shop.echo" lists envSecret('K'), ` +
        'which is known only at boot. A resolve() dependency must be a deploy-time value. Bind ' +
        "envSecret('K') directly into the input of the service that reads it.",
    );
    expect(ran).toEqual([]);
  });

  test('a plain runtime source listed in resolve() fails at Load the same way', () => {
    expect(loadError(() => Load(listing(origin(), []))).message).toBe(
      'The resolve() function for input key "url" of service "shop.echo" lists ' +
        "serviceOrigin('shop.web'), which is known only at boot. A resolve() dependency must be a " +
        "deploy-time value. Bind serviceOrigin('shop.web') directly into the input of the service " +
        'that reads it.',
    );
  });

  test('a wrapped field bound to a runtime value fails at Load, saying to declare it plain', () => {
    const email = module(
      'email',
      { input: type({ from: field(type('string')) }) },
      ({ input, provision }) => {
        const url = resolve([input.from as Value<unknown>], () => 'x');
        provision(echoService(), { input: { url } });
      },
    );

    expect(loadError(() => Load(shopWith(email, { from: origin() }))).message).toBe(
      'The resolve() function for input key "url" of service "shop.email.echo" lists ' +
        `input.from of module "shop.email", whose real value is serviceOrigin('shop.web'), a ` +
        'value known only at boot. A resolve() dependency must be a deploy-time value. To ' +
        'compute with input.from, declare it plain, without field(), and bind it to deploy-time ' +
        'data.',
    );
  });

  test('an object field that holds a pointer fails at Load, naming the field that holds it', () => {
    const email = module(
      'email',
      { input: type({ smtp: { user: field(type('string')), host: 'string' } }) },
      ({ input, provision }) => {
        const url = resolve([input.smtp as Value<unknown>], () => 'x');
        provision(echoService(), { input: { url } });
      },
    );

    expect(
      loadError(() => Load(shopWith(email, { smtp: { user: origin(), host: 'h' } }))).message,
    ).toBe(
      'The resolve() function for input key "url" of service "shop.email.echo" lists ' +
        `input.smtp of module "shop.email", which holds serviceOrigin('shop.web') at ` +
        'input.smtp.user, a value known only at boot. A resolve() dependency must be a ' +
        'deploy-time value. To compute with input.smtp.user, declare it plain, without ' +
        'field(), and bind it to deploy-time data.',
    );
  });

  test('a secret below the listed field is named by its own path in the advice', () => {
    const email = module(
      'email',
      { input: type({ smtp: { user: 'string', password: secretString() } }) },
      ({ input, provision }) => {
        const url = resolve([input.smtp as Value<unknown>], () => 'x');
        provision(echoService(), { input: { url } });
      },
    );

    const message = loadError(() =>
      Load(shopWith(email, { smtp: { user: 'u', password: pointer('SMTP_PASSWORD') } })),
    ).message;

    expect(message).toContain(
      `lists input.smtp of module "shop.email", which holds envSecret('SMTP_PASSWORD') at input.smtp.password,`,
    );
    expect(message).toContain(
      'A secret has no deploy-time value: pass input.smtp.password on into a binding, and read it in the service.',
    );
  });

  test('a pointer in an array field is named by its index', () => {
    const email = module(
      'email',
      { input: type({ tags: field(type('string')).array() }) },
      ({ input, provision }) => {
        const url = resolve([input.tags as Value<unknown>], () => 'x');
        provision(echoService(), { input: { url } });
      },
    );

    expect(loadError(() => Load(shopWith(email, { tags: ['a', origin()] }))).message).toContain(
      `lists input.tags of module "shop.email", which holds serviceOrigin('shop.web') at input.tags.1,`,
    );
  });

  test('a field typed unknown compiles in resolve(), and Load refuses it when it holds a pointer', () => {
    const untyped: StandardSchemaV1<{ from: unknown }, { from: unknown }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => ({ value: value as { from: unknown } }),
      },
    };
    const email = module('email', { input: untyped }, ({ input, provision }) => {
      const url = resolve([input.from], () => 'x');
      provision(echoService(), { input: { url } });
    });

    expect(loadError(() => Load(shopWith(email, { from: origin() }))).message).toContain(
      `lists input.from of module "shop.email", whose real value is serviceOrigin('shop.web'),`,
    );
  });

  test('a wrapped field bound to deploy-time data passes Load when a cast gets it past the compiler', () => {
    const email = module(
      'email',
      { input: type({ from: field(type('string')) }) },
      ({ input, provision }) => {
        const url = resolve([input.from as Value<unknown>], ([from]) => `${String(from)}!`);
        provision(echoService(), { input: { url } });
      },
    );

    const graph = Load(shopWith(email, { from: 'shop@example.com' }));

    expect(bindingOf(graph)['url']).toBe('shop@example.com!');
  });
});
