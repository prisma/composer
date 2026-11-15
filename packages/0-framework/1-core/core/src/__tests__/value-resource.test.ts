import { describe, expect, test } from 'bun:test';
import { secretString } from '@internal/foundation/arktype';
import { isPlainPointer, isSecretPointer } from '@internal/foundation/pointer';
import { type } from 'arktype';
import { string } from '../config.ts';
import { Load, LoadError } from '../graph.ts';
import {
  type AnyContract,
  appRoot,
  type Deps,
  isParamSource,
  isSecretSource,
  isValueResource,
  module,
  paramSource,
  ResourceNodeBase,
  resource,
  secretSource,
  service,
  sourceOriginOf,
  valueResource,
} from '../node.ts';
import { isValue } from '../value.ts';
import { anyInputSchema, plainValue, providerContract, secretValue } from './helpers.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const echo = (name = 'echo') =>
  service({
    name,
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: { greeting: string() },
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

describe('valueResource()', () => {
  test('builds a frozen resource node that is a value, with no contract and no dependencies', () => {
    const node = plainValue('GREETING');

    expect(isValueResource(node)).toBe(true);
    expect(Object.isFrozen(node)).toBe(true);
    expect(node.kind).toBe('resource');
    expect(node.type).toBe('test-value');
    expect(node.provides).toBeUndefined();
    expect(node.inputs).toEqual({});
    expect(node.deps).toEqual({});
    expect(node.props).toEqual({ name: 'GREETING' });
  });

  test('has no public member that holds the value', () => {
    const node = plainValue('GREETING');

    expect(Object.keys(node)).not.toContain('value');
    expect(Object.values(node).some((member) => isParamSource(member))).toBe(false);
  });

  test('throws when the value is not a source', () => {
    expect(() =>
      valueResource({
        name: 'greeting',
        extension: 'test/pack',
        type: 'test-value',
        value: { name: 'GREETING' } as never,
      }),
    ).toThrow(
      'valueResource() value must be a source, built with secretSource() or paramSource().',
    );
  });

  test('isValueResource() is false for a resource, a source and anything else', () => {
    expect(isValueResource(resource({ name: 'db', extension: 'test/pack', type: 'db' }))).toBe(
      false,
    );
    expect(isValueResource(secretSource({ name: 'X' }))).toBe(false);
    expect(isValueResource({ [Symbol.for('prisma:value-resource')]: secretSource({}) })).toBe(
      false,
    );
    expect(isValueResource(undefined)).toBe(false);
  });
});

describe('provision() of a value resource in an appRoot() body', () => {
  test('returns a frozen copy of the value with the same brand, payload and pointer kind', () => {
    const node = plainValue('GREETING');
    const secretNode = secretValue('API_KEY');
    let plain: unknown;
    let secret: unknown;
    Load(
      appRoot('shop', ({ provision }) => {
        plain = provision(node);
        secret = provision(secretNode);
      }),
    );

    expect(isValue(plain)).toBe(true);
    expect(isParamSource(plain)).toBe(true);
    expect(isPlainPointer(plain)).toBe(true);
    expect(isSecretSource(secret)).toBe(true);
    expect(isSecretPointer(secret)).toBe(true);
    expect(Object.isFrozen(plain)).toBe(true);
    expect(isParamSource(plain) && plain.payload).toEqual({ name: 'GREETING' });
  });

  test("its origin keeps the source's label and secrets key and adds the node's address", () => {
    let copy: unknown;
    Load(
      appRoot('shop', ({ provision }) => {
        copy = provision(secretValue('API_KEY'), { id: 'apiKey' });
      }),
    );

    const origin = isSecretSource(copy) ? sourceOriginOf(copy) : undefined;
    expect(origin).toMatchObject({
      kind: 'source',
      sourceKind: 'secret',
      label: 'the test secret "API_KEY"',
      secretsKey: 'API_KEY',
      resource: 'shop.apiKey',
    });
    expect(origin?.source).toBe(copy as never);
  });

  test('a source no node provisioned records no address', () => {
    expect(sourceOriginOf(secretSource({ name: 'X' }))?.resource).toBeUndefined();
    expect(sourceOriginOf(paramSource({ name: 'X' }))?.resource).toBeUndefined();
  });

  test('has a non-enumerable id, the full address, so a binding serializes without it', () => {
    let copy: (object & { readonly id: string }) | undefined;
    Load(
      appRoot('shop', ({ provision }) => {
        copy = provision(plainValue('GREETING'), { id: 'greeting' });
      }),
    );

    expect(copy?.id).toBe('shop.greeting');
    expect(Object.keys(copy ?? {})).not.toContain('id');
    expect(JSON.stringify({ greeting: copy })).toBe(
      JSON.stringify({ greeting: { payload: { name: 'GREETING' } } }),
    );
  });

  test('turning it into text in a body throws the source-misuse error', () => {
    const root = appRoot('shop', ({ provision }) => {
      const greeting = provision(plainValue('GREETING'));
      void `${greeting}`;
    });

    expect(() => Load(root)).toThrow(
      'the test value "GREETING" is known only at boot: the deploy holds a pointer to it, never its value',
    );
  });

  test('two provisions of one node give two copies, each read on its own', () => {
    const node = plainValue('GREETING');
    const copies: unknown[] = [];
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        const first = provision(node, { id: 'first' });
        const second = provision(node, { id: 'second' });
        copies.push(first, second);
        provision(echo(), { input: { a: first, b: second } });
      }),
    );

    expect(copies[0]).not.toBe(copies[1]);
    expect(graph.valueReads.map(({ resource }) => resource)).toEqual(['shop.first', 'shop.second']);
  });
});

describe('the loaded graph', () => {
  test('has a resource node for each provisioned value resource', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(plainValue('GREETING'));
        provision(secretValue('API_KEY'));
      }),
    );

    const values = graph.nodes.flatMap(({ id, node }) => {
      const candidate: unknown = node;
      return isValueResource(candidate) ? [[id, candidate.kind, candidate.type]] : [];
    });
    expect(values).toEqual([
      ['shop.greeting', 'resource', 'test-value'],
      ['shop.apikey', 'resource', 'test-value'],
    ]);
  });

  test('has no value reads when no service reads a value resource', () => {
    expect(Load(appRoot('shop', () => {})).valueReads).toEqual([]);
    const unread = Load(
      appRoot('shop', ({ provision }) => {
        provision(plainValue('GREETING'));
      }),
    );
    expect(unread.valueReads).toEqual([]);
    const lone = service({
      name: 'lone',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: {},
      params: {},
      build,
    });
    expect(Load(lone).valueReads).toEqual([]);
  });

  test('records a read at depth inside objects and arrays', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        const greeting = provision(plainValue('GREETING'));
        const apiKey = provision(secretValue('API_KEY'), { id: 'apiKey' });
        provision(echo(), { input: { mail: { greeting, keys: ['literal', apiKey] } } });
      }),
    );

    expect(graph.valueReads).toEqual([
      {
        reader: 'shop.echo',
        resource: 'shop.greeting',
        site: { kind: 'serviceInput', path: 'mail.greeting' },
      },
      {
        reader: 'shop.echo',
        resource: 'shop.apiKey',
        site: { kind: 'serviceInput', path: 'mail.keys.1' },
      },
    ]);
  });

  test('records a read at each place one object is bound', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        const shared = { greeting: provision(plainValue('GREETING')) };
        provision(echo(), { input: { a: shared, b: shared } });
      }),
    );

    expect(graph.valueReads).toEqual([
      {
        reader: 'shop.echo',
        resource: 'shop.greeting',
        site: { kind: 'serviceInput', path: 'a.greeting' },
      },
      {
        reader: 'shop.echo',
        resource: 'shop.greeting',
        site: { kind: 'serviceInput', path: 'b.greeting' },
      },
    ]);
  });

  test('records a read in a binding that holds a cycle', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        const cyclic: Record<string, unknown> = { greeting: provision(plainValue('GREETING')) };
        cyclic['self'] = cyclic;
        provision(echo(), { input: cyclic });
      }),
    );

    expect(graph.valueReads).toEqual([
      {
        reader: 'shop.echo',
        resource: 'shop.greeting',
        site: { kind: 'serviceInput', path: 'greeting' },
      },
    ]);
  });

  test('records a value bound as the whole input binding with the empty path', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(echo(), { input: provision(plainValue('GREETING')) });
      }),
    );

    expect(graph.valueReads).toEqual([
      { reader: 'shop.echo', resource: 'shop.greeting', site: { kind: 'serviceInput', path: '' } },
    ]);
  });

  test('records a read through two module inputs', () => {
    const inner = module('inner', { input: anyInputSchema }, ({ input, provision }) => {
      provision(echo(), { input: { greeting: (input as never)['greeting'] } });
    });
    const outer = module('outer', { input: anyInputSchema }, ({ input, provision }) => {
      provision(inner, { input: { greeting: (input as never)['greeting'] } });
    });
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(outer, { input: { greeting: provision(plainValue('GREETING')) } });
      }),
    );

    expect(graph.valueReads).toEqual([
      {
        reader: 'shop.outer.inner.echo',
        resource: 'shop.greeting',
        site: { kind: 'serviceInput', path: 'greeting' },
      },
    ]);
  });

  test('records a read through a module input whose schema copies its object', () => {
    const copying = type({ mail: { key: secretString() } }).pipe((input) => ({
      mail: { ...input.mail },
    }));
    const mailer = module('mailer', { input: copying }, ({ input, provision }) => {
      provision(echo(), { input: { key: input.mail } });
    });
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        const key = provision(secretValue('API_KEY'), { id: 'apiKey' });
        provision(mailer, { input: { mail: { key } } });
      }),
    );

    expect(graph.valueReads).toEqual([
      {
        reader: 'shop.mailer.echo',
        resource: 'shop.apiKey',
        site: { kind: 'serviceInput', path: 'key.key' },
      },
    ]);
  });

  test("records a read through a module factory's argument", () => {
    const mailer = (greeting: unknown) =>
      module('mailer', ({ provision }) => {
        provision(echo(), { input: { greeting } });
      });
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(mailer(provision(plainValue('GREETING'))));
      }),
    );

    expect(graph.valueReads).toEqual([
      {
        reader: 'shop.mailer.echo',
        resource: 'shop.greeting',
        site: { kind: 'serviceInput', path: 'greeting' },
      },
    ]);
  });

  test('records a read in a per-key param', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        const greeting = provision(plainValue('GREETING'));
        provision(echo(), { input: {}, params: { greeting } });
      }),
    );

    expect(graph.valueReads).toEqual([
      { reader: 'shop.echo', resource: 'shop.greeting', site: { kind: 'param', path: 'greeting' } },
    ]);
  });

  test('records no read for a source no node provisioned', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(echo(), { input: { key: secretSource({ name: 'X' }) } });
      }),
    );

    expect(graph.valueReads).toEqual([]);
  });
});

describe('the duplicate-id error for a value resource', () => {
  test('names the value resource already at the id by its label', () => {
    const root = appRoot('shop', ({ provision }) => {
      provision(plainValue('EMAIL_FROM', 'sender'));
      provision(plainValue('SENDER'));
    });

    expect(() => Load(root)).toThrow(
      'Duplicate provision id "sender" in module "shop": "shop.sender" already holds the test value "EMAIL_FROM", and the test value "SENDER" takes the same id. Give one of them a different id with provision(node, { id: \'…\' }).',
    );
  });

  test('fires for one node provisioned twice with its default id', () => {
    const node = secretValue('API_KEY', 'apiKey');
    const root = appRoot('shop', ({ provision }) => {
      provision(node);
      provision(node);
    });

    expect(() => Load(root)).toThrow(
      'Duplicate provision id "apiKey" in module "shop": "shop.apiKey" already holds the test secret "API_KEY", and the test secret "API_KEY" takes the same id.',
    );
  });
});

describe('Load refuses', () => {
  class ExtensionValueResource extends ResourceNodeBase<AnyContract | undefined, Deps> {
    constructor(def: { name: string; extension: string; [key: string]: unknown }) {
      super(def as never);
      Object.defineProperty(this, Symbol.for('prisma:value-resource'), {
        value: paramSource({ name: 'GREETING' }, { label: 'the test value "GREETING"' }),
      });
      Object.freeze(this);
    }
  }

  test('a value resource that also provides a contract', () => {
    const node = new ExtensionValueResource({
      name: 'greeting',
      extension: 'test/pack',
      provides: providerContract('fake/db', { url: '' }),
    });
    expect(isValueResource(node)).toBe(true);

    const error = loadError(() =>
      Load(
        appRoot('shop', ({ provision }) => {
          provision(node as never);
        }),
      ),
    );

    expect(error.code).toBe('COMPOSE.GRAPH_INVALID');
    expect(error.message).toBe(
      'Resource "shop.greeting" is a value and also provides a contract. A resource that is a value provides no contract and has no dependencies.',
    );
  });

  test('a value resource that also declares dependency slots', () => {
    const slots = {
      db: { [Symbol.for('prisma:node')]: true, kind: 'dependency', name: 'db', type: 'fake/db' },
    };
    const node = new ExtensionValueResource({
      name: 'greeting',
      extension: 'test/pack',
      type: 'test-value',
      inputs: slots as never,
      deps: { db: { id: 'shop.db' } } as never,
    });

    expect(() =>
      Load(
        appRoot('shop', ({ provision }) => {
          provision(node as never);
        }),
      ),
    ).toThrow(
      'Resource "shop.greeting" is a value and also declares dependency slots. A resource that is a value provides no contract and has no dependencies.',
    );
  });

  test('a value resource provisioned in a module() body through a cast', () => {
    const inner = module('inner', ({ provision }) => {
      provision(plainValue('GREETING') as never);
    });

    const error = loadError(() =>
      Load(
        appRoot('shop', ({ provision }) => {
          provision(inner, { id: 'mail' });
        }),
      ),
    );

    expect(error.code).toBe('COMPOSE.GRAPH_INVALID');
    expect(error.message).toBe(
      'Module "shop.mail" provisions "greeting", a resource that is a value. Only the app root, built with appRoot(), can provision one. Provision it in the root and pass its value down through this module\'s input.',
    );
  });

  test('a value resource provisioned in the body of a module() root through a cast', () => {
    const root = module('shop', ({ provision }) => {
      provision(plainValue('GREETING') as never, { id: 'sender' });
    });

    expect(() => Load(root)).toThrow(
      'Module "shop" provisions "sender", a resource that is a value. Only the app root, built with appRoot(), can provision one.',
    );
  });
});
