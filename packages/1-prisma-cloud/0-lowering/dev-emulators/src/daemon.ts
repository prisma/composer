/**
 * The shared daemon layer (local-dev spec § 2): a machine-scoped registry of
 * running emulator daemons (`compute`, `buckets`), and `ensureDaemon` /
 * `stopDaemon` to start, adopt, or replace them. Every daemon is a detached,
 * `unref()`'d child process that outlives whatever called `ensureDaemon` —
 * the registry is how a later call finds it again.
 *
 * `registryRoot` defaults to `~/.prisma-composer/emulators/` and governs
 * every path this module manages for a given daemon: the registry JSON
 * itself, the daemon's own state directory, and its stdio log file. The
 * `{ registryRoot }` override exists solely so tests never touch the real
 * home directory; production code never passes it.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile, StateFile } from './state-file.ts';

export type DaemonName = 'compute' | 'buckets';

export interface RegistryEntry {
  readonly pid: number;
  readonly port: number;
  readonly version: string;
  readonly logPath: string;
}

export interface DaemonRootOptions {
  /** Test-only isolation seam (local-dev spec § 2). Never passed by production code. */
  readonly registryRoot?: string;
}

const MIN_PORT = 4300;
const EXISTING_HEALTH_TIMEOUT_MS = 2000;
const START_HEALTH_BUDGET_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 200;
const TERMINATE_GRACE_MS = 5000;
const TERMINATE_POLL_INTERVAL_MS = 150;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isEnoent(err: unknown): boolean {
  return isErrnoException(err) && err.code === 'ENOENT';
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    'port' in value &&
    typeof value.port === 'number' &&
    'version' in value &&
    typeof value.version === 'string' &&
    'logPath' in value &&
    typeof value.logPath === 'string'
  );
}

interface HealthBody {
  readonly version: string;
}

function isHealthBody(value: unknown): value is HealthBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string'
  );
}

interface PackageJson {
  readonly version: string;
}

function isPackageJson(value: unknown): value is PackageJson {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `~/.prisma-composer/emulators/` — `registryRoot`'s default. */
export function defaultRegistryRoot(): string {
  return path.join(os.homedir(), '.prisma-composer', 'emulators');
}

/** `<registryRoot>/<name>.json`. */
export function registryFilePath(registryRoot: string, name: DaemonName): string {
  return path.join(registryRoot, `${name}.json`);
}

/** `<registryRoot>/<name>/` — the daemon's own `--state-dir`. */
export function daemonStateDir(registryRoot: string, name: DaemonName): string {
  return path.join(registryRoot, name);
}

/** `<registryRoot>/<name>.log` — the daemon's stdio log. */
export function daemonLogPath(registryRoot: string, name: DaemonName): string {
  return path.join(registryRoot, `${name}.log`);
}

/** Compute's root namespace is its own JSON admin API; buckets' root namespace is the S3 wire, so its health lives under `/_pcdev/`. */
export function healthPathFor(name: DaemonName): string {
  return name === 'compute' ? '/health' : '/_pcdev/health';
}

/** `@internal/dev-emulators`'s own `package.json` version — what "version" means everywhere in this package. */
export function readOwnVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(here, '..', 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isPackageJson(parsed)) {
    throw new Error(`could not read a version string from ${pkgPath}`);
  }
  return parsed.version;
}

/** `process.kill(pid, 0)` existence probe — true unless the pid is provably gone (ESRCH). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EPERM') return true; // exists, just not ours
    return false;
  }
}

export async function readRegistryEntry(
  registryRoot: string,
  name: DaemonName,
): Promise<RegistryEntry | undefined> {
  return readJsonFile(registryFilePath(registryRoot, name), isRegistryEntry);
}

async function probeHealth(
  port: number,
  healthPath: string,
  timeoutMs: number,
): Promise<HealthBody | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    return isHealthBody(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

async function pollUntilHealthy(
  port: number,
  healthPath: string,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  do {
    const remaining = deadline - Date.now();
    const health = await probeHealth(port, healthPath, Math.max(200, Math.min(1000, remaining)));
    if (health) return true;
    await sleep(HEALTH_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return false;
}

/** SIGTERM, wait up to `graceMs` for the pid to exit, then SIGKILL. A no-op if the pid is already gone. */
async function terminate(pid: number, graceMs: number): Promise<void> {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // gone between the liveness check and the signal
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await sleep(TERMINATE_POLL_INTERVAL_MS);
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Every port recorded by any registry entry under `registryRoot` — the two daemons share one port pool. */
async function usedPorts(registryRoot: string): Promise<Set<number>> {
  let names: string[];
  try {
    names = await fsp.readdir(registryRoot);
  } catch (err) {
    if (isEnoent(err)) return new Set();
    throw err;
  }
  const ports = new Set<number>();
  for (const fname of names) {
    if (!fname.endsWith('.json')) continue;
    const entry = await readJsonFile(path.join(registryRoot, fname), isRegistryEntry);
    if (entry) ports.add(entry.port);
  }
  return ports;
}

function smallestUnused(used: ReadonlySet<number>, min: number): number {
  let port = min;
  while (used.has(port)) port++;
  return port;
}

/**
 * Ensure the named daemon is running and healthy at this package's version,
 * starting or replacing it as needed (spec § 2 `daemon.ts`). Idempotent —
 * safe to call repeatedly, including across unrelated processes on the same
 * machine.
 */
export async function ensureDaemon(
  name: DaemonName,
  opts: DaemonRootOptions = {},
): Promise<{ url: string }> {
  const registryRoot = opts.registryRoot ?? defaultRegistryRoot();
  const registryFile = registryFilePath(registryRoot, name);
  const healthPath = healthPathFor(name);
  const ownVersion = readOwnVersion();

  const existing = await readJsonFile(registryFile, isRegistryEntry);
  let reusablePort: number | undefined;

  if (existing) {
    reusablePort = existing.port;
    if (isPidAlive(existing.pid)) {
      const health = await probeHealth(existing.port, healthPath, EXISTING_HEALTH_TIMEOUT_MS);
      if (health && health.version === ownVersion) {
        return { url: `http://127.0.0.1:${existing.port}` };
      }
      if (health && health.version !== ownVersion) {
        // Version mismatch: this IS our daemon, just stale — replace it.
        await terminate(existing.pid, TERMINATE_GRACE_MS);
      }
      // Failed health while the pid is alive: can't confirm this is even our
      // daemon (a reused pid after a reboot, a hung foreign process). Never
      // signal something we can't identify — just drop the stale entry and
      // let the port-in-use case surface naturally as a start failure below.
    }
    await fsp.rm(registryFile, { force: true });
  }

  const port = reusablePort ?? smallestUnused(await usedPorts(registryRoot), MIN_PORT);
  const stateDir = daemonStateDir(registryRoot, name);
  const logPath = daemonLogPath(registryRoot, name);
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.mkdir(path.dirname(logPath), { recursive: true });

  const entry = fileURLToPath(import.meta.resolve(`@internal/dev-emulators/${name}-main`));
  const logFd = fs.openSync(logPath, 'a');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [entry, '--port', String(port), '--state-dir', stateDir], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`failed to spawn the ${name} emulator — see ${logPath}.`);
  }

  await new StateFile<RegistryEntry>(registryFile).write({
    pid: child.pid,
    port,
    version: ownVersion,
    logPath,
  });

  const healthy = await pollUntilHealthy(port, healthPath, START_HEALTH_BUDGET_MS);
  if (!healthy) {
    // Never leave an unsupervised, never-healthy process running: a spawn
    // that didn't come up (a squatted port, a broken build) must not leak,
    // even though the happy-path child is deliberately detached to outlive
    // this call.
    await terminate(child.pid, TERMINATE_GRACE_MS);
    throw new Error(`${name} emulator failed to start on port ${port} — see ${logPath}.`);
  }
  return { url: `http://127.0.0.1:${port}` };
}

/** SIGTERM/SIGKILL + registry cleanup. Not called by any v1 command — an operator escape hatch, exported for tests. */
export async function stopDaemon(name: DaemonName, opts: DaemonRootOptions = {}): Promise<void> {
  const registryRoot = opts.registryRoot ?? defaultRegistryRoot();
  const registryFile = registryFilePath(registryRoot, name);
  const entry = await readJsonFile(registryFile, isRegistryEntry);
  if (entry) {
    await terminate(entry.pid, TERMINATE_GRACE_MS);
  }
  await fsp.rm(registryFile, { force: true });
}
