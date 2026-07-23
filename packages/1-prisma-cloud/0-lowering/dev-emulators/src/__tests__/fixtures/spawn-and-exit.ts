/**
 * Test fixture: calls `ensureDaemon` and exits immediately, so the test can
 * prove the daemon it started survives this (its parent) process exiting.
 * Run standalone via `bun <this file> <compute|buckets> <registryRoot>`.
 */
import { fileURLToPath } from 'node:url';
import { type DaemonName, ensureDaemon } from '../../daemon.ts';

function isDaemonName(value: string | undefined): value is DaemonName {
  return value === 'compute' || value === 'buckets';
}

const [, , name, registryRoot] = process.argv;
if (!isDaemonName(name)) {
  throw new Error(`spawn-and-exit fixture: expected "compute" or "buckets", got ${String(name)}`);
}
if (!registryRoot) {
  throw new Error('spawn-and-exit fixture: registryRoot argument is required');
}

const entryPath = fileURLToPath(import.meta.resolve(`@internal/dev-emulators/${name}-main`));
await ensureDaemon(name, entryPath, { registryRoot });
process.exit(0);
