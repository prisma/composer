/**
 * Composing the application-topology wire body from a loaded Graph, and the
 * content hash the platform stores opaquely (pdp-control-plane
 * `projects/branch-topology/spec.md`). The graphs are REAL Load outputs —
 * the composition reads the authored view core keeps, never a hand-built
 * stand-in.
 */
import { describe, expect, test } from 'bun:test';
import { type Contract, dependency, Load, module, resource, service } from '@internal/core';
import {
  applicationTopologyContentHash,
  composeApplicationTopology,
} from '../builds/application-topology.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const dbContract: Contract<'postgres', undefined> = {
  kind: 'postgres',
  __cmp: undefined,
  satisfies: (required) => required.kind === 'postgres',
};

const rpcContract = (): Contract<'rpc', undefined> => {
  const value: Contract<'rpc', undefined> = {
    kind: 'rpc',
    __cmp: undefined,
    satisfies: (required) => value === required,
  };
  return value;
};

const connection = { params: {}, hydrate: () => ({}) };

const dbEnd = () => dependency({ type: 'postgres', connection, required: dbContract });

/** The spec's shop: a resource, a module exposing a child service's port, and a consumer of both. */
function shopGraph() {
  const verify = rpcContract();
  const api = service({
    name: 'api',
    extension: 'test/pack',
    type: 'compute',
    inputs: { db: dbEnd() },
    params: {},
    build,
    expose: { verify },
  });
  const auth = module(
    'auth',
    { deps: { db: dbEnd() }, expose: { verify } },
    ({ inputs, provision }) => ({
      verify: provision(api, { id: 'api', deps: { db: inputs.db } }).verify,
    }),
  );
  const web = service({
    name: 'web',
    extension: 'test/pack',
    type: 'compute',
    inputs: {
      db: dbEnd(),
      verify: dependency({ type: 'rpc', connection, required: verify }),
    },
    params: {},
    build,
  });
  return Load(
    module('shop', {}, ({ provision }) => {
      const catalogDb = provision(
        resource({ name: 'catalogDb', extension: 'test/pack', provides: dbContract }),
      );
      const authRef = provision(auth, { deps: { db: catalogDb } });
      provision(web, { deps: { db: catalogDb, verify: authRef.verify } });
    }),
  );
}

describe('composeApplicationTopology', () => {
  test('nodes state containment, carry kind and type; modules send no type', () => {
    const topology = composeApplicationTopology(shopGraph());

    expect(topology.nodes).toContainEqual({
      logicalId: 'shop',
      parentLogicalId: null,
      kind: 'module',
    });
    expect(topology.nodes).toContainEqual({
      logicalId: 'catalogDb',
      parentLogicalId: 'shop',
      kind: 'resource',
      type: 'postgres',
    });
    expect(topology.nodes).toContainEqual({
      logicalId: 'auth',
      parentLogicalId: 'shop',
      kind: 'module',
    });
    expect(topology.nodes).toContainEqual({
      logicalId: 'auth.api',
      parentLogicalId: 'auth',
      kind: 'service',
      type: 'compute',
    });
    expect(topology.nodes).toContainEqual({
      logicalId: 'web',
      parentLogicalId: 'shop',
      kind: 'service',
      type: 'compute',
    });
    // The flat view's dependency-slot nodes are ports on the wire, not nodes.
    expect(topology.nodes).toHaveLength(5);
  });

  test('ports carry the owning logical id, direction, name, and contract kind', () => {
    const topology = composeApplicationTopology(shopGraph());

    expect(topology.ports).toContainEqual({
      logicalId: 'catalogDb',
      direction: 'out',
      name: '$out',
      contractKind: 'postgres',
    });
    expect(topology.ports).toContainEqual({
      logicalId: 'auth',
      direction: 'in',
      name: 'db',
      contractKind: 'postgres',
    });
    expect(topology.ports).toContainEqual({
      logicalId: 'auth',
      direction: 'out',
      name: 'verify',
      contractKind: 'rpc',
    });
    expect(topology.ports).toContainEqual({
      logicalId: 'web',
      direction: 'in',
      name: 'verify',
      contractKind: 'rpc',
    });
  });

  test('edges resolve family through module boundaries: resource-fed edges are data, rpc-fed edges request-response communication', () => {
    const topology = composeApplicationTopology(shopGraph());

    // Directly resource-fed.
    expect(topology.edges).toContainEqual({
      from: { logicalId: 'catalogDb', direction: 'out', name: '$out' },
      to: { logicalId: 'web', direction: 'in', name: 'db' },
      family: 'data',
    });
    expect(topology.edges).toContainEqual({
      from: { logicalId: 'catalogDb', direction: 'out', name: '$out' },
      to: { logicalId: 'auth', direction: 'in', name: 'db' },
      family: 'data',
    });
    // The boundary edge inside auth resolves through auth's own in port to
    // the resource: still data.
    expect(topology.edges).toContainEqual({
      from: { logicalId: 'auth', direction: 'in', name: 'db' },
      to: { logicalId: 'auth.api', direction: 'in', name: 'db' },
      family: 'data',
    });
    // The rpc port, exposed through the module boundary: communication with
    // the request-response style on both hops.
    expect(topology.edges).toContainEqual({
      from: { logicalId: 'auth.api', direction: 'out', name: 'verify' },
      to: { logicalId: 'auth', direction: 'out', name: 'verify' },
      family: 'communication',
      style: 'request-response',
    });
    expect(topology.edges).toContainEqual({
      from: { logicalId: 'auth', direction: 'out', name: 'verify' },
      to: { logicalId: 'web', direction: 'in', name: 'verify' },
      family: 'communication',
      style: 'request-response',
    });
    expect(topology.edges).toHaveLength(5);
  });

  test('an empty graph composes an empty submission — a valid replace that empties the branch', () => {
    const topology = composeApplicationTopology(Load(module('bare', () => {})));

    expect(topology).toEqual({
      nodes: [{ logicalId: 'bare', parentLogicalId: null, kind: 'module' }],
      ports: [],
      edges: [],
    });
  });
});

describe('applicationTopologyContentHash', () => {
  test('is stable across loads of the same declaration', () => {
    const first = applicationTopologyContentHash(composeApplicationTopology(shopGraph()));
    const second = applicationTopologyContentHash(composeApplicationTopology(shopGraph()));

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('changes when the declared graph changes', () => {
    const shop = applicationTopologyContentHash(composeApplicationTopology(shopGraph()));
    const bare = applicationTopologyContentHash(
      composeApplicationTopology(Load(module('bare', () => {}))),
    );

    expect(shop).not.toBe(bare);
  });

  test('is order-insensitive: the same entries hash the same however they arrive', () => {
    const topology = composeApplicationTopology(shopGraph());
    const reversed = {
      nodes: [...topology.nodes].reverse(),
      ports: [...topology.ports].reverse(),
      edges: [...topology.edges].reverse(),
    };

    expect(applicationTopologyContentHash(reversed)).toBe(applicationTopologyContentHash(topology));
  });
});
