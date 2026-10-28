import { beforeEach, expect, mock, test } from 'bun:test';
import * as RealDevEmulators from '@internal/dev-emulators';
import * as RealLocalTarget from '@internal/local-target';
import { PrismaCloudContainer } from '../container.ts';
import { scopedFakes } from './scoped-fakes.ts';

const events: string[] = [];
let deleteFails = false;

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
  recordedKinds: fake(
    RealLocalTarget.recordedKinds,
    async () => new Set(['service', 'database'] as const),
  ),
  deleteAppInstances: fake(RealLocalTarget.deleteAppInstances, async ({ app }: { app: string }) => {
    events.push(`delete instances of ${app}`);
    if (deleteFails) throw new Error('delete failed');
  }),
  removeAppDevState: fake(RealLocalTarget.removeAppDevState, (_devDir: string, app: string) => {
    events.push(`remove dev state of ${app}`);
  }),
  removeLocalPaths: fake(RealLocalTarget.removeLocalPaths, () => {
    events.push('remove local paths');
  }),
}));

const { runDevTeardown } = await import('../local-target/teardown.ts');

const container = new PrismaCloudContainer(
  { appName: 'my-app', environment: 'dev' },
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
  await runDevTeardown({ container, environment: 'dev' });

  expect(events).toEqual([
    'daemon compute',
    'daemon postgres',
    'delete instances of my-app',
    ...removalEvents,
  ]);
});

test('a failed delete still removes the local state, then fails the teardown', async () => {
  deleteFails = true;

  await expect(runDevTeardown({ container, environment: 'dev' })).rejects.toThrow('delete failed');
  expect(events).toEqual([
    'daemon compute',
    'daemon postgres',
    'delete instances of my-app',
    ...removalEvents,
  ]);
});
