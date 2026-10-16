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

/** Why a running emulator could not be listed: it did not answer, or it answered with an error. */
export interface EmulatorListingError {
  readonly code: string;
  readonly message: string;
}

export interface EmulatorListing {
  readonly kind: EmulatorKind;
  readonly running: boolean;
  /** The emulator's admin URL; null when it is not running. */
  readonly url: string | null;
  /** Empty when the emulator is not running or could not be listed. */
  readonly instances: readonly EmulatorInstance[];
  /** Null unless the emulator runs but could not be listed. */
  readonly error: EmulatorListingError | null;
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

interface InstanceLister {
  readonly url: string;
  list(): Promise<EmulatorInstance[]>;
}

function listerOf(kind: EmulatorKind, opts: DaemonRootOptions): InstanceLister {
  if (kind === 'service') {
    const client = computeClient(opts);
    return {
      url: client.baseUrl,
      list: async () =>
        (await client.listInstances()).map(({ id, url, status, labels }) => ({
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
    return {
      url: client.baseUrl,
      list: async () =>
        (await client.listInstances()).map(({ id, url, status, labels }) => ({
          id,
          kind,
          url,
          state: status,
          labels,
        })),
    };
  }
  const client = bucketsClient(opts);
  return {
    url: client.baseUrl,
    list: async () =>
      (await client.listInstances()).map(({ id, labels }) => ({
        id,
        kind,
        url: `${client.baseUrl}/${id}`,
        state: 'running',
        labels,
      })),
  };
}

async function listingOf(kind: EmulatorKind, opts: DaemonRootOptions): Promise<EmulatorListing> {
  if (!(await isEmulatorRunning(kind, opts))) {
    return { kind, running: false, url: null, instances: [], error: null };
  }
  const lister = listerOf(kind, opts);
  try {
    return { kind, running: true, url: lister.url, instances: await lister.list(), error: null };
  } catch (error) {
    const failure = CliStructuredError.is(error)
      ? error
      : new CliStructuredError(
          'DEV.EMULATOR_FAILED',
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
    return {
      kind,
      running: true,
      url: lister.url,
      instances: [],
      error: { code: failure.code, message: failure.message },
    };
  }
}

/**
 * Every emulator, whether it runs, and its instances. Nothing running is a
 * valid answer, and an emulator that cannot be listed is reported in its own
 * entry; only an invalid emulators directory fails the whole listing.
 */
export async function listEmulators(
  opts: DaemonRootOptions = {},
): Promise<Result<EmulatorList, CliStructuredError>> {
  try {
    const emulators: EmulatorListing[] = [];
    for (const kind of EMULATOR_KINDS) emulators.push(await listingOf(kind, opts));
    return ok({ emulators });
  } catch (error) {
    if (CliStructuredError.is(error)) return notOk(error);
    throw error;
  }
}
