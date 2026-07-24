/**
 * Test fixture: calls `ensureDaemon` and prints the result — the URL AND
 * the registry entry's pid this call observed — as JSON on stdout, so a
 * test driving TWO of these as separate OS processes can compare what each
 * one observed. Portable by design: no OS process inspection, just the
 * daemon's own registry. The concurrent-ensure protocol is an inter-process
 * lock, so the mutex under test only exists across real processes, never
 * across two promises in one. Run standalone via
 * `bun <this file> <compute|buckets> <registryRoot>`.
 */
import { fileURLToPath } from 'node:url';
import { type DaemonName, ensureDaemon, readRegistryEntry } from '../../daemon.ts';

function isDaemonName(value: string | undefined): value is DaemonName {
  return value === 'compute' || value === 'buckets';
}

const [, , name, registryRoot] = process.argv;
if (!isDaemonName(name)) {
  throw new Error(`ensure-and-print fixture: expected "compute" or "buckets", got ${String(name)}`);
}
if (!registryRoot) {
  throw new Error('ensure-and-print fixture: registryRoot argument is required');
}

const entryPath = fileURLToPath(import.meta.resolve(`@internal/dev-emulators/${name}-main`));
const result = await ensureDaemon(name, entryPath, { registryRoot });
const entry = await readRegistryEntry(registryRoot, name);
if (!entry) {
  throw new Error('ensure-and-print fixture: ensureDaemon resolved but the registry entry is gone');
}
console.log(JSON.stringify({ url: result.url, pid: entry.pid }));
