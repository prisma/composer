import { describe, expect, test } from 'bun:test';
import type { ServiceNode } from '@prisma/app';
import { Load, service, system } from '@prisma/app';
import type { PrismaAppConfig } from '@prisma/app/config';
import { AssembleError } from '../assemble-error.ts';
import { assembleServices } from '../assemble-services.ts';

const fakeRun = async (node: ServiceNode) => ({
  dir: `/bundles/${node.name}`,
  entry: 'server.js',
});

const emptyConfig: PrismaAppConfig = {
  extensions: [],
  state: () => {
    throw new Error('state() must not be called by assembleServices()');
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
  test('a system root produces `bundles` keyed by each service’s full hierarchical address', async () => {
    const root = system('fixture-system', {}, ({ provision }) => {
      provision('auth', makeService('auth'));
      provision('storefront', makeService('storefront'));
      return {};
    });
    const graph = Load(root);

    const assembled = await assembleServices(graph, emptyConfig, fakeRun);

    expect(assembled.bundles).toEqual({
      auth: { dir: '/bundles/auth', entry: 'server.js' },
      storefront: { dir: '/bundles/storefront', entry: 'server.js' },
    });
  });

  test('a service provisioned by a NESTED system keys its bundle by the dotted address (H1)', async () => {
    const inner = system('auth', {}, ({ provision }) => {
      provision('api', makeService('auth-api'));
      return {};
    });
    const root = system('shop', {}, ({ provision }) => {
      provision('auth', inner);
      return {};
    });
    const graph = Load(root);

    const assembled = await assembleServices(graph, emptyConfig, fakeRun);

    expect(Object.keys(assembled.bundles)).toEqual(['auth.api']);
  });

  test('a system with no provisioned services throws AssembleError', async () => {
    const root = system('empty-system', {}, () => ({}));
    const graph = Load(root);

    await expect(assembleServices(graph, emptyConfig, fakeRun)).rejects.toThrow(AssembleError);
  });

  test("the default RunAssembler routes through the config's build control — (build.extension, build.type), any community id", async () => {
    // A made-up extension + type a community build adapter could use —
    // nothing in this package recognizes either specially; the registry the
    // config carries is the whole routing table.
    const seen: string[] = [];
    const config: PrismaAppConfig = {
      extensions: [
        {
          id: '@community/cron-adapter',
          nodes: {
            cron: {
              kind: 'build',
              assemble: async (input) => {
                seen.push(input.build.type);
                return { dir: '/bundles/cron', entry: input.build.entry };
              },
            },
          },
        },
      ],
      state: emptyConfig.state,
    };
    const root = system('fixture-system', {}, ({ provision }) => {
      provision(
        'svc',
        makeService('svc', { extension: '@community/cron-adapter', type: 'cron', entry: 'x' }),
      );
      return {};
    });
    const graph = Load(root);

    const assembled = await assembleServices(graph, config);

    expect(seen).toEqual(['cron']);
    expect(assembled.bundles['svc']).toEqual({ dir: '/bundles/cron', entry: 'x' });
  });

  test("a build whose extension isn't configured throws AssembleError naming it and the config fix", async () => {
    const root = system('fixture-system', {}, ({ provision }) => {
      provision('svc', makeService('svc'));
      return {};
    });
    const graph = Load(root);

    await expect(assembleServices(graph, emptyConfig)).rejects.toThrow(
      /No extension "@fixture\/node-adapter" is configured .*prisma-app\.config\.ts/,
    );
  });

  test('a build routed to a non-build control throws AssembleError naming the kinds', async () => {
    const resourceControl = Object.assign(
      () => {
        throw new Error('control body must not run');
      },
      { kind: 'resource' as const },
    );
    const config: PrismaAppConfig = {
      extensions: [{ id: '@fixture/node-adapter', nodes: { node: resourceControl } }],
      state: emptyConfig.state,
    };
    const root = system('fixture-system', {}, ({ provision }) => {
      provision('svc', makeService('svc'));
      return {};
    });
    const graph = Load(root);

    await expect(assembleServices(graph, config)).rejects.toThrow(
      /is a "resource" control — a service build descriptor needs a "build" control/,
    );
  });
});
