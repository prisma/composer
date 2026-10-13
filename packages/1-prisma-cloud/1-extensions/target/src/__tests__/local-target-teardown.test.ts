import { beforeEach, expect, mock, test } from 'bun:test';
import * as RealDevEmulators from '@internal/dev-emulators';
import * as RealLocalTarget from '@internal/local-target';
import { PrismaCloudContainer } from '../container.ts';

const events: string[] = [];
let deleteFails = false;

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
  recordedKinds: async () => new Set(['compute', 'database']),
  deleteAppInstances: async ({ app }: { app: string }) => {
    events.push(`delete instances of ${app}`);
    if (deleteFails) throw new Error('delete failed');
  },
  removeAppDevState: (_devDir: string, app: string) => {
    events.push(`remove dev state of ${app}`);
  },
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
  deleteFails = false;
});

const removalEvents = ['remove dev state of my-app', 'remove local paths'];

test("starts the emulators holding the app's instances before deleting them, so a stopped emulator still forgets them", async () => {
  await runDevTeardown({ container, stage: undefined });

  expect(events).toEqual([
    'daemon compute',
    'daemon postgres',
    'delete instances of my-app',
    ...removalEvents,
  ]);
});

test('a failed delete still removes the local state, then fails the teardown', async () => {
  deleteFails = true;

  await expect(runDevTeardown({ container, stage: undefined })).rejects.toThrow('delete failed');
  expect(events).toEqual([
    'daemon compute',
    'daemon postgres',
    'delete instances of my-app',
    ...removalEvents,
  ]);
});
