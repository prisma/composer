import { beforeEach, expect, mock, test } from 'bun:test';
import * as RealDevEmulators from '@internal/dev-emulators';
import * as RealLocalTarget from '@internal/local-target';
import { PrismaCloudContainer } from '../container.ts';

const events: string[] = [];

const unreachable = (name: string) => () => ({
  deleteApp: async () => {
    throw new Error(`${name} emulator is not running`);
  },
});

mock.module('@internal/dev-emulators', () => ({
  ...RealDevEmulators,
  ensureDaemon: async (name: string) => {
    events.push(`daemon ${name}`);
    return { url: `http://127.0.0.1/${name}` };
  },
  computeClient: () => ({
    deleteApp: async (app: string) => {
      events.push(`delete compute ${app}`);
    },
  }),
  postgresClient: unreachable('postgres'),
  bucketsClient: unreachable('buckets'),
}));

mock.module('@internal/local-target', () => ({
  ...RealLocalTarget,
  resolvePackageEntry: (specifier: string) => specifier,
  removeLocalPaths: () => {
    events.push('remove local paths');
  },
}));

const { runDevTeardown } = await import('../local-target/teardown.ts');

const container = new PrismaCloudContainer(
  { appName: 'my-app', stage: undefined },
  'local',
  undefined,
  undefined,
  true,
);

beforeEach(() => {
  events.length = 0;
});

test('starts the compute emulator before deleting the app from it, so a stopped emulator still forgets the old ports', async () => {
  await runDevTeardown({ container, stage: undefined });

  expect(events).toEqual(['daemon compute', 'delete compute my-app', 'remove local paths']);
});
