import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { Contract } from '@internal/core';
import { dependency, Load, module, string } from '@internal/core';
import type { ContainerInstance } from '@internal/core/config';
import * as RealDevEmulators from '@internal/dev-emulators';
import * as RealLocalTarget from '@internal/local-target';
import { compute, rawPostgres } from '../exports/index.ts';
import { scopedFakes } from './scoped-fakes.ts';

const events: string[] = [];
let portChanges: {
  kind: 'service' | 'database';
  address: string;
  previous: number;
  given: number;
}[] = [];
let previousApp: string | undefined;
let ensureFails = false;

const fake = scopedFakes();

mock.module('@internal/dev-emulators', () => ({
  ...RealDevEmulators,
  ensureDaemon: fake(RealDevEmulators.ensureDaemon, async (name: string) => {
    events.push(`daemon ${name}`);
    return { url: `http://127.0.0.1/${name}` };
  }),
}));

mock.module('@internal/local-target', () => ({
  ...RealLocalTarget,
  resolvePackageEntry: fake(RealLocalTarget.resolvePackageEntry, (specifier: string) => specifier),
  selectApp: fake(RealLocalTarget.selectApp, async ({ app }: { app: string }) => {
    events.push(`select ${app}`);
    return previousApp;
  }),
  ensureAppInstances: fake(
    RealLocalTarget.ensureAppInstances,
    async ({ app }: { app: string }, nodes: readonly { address: string; kind: string }[]) => {
      events.push(`ensure ${app}: ${nodes.map((n) => `${n.kind} ${n.address}`).join(', ')}`);
      if (ensureFails) throw new Error('the second database could not start');
      return portChanges;
    },
  ),
  stopAppInstances: fake(RealLocalTarget.stopAppInstances, async ({ app }: { app: string }) => {
    events.push(`stop ${app}`);
  }),
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
  previousApp = undefined;
  ensureFails = false;
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

  expect(events).toEqual([
    'daemon compute',
    'select my-app',
    'ensure my-app: service quotes, service gateway',
  ]);
});

test('ensures services and databases in declaration order when nothing orders them, after starting their emulators', async () => {
  const graph = Load(
    module('my-app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, build }));
      provision(rawPostgres({ name: 'db' }), { id: 'db' });
      provision(compute({ name: 'admin', deps: {}, build }));
    }),
  );

  await runDevEmulators({ graph, container, devDir: '/dev/null/unused' });

  expect(events).toEqual([
    'daemon compute',
    'daemon postgres',
    'select my-app',
    'ensure my-app: service web, database db, service admin',
  ]);
});

test('prints one line for each service that could not get its remembered port back', async () => {
  portChanges = [
    { kind: 'service', address: 'gateway', previous: 3001, given: 3004 },
    { kind: 'database', address: 'db', previous: 51300, given: 51301 },
  ];
  const graph = Load(
    module('my-app', ({ provision }) => {
      provision(compute({ name: 'gateway', deps: {}, build }));
    }),
  );

  await runDevEmulators({ graph, container, devDir: '/dev/null/unused' });

  expect(logged.filter((line) => line.includes('port'))).toEqual([
    '[dev] service "gateway" now uses port 3004: its previous port 3001 is in use',
    '[dev] database "db" now uses port 51301: its previous port 51300 is in use',
  ]);
});

test("prints one line when the directory's previous app's local services were stopped", async () => {
  previousApp = 'old-app';
  const graph = Load(
    module('my-app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, build }));
    }),
  );

  await runDevEmulators({ graph, container, devDir: '/dev/null/unused' });

  expect(logged.filter((line) => line.includes('stopped'))).toEqual([
    '[dev] stopped the local services of "old-app", the app run here before; its data is kept',
  ]);
});

test('a failure ensuring the instances stops what the run started, then reports the failure', async () => {
  ensureFails = true;
  const graph = Load(
    module('my-app', ({ provision }) => {
      provision(rawPostgres({ name: 'one' }), { id: 'one' });
      provision(rawPostgres({ name: 'two' }), { id: 'two' });
    }),
  );

  await expect(runDevEmulators({ graph, container, devDir: '/dev/null/unused' })).rejects.toThrow(
    'the second database could not start',
  );
  expect(events.slice(-2)).toEqual(['ensure my-app: database one, database two', 'stop my-app']);
});
