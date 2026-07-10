import { describe, expect, test } from 'bun:test';
import type { Graph } from '@prisma/app';
import { resource, service } from '@prisma/app';
import {
  collectTargetModules,
  extractFromEnv,
  inferTarget,
  resolveSingleTargetModule,
} from '../infer-target.ts';

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

describe('collectTargetModules() + resolveSingleTargetModule() (ADR-0003)', () => {
  test('collects the distinct targetModule across service and resource nodes', () => {
    const graph = graphWithTargetModules(['@prisma/app-cloud/target', '@prisma/app-cloud/target']);
    expect(collectTargetModules(graph)).toEqual(['@prisma/app-cloud/target']);
    expect(resolveSingleTargetModule(collectTargetModules(graph))).toBe('@prisma/app-cloud/target');
  });

  test('includes resource-node targetModules too', () => {
    const svc = service({
      name: 'svc',
      pack: 'test/pack',
      type: 'fixture/service',
      inputs: {},
      params: {},
      build,
      targetModule: '@prisma/app-cloud/target',
    });
    const res = resource({
      name: 'res',
      pack: '@other/pack',
      provides: {
        kind: 'fixture/resource',
        __cmp: {},
        satisfies: () => true,
      },
      targetModule: '@other/pack/target',
    });
    const graph: Graph = {
      root: { id: 'root', node: svc },
      nodes: [
        { id: 'root', node: svc },
        { id: 'root.db', node: res },
      ],
      edges: [],
    };
    expect(collectTargetModules(graph)).toEqual(['@other/pack/target', '@prisma/app-cloud/target']);
  });

  test('a service or resource with no targetModule contributes nothing', () => {
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
    expect(collectTargetModules(graph)).toEqual([]);
  });

  test('throws listing every targetModule found when a graph mixes more than one', () => {
    const graph = graphWithTargetModules(['@prisma/app-cloud/target', '@other/pack/target']);
    expect(() => resolveSingleTargetModule(collectTargetModules(graph))).toThrow(
      /mixes more than one deploy target \(@other\/pack\/target, @prisma\/app-cloud\/target\)/,
    );
  });

  test('throws when the graph carries no targetModule at all', () => {
    expect(() => resolveSingleTargetModule([])).toThrow(/carries no targetModule/);
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

describe('inferTarget() — an unresolvable targetModule (node-owned loading)', () => {
  test('surfaces an error naming the specifier and the fix, not a raw module error', async () => {
    const graph = graphWithTargetModules(['@prisma/does-not-exist/target']);

    await expect(inferTarget(graph)).rejects.toThrow(
      /Cannot resolve the target module "@prisma\/does-not-exist\/target".*must depend on the package/s,
    );
  });
});
