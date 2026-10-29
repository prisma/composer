/**
 * The authored graph view Load keeps alongside the flat one: explicit
 * parents on every node, declared boundary ports, and pre-dereference
 * (authored) edges where module boundaries are ordinary edges. This is what
 * the application-topology submission reads (pdp `projects/branch-topology/spec.md`).
 */
import { describe, expect, test } from 'bun:test';
import { string } from '../config.ts';
import type { Contract } from '../contract.ts';
import { Load } from '../graph.ts';
import { dependency, module, resource, service } from '../node.ts';
import { conn, providerContract } from './helpers.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const fakeContract = <Cmp>(cmp: Cmp): Contract<'rpc', Cmp> => {
  const value: Contract<'rpc', Cmp> = {
    kind: 'rpc',
    __cmp: cmp,
    style: 'request-response',
    satisfies: (required) => value === required,
  };
  return value;
};

const dbContract = providerContract('fake/db', { url: '' });

const dbEnd = () =>
  dependency({
    type: 'fake/db',
    connection: conn({ url: string() }, (v) => ({ url: v.url })),
    required: dbContract,
  });

/** The spec's worked example: a root with a resource, a nested module, and a service consuming both. */
function shopGraph() {
  const verifyContract = fakeContract({ verify: (token: string) => Boolean(token) });

  const api = service({
    name: 'api',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: { db: dbEnd() },
    params: {},
    build,
    expose: { verify: verifyContract },
  });

  const auth = module(
    'auth',
    { deps: { db: dbEnd() }, expose: { verify: verifyContract } },
    ({ deps, provision }) => {
      const ref = provision(api, { id: 'api', deps: { db: deps.db } });
      return { verify: ref.verify };
    },
  );

  const web = service({
    name: 'web',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {
      db: dbEnd(),
      verify: dependency({
        type: 'fake/rpc',
        connection: conn({ url: string() }, (v) => ({ url: v.url })),
        required: verifyContract,
      }),
    },
    params: {},
    build,
  });

  const root = module('shop', {}, ({ provision }) => {
    const catalogDb = provision(
      resource({ name: 'catalogDb', extension: 'test/pack', provides: dbContract }),
    );
    const authRef = provision(auth, { deps: { db: catalogDb } });
    provision(web, { deps: { db: catalogDb, verify: authRef.verify } });
  });

  return Load(root);
}

describe('explicit parents', () => {
  test('every node carries its parent id; only the root has none', () => {
    const graph = shopGraph();
    const parentOf = (id: string) => graph.nodes.find((n) => n.id === id)?.parent;

    expect(graph.root.parent).toBeUndefined();
    expect(parentOf('shop')).toBeUndefined();
    expect(parentOf('shop.catalogDb')).toBe('shop');
    expect(parentOf('shop.auth')).toBe('shop');
    expect(parentOf('shop.auth.api')).toBe('shop.auth');
    expect(parentOf('shop.web')).toBe('shop');
    // Flat-view dependency slot nodes hang off their service.
    expect(parentOf('shop.web.db')).toBe('shop.web');
    expect(parentOf('shop.auth.api.db')).toBe('shop.auth.api');
  });
});

describe('boundary ports', () => {
  test('dep slots are in ports, exposed contracts are out ports with their style, a resource has one $out', () => {
    const graph = shopGraph();

    expect(graph.ports).toContainEqual({
      node: 'shop.catalogDb',
      direction: 'out',
      name: '$out',
      contractKind: 'fake/db',
      style: undefined,
    });
    expect(graph.ports).toContainEqual({
      node: 'shop.auth',
      direction: 'in',
      name: 'db',
      contractKind: 'fake/db',
      style: undefined,
    });
    expect(graph.ports).toContainEqual({
      node: 'shop.auth',
      direction: 'out',
      name: 'verify',
      contractKind: 'rpc',
      style: 'request-response',
    });
    expect(graph.ports).toContainEqual({
      node: 'shop.auth.api',
      direction: 'in',
      name: 'db',
      contractKind: 'fake/db',
      style: undefined,
    });
    expect(graph.ports).toContainEqual({
      node: 'shop.auth.api',
      direction: 'out',
      name: 'verify',
      contractKind: 'rpc',
      style: 'request-response',
    });
    expect(graph.ports).toContainEqual({
      node: 'shop.web',
      direction: 'in',
      name: 'db',
      contractKind: 'fake/db',
      style: undefined,
    });
    expect(graph.ports).toContainEqual({
      node: 'shop.web',
      direction: 'in',
      name: 'verify',
      contractKind: 'fake/rpc',
      style: undefined,
    });
    // The root declares no boundary, so it contributes no ports.
    expect(graph.ports.filter((p) => p.node === 'shop')).toEqual([]);
  });
});

describe('authored (pre-dereference) edges', () => {
  test('module boundaries are ordinary edges; the flat view resolves through them', () => {
    const graph = shopGraph();

    // Wiring at the root scope.
    expect(graph.authoredEdges).toContainEqual({
      from: { node: 'shop.catalogDb', direction: 'out', name: '$out' },
      to: { node: 'shop.auth', direction: 'in', name: 'db' },
    });
    expect(graph.authoredEdges).toContainEqual({
      from: { node: 'shop.catalogDb', direction: 'out', name: '$out' },
      to: { node: 'shop.web', direction: 'in', name: 'db' },
    });
    // A consumer wired to a module's exposed port sees the MODULE boundary,
    // not the inner producer the flat view resolves to.
    expect(graph.authoredEdges).toContainEqual({
      from: { node: 'shop.auth', direction: 'out', name: 'verify' },
      to: { node: 'shop.web', direction: 'in', name: 'verify' },
    });
    // Inside the module: input forwarded to a child (in → in) and a child's
    // output exposed at the boundary (out → out).
    expect(graph.authoredEdges).toContainEqual({
      from: { node: 'shop.auth', direction: 'in', name: 'db' },
      to: { node: 'shop.auth.api', direction: 'in', name: 'db' },
    });
    expect(graph.authoredEdges).toContainEqual({
      from: { node: 'shop.auth.api', direction: 'out', name: 'verify' },
      to: { node: 'shop.auth', direction: 'out', name: 'verify' },
    });
    expect(graph.authoredEdges).toHaveLength(5);

    // The flat view still dereferences every chain to the real producer.
    expect(graph.edges).toContainEqual({
      from: 'shop.catalogDb',
      to: 'shop.auth.api',
      input: 'db',
      kind: 'dependency',
    });
    expect(graph.edges).toContainEqual({
      from: 'shop.auth.api',
      to: 'shop.web',
      input: 'verify',
      kind: 'dependency',
    });
  });

  test('a re-exposed own input is an in → out edge on the module itself', () => {
    const passThrough = module(
      'relay',
      { deps: { db: dbEnd() }, expose: { db: dbContract } },
      ({ deps }) => ({ db: deps.db }),
    );
    const root = module('shop', {}, ({ provision }) => {
      const db = provision(
        resource({ name: 'primary', extension: 'test/pack', provides: dbContract }),
      );
      provision(passThrough, { deps: { db } });
    });

    const graph = Load(root);

    expect(graph.authoredEdges).toContainEqual({
      from: { node: 'shop.relay', direction: 'in', name: 'db' },
      to: { node: 'shop.relay', direction: 'out', name: 'db' },
    });
  });

  test('a whole ref wired wholesale into an untyped slot authors no edge', () => {
    const consumer = service({
      name: 'consumer',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: {
        upstream: dependency({
          type: 'fake/http',
          connection: conn({ url: string() }, (v) => ({ url: v.url })),
        }),
      },
      params: {},
      build,
    });
    const root = module('shop', {}, ({ provision }) => {
      const producer = provision(
        service({
          name: 'producer',
          extension: 'test/pack',
          type: 'fake/compute',
          inputs: {},
          params: {},
          build,
        }),
      );
      provision(consumer, { deps: { upstream: producer } });
    });

    const graph = Load(root);

    // The flat edge still resolves; the authored view has nothing to name.
    expect(graph.edges).toContainEqual({
      from: 'shop.producer',
      to: 'shop.consumer',
      input: 'upstream',
      kind: 'dependency',
    });
    expect(graph.authoredEdges).toEqual([]);
  });
});

describe('the reserved $out port name', () => {
  test('service() rejects an expose named $out', () => {
    expect(() =>
      service({
        name: 'svc',
        extension: 'test/pack',
        type: 'fake/compute',
        inputs: {},
        params: {},
        build,
        expose: { $out: dbContract },
      }),
    ).toThrow(
      'service() declares a port named "$out" — that name is reserved for a resource\'s ' +
        'anonymous output; choose another name.',
    );
  });

  test('module() rejects a dep named $out', () => {
    expect(() => module('m', { deps: { $out: dbEnd() } }, () => ({}))).toThrow(
      'module() declares a port named "$out"',
    );
  });

  test('module() rejects an expose named $out', () => {
    expect(() => module('m', { expose: { $out: dbContract } }, () => ({}) as never)).toThrow(
      'module() declares a port named "$out"',
    );
  });
});
