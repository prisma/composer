import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Graph } from '@makerkit/core';
import { hex, Load, service } from '@makerkit/core';
import { assembleServices } from '../assemble-services.ts';

const moduleUrl = (dir: string) => pathToFileURL(path.join(dir, 'service.ts')).href;

const fakeRun = async (_specifier: string, input: { build: { module: string } }) => ({
  dir: path.join(path.dirname(input.build.module.replace('file://', '')), 'dist', 'bundle'),
  entry: 'server.js',
});

describe('assembleServices()', () => {
  test('a service root produces a single `bundle`', async () => {
    const dir = '/fixtures/svc';
    const root = service({
      name: 'svc',
      pack: 'test/pack',
      type: 'fixture/service',
      inputs: {},
      params: {},
      build: { kind: 'node', module: moduleUrl(dir), entry: 'server.js' },
    });
    const graph = Load(root);

    const assembled = await assembleServices(graph, false, '/fixtures/entry.ts', fakeRun);

    expect(assembled.bundle).toEqual({ dir: path.join(dir, 'dist', 'bundle'), entry: 'server.js' });
    expect(assembled.bundles).toBeUndefined();
  });

  test('a hex root produces `bundles` keyed by each service’s provision id', async () => {
    const dirOne = '/fixtures/auth';
    const dirTwo = '/fixtures/storefront';
    const makeService = (name: string, dir: string) =>
      service({
        name,
        pack: 'test/pack',
        type: 'fixture/service',
        inputs: {},
        params: {},
        build: { kind: 'node', module: moduleUrl(dir), entry: 'server.js' },
      });
    const root = hex('fixture-hex', (h) => {
      h.provision('auth', makeService('auth', dirOne));
      h.provision('storefront', makeService('storefront', dirTwo));
    });
    const graph: Graph = Load(root);

    const assembled = await assembleServices(graph, true, '/fixtures/entry.ts', fakeRun);

    expect(assembled.bundles).toEqual({
      auth: { dir: path.join(dirOne, 'dist', 'bundle'), entry: 'server.js' },
      storefront: { dir: path.join(dirTwo, 'dist', 'bundle'), entry: 'server.js' },
    });
    expect(assembled.bundle).toBeUndefined();
  });

  test('an unknown build adapter kind names the kind and the known kinds', async () => {
    const root = service({
      name: 'svc',
      pack: 'test/pack',
      type: 'fixture/service',
      inputs: {},
      params: {},
      build: { kind: 'deno', module: moduleUrl('/fixtures/svc'), entry: 'server.js' },
    });
    const graph = Load(root);

    await expect(assembleServices(graph, false, '/fixtures/entry.ts', fakeRun)).rejects.toThrow(
      /declares build kind "deno".*known kinds: nextjs, node/,
    );
  });
});
