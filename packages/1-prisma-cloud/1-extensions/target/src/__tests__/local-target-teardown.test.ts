import { beforeEach, expect, mock, test } from 'bun:test';
import * as RealDevEmulators from '@internal/dev-emulators';
import * as RealLocalTarget from '@internal/local-target';
import { PrismaCloudContainer } from '../container.ts';

const events: string[] = [];
let computeDeleteFails = false;

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
      if (computeDeleteFails) throw new Error('compute delete failed');
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
  computeDeleteFails = false;
});

test('starts the compute emulator before deleting the app from it, so a stopped emulator still forgets the old ports', async () => {
  await runDevTeardown({ container, stage: undefined });

  expect(events).toEqual(['daemon compute', 'delete compute my-app', 'remove local paths']);
});

test('a failed compute delete still removes the local state, then fails the teardown', async () => {
  computeDeleteFails = true;

  await expect(runDevTeardown({ container, stage: undefined })).rejects.toThrow(
    'compute delete failed',
  );
  expect(events).toEqual(['daemon compute', 'delete compute my-app', 'remove local paths']);
});
