/**
 * `@internal/dev-emulators`'s surface (local-dev spec § 2): the shared
 * daemon layer (`ensureDaemon`/`stopDaemon`) and typed loopback clients for
 * both emulator daemons. The daemon programs themselves are separate
 * subpaths — `@internal/dev-emulators/compute-main` and `/buckets-main`.
 */

export type {
  BucketInstanceInfo,
  BucketsClient,
  ComputeClient,
  CreateBucketRequest,
  CreateDatabaseRequest,
  CreateServiceRequest,
  DatabaseInstanceInfo,
  DeploymentRequest,
  PostgresClient,
  ServiceInstanceInfo,
  ServiceInstanceStatus,
} from '../client.ts';
export { bucketsClient, computeClient, postgresClient } from '../client.ts';
export type { DaemonName, DaemonRootOptions, RegistryEntry } from '../daemon.ts';
export {
  daemonLogPath,
  daemonStateDir,
  defaultRegistryRoot,
  EMULATORS_DIR_ENV,
  ensureDaemon,
  healthPathFor,
  readOwnVersion,
  readRegistryEntry,
  registryFilePath,
  stopDaemon,
} from '../daemon.ts';
export type {
  EmulatorInstance,
  EmulatorKind,
  EmulatorList,
  EmulatorListing,
} from '../emulator-list.ts';
export { EMULATOR_KINDS, isEmulatorRunning, listEmulators } from '../emulator-list.ts';
