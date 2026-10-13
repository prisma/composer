import { beforeEach, expect, mock, test } from 'bun:test';
import type { Contract } from '@internal/core';
import { dependency, Load, module, string } from '@internal/core';
import type { ContainerInstance } from '@internal/core/config';
import * as RealDevEmulators from '@internal/dev-emulators';
import * as RealLocalTarget from '@internal/local-target';
import { compute, rawPostgres } from '../exports/index.ts';

const events: string[] = [];

mock.module('@internal/dev-emulators', () => ({
  ...RealDevEmulators,
  ensureDaemon: async (name: string) => {
    events.push(`daemon ${name}`);
    return { url: `http://127.0.0.1/${name}` };
  },
}));

mock.module('@internal/local-target', () => ({
  ...RealLocalTarget,
  resolvePackageEntry: (specifier: string) => specifier,
  reserveServicePorts: async (
    container: ContainerInstance | undefined,
    addresses: readonly string[],
  ) => {
    events.push(`reserve ${container?.input.appName ?? '?'}: ${addresses.join(', ')}`);
  },
}));

const { runDevEmulators } = await import('../local-target/emulators.ts');

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const quotesContract: Contract<'rpc', Record<never, never>> = {
  kind: 'rpc',
  __cmp: {},
  satisfies: () => true,
};

const rpcDep = () =>
  dependency({
    type: 'rpc',
    connection: { params: { url: string() }, hydrate: (v) => v },
  });

const container: ContainerInstance = {
  input: { appName: 'my-app', stage: undefined },
  serialize: () => 'x',
};

beforeEach(() => {
  events.length = 0;
});

test('reserves the getting-started services in dependency order once the compute emulator is up', async () => {
  const graph = Load(
    module('my-app', ({ provision }) => {
      const quotes = provision(
        compute({ name: 'quotes', deps: {}, build, expose: { rpc: quotesContract } }),
      );
      provision(compute({ name: 'gateway', deps: { quotes: rpcDep() }, build }), {
        deps: { quotes: quotes.rpc },
      });
    }),
  );

  await runDevEmulators({ graph, container, devDir: '/dev/null/unused' });

  expect(events).toEqual(['daemon compute', 'reserve my-app: quotes, gateway']);
});

test('reserves only services, in declaration order when nothing orders them', async () => {
  const graph = Load(
    module('my-app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, build }));
      provision(rawPostgres({ name: 'db' }), { id: 'db' });
      provision(compute({ name: 'admin', deps: {}, build }));
    }),
  );

  await runDevEmulators({ graph, container, devDir: '/dev/null/unused' });

  expect(events).toEqual(['daemon compute', 'reserve my-app: web, admin', 'daemon postgres']);
});
