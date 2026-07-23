/**
 * `@internal/dev-emulators`'s surface (local-dev spec § 2): the shared
 * daemon layer (`ensureDaemon`/`stopDaemon`) and typed loopback clients for
 * both emulator daemons. The daemon programs themselves are separate
 * subpaths — `@internal/dev-emulators/compute-main` and `/buckets-main`.
 */

export type {
  BucketsClient,
  ComputeClient,
  DatabaseInfo,
  DeploymentRequest,
  PostgresClient,
  ServiceInfo,
} from '../client.ts';
export { bucketsClient, computeClient, postgresClient } from '../client.ts';
export type { DaemonName, DaemonRootOptions, RegistryEntry } from '../daemon.ts';
export {
  daemonLogPath,
  daemonStateDir,
  defaultRegistryRoot,
  ensureDaemon,
  healthPathFor,
  readOwnVersion,
  readRegistryEntry,
  registryFilePath,
  stopDaemon,
} from '../daemon.ts';
