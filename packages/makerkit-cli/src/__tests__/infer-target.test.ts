import { describe, expect, test } from 'bun:test';
import type { Graph } from '@makerkit/core';
import { resource, service } from '@makerkit/core';
import { collectPacks, extractFromEnv, resolveSinglePack } from '../infer-target.ts';

const build = { kind: 'node', module: 'file:///test/service.ts', entry: 'server.js' } as const;

function graphWithPacks(packs: readonly string[]): Graph {
  const nodes = packs.map((pack, i) => ({
    id: `svc-${i}`,
    node: service({
      name: `svc-${i}`,
      pack,
      type: 'fixture/service',
      inputs: {},
      params: {},
      build,
    }),
  }));
  const root = nodes[0];
  if (root === undefined) throw new Error('graphWithPacks needs at least one pack');
  return { root, nodes, edges: [] };
}

describe('collectPacks() + resolveSinglePack() (ADR-0003)', () => {
  test('collects the distinct pack across service and resource nodes', () => {
    const graph = graphWithPacks(['@makerkit/prisma-cloud', '@makerkit/prisma-cloud']);
    expect(collectPacks(graph)).toEqual(['@makerkit/prisma-cloud']);
    expect(resolveSinglePack(collectPacks(graph))).toBe('@makerkit/prisma-cloud');
  });

  test('includes resource-node packs too', () => {
    const svc = service({
      name: 'svc',
      pack: '@makerkit/prisma-cloud',
      type: 'fixture/service',
      inputs: {},
      params: {},
      build,
    });
    const res = resource({
      name: 'res',
      pack: '@other/pack',
      type: 'fixture/resource',
      connection: { params: {}, hydrate: () => ({}) },
    });
    const graph: Graph = {
      root: { id: 'root', node: svc },
      nodes: [
        { id: 'root', node: svc },
        { id: 'root.db', node: res },
      ],
      edges: [],
    };
    expect(collectPacks(graph)).toEqual(['@makerkit/prisma-cloud', '@other/pack']);
  });

  test('throws listing every pack found when a graph mixes more than one', () => {
    const graph = graphWithPacks(['@makerkit/prisma-cloud', '@other/pack']);
    expect(() => resolveSinglePack(collectPacks(graph))).toThrow(
      /mixes more than one pack \(@makerkit\/prisma-cloud, @other\/pack\)/,
    );
  });

  test('throws when the graph carries no pack at all', () => {
    expect(() => resolveSinglePack([])).toThrow(/carries no pack/);
  });
});

describe("extractFromEnv() — the pack's /target module must export fromEnv()", () => {
  test('returns the export when present', () => {
    const fakeTarget = { name: 'fake-target' };
    const fromEnv = extractFromEnv('@fake/pack', '@fake/pack/target', {
      fromEnv: () => fakeTarget,
    });
    expect(fromEnv()).toBe(fakeTarget);
  });

  test('throws naming the pack and the expected export when fromEnv is missing', () => {
    expect(() => extractFromEnv('@fake/pack', '@fake/pack/target', {})).toThrow(
      /Pack "@fake\/pack" has no fromEnv\(\) export at "@fake\/pack\/target"/,
    );
  });

  test('throws the same way when the module has no exports at all', () => {
    expect(() => extractFromEnv('@fake/pack', '@fake/pack/target', null)).toThrow(
      /has no fromEnv\(\) export/,
    );
  });
});
