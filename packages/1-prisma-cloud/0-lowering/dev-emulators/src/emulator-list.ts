/**
 * Every local emulator on this machine and every instance on it — the
 * operation behind `prisma emulator list`. It needs no project: it reads the
 * emulators' registry and asks each running emulator for its instances.
 */
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok, type Result } from '@internal/foundation/result';
import { bucketsClient, computeClient, postgresClient } from './client.ts';
import {
  type DaemonName,
  type DaemonRootOptions,
  defaultRegistryRoot,
  isPidAlive,
  readRegistryEntry,
} from './daemon.ts';

/** What an emulator's instances are. */
export type EmulatorKind = 'service' | 'database' | 'bucket';

export const EMULATOR_KINDS: readonly EmulatorKind[] = ['service', 'database', 'bucket'];

const DAEMON_OF: Record<EmulatorKind, DaemonName> = {
  service: 'compute',
  database: 'postgres',
  bucket: 'buckets',
};

export interface EmulatorInstance {
  readonly id: string;
  readonly kind: EmulatorKind;
  /** A service's URL, a database's connection string, or a bucket's S3 endpoint plus `/<id>`. */
  readonly url: string;
  /** A service's status, a database's `running` or `stopped`, or `running` for a bucket. */
  readonly state: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface EmulatorListing {
  readonly kind: EmulatorKind;
  readonly running: boolean;
  /** The emulator's admin URL; absent when it is not running. */
  readonly url?: string;
  /** Empty when the emulator is not running. */
  readonly instances: readonly EmulatorInstance[];
}

export interface EmulatorList {
  readonly emulators: readonly EmulatorListing[];
}

/** Whether the emulator for `kind` is registered with a live process. */
export async function isEmulatorRunning(
  kind: EmulatorKind,
  opts: DaemonRootOptions = {},
): Promise<boolean> {
  const entry = await readRegistryEntry(
    opts.registryRoot ?? defaultRegistryRoot(),
    DAEMON_OF[kind],
  );
  return entry !== undefined && isPidAlive(entry.pid);
}

async function instancesOf(
  kind: EmulatorKind,
  opts: DaemonRootOptions,
): Promise<{ readonly url: string; readonly instances: EmulatorInstance[] }> {
  if (kind === 'service') {
    const client = computeClient(opts);
    const instances = await client.listInstances();
    return {
      url: client.baseUrl,
      instances: instances.map(({ id, url, status, labels }) => ({
        id,
        kind,
        url,
        state: status,
        labels,
      })),
    };
  }
  if (kind === 'database') {
    const client = postgresClient(opts);
    const instances = await client.listInstances();
    return {
      url: client.baseUrl,
      instances: instances.map(({ id, url, status, labels }) => ({
        id,
        kind,
        url,
        state: status,
        labels,
      })),
    };
  }
  const client = bucketsClient(opts);
  const instances = await client.listInstances();
  return {
    url: client.baseUrl,
    instances: instances.map(({ id, labels }) => ({
      id,
      kind,
      url: `${client.baseUrl}/${id}`,
      state: 'running',
      labels,
    })),
  };
}

/** Every emulator, whether it runs, and its instances. Nothing running is a valid answer, not a failure. */
export async function listEmulators(
  opts: DaemonRootOptions = {},
): Promise<Result<EmulatorList, CliStructuredError>> {
  try {
    const emulators: EmulatorListing[] = [];
    for (const kind of EMULATOR_KINDS) {
      if (!(await isEmulatorRunning(kind, opts))) {
        emulators.push({ kind, running: false, instances: [] });
        continue;
      }
      emulators.push({ kind, running: true, ...(await instancesOf(kind, opts)) });
    }
    return ok({ emulators });
  } catch (error) {
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
}
