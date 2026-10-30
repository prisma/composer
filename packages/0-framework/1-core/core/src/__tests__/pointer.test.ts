import { describe, expect, test } from 'bun:test';
import { field } from '@internal/foundation/arktype';
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
import { environmentFacts, isValue, resolve } from '../value.ts';
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

const origin = () =>
  paramSource({}, { label: "serviceOrigin('shop.web')", sentinel: 'https://origin.invalid' });

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
    expect(kinds(paramSource({}, { sentinel: 'x' }))).toEqual([false, true]);
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

    const graph = Load(shopWith(relay(type({ base: 'string' })), { base: copyOf(source) }));

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

  test("a wrapped field takes a runtime param source's stand-in at Load, and the service receives the source", () => {
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
