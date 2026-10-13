/**
 * The app `prisma dev` last ran from a directory, read from the directory's
 * record alone: where each of its nodes runs, and stopping it. Behind
 * `prisma dev url` and `prisma dev stop`.
 */
import type {
  LocalNodeLocation,
  LocalNodeStopped,
  LocalTargetCurrentApp,
} from '@internal/core/config';
import {
  bucketsClient,
  computeClient,
  type EmulatorKind,
  isEmulatorRunning,
  postgresClient,
} from '@internal/dev-emulators';
import {
  directoryOf,
  type NodeInstance,
  readEmulatorInstances,
  stopAppInstances,
} from './emulator-instances.ts';

/** A node's state when its emulator no longer has the instance the record names. */
const MISSING = 'missing';

async function locate(address: string, node: NodeInstance): Promise<LocalNodeLocation> {
  const kind: EmulatorKind = node.kind;
  if (!(await isEmulatorRunning(kind))) return { address, kind, emulator: 'not-running' };
  if (node.kind === 'service') {
    const instance = await computeClient().getInstance(node.id);
    return instance
      ? { address, kind, emulator: 'running', url: instance.url, state: instance.status }
      : { address, kind, emulator: 'running', state: MISSING };
  }
  if (node.kind === 'database') {
    const instance = await postgresClient().getInstance(node.id);
    return instance
      ? { address, kind, emulator: 'running', url: instance.url, state: instance.status }
      : { address, kind, emulator: 'running', state: MISSING };
  }
  const client = bucketsClient();
  const instance = await client.getInstance(node.id);
  return instance
    ? { address, kind, emulator: 'running', url: `${client.baseUrl}/${node.id}`, state: 'running' }
    : { address, kind, emulator: 'running', state: MISSING };
}

/** The directory's current app; undefined when `prisma dev` never ran there. */
export async function currentApp(devDir: string): Promise<LocalTargetCurrentApp | undefined> {
  const record = await readEmulatorInstances(directoryOf(devDir));
  if (record === undefined) return undefined;
  const app = record.current;
  const nodes = record.apps[app]?.nodes ?? {};
  return {
    app,
    addresses: Object.keys(nodes),
    locate: async (address) => {
      const node = nodes[address];
      return node === undefined ? undefined : locate(address, node);
    },
    stop: async (): Promise<readonly LocalNodeStopped[]> => {
      await stopAppInstances({ devDir, app });
      return Object.entries(nodes).flatMap(([address, node]) =>
        node.kind === 'bucket' ? [] : [{ address, kind: node.kind }],
      );
    },
  };
}
