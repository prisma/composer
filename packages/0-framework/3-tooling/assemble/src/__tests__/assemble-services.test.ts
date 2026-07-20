import { describe, expect, test } from 'bun:test';
import type { ServiceNode } from '@internal/core';
import { Load, module, service } from '@internal/core';
import type { PrismaAppConfig } from '@internal/core/config';
import { AssembleError } from '../assemble-error.ts';
import { assembleServices } from '../assemble-services.ts';

const CWD = '/deploy-cwd';

const fakeRun = async (node: ServiceNode) => ({
  dir: `/bundles/${node.name}`,
  entry: 'server.js',
});

const emptyConfig: PrismaAppConfig = {
  extensions: [],
  state: {
    extension: 'test/pack',
    create: () => {
      throw new Error('state.create() must not be called by assembleServices()');
    },
  },
};

const makeService = (name: string, build: Partial<ServiceNode['build']> = {}) =>
  service({
    name,
    extension: 'test/pack',
    type: 'fixture/service',
    inputs: {},
    params: {},
    build: {
      extension: '@fixture/node-adapter',
      type: 'node',
      module: 'file:///fixtures/service.ts',
      entry: 'server.js',
      ...build,
    },
  });

describe('assembleServices()', () => {
  test('a module root produces `bundles` keyed by each service’s full hierarchical address', async () => {
    const root = module('fixture-module', {}, ({ provision }) => {
      provision(makeService('auth'), { id: 'auth' });
      provision(makeService('storefront'), { id: 'storefront' });
      return {};
    });
    const graph = Load(root);

    const assembled = await assembleServices(graph, emptyConfig, CWD, fakeRun);

    expect(assembled.bundles).toEqual({
      auth: { dir: '/bundles/auth', entry: 'server.js' },
      storefront: { dir: '/bundles/storefront', entry: 'server.js' },
    });
  });

  test('a service provisioned by a NESTED module keys its bundle by the dotted address (H1)', async () => {
    const inner = module('auth', {}, ({ provision }) => {
      provision(makeService('auth-api'), { id: 'api' });
      return {};
    });
    const root = module('shop', {}, ({ provision }) => {
      provision(inner, { id: 'auth' });
      return {};
    });
    const graph = Load(root);

    const assembled = await assembleServices(graph, emptyConfig, CWD, fakeRun);

    expect(Object.keys(assembled.bundles)).toEqual(['auth.api']);
  });

  test('a module with no provisioned services throws AssembleError', async () => {
    const root = module('empty-module', {}, () => ({}));
    const graph = Load(root);

    await expect(assembleServices(graph, emptyConfig, CWD, fakeRun)).rejects.toThrow(AssembleError);
  });

  test('the RunAssembler seam receives each service’s graph address and the deploy cwd', async () => {
    const seen: Array<{ address: string; cwd: string }> = [];
    const run = async (node: ServiceNode, address: string, cwd: string) => {
      seen.push({ address, cwd });
      return { dir: `/bundles/${node.name}`, entry: 'server.js' };
    };
    const root = module('fixture-module', {}, ({ provision }) => {
      provision(makeService('auth'), { id: 'auth' });
      return {};
    });
    const graph = Load(root);

    await assembleServices(graph, emptyConfig, CWD, run);

    expect(seen).toEqual([{ address: 'auth', cwd: CWD }]);
  });

  test("the default RunAssembler routes through the config's build descriptor — (build.extension, build.type), any community id — and forwards the address + cwd", async () => {
    // A made-up extension + type a community build adapter could use —
    // nothing in this package recognizes either specially; the registry the
    // config carries is the whole routing table.
    const seen: Array<{ type: string; address: string; cwd: string }> = [];
    const config: PrismaAppConfig = {
      extensions: [
        {
          id: '@community/cron-adapter',
          nodes: {
            cron: {
              kind: 'build',
              assemble: async (input) => {
                seen.push({ type: input.build.type, address: input.address, cwd: input.cwd });
                return { dir: '/bundles/cron', entry: input.build.entry };
              },
            },
          },
        },
      ],
      state: emptyConfig.state,
    };
    const root = module('fixture-module', {}, ({ provision }) => {
      provision(
        makeService('svc', { extension: '@community/cron-adapter', type: 'cron', entry: 'x' }),
        { id: 'svc' },
      );
      return {};
    });
    const graph = Load(root);

    const assembled = await assembleServices(graph, config, CWD);

    expect(seen).toEqual([{ type: 'cron', address: 'svc', cwd: CWD }]);
    expect(assembled.bundles['svc']).toEqual({ dir: '/bundles/cron', entry: 'x' });
  });

  test("a build whose extension isn't configured throws AssembleError naming it and the config fix", async () => {
    const root = module('fixture-module', {}, ({ provision }) => {
      provision(makeService('svc'), { id: 'svc' });
      return {};
    });
    const graph = Load(root);

    await expect(assembleServices(graph, emptyConfig, CWD)).rejects.toThrow(
      /No extension "@fixture\/node-adapter" is configured .*prisma-composer\.config\.ts/,
    );
  });

  test('a build routed to a non-build descriptor throws AssembleError naming the kinds', async () => {
    const resourceDescriptor = Object.assign(
      () => {
        throw new Error('descriptor body must not run');
      },
      { kind: 'resource' as const },
    );
    const config: PrismaAppConfig = {
      extensions: [{ id: '@fixture/node-adapter', nodes: { node: resourceDescriptor } }],
      state: emptyConfig.state,
    };
    const root = module('fixture-module', {}, ({ provision }) => {
      provision(makeService('svc'), { id: 'svc' });
      return {};
    });
    const graph = Load(root);

    await expect(assembleServices(graph, config, CWD)).rejects.toThrow(
      /is a "resource" descriptor — assembling a service build needs a "build" descriptor/,
    );
  });
});
