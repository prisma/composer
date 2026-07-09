import { describe, expect, test } from 'bun:test';
import type { Contract } from '../contract.ts';
import { connectionEnd, hex, isNode, resource, service } from '../node.ts';
import { conn } from './helpers.ts';

const fakeContract = <Cmp>(cmp: Cmp): Contract<'rpc', Cmp> => ({
  kind: 'rpc',
  __cmp: cmp,
  satisfies: (required) => required.__cmp === cmp,
});

describe('resource()', () => {
  test('returns a branded, frozen resource node carrying its name, pack, and connection', () => {
    const node = resource({
      name: 'db',
      pack: '@makerkit/prisma-cloud',
      type: 'fake/db',
      connection: conn({ url: { type: 'string', secret: true } }, (v) => ({ url: v.url })),
    });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('resource');
    expect(node.name).toBe('db');
    expect(node.pack).toBe('@makerkit/prisma-cloud');
    expect(node.type).toBe('fake/db');
    expect(node.connection.params).toEqual({ url: { type: 'string', secret: true } });
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node.connection)).toBe(true);
    expect(Object.isFrozen(node.connection.params)).toBe(true);
    expect(Object.isFrozen(node.connection.params['url'])).toBe(true);
  });

  test("hydrate is the app's factory — called only when invoked", () => {
    let calls = 0;
    const node = resource({
      name: 'db',
      pack: 'test/pack',
      type: 'fake/db',
      connection: conn({ url: { type: 'string' } }, (v) => {
        calls += 1;
        return { url: v.url };
      }),
    });

    expect(calls).toBe(0);
    expect(node.connection.hydrate({ url: 'postgres://x' })).toEqual({ url: 'postgres://x' });
    expect(calls).toBe(1);
  });

  test('throws on an empty type', () => {
    expect(() =>
      resource({ name: 'db', pack: 'test/pack', type: '', connection: conn({}, () => ({})) }),
    ).toThrow(/non-empty node type/);
  });

  test('throws on an empty name', () => {
    expect(() =>
      resource({ name: '', pack: 'test/pack', type: 'fake/db', connection: conn({}, () => ({})) }),
    ).toThrow(/non-empty name/);
  });

  test('throws on an empty pack', () => {
    expect(() =>
      resource({ name: 'db', pack: '', type: 'fake/db', connection: conn({}, () => ({})) }),
    ).toThrow(/non-empty pack/);
  });

  test('rejects an underscore in a param name (would collide with the config-key separator)', () => {
    expect(() =>
      resource({
        name: 'db',
        pack: 'test/pack',
        type: 'fake/db',
        connection: conn({ db_url: { type: 'string' } }, () => ({})),
      }),
    ).toThrow(/param name "db_url" may not contain "_"/);
  });
});

describe('service()', () => {
  const build = {
    kind: 'node',
    pack: '@makerkit/node',
    module: 'file:///app/src/service.ts',
    entry: 'dist/server.js',
  };

  test('returns a branded, frozen service node with frozen name, pack, inputs, params, and build', () => {
    const db = resource({
      name: 'db',
      pack: 'test/pack',
      type: 'fake/db',
      connection: conn({}, () => ({})),
    });
    const node = service({
      name: 'hello',
      pack: '@makerkit/prisma-cloud',
      type: 'fake/app',
      inputs: { db },
      params: { port: { type: 'number', default: 3000 } },
      build,
    });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('service');
    expect(node.name).toBe('hello');
    expect(node.pack).toBe('@makerkit/prisma-cloud');
    expect(node.type).toBe('fake/app');
    expect(node.inputs.db).toBe(db);
    expect(node.params).toEqual({ port: { type: 'number', default: 3000 } });
    expect(node.build).toEqual({
      kind: 'node',
      pack: '@makerkit/node',
      module: 'file:///app/src/service.ts',
      entry: 'dist/server.js',
    });
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node.inputs)).toBe(true);
    expect(Object.isFrozen(node.params)).toBe(true);
    expect(Object.isFrozen(node.params.port)).toBe(true);
    expect(Object.isFrozen(node.build)).toBe(true);
  });

  test('carries no handler — the node is a pure description', () => {
    const node = service({
      name: 'hello',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {
        db: resource({
          name: 'db',
          pack: 'test/pack',
          type: 'fake/db',
          connection: conn({}, () => ({})),
        }),
      },
      params: { port: { type: 'number', default: 3000 } },
      build,
    });

    expect('invoke' in node).toBe(false);
    expect(node.build.kind).toBe('node');
  });

  test('throws on an empty type', () => {
    expect(() =>
      service({
        name: 'hello',
        pack: 'test/pack',
        type: '',
        inputs: {},
        params: {},
        build,
      }),
    ).toThrow(/non-empty node type/);
  });

  test('throws on an empty name', () => {
    expect(() =>
      service({
        name: '',
        pack: 'test/pack',
        type: 'fake/app',
        inputs: {},
        params: {},
        build,
      }),
    ).toThrow(/non-empty name/);
  });

  test('rejects an underscore in an input name', () => {
    const db = resource({
      name: 'db',
      pack: 'test/pack',
      type: 'fake/db',
      connection: conn({}, () => ({})),
    });
    expect(() =>
      service({
        name: 'hello',
        pack: 'test/pack',
        type: 'fake/app',
        inputs: { my_db: db },
        params: {},
        build,
      }),
    ).toThrow(/input name "my_db" may not contain "_"/);
  });

  test('rejects an underscore in a service param name', () => {
    expect(() =>
      service({
        name: 'hello',
        pack: 'test/pack',
        type: 'fake/app',
        inputs: {},
        params: { max_conns: { type: 'number', default: 1 } },
        build,
      }),
    ).toThrow(/param name "max_conns" may not contain "_"/);
  });

  test('expose is absent by default', () => {
    const node = service({
      name: 'hello',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: {},
      build,
    });

    expect(node.expose).toBeUndefined();
  });

  test('carries a frozen expose map of named output-port Contracts when declared', () => {
    const authContract = fakeContract({ verify: async () => ({ ok: true }) });
    const node = service({
      name: 'hello',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: {},
      build,
      expose: { rpc: authContract },
    });

    expect(node.expose).toEqual({ rpc: authContract });
    expect(node.expose?.rpc).toBe(authContract);
    expect(Object.isFrozen(node.expose)).toBe(true);
  });
});

describe('connectionEnd()', () => {
  test('returns a branded, frozen connection end carrying its given name and connection', () => {
    const end = connectionEnd({
      name: 'auth',
      type: 'fake/http',
      connection: conn({ url: { type: 'string' } }, (v) => ({ url: v.url })),
    });

    expect(isNode(end)).toBe(true);
    expect(end.kind).toBe('connection');
    expect(end.name).toBe('auth');
    expect(end.type).toBe('fake/http');
    expect(end.connection.params).toEqual({ url: { type: 'string' } });
    expect(Object.isFrozen(end)).toBe(true);
    expect(Object.isFrozen(end.connection)).toBe(true);
    expect(Object.isFrozen(end.connection.params)).toBe(true);
  });

  test('name is optional — an unnamed end falls back to its type', () => {
    const end = connectionEnd({
      type: 'fake/http',
      connection: conn({}, () => ({})),
    });

    expect(end.name).toBe('fake/http');
  });

  test('hydrate is the supplied factory — called only when invoked', () => {
    let calls = 0;
    const end = connectionEnd({
      type: 'fake/http',
      connection: conn({ url: { type: 'string' } }, (v) => {
        calls += 1;
        return { url: v.url };
      }),
    });

    expect(calls).toBe(0);
    expect(end.connection.hydrate({ url: 'https://x' })).toEqual({ url: 'https://x' });
    expect(calls).toBe(1);
  });

  test('throws on an empty type', () => {
    expect(() => connectionEnd({ type: '', connection: conn({}, () => ({})) })).toThrow(
      /non-empty node type/,
    );
  });

  test('rejects an underscore in a param name', () => {
    expect(() =>
      connectionEnd({
        type: 'fake/http',
        connection: conn({ base_url: { type: 'string' } }, () => ({})),
      }),
    ).toThrow(/param name "base_url" may not contain "_"/);
  });
});

describe('hex()', () => {
  test('construction is INERT — the body runs only at Load', () => {
    let bodyCalls = 0;
    const node = hex('shop', () => {
      bodyCalls += 1;
    });

    expect(bodyCalls).toBe(0);
    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('hex');
    expect(node.name).toBe('shop');
    expect(Object.isFrozen(node)).toBe(true);
  });

  test('throws on an empty name', () => {
    expect(() => hex('', () => {})).toThrow(/non-empty name/);
  });
});
