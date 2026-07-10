import { describe, expect, test } from 'bun:test';
import { type Graph, resource, service } from '@prisma/app';
import { extractFromEnv, targetNodeOf } from '../target.ts';

const build = {
  kind: 'node',
  assembler: '@prisma/app-node/assemble',
  module: 'file:///test/service.ts',
  entry: 'server.js',
} as const;

function graphWithTargetModules(targetModules: readonly string[]): Graph {
  const nodes = targetModules.map((targetModule, i) => ({
    id: `svc-${i}`,
    node: service({
      name: `svc-${i}`,
      pack: 'test/pack',
      type: 'fixture/service',
      inputs: {},
      params: {},
      build,
      targetModule,
    }),
  }));
  const root = nodes[0];
  if (root === undefined) throw new Error('graphWithTargetModules needs at least one targetModule');
  return { root, nodes, edges: [] };
}

describe('targetNodeOf() (ADR-0003, one target per application)', () => {
  test('returns the single target and a node that carries it', () => {
    const graph = graphWithTargetModules(['@prisma/app-cloud/target', '@prisma/app-cloud/target']);
    const { node, targetModule } = targetNodeOf(graph);
    expect(targetModule).toBe('@prisma/app-cloud/target');
    expect(node.targetModule).toBe('@prisma/app-cloud/target');
  });

  test('reads a resource node targetModule too', () => {
    const svc = service({
      name: 'svc',
      pack: 'test/pack',
      type: 'fixture/service',
      inputs: {},
      params: {},
      build,
    });
    const res = resource({
      name: 'res',
      pack: '@prisma/app-cloud',
      provides: { kind: 'fixture/resource', __cmp: {}, satisfies: () => true },
      targetModule: '@prisma/app-cloud/target',
    });
    const graph: Graph = {
      root: { id: 'root', node: svc },
      nodes: [
        { id: 'root', node: svc },
        { id: 'root.db', node: res },
      ],
      edges: [],
    };
    expect(targetNodeOf(graph).targetModule).toBe('@prisma/app-cloud/target');
  });

  test('throws when the graph mixes more than one target', () => {
    const graph = graphWithTargetModules(['@prisma/app-cloud/target', '@other/pack/target']);
    expect(() => targetNodeOf(graph)).toThrow(
      /mixes more than one deploy target \(@prisma\/app-cloud\/target, @other\/pack\/target\)/,
    );
  });

  test('throws when no node carries a targetModule', () => {
    const svc = service({
      name: 'svc',
      pack: 'test/pack',
      type: 'fixture/service',
      inputs: {},
      params: {},
      build,
    });
    const graph: Graph = {
      root: { id: 'root', node: svc },
      nodes: [{ id: 'root', node: svc }],
      edges: [],
    };
    expect(() => targetNodeOf(graph)).toThrow(/carries no targetModule/);
  });

  test('the returned node loadTarget() surfaces a friendly resolution error, not a raw one', async () => {
    const graph = graphWithTargetModules(['@prisma/does-not-exist/target']);
    const { node } = targetNodeOf(graph);
    await expect(node.loadTarget()).rejects.toThrow(
      /Cannot resolve the target module "@prisma\/does-not-exist\/target".*must depend on the package/s,
    );
  });
});

describe('extractFromEnv() — the target module must export fromEnv()', () => {
  test('returns the export when present', () => {
    const fakeTarget = { name: 'fake-target' };
    const fromEnv = extractFromEnv('@fake/pack/target', { fromEnv: () => fakeTarget });
    expect(fromEnv()).toBe(fakeTarget);
  });

  test('throws naming the specifier and the expected export when fromEnv is missing', () => {
    expect(() => extractFromEnv('@fake/pack/target', {})).toThrow(
      /"@fake\/pack\/target" has no fromEnv\(\) export/,
    );
  });

  test('throws the same way when the module has no exports at all', () => {
    expect(() => extractFromEnv('@fake/pack/target', null)).toThrow(/has no fromEnv\(\) export/);
  });
});
