/**
 * Which emulator instance backs each node of each app run from a directory.
 * `prisma dev` records it in `<directory>/.prisma-composer/dev/`, and every
 * Composer operation on an emulator instance goes through it. The emulators
 * know nothing about Composer: the labels written on create are for people
 * reading an emulator listing, and nothing here reads them back.
 */
import * as path from 'node:path';
import { DEV_DIR } from '@internal/core/config';
import {
  type BucketInstanceInfo,
  bucketsClient,
  computeClient,
  type DatabaseInstanceInfo,
  postgresClient,
  type ServiceInstanceInfo,
} from '@internal/dev-emulators';
import { createStore, type DevStore } from './dev-store.ts';
import { resolvePrismaDevModulePath } from './prisma-dev-module.ts';

export const EMULATOR_INSTANCES_FILE = 'emulator-instances.json';

export interface ServiceNodeInstance {
  readonly kind: 'service';
  readonly id: string;
  /** The port the instance was given, requested again if the instance has to be re-created. */
  readonly port: number;
}

export interface DatabaseNodeInstance {
  readonly kind: 'database';
  readonly id: string;
  /** The port the database was given, requested again if it has to be re-created. */
  readonly port: number;
}

export interface BucketNodeInstance {
  readonly kind: 'bucket';
  readonly id: string;
}

export type NodeInstance = ServiceNodeInstance | DatabaseNodeInstance | BucketNodeInstance;
export type NodeKind = NodeInstance['kind'];

export interface AppInstances {
  /** Keyed by node address. */
  readonly nodes: Readonly<Record<string, NodeInstance>>;
}

export interface EmulatorInstances {
  /** The app `prisma dev` last ran from the directory. */
  readonly current: string;
  /** Every app run from the directory, keyed by app name. */
  readonly apps: Readonly<Record<string, AppInstances>>;
}

/** The app run from the directory that holds `devDir` (`<directory>/.prisma-composer/dev`). */
export interface AppScope {
  readonly devDir: string;
  readonly app: string;
}

/** A node whose remembered port another instance or process now holds. */
export interface PortChange {
  readonly kind: 'service' | 'database';
  readonly address: string;
  readonly previous: number;
  readonly given: number;
}

function isNodeInstance(value: unknown): value is NodeInstance {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || typeof value.id !== 'string' || !('kind' in value)) return false;
  if (value.kind === 'bucket') return true;
  return (
    (value.kind === 'service' || value.kind === 'database') &&
    'port' in value &&
    typeof value.port === 'number'
  );
}

function isNodes(value: unknown): value is Record<string, NodeInstance> {
  return typeof value === 'object' && value !== null && Object.values(value).every(isNodeInstance);
}

function isAppInstances(value: unknown): value is AppInstances {
  return typeof value === 'object' && value !== null && 'nodes' in value && isNodes(value.nodes);
}

function isEmulatorInstances(value: unknown): value is EmulatorInstances {
  return (
    typeof value === 'object' &&
    value !== null &&
    'current' in value &&
    typeof value.current === 'string' &&
    'apps' in value &&
    typeof value.apps === 'object' &&
    value.apps !== null &&
    Object.values(value.apps).every(isAppInstances)
  );
}

/** The single-app record an earlier version wrote: one app and its services, whose kind it called `compute`. */
interface SingleAppRecord {
  readonly app: string;
  readonly nodes: Readonly<Record<string, { readonly id: string; readonly port: number }>>;
}

function isEarlierServiceNode(value: unknown): value is { id: string; port: number } {
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

function isSingleAppRecord(value: unknown): value is SingleAppRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'app' in value &&
    typeof value.app === 'string' &&
    'nodes' in value &&
    typeof value.nodes === 'object' &&
    value.nodes !== null &&
    Object.values(value.nodes).every(isEarlierServiceNode)
  );
}

type StoredRecord = EmulatorInstances | SingleAppRecord;

function isStoredRecord(value: unknown): value is StoredRecord {
  return isEmulatorInstances(value) || isSingleAppRecord(value);
}

/** A single-app record reads as a record holding that one app; the next write rewrites it. */
function normalized(stored: StoredRecord | undefined): EmulatorInstances | undefined {
  if (stored === undefined || isEmulatorInstances(stored)) return stored;
  const nodes = Object.fromEntries(
    Object.entries(stored.nodes).map(([address, { id, port }]) => [
      address,
      { kind: 'service' as const, id, port },
    ]),
  );
  return { current: stored.app, apps: { [stored.app]: { nodes } } };
}

/**
 * A database's or bucket's key in the record: its resource `name`, which the
 * lowering sets from the same helper the emulators hook keys it by. A
 * resource without a name cannot be matched to the instance the hook
 * recorded, so it is refused rather than recorded under another key.
 */
export function recordKeyOf(
  kind: 'database' | 'bucket',
  resourceId: string,
  name: string | undefined,
): string {
  if (name === undefined) {
    throw new Error(
      `local dev: the ${kind} resource "${resourceId}" has no name, so its emulator instance cannot be found in the directory's record.`,
    );
  }
  return name;
}

/** The project directory that holds `devDir` (`<directory>/.prisma-composer/dev`). */
export function directoryOf(devDir: string): string {
  const normalizedDir = path.normalize(devDir);
  return normalizedDir.endsWith(DEV_DIR)
    ? normalizedDir.slice(0, -DEV_DIR.length - 1)
    : normalizedDir;
}

function store(devDir: string): DevStore<StoredRecord | undefined> {
  return createStore(path.join(devDir, EMULATOR_INSTANCES_FILE), isStoredRecord, undefined);
}

async function readRecord(devDir: string): Promise<EmulatorInstances | undefined> {
  return normalized(await store(devDir).read());
}

async function updateRecord(
  devDir: string,
  mutate: (record: EmulatorInstances | undefined) => EmulatorInstances,
): Promise<void> {
  await store(devDir).update((stored) => mutate(normalized(stored)));
}

/** The record `prisma dev` left in `directory`; undefined when it has not run there. */
export function readEmulatorInstances(directory: string): Promise<EmulatorInstances | undefined> {
  return readRecord(path.join(directory, DEV_DIR));
}

async function appNodes(scope: AppScope): Promise<Readonly<Record<string, NodeInstance>>> {
  return (await readRecord(scope.devDir))?.apps[scope.app]?.nodes ?? {};
}

async function updateNodes(
  scope: AppScope,
  mutate: (nodes: Record<string, NodeInstance>) => void,
): Promise<void> {
  await updateRecord(scope.devDir, (record) => {
    const nodes = { ...(record?.apps[scope.app]?.nodes ?? {}) };
    mutate(nodes);
    return {
      current: record?.current ?? scope.app,
      apps: { ...record?.apps, [scope.app]: { nodes } },
    };
  });
}

function labelsFor(scope: AppScope, address: string): Record<string, string> {
  return {
    'composer.directory': directoryOf(scope.devDir),
    'composer.app': scope.app,
    'composer.address': address,
  };
}

function idsOf(nodes: Readonly<Record<string, NodeInstance>>, kind: NodeKind): string[] {
  return Object.values(nodes).flatMap((node) => (node.kind === kind ? [node.id] : []));
}

/**
 * Stops the service processes and database servers of `nodes`, keeping
 * their data and ports. A kind whose emulator is not running has nothing
 * running to stop.
 */
async function stopNodes(nodes: Readonly<Record<string, NodeInstance>>): Promise<void> {
  const services = idsOf(nodes, 'service');
  const databases = idsOf(nodes, 'database');
  // Both are attempted, so a failed service stop never leaves the database
  // servers running; the first failure is reported after both.
  const results = await Promise.allSettled([
    services.length > 0 ? whenRunning(() => computeClient().stopInstances(services)) : undefined,
    databases.length > 0 ? whenRunning(() => postgresClient().stopInstances(databases)) : undefined,
  ]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

/** Runs `action` against an emulator, treating "the emulator is not running" as nothing to do. */
async function whenRunning(action: () => Promise<void>): Promise<void> {
  let run: Promise<void>;
  try {
    run = action();
  } catch {
    return;
  }
  await run;
}

/**
 * Makes `scope.app` the directory's current app. When another app ran here
 * last, its service processes and database servers are stopped and its
 * instances stay recorded, so running it again resumes them with their data
 * and ports. Returns the previous app's name when it changed.
 */
export async function selectApp(scope: AppScope): Promise<string | undefined> {
  const record = await readRecord(scope.devDir);
  const previous = record?.current;
  if (previous !== undefined && previous !== scope.app) {
    await stopNodes(record?.apps[previous]?.nodes ?? {});
  }
  await updateRecord(scope.devDir, (latest) => ({
    current: scope.app,
    apps: { ...latest?.apps, [scope.app]: latest?.apps[scope.app] ?? { nodes: {} } },
  }));
  return previous !== undefined && previous !== scope.app ? previous : undefined;
}

/** Each node of the app of `kind`, with the instance that backs it. */
export async function nodeInstancesOf<K extends NodeKind>(
  scope: AppScope,
  kind: K,
): Promise<{ readonly address: string; readonly instance: Extract<NodeInstance, { kind: K }> }[]> {
  return Object.entries(await appNodes(scope)).flatMap(([address, instance]) =>
    isOfKind(instance, kind) ? [{ address, instance }] : [],
  );
}

function isOfKind<K extends NodeKind>(
  instance: NodeInstance,
  kind: K,
): instance is Extract<NodeInstance, { kind: K }> {
  return instance.kind === kind;
}

/** The instance of `kind` recorded for `address`; undefined when there is none. */
async function recordedInstance<K extends NodeKind>(
  scope: AppScope,
  address: string,
  kind: K,
): Promise<Extract<NodeInstance, { kind: K }> | undefined> {
  const recorded = (await appNodes(scope))[address];
  return recorded !== undefined && isOfKind(recorded, kind) ? recorded : undefined;
}

/**
 * The instance that runs the service at `address`. The recorded instance is
 * reused while the Compute emulator still has it. Otherwise a new one is
 * created, requesting the recorded port, and recorded.
 */
export async function ensureServiceInstance(
  scope: AppScope,
  address: string,
): Promise<{ readonly instance: ServiceNodeInstance; readonly portChange?: PortChange }> {
  const client = computeClient();
  const recorded = await recordedInstance(scope, address, 'service');
  if (recorded && (await client.getInstance(recorded.id))) return { instance: recorded };

  const created = await client.createInstance({
    labels: labelsFor(scope, address),
    ...(recorded ? { port: recorded.port } : {}),
  });
  const instance: ServiceNodeInstance = { kind: 'service', id: created.id, port: created.port };
  await updateNodes(scope, (nodes) => {
    nodes[address] = instance;
  });
  return { instance, ...portChangeOf('service', address, recorded?.port, created.port) };
}

function portChangeOf(
  kind: PortChange['kind'],
  address: string,
  previous: number | undefined,
  given: number,
): { readonly portChange?: PortChange } {
  return previous !== undefined && previous !== given
    ? { portChange: { kind, address, previous, given } }
    : {};
}

/**
 * The running database for `address`. A recorded database the Postgres
 * emulator still has is started if it is stopped. Otherwise a new one is
 * created, requesting the recorded port, and recorded; it starts empty.
 */
export async function ensureDatabaseInstance(
  scope: AppScope,
  address: string,
  prismaDevModulePath: string,
): Promise<{ readonly instance: DatabaseInstanceInfo; readonly portChange?: PortChange }> {
  const client = postgresClient();
  const recorded = await recordedInstance(scope, address, 'database');
  const existing = recorded ? await client.getInstance(recorded.id) : undefined;
  if (existing?.status === 'running') return { instance: existing };
  if (existing) {
    await client.startInstances([existing.id], prismaDevModulePath);
    return { instance: (await client.getInstance(existing.id)) ?? existing };
  }

  const created = await client.createInstance({
    labels: labelsFor(scope, address),
    ...(recorded ? { port: recorded.port } : {}),
    prismaDevModulePath,
  });
  await updateNodes(scope, (nodes) => {
    nodes[address] = { kind: 'database', id: created.id, port: created.port };
  });
  return { instance: created, ...portChangeOf('database', address, recorded?.port, created.port) };
}

/**
 * The bucket for `address`. The recorded bucket is reused while the bucket
 * emulator still has it. Otherwise a new one is created over `dir` and
 * recorded; the objects already in `dir` are its objects.
 */
export async function ensureBucketInstance(
  scope: AppScope,
  address: string,
  dir: string,
): Promise<BucketInstanceInfo> {
  const client = bucketsClient();
  const recorded = await recordedInstance(scope, address, 'bucket');
  const existing = recorded ? await client.getInstance(recorded.id) : undefined;
  if (existing) return existing;

  const created = await client.createInstance({ labels: labelsFor(scope, address), dir });
  await updateNodes(scope, (nodes) => {
    nodes[address] = { kind: 'bucket', id: created.id };
  });
  return created;
}

/** The Compute emulator's view of the instance recorded for `address`; undefined when either is missing. */
export async function liveServiceInstance(
  scope: AppScope,
  address: string,
): Promise<ServiceInstanceInfo | undefined> {
  const recorded = await recordedInstance(scope, address, 'service');
  return recorded ? computeClient().getInstance(recorded.id) : undefined;
}

/** The id recorded for `address`; undefined when there is none. */
export async function recordedInstanceId(
  scope: AppScope,
  address: string,
): Promise<string | undefined> {
  return (await appNodes(scope))[address]?.id;
}

async function deleteInstance(instance: NodeInstance): Promise<void> {
  if (instance.kind === 'service') await computeClient().deleteInstance(instance.id);
  else if (instance.kind === 'database') {
    // The caller's `@prisma/dev`: the one the database was created with may
    // since have been removed by an upgrade.
    await postgresClient().deleteInstance(instance.id, resolvePrismaDevModulePath());
  } else await bucketsClient().deleteInstance(instance.id);
}

/** Deletes the instance recorded for `address` and forgets it. */
export async function deleteNodeInstance(scope: AppScope, address: string): Promise<void> {
  const recorded = (await appNodes(scope))[address];
  if (!recorded) return;
  await deleteInstance(recorded);
  await updateNodes(scope, (nodes) => {
    delete nodes[address];
  });
}

/** The kinds of instance recorded for the app, so a caller can start their emulators first. */
export async function recordedKinds(scope: AppScope): Promise<Set<NodeKind>> {
  return new Set(Object.values(await appNodes(scope)).map((node) => node.kind));
}

/**
 * `--fresh`: deletes the app's recorded instances of every kind and its
 * entry. Other apps' entries are left alone. A bucket's objects live in the
 * dev directory, which `--fresh` removes separately.
 */
export async function deleteAppInstances(scope: AppScope): Promise<void> {
  for (const instance of Object.values(await appNodes(scope))) await deleteInstance(instance);
  await updateRecord(scope.devDir, (record) => {
    const apps = { ...record?.apps };
    delete apps[scope.app];
    return { current: record?.current ?? scope.app, apps };
  });
}

/** When `prisma dev` ends: stops the app's service processes and database servers, keeping their data and ports. */
export async function stopAppInstances(scope: AppScope): Promise<void> {
  await stopNodes(await appNodes(scope));
}

/**
 * The emulators' failure messages name instances by id; `prisma dev` names
 * services by address. Rewrites a plain `Error`'s message and leaves any
 * other error, such as a structured one, untouched.
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
