import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { Contract } from '@internal/core';
import { dependency, Load, module, string } from '@internal/core';
import type { ContainerInstance } from '@internal/core/config';
import * as RealDevEmulators from '@internal/dev-emulators';
import * as RealLocalTarget from '@internal/local-target';
import { compute, rawPostgres } from '../exports/index.ts';

const events: string[] = [];
let portChanges: { address: string; previous: number; given: number }[] = [];
let retiredApp: string | undefined;

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
  retirePreviousApp: async () => retiredApp,
  ensureServiceInstances: async (
    container: ContainerInstance | undefined,
    _devDir: string,
    addresses: readonly string[],
  ) => {
    events.push(`ensure ${container?.input.appName ?? '?'}: ${addresses.join(', ')}`);
    return portChanges;
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

const logged: string[] = [];
const consoleLog = spyOn(console, 'log').mockImplementation((line: unknown) => {
  logged.push(String(line));
});

beforeEach(() => {
  events.length = 0;
  logged.length = 0;
  portChanges = [];
  retiredApp = undefined;
});

afterEach(() => {
  consoleLog.mockClear();
});

test('ensures the getting-started services in dependency order once the compute emulator is up', async () => {
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

  expect(events).toEqual(['daemon compute', 'ensure my-app: quotes, gateway']);
});

test('ensures only services, in declaration order when nothing orders them', async () => {
  const graph = Load(
    module('my-app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, build }));
      provision(rawPostgres({ name: 'db' }), { id: 'db' });
      provision(compute({ name: 'admin', deps: {}, build }));
    }),
  );

  await runDevEmulators({ graph, container, devDir: '/dev/null/unused' });

  expect(events).toEqual(['daemon compute', 'ensure my-app: web, admin', 'daemon postgres']);
});

test('prints one line for each service that could not get its remembered port back', async () => {
  portChanges = [{ address: 'gateway', previous: 3001, given: 3004 }];
  const graph = Load(
    module('my-app', ({ provision }) => {
      provision(compute({ name: 'gateway', deps: {}, build }));
    }),
  );

  await runDevEmulators({ graph, container, devDir: '/dev/null/unused' });

  expect(logged.filter((line) => line.includes('port'))).toEqual([
    '[dev] service "gateway" now uses port 3004: its previous port 3001 is in use',
  ]);
});

test("prints one line when the directory's previous app's local services were removed", async () => {
  retiredApp = 'old-app';
  const graph = Load(
    module('my-app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, build }));
    }),
  );

  await runDevEmulators({ graph, container, devDir: '/dev/null/unused' });

  expect(logged.filter((line) => line.includes('removed'))).toEqual([
    '[dev] removed the local services of "old-app", the app run here before',
  ]);
});
