import { describe, expect, test } from 'bun:test';
import { isNode, resource, service } from '../node.ts';
import { conn, memoryAdapter } from './helpers.ts';

const adapter = memoryAdapter({});

describe('resource()', () => {
  test('returns a branded, frozen resource node carrying its connection', () => {
    const node = resource({
      type: 'fake/db',
      connection: conn({ url: { type: 'string', secret: true } }, (v) => ({ url: v.url })),
    });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('resource');
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
    expect(() => resource({ type: '', connection: conn({}, () => ({})) })).toThrow(
      /non-empty node type/,
    );
  });
});

describe('service()', () => {
  test('returns a branded, frozen service node with frozen inputs and params', () => {
    const db = resource({ type: 'fake/db', connection: conn({}, () => ({})) });
    const node = service({
      type: 'fake/app',
      inputs: { db },
      params: { port: { type: 'number', default: 3000 } },
      config: adapter,
      handler: () => null,
    });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('service');
    expect(node.type).toBe('fake/app');
    expect(node.inputs.db).toBe(db);
    expect(node.params).toEqual({ port: { type: 'number', default: 3000 } });
    expect(node.config).toBe(adapter);
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node.inputs)).toBe(true);
    expect(Object.isFrozen(node.params)).toBe(true);
    expect(Object.isFrozen(node.params.port)).toBe(true);
  });

  test('stores the handler as run; constructing calls nothing', () => {
    let calls = 0;
    const node = service({
      type: 'fake/app',
      inputs: { db: resource({ type: 'fake/db', connection: conn({}, () => ({})) }) },
      params: { port: { type: 'number', default: 3000 } },
      config: adapter,
      handler: (deps, ctx) => {
        calls += 1;
        return { deps, ctx };
      },
    });

    expect(calls).toBe(0);

    const fakeDb = { q: 1 };
    const result = node.run({ db: fakeDb }, { port: 4242 });
    expect(calls).toBe(1);
    expect(result).toEqual({ deps: { db: fakeDb }, ctx: { port: 4242 } });
  });

  test('throws on an empty type', () => {
    expect(() =>
      service({ type: '', inputs: {}, params: {}, config: adapter, handler: () => null }),
    ).toThrow(/non-empty node type/);
  });
});
