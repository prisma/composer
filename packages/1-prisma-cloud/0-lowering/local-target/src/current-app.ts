/**
 * An app's local copy in one environment, read from the environment's
 * record alone: where each of its nodes runs, and stopping it. Behind
 * `prisma dev url` and `prisma dev stop`.
 */
import type {
  LocalNodeCondition,
  LocalNodeLocation,
  LocalNodeStopped,
  LocalTargetCurrentApp,
  LocalTargetCurrentInput,
} from '@internal/core/config';
import {
  bucketsClient,
  computeClient,
  type EmulatorKind,
  isEmulatorRunning,
  postgresClient,
  type ServiceInstanceStatus,
} from '@internal/dev-emulators';
import {
  type NodeInstance,
  readEmulatorInstances,
  stopAppInstances,
} from './emulator-instances.ts';

const CONDITION_OF: Record<ServiceInstanceStatus, LocalNodeCondition> = {
  running: 'running',
  stopped: 'stopped',
  backoff: 'crashing',
  held: 'crashing',
};

/** A node whose emulator no longer has the instance the record names. */
function missing(address: string, kind: EmulatorKind): LocalNodeLocation {
  return { address, kind, emulator: 'running', state: 'missing', condition: 'missing' };
}

async function locate(address: string, node: NodeInstance): Promise<LocalNodeLocation> {
  const kind: EmulatorKind = node.kind;
  if (!(await isEmulatorRunning(kind))) return { address, kind, emulator: 'not-running' };
  if (node.kind === 'service') {
    const instance = await computeClient().getInstance(node.id);
    if (instance === undefined) return missing(address, kind);
    return {
      address,
      kind,
      emulator: 'running',
      url: instance.url,
      state: instance.status,
      condition: CONDITION_OF[instance.status],
      logPath: instance.logPath,
      ...(instance.command !== undefined ? { command: instance.command.argv } : {}),
    };
  }
  if (node.kind === 'database') {
    const instance = await postgresClient().getInstance(node.id);
    if (instance === undefined) return missing(address, kind);
    return {
      address,
      kind,
      emulator: 'running',
      url: instance.url,
      state: instance.status,
      condition: instance.status,
    };
  }
  const client = bucketsClient();
  if ((await client.getInstance(node.id)) === undefined) return missing(address, kind);
  return {
    address,
    kind,
    emulator: 'running',
    url: `${client.baseUrl}/${node.id}`,
    state: 'running',
    condition: 'running',
  };
}

/** The app's local copy in the environment; undefined when `prisma dev` never ran it there. */
export async function currentApp(
  input: LocalTargetCurrentInput,
): Promise<LocalTargetCurrentApp | undefined> {
  const { devDir, app, environment } = input;
  const nodes = (await readEmulatorInstances(devDir))?.apps[app]?.nodes;
  if (nodes === undefined) return undefined;
  return {
    app,
    addresses: Object.keys(nodes),
    locate: async (address) => {
      const node = nodes[address];
      return node === undefined ? undefined : locate(address, node);
    },
    stop: (): Promise<readonly LocalNodeStopped[]> =>
      stopAppInstances({ devDir, app, environment }),
  };
}
