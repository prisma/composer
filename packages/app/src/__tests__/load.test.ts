import { describe, expect, test } from 'bun:test';
import { string } from '../config.ts';
import { Load, LoadError } from '../graph.ts';
import { dependency, resource, service, system } from '../node.ts';
import { conn, providerContract } from './helpers.ts';

const build = {
  extension: '@prisma/app-node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const dbDep = () =>
  dependency({
    name: 'db',
    type: 'fake/db',
    connection: conn({}, () => ({})),
    required: providerContract('fake/db', { url: '' }),
  });
const dbResource = () =>
  resource({
    name: 'db',
    extension: 'test/pack',
    provides: providerContract('fake/db', { url: '' }),
  });
const app = (inputs: Record<string, ReturnType<typeof dbDep>>) =>
  service({
    name: 'test-service',
    extension: 'test/pack',
    type: 'fake/app',
    inputs,
    params: {},
    build,
  });

describe('Load', () => {
  test('a dep-less service root loads to a one-node graph with no edges', () => {
    const root = app({});

    const graph = Load(root, { id: 'hello' });

    expect(graph.root).toEqual({ id: 'hello', node: root });
    expect(graph.nodes.map((n) => n.id)).toEqual(['hello']);
    expect(graph.edges).toEqual([]);
  });

  test('defaults the root id to "root"', () => {
    const graph = Load(app({}));

    expect(graph.root.id).toBe('root');
  });

  test('executes nothing — Load never calls a connection hydrate', () => {
    let calls = 0;
    const svc = service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {
        db: dependency({
          name: 'db',
          type: 'fake/db',
          connection: conn({}, () => {
            calls += 1;
            return {};
          }),
        }),
      },
      params: {},
      build,
    });
    const root = system('shop', {}, (h) => {
      const db = h.provision('db', dbResource());
      h.provision('app', svc, { db });
      return {};
    });

    Load(root);

    expect(calls).toBe(0);
  });

  test('rejects a root that is not a branded service or system node', () => {
    expect(() => Load({} as never)).toThrow(LoadError);
    expect(() => Load(dbResource() as never)).toThrow(LoadError);
  });

  test('rejects an input that is not a branded dependency end', () => {
    const root = app({ db: { kind: 'dependency', type: 'fake/db' } as never });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/db/);
  });

  test('rejects a forged input with an empty type', () => {
    // Spread copies the brand symbol but lets the type be emptied — Load must catch it.
    const forged = { ...dbDep(), type: '' };
    const root = system('shop', {}, (h) => {
      const db = h.provision('db', dbResource());
      h.provision('app', app({ db: forged as never }), { db });
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/empty node type/);
  });

  test('rejects a root service with an unwired dependency input, naming the input and pointing at the composing system (ADR-0003)', () => {
    const auth = dependency({
      name: 'auth',
      type: 'fake/http',
      connection: conn({ url: string() }, (v) => ({ url: v.url })),
    });
    const root = service({
      name: 'storefront',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: { auth },
      params: {},
      build,
    });

    expect(() => Load(root, { id: 'storefront' })).toThrow(LoadError);
    expect(() => Load(root, { id: 'storefront' })).toThrow(
      /Service "storefront" has an unwired dependency input "auth" — this service is composed by a system; deploy the system instead of loading "storefront" directly\./,
    );
  });

  test('the lone-root rule is uniform — a resource-requiring dependency input reads the same way', () => {
    const root = app({ db: dbDep() });

    expect(() => Load(root, { id: 'hello' })).toThrow(LoadError);
    expect(() => Load(root, { id: 'hello' })).toThrow(
      /Service "hello" has an unwired dependency input "db" — this service is composed by a system; deploy the system instead of loading "hello" directly\./,
    );
  });

  test('rejects a concrete ResourceNode found in deps — a resource is provisioned by the composing system, never by mention', () => {
    const root = app({ db: dbResource() as never });

    expect(() => Load(root, { id: 'hello' })).toThrow(LoadError);
    expect(() => Load(root, { id: 'hello' })).toThrow(
      /Input "db" of "hello" is a resource node — a resource is provisioned by the composing system, never created for a service that mentions it\./,
    );
  });
});
