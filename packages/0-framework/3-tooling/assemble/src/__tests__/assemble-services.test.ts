import { describe, expect, test } from 'bun:test';
import type { ServiceNode } from '@internal/core';
import { Load, module, service } from '@internal/core';
import type { PrismaAppConfig } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import { AssembleError } from '../assemble-error.ts';
import { type AssembleEvent, assembleServices } from '../assemble-services.ts';

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

  test('each service reports its start and end, carrying what its build descriptor reported', async () => {
    const config: PrismaAppConfig = {
      extensions: [
        {
          id: '@community/adapter',
          nodes: {
            loud: {
              kind: 'build',
              assemble: async (input) => {
                input.report?.({ strategy: 'copy', files: 3 });
                return { dir: '/bundles/loud', entry: 'x' };
              },
            },
            quiet: { kind: 'build', assemble: async () => ({ dir: '/bundles/quiet', entry: 'x' }) },
          },
        },
      ],
      state: emptyConfig.state,
    };
    const root = module('fixture-module', {}, ({ provision }) => {
      provision(makeService('loud', { extension: '@community/adapter', type: 'loud' }), {
        id: 'loud',
      });
      provision(makeService('quiet', { extension: '@community/adapter', type: 'quiet' }), {
        id: 'quiet',
      });
      return {};
    });
    const events: AssembleEvent[] = [];

    await assembleServices(Load(root), config, CWD, undefined, (event) => events.push(event));

    expect(events).toEqual([
      { kind: 'service-started', address: 'loud' },
      { kind: 'service-assembled', address: 'loud', data: { strategy: 'copy', files: 3 } },
      { kind: 'service-started', address: 'quiet' },
      { kind: 'service-assembled', address: 'quiet', data: {} },
    ]);
  });

  test("a build whose extension isn't configured throws AssembleError naming it and the config fix", async () => {
    const root = module('fixture-module', {}, ({ provision }) => {
      provision(makeService('svc'), { id: 'svc' });
      return {};
    });
    const graph = Load(root);

    const error: unknown = await assembleServices(graph, emptyConfig, CWD).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AssembleError);
    if (!(error instanceof AssembleError)) throw new Error('unreachable');
    expect(error.code).toBe('ASSEMBLE.EXTENSION_MISSING');
    expect(error.message).toMatch(/No extension "@fixture\/node-adapter" is configured/);
    expect(error.fix).toBe('Add it to `extensions` in the `composer` section of prisma.config.ts.');
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

    const error: unknown = await assembleServices(graph, config, CWD).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AssembleError);
    if (!(error instanceof AssembleError)) throw new Error('unreachable');
    expect(error.code).toBe('ASSEMBLE.DESCRIPTOR_KIND_MISMATCH');
    expect(error.message).toMatch(/is a "resource" descriptor/);
    expect(error.why).toContain('needs a "build" descriptor');
  });

  test('a rejecting RunAssembler is structured as ASSEMBLE.BUILD_FAILED carrying the address and the cause', async () => {
    const cause = new Error('no built entry at /some/dist/server.js');
    const failingRun = async () => {
      throw cause;
    };
    const root = module('fixture-module', {}, ({ provision }) => {
      provision(makeService('auth'), { id: 'auth' });
      return {};
    });
    const graph = Load(root);

    const error: unknown = await assembleServices(graph, emptyConfig, CWD, failingRun).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AssembleError);
    if (!(error instanceof AssembleError)) throw new Error('unreachable');
    expect(error.code).toBe('ASSEMBLE.BUILD_FAILED');
    expect(error.message).toBe('no built entry at /some/dist/server.js');
    expect(error.meta).toEqual({ address: 'auth' });
    expect(error.cause).toBe(cause);
  });

  test('a RunAssembler throwing an already-structured error passes it through unwrapped', async () => {
    const structured = new AssembleError('ASSEMBLE.BUILD_FAILED', 'already structured', {
      meta: { address: 'auth' },
    });
    const failingRun = async () => {
      throw structured;
    };
    const root = module('fixture-module', {}, ({ provision }) => {
      provision(makeService('auth'), { id: 'auth' });
      return {};
    });
    const graph = Load(root);

    const error: unknown = await assembleServices(graph, emptyConfig, CWD, failingRun).catch(
      (e: unknown) => e,
    );

    expect(error).toBe(structured);
  });
});

describe('assembleServices({ devServers }) (ADR-0056)', () => {
  const server = { cwd: '/app/web', argv: () => ['next', 'dev'], display: 'next dev' };
  const devConfig = (serve: () => Promise<typeof server | undefined>): PrismaAppConfig => ({
    extensions: [
      {
        id: '@community/adapter',
        nodes: {
          web: {
            kind: 'build',
            assemble: async () => ({ dir: '/bundles/web', entry: 'x' }),
            serve,
          },
          api: { kind: 'build', assemble: async () => ({ dir: '/bundles/api', entry: 'x' }) },
        },
      },
    ],
    state: emptyConfig.state,
  });
  const root = () =>
    module('fixture-module', {}, ({ provision }) => {
      provision(makeService('web', { extension: '@community/adapter', type: 'web' }), {
        id: 'web',
      });
      provision(makeService('api', { extension: '@community/adapter', type: 'api' }), {
        id: 'api',
      });
      return {};
    });

  test('a service whose descriptor declares a dev server is recorded and not assembled', async () => {
    const events: AssembleEvent[] = [];

    const assembled = await assembleServices(
      Load(root()),
      devConfig(async () => server),
      CWD,
      undefined,
      (event) => events.push(event),
      { devServers: true },
    );

    expect(assembled.devServers).toEqual({ web: server });
    expect(Object.keys(assembled.bundles)).toEqual(['api']);
    expect(events.map((e) => `${e.kind}:${e.address}`)).toEqual([
      'service-started:api',
      'service-assembled:api',
    ]);
  });

  test('a serve step returning undefined assembles the service as before', async () => {
    const assembled = await assembleServices(
      Load(root()),
      devConfig(async () => undefined),
      CWD,
      undefined,
      undefined,
      { devServers: true },
    );

    expect(assembled.devServers).toEqual({});
    expect(Object.keys(assembled.bundles).sort()).toEqual(['api', 'web']);
  });

  test('without devServers every service is assembled and serve is never asked', async () => {
    let asked = false;
    const assembled = await assembleServices(
      Load(root()),
      devConfig(async () => {
        asked = true;
        return server;
      }),
      CWD,
    );

    expect(asked).toBe(false);
    expect(assembled.devServers).toEqual({});
    expect(Object.keys(assembled.bundles).sort()).toEqual(['api', 'web']);
  });

  test('a serve step that throws is DEV.DEV_SERVER_UNAVAILABLE naming the address and the message', async () => {
    const error = await assembleServices(
      Load(root()),
      devConfig(async () => {
        throw new Error('cannot find the `next` package from /app/web');
      }),
      CWD,
      undefined,
      undefined,
      { devServers: true },
    ).catch((e: unknown) => e);

    expect(CliStructuredError.is(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'DEV.DEV_SERVER_UNAVAILABLE',
      message:
        'service "web" cannot run its dev server: cannot find the `next` package from /app/web',
      meta: { address: 'web' },
    });
  });
});
