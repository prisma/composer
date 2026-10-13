/**
 * Which emulator instance backs each node of the app run from a directory.
 * `prisma dev` records it in `<directory>/.prisma-composer/dev/`, and every
 * Composer operation on an emulator instance goes through it. The emulators
 * know nothing about Composer: the labels written on create are for people
 * reading an emulator listing, and nothing here reads them back.
 */
import * as path from 'node:path';
import { DEV_DIR } from '@internal/core/config';
import { computeClient, type InstanceInfo } from '@internal/dev-emulators';
import { createStore, type DevStore } from './dev-store.ts';

export const EMULATOR_INSTANCES_FILE = 'emulator-instances.json';

export interface ComputeNodeInstance {
  readonly kind: 'compute';
  readonly id: string;
  /** The port the instance was given, requested again if the instance has to be re-created. */
  readonly port: number;
}

export type NodeInstance = ComputeNodeInstance;

export interface EmulatorInstances {
  readonly app: string;
  /** Keyed by node address. */
  readonly nodes: Readonly<Record<string, NodeInstance>>;
}

/** The app run from the directory that holds `devDir` (`<directory>/.prisma-composer/dev`). */
export interface AppScope {
  readonly devDir: string;
  readonly app: string;
}

/** A service whose remembered port another instance or process now holds. */
export interface PortChange {
  readonly address: string;
  readonly previous: number;
  readonly given: number;
}

function isNodeInstance(value: unknown): value is NodeInstance {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'compute' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'port' in value &&
    typeof value.port === 'number'
  );
}

function isEmulatorInstances(value: unknown): value is EmulatorInstances {
  return (
    typeof value === 'object' &&
    value !== null &&
    'app' in value &&
    typeof value.app === 'string' &&
    'nodes' in value &&
    typeof value.nodes === 'object' &&
    value.nodes !== null &&
    Object.values(value.nodes).every(isNodeInstance)
  );
}

function directoryOf(devDir: string): string {
  const normalized = path.normalize(devDir);
  return normalized.endsWith(DEV_DIR) ? normalized.slice(0, -DEV_DIR.length - 1) : normalized;
}

function store(devDir: string): DevStore<EmulatorInstances | undefined> {
  return createStore(path.join(devDir, EMULATOR_INSTANCES_FILE), isEmulatorInstances, undefined);
}

/** The record `prisma dev` left in `directory`; undefined when it has not run there. */
export function readEmulatorInstances(directory: string): Promise<EmulatorInstances | undefined> {
  return store(path.join(directory, DEV_DIR)).read();
}

/** This app's nodes. A record left by another app run from the same directory counts as empty. */
async function appNodes(scope: AppScope): Promise<Readonly<Record<string, NodeInstance>>> {
  const current = await store(scope.devDir).read();
  return current?.app === scope.app ? current.nodes : {};
}

async function updateNodes(
  scope: AppScope,
  mutate: (nodes: Record<string, NodeInstance>) => void,
): Promise<void> {
  await store(scope.devDir).update((current) => {
    const nodes = { ...(current?.app === scope.app ? current.nodes : {}) };
    mutate(nodes);
    return { app: scope.app, nodes };
  });
}

/** Each compute node of the app, with the instance that backs it. */
export async function computeNodeInstances(
  scope: AppScope,
): Promise<{ readonly address: string; readonly instance: ComputeNodeInstance }[]> {
  return Object.entries(await appNodes(scope)).map(([address, instance]) => ({
    address,
    instance,
  }));
}

/** The compute instance recorded for `address`; undefined when there is none. */
export async function mappedComputeInstance(
  scope: AppScope,
  address: string,
): Promise<ComputeNodeInstance | undefined> {
  return (await appNodes(scope))[address];
}

/**
 * The instance that runs the service at `address`. The recorded instance is
 * reused while the Compute emulator still has it. Otherwise a new one is
 * created, requesting the recorded port, and recorded.
 */
export async function ensureComputeInstance(
  scope: AppScope,
  address: string,
): Promise<{ readonly instance: ComputeNodeInstance; readonly portChange?: PortChange }> {
  const client = computeClient();
  const recorded = await mappedComputeInstance(scope, address);
  if (recorded && (await client.getInstance(recorded.id))) return { instance: recorded };

  const created = await client.createInstance({
    labels: {
      'composer.directory': directoryOf(scope.devDir),
      'composer.app': scope.app,
      'composer.address': address,
    },
    ...(recorded ? { port: recorded.port } : {}),
  });
  const instance: ComputeNodeInstance = { kind: 'compute', id: created.id, port: created.port };
  await updateNodes(scope, (nodes) => {
    nodes[address] = instance;
  });
  if (recorded && recorded.port !== created.port) {
    return { instance, portChange: { address, previous: recorded.port, given: created.port } };
  }
  return { instance };
}

/** The emulator's view of the instance recorded for `address`; undefined when either is missing. */
export async function liveComputeInstance(
  scope: AppScope,
  address: string,
): Promise<InstanceInfo | undefined> {
  const recorded = await mappedComputeInstance(scope, address);
  return recorded ? computeClient().getInstance(recorded.id) : undefined;
}

/** Deletes the instance recorded for `address` and forgets it. */
export async function deleteComputeInstance(scope: AppScope, address: string): Promise<void> {
  const recorded = await mappedComputeInstance(scope, address);
  if (!recorded) return;
  await computeClient().deleteInstance(recorded.id);
  await updateNodes(scope, (nodes) => {
    delete nodes[address];
  });
}

/** Deletes every compute instance recorded for the app and forgets them. */
export async function deleteComputeInstances(scope: AppScope): Promise<void> {
  for (const { address } of await computeNodeInstances(scope)) {
    await deleteComputeInstance(scope, address);
  }
}

/**
 * The Compute emulator's failure messages name instances by id; `prisma dev`
 * names services by address. Rewrites a plain `Error`'s message and leaves
 * any other error, such as a structured one, untouched.
 */
export function withServiceAddresses(
  error: unknown,
  nodes: readonly { readonly address: string; readonly instance: { readonly id: string } }[],
): unknown {
  if (!(error instanceof Error) || error.constructor !== Error) return error;
  let message = error.message;
  for (const { address, instance } of nodes) {
    message = message.replaceAll(`instance "${instance.id}"`, `service "${address}"`);
  }
  return message === error.message ? error : new Error(message, { cause: error });
}
