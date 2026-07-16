import { describe, expect, test } from 'bun:test';
import { number, string } from '../config.ts';
import type { Contract } from '../contract.ts';
import { Load } from '../graph.ts';
import {
  dependency,
  isNode,
  isProvisionNeed,
  module,
  provisionNeed,
  resource,
  secret,
  service,
} from '../node.ts';
import { conn, providerContract } from './helpers.ts';

const fakeContract = <Cmp>(cmp: Cmp): Contract<'rpc', Cmp> => ({
  kind: 'rpc',
  __cmp: cmp,
  satisfies: (required) => required.__cmp === cmp,
});

const dbContract = () => providerContract('fake/db', { url: '' });

describe('resource()', () => {
  test('returns a branded, frozen resource identity — the routing type is the provided contract kind', () => {
    const provides = dbContract();
    const node = resource({
      name: 'db',
      extension: '@prisma/composer-prisma-cloud',
      provides,
    });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('resource');
    expect(node.name).toBe('db');
    expect(node.extension).toBe('@prisma/composer-prisma-cloud');
    expect(node.type).toBe('fake/db');
    expect(node.provides).toBe(provides);
    expect(Object.isFrozen(node)).toBe(true);
  });

  test('throws when provides is missing or not a contract (kind + satisfies)', () => {
    expect(() => resource({ name: 'db', extension: 'test/pack', provides: {} as never })).toThrow(
      /requires `provides`/,
    );
    expect(() =>
      resource({
        name: 'db',
        extension: 'test/pack',
        provides: { kind: '', satisfies: () => true } as never,
      }),
    ).toThrow(/requires `provides`/);
    expect(() =>
      resource({ name: 'db', extension: 'test/pack', provides: { kind: 'fake/db' } as never }),
    ).toThrow(/requires `provides`/);
  });

  test('throws on an empty name', () => {
    expect(() => resource({ name: '', extension: 'test/pack', provides: dbContract() })).toThrow(
      /non-empty name/,
    );
  });

  test('throws on an empty extension', () => {
    expect(() => resource({ name: 'db', extension: '', provides: dbContract() })).toThrow(
      /non-empty extension/,
    );
  });
});

describe('dependency()', () => {
  test('returns a branded, frozen dependency end carrying its given name and connection', () => {
    const end = dependency({
      name: 'db',
      type: 'fake/db',
      connection: conn({ url: string() }, (v) => ({ url: v.url })),
    });

    expect(isNode(end)).toBe(true);
    expect(end.kind).toBe('dependency');
    expect(end.name).toBe('db');
    expect(end.type).toBe('fake/db');
    expect(end.connection.params).toEqual({ url: string() });
    expect(Object.isFrozen(end)).toBe(true);
    expect(Object.isFrozen(end.connection)).toBe(true);
    expect(Object.isFrozen(end.connection.params)).toBe(true);
    expect(Object.isFrozen(end.connection.params['url'])).toBe(true);
  });

  test('name is optional — an unnamed end falls back to its type', () => {
    const end = dependency({
      type: 'fake/http',
      connection: conn({}, () => ({})),
    });

    expect(end.name).toBe('fake/http');
  });

  test('carries the required contract when given — the value Load checks satisfies() against', () => {
    const required = dbContract();
    const end = dependency({
      type: 'fake/db',
      connection: conn({ url: string() }, (v) => ({ url: v.url })),
      required,
    });

    expect(end.required).toBe(required);
  });

  test("hydrate is the app's factory — called only when invoked", () => {
    let calls = 0;
    const end = dependency({
      type: 'fake/db',
      connection: conn({ url: string() }, (v) => {
        calls += 1;
        return { url: v.url };
      }),
    });

    expect(calls).toBe(0);
    expect(end.connection.hydrate({ url: 'postgres://x' })).toEqual({ url: 'postgres://x' });
    expect(calls).toBe(1);
  });

  test('throws on an empty type', () => {
    expect(() => dependency({ type: '', connection: conn({}, () => ({})) })).toThrow(
      /non-empty node type/,
    );
  });

  test('rejects an underscore in a param name (would collide with the config-key separator)', () => {
    expect(() =>
      dependency({
        name: 'db',
        type: 'fake/db',
        connection: conn({ db_url: string() }, () => ({})),
      }),
    ).toThrow(/param name "db_url" may not contain "_"/);
  });
});

describe('service()', () => {
  const build = {
    extension: '@prisma/composer/node',
    type: 'node',
    module: 'file:///app/src/service.ts',
    entry: 'dist/server.js',
  };

  test('returns a branded, frozen service node with frozen name, extension, inputs, params, and build', () => {
    const db = dependency({
      name: 'db',
      type: 'fake/db',
      connection: conn({}, () => ({})),
    });
    const node = service({
      name: 'hello',
      extension: '@prisma/composer-prisma-cloud',
      type: 'fake/app',
      inputs: { db },
      params: { port: number({ default: 3000 }) },
      build,
    });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('service');
    expect(node.name).toBe('hello');
    expect(node.extension).toBe('@prisma/composer-prisma-cloud');
    expect(node.type).toBe('fake/app');
    expect(node.inputs.db).toBe(db);
    expect(node.params).toEqual({ port: number({ default: 3000 }) });
    expect(node.build).toEqual({
      extension: '@prisma/composer/node',
      type: 'node',
      module: 'file:///app/src/service.ts',
      entry: 'dist/server.js',
    });
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node.inputs)).toBe(true);
    expect(Object.isFrozen(node.params)).toBe(true);
    expect(Object.isFrozen(node.params.port)).toBe(true);
    expect(Object.isFrozen(node.build)).toBe(true);
  });

  test('carries no descriptor — the node is a pure description', () => {
    const node = service({
      name: 'hello',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {
        db: dependency({
          name: 'db',
          type: 'fake/db',
          connection: conn({}, () => ({})),
        }),
      },
      params: { port: number({ default: 3000 }) },
      build,
    });

    expect('invoke' in node).toBe(false);
    expect(node.build.type).toBe('node');
  });

  test('throws on an empty type', () => {
    expect(() =>
      service({
        name: 'hello',
        extension: 'test/pack',
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
        extension: 'test/pack',
        type: 'fake/app',
        inputs: {},
        params: {},
        build,
      }),
    ).toThrow(/non-empty name/);
  });

  test('throws on an empty extension', () => {
    expect(() =>
      service({
        name: 'hello',
        extension: '',
        type: 'fake/app',
        inputs: {},
        params: {},
        build,
      }),
    ).toThrow(/non-empty extension/);
  });

  test('rejects an underscore in an input name', () => {
    const db = dependency({
      name: 'db',
      type: 'fake/db',
      connection: conn({}, () => ({})),
    });
    expect(() =>
      service({
        name: 'hello',
        extension: 'test/pack',
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
        extension: 'test/pack',
        type: 'fake/app',
        inputs: {},
        params: { max_conns: number({ default: 1 }) },
        build,
      }),
    ).toThrow(/param name "max_conns" may not contain "_"/);
  });

  test('rejects a secret slot name that collides with a service param name', () => {
    expect(() =>
      service({
        name: 'hello',
        extension: 'test/pack',
        type: 'fake/app',
        inputs: {},
        params: { token: string() },
        secrets: { token: secret() },
        build,
      }),
    ).toThrow(/secret slot "token" collides with a param of the same name/);
  });

  test('a secret slot name may match a dependency input name — their config keys never collide', () => {
    const node = service({
      name: 'hello',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {
        token: dependency({
          name: 'token',
          type: 'fake/rpc',
          connection: conn({ url: string() }, () => ({})),
        }),
      },
      params: {},
      secrets: { token: secret() },
      build,
    });
    expect(Object.keys(node.secretSlots)).toEqual(['token']);
    expect(Object.keys(node.inputs)).toEqual(['token']);
  });

  test('expose is absent by default', () => {
    const node = service({
      name: 'hello',
      extension: 'test/pack',
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
      extension: 'test/pack',
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

describe('module()', () => {
  test('construction is INERT — the body runs only at Load', () => {
    let bodyCalls = 0;
    const node = module('shop', {}, () => {
      bodyCalls += 1;
      return {};
    });

    expect(bodyCalls).toBe(0);
    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('module');
    expect(node.name).toBe('shop');
    expect(Object.isFrozen(node)).toBe(true);
  });

  test('throws on an empty name', () => {
    expect(() => module('', {}, () => ({}))).toThrow(/non-empty name/);
  });

  test('closed-root overload — no boundary, no return — is empty on both sides', () => {
    let ran = false;
    const node = module('root', (ctx) => {
      ran = true;
      expect(ctx.provision).toBeInstanceOf(Function);
    });

    // Inert at construction; empty boundary on both sides.
    expect(ran).toBe(false);
    expect(node.deps).toEqual({});
    expect(node.expose).toEqual({});

    // Load runs the body against a real ctx; the wrapper returns no ports.
    const graph = Load(node);
    expect(ran).toBe(true);
    expect(graph.nodes.map((n) => n.id)).toEqual(['root']);
  });
});

describe('provisionNeed() / isProvisionNeed() (ADR-0031)', () => {
  test('provisionNeed builds a branded need; plain values and other brands are not one', () => {
    expect(isProvisionNeed(provisionNeed(Symbol('test-need')))).toBe(true);
    expect(isProvisionNeed({})).toBe(false);
    expect(isProvisionNeed(undefined)).toBe(false);
  });

  test('the brand and payload round-trip untouched — core never reads or transforms the payload', () => {
    const brand = Symbol('test-need');
    const need = provisionNeed(brand, { arbitrary: 'shape' });

    expect(need.brand).toBe(brand);
    expect(need.payload).toEqual({ arbitrary: 'shape' });
  });

  test('payload defaults to undefined when omitted', () => {
    const need = provisionNeed(Symbol('test-need'));

    expect(need.payload).toBeUndefined();
  });
});
