import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Graph } from '@makerkit/core';
import { hex, Load, service } from '@makerkit/core';
import { AssembleError } from '../assemble-error.ts';
import { assembleServices } from '../assemble-services.ts';

const moduleUrl = (dir: string) => pathToFileURL(path.join(dir, 'service.ts')).href;

const fakeRun = async (_pack: string, input: { build: { module: string } }) => ({
  dir: path.join(path.dirname(input.build.module.replace('file://', '')), 'dist', 'bundle'),
  entry: 'server.js',
});

describe('assembleServices()', () => {
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
        build: {
          kind: 'node',
          pack: '@fixture/node-adapter',
          module: moduleUrl(dir),
          entry: 'server.js',
        },
      });
    const root = hex('fixture-hex', (h) => {
      h.provision('auth', makeService('auth', dirOne));
      h.provision('storefront', makeService('storefront', dirTwo));
    });
    const graph: Graph = Load(root);

    const assembled = await assembleServices(graph, '/fixtures/entry.ts', fakeRun);

    expect(assembled.bundles).toEqual({
      auth: { dir: path.join(dirOne, 'dist', 'bundle'), entry: 'server.js' },
      storefront: { dir: path.join(dirTwo, 'dist', 'bundle'), entry: 'server.js' },
    });
  });

  test('a hex with no provisioned services throws AssembleError', async () => {
    const root = hex('empty-hex', () => {});
    const graph: Graph = Load(root);

    await expect(assembleServices(graph, '/fixtures/entry.ts', fakeRun)).rejects.toThrow(
      AssembleError,
    );
  });

  test('routes by the build adapter’s own `pack` field — not a hardcoded kind map (W05/A1)', async () => {
    const dir = '/fixtures/svc';
    const makeService = () =>
      service({
        name: 'svc',
        pack: 'test/pack',
        type: 'fixture/service',
        inputs: {},
        params: {},
        // A made-up kind a community adapter could use — nothing in this
        // package recognizes "cron" specially; the pack field alone routes it.
        build: {
          kind: 'cron',
          pack: '@community/cron-adapter',
          module: moduleUrl(dir),
          entry: 'x',
        },
      });
    const root = hex('fixture-hex', (h) => {
      h.provision('svc', makeService());
    });
    const graph = Load(root);
    const seenPacks: string[] = [];

    await assembleServices(graph, '/fixtures/entry.ts', async (pack, input) => {
      seenPacks.push(pack);
      return fakeRun(pack, input);
    });

    expect(seenPacks).toEqual(['@community/cron-adapter']);
  });
});
