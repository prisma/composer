import { describe, expect, test } from 'bun:test';
import type { ServiceNode } from '@prisma/app';
import { hex, Load, service } from '@prisma/app';
import { AssembleError } from '../assemble-error.ts';
import { assembleServices } from '../assemble-services.ts';

const fakeRun = async (node: ServiceNode) => ({
  dir: `/bundles/${node.name}`,
  entry: 'server.js',
});

describe('assembleServices()', () => {
  test('a hex root produces `bundles` keyed by each service’s full hierarchical address', async () => {
    const makeService = (name: string) =>
      service({
        name,
        pack: 'test/pack',
        type: 'fixture/service',
        inputs: {},
        params: {},
        build: {
          kind: 'node',
          assembler: '@fixture/node-adapter/assemble',
          module: 'file:///fixtures/service.ts',
          entry: 'server.js',
        },
      });
    const root = hex('fixture-hex', {}, ({ provision }) => {
      provision('auth', makeService('auth'));
      provision('storefront', makeService('storefront'));
      return {};
    });
    const graph = Load(root);

    const assembled = await assembleServices(graph, fakeRun);

    expect(assembled.bundles).toEqual({
      auth: { dir: '/bundles/auth', entry: 'server.js' },
      storefront: { dir: '/bundles/storefront', entry: 'server.js' },
    });
  });

  test('a hex with no provisioned services throws AssembleError', async () => {
    const root = hex('empty-hex', {}, () => ({}));
    const graph = Load(root);

    await expect(assembleServices(graph, fakeRun)).rejects.toThrow(AssembleError);
  });

  test('the default RunAssembler calls each node’s own assemble() — no hardcoded kind/pack routing here', async () => {
    // A made-up kind + assembler a community adapter could use — nothing in
    // this package recognizes either specially; assembleServices() never
    // constructs a specifier or reads `build.kind` itself, only the node's
    // own assemble() (@prisma/app) does. The assembler isn't installed
    // here, so the node's real assemble() rejects — but naming exactly this
    // specifier proves assembleServices() reached the node's own method
    // rather than some other resolution path.
    const root = hex('fixture-hex', {}, ({ provision }) => {
      provision(
        'svc',
        service({
          name: 'svc',
          pack: 'test/pack',
          type: 'fixture/service',
          inputs: {},
          params: {},
          build: {
            kind: 'cron',
            assembler: '@community/cron-adapter/assemble',
            module: 'file:///fixtures/svc.ts',
            entry: 'x',
          },
        }),
      );
      return {};
    });
    const graph = Load(root);

    await expect(assembleServices(graph)).rejects.toThrow(
      /Cannot resolve the build assembler "@community\/cron-adapter\/assemble"/,
    );
  });
});
