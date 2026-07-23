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
import getPort, { portNumbers } from 'get-port';
import * as properLockfile from 'proper-lockfile';
import { readJsonFile, StateFile } from './state-file.ts';

export type DaemonName = 'compute' | 'buckets' | 'postgres';

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
const MAX_PORT = 65_535;
const EXISTING_HEALTH_TIMEOUT_MS = 2000;
const START_HEALTH_BUDGET_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 200;
const TERMINATE_GRACE_MS = 5000;
const TERMINATE_POLL_INTERVAL_MS = 150;
const LOCK_RETRY_INTERVAL_MS = 250;
const LOCK_WAIT_BUDGET_MS = 10_000;
const LOCK_STALE_MS = 10_000;
/** Spec § 2 step 5: a FRESH allocation (no persisted port) tries at most this many distinct port candidates before the pinned failure error. */
const MAX_FRESH_PORT_CANDIDATES = 5;

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

/** Compute's and postgres's root namespace is their own JSON admin API; buckets' root namespace is the S3 wire, so its health lives under `/_pcdev/`. */
export function healthPathFor(name: DaemonName): string {
  return name === 'buckets' ? '/_pcdev/health' : '/health';
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

interface HealthOutcome {
  readonly healthy: boolean;
  /** The child process exited before the health budget produced a healthy daemon — a bind failure, not a slow-to-start one. */
  readonly exitedBeforeHealthy: boolean;
}

/**
 * Polls the health path up to `budgetMs`, but returns immediately once the
 * child exits — a dead child can never become healthy, and the port-retry
 * protocol (spec § 2 step 5) needs to move to the next candidate right
 * away rather than exhausting a live-process budget on one that isn't
 * live. Only a child that stays alive without becoming healthy consumes
 * the full budget.
 *
 * Verifies the health response's OWN version, not just that something
 * answered: if our child failed to bind (a foreign process already held
 * the port) that foreign process may itself answer `/health` successfully
 * — a version mismatch there is exactly the "port taken" case, not a false
 * "healthy", and must not be reported as such.
 */
async function awaitHealthy(
  child: ChildProcess,
  port: number,
  healthPath: string,
  ownVersion: string,
  budgetMs: number,
): Promise<HealthOutcome> {
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + budgetMs;
  do {
    if (exited) return { healthy: false, exitedBeforeHealthy: true };
    const remaining = deadline - Date.now();
    const health = await probeHealth(port, healthPath, Math.max(200, Math.min(1000, remaining)));
    if (health && health.version === ownVersion)
      return { healthy: true, exitedBeforeHealthy: false };
    if (exited) return { healthy: false, exitedBeforeHealthy: true };
    await sleep(HEALTH_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return { healthy: false, exitedBeforeHealthy: exited };
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

/**
 * The smallest genuinely free port at or above `min`, skipping every port
 * already recorded in the registry — persistence and the range policy
 * (`min`, "skip registry-used ports") stay ours; whether a given candidate
 * is actually bindable is `get-port`'s (spec § 2's dependency razor — a
 * hand-rolled probe already produced a real cross-platform bug: a Linux-only
 * self-collision from checking two bind scopes concurrently).
 */
async function smallestUnused(used: ReadonlySet<number>, min: number): Promise<number> {
  return getPort({ port: portNumbers(min, MAX_PORT), exclude: used });
}

/** Spawns the daemon binary detached, stdio appended to `logPath`. Doesn't wait for health. */
function spawnDaemonProcess(
  entryPath: string,
  port: number,
  stateDir: string,
  logPath: string,
): ChildProcess {
  const logFd = fs.openSync(logPath, 'a');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [entryPath, '--port', String(port), '--state-dir', stateDir], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  return child;
}

type ObserveResult =
  | { readonly kind: 'healthy'; readonly entry: RegistryEntry }
  | { readonly kind: 'stale-version'; readonly entry: RegistryEntry }
  | { readonly kind: 'dead-or-unhealthy'; readonly entry: RegistryEntry }
  | { readonly kind: 'absent' };

/**
 * Reads the registry entry and classifies it. "dead-or-unhealthy" covers
 * both a provably dead pid AND a live pid that fails health — the latter
 * can't be confirmed as our daemon (a reused pid after a reboot, a hung
 * foreign process), so it is never signaled, only dropped.
 */
async function observeExisting(
  registryFile: string,
  healthPath: string,
  ownVersion: string,
): Promise<ObserveResult> {
  const entry = await readJsonFile(registryFile, isRegistryEntry);
  if (!entry) return { kind: 'absent' };
  if (!isPidAlive(entry.pid)) return { kind: 'dead-or-unhealthy', entry };
  const health = await probeHealth(entry.port, healthPath, EXISTING_HEALTH_TIMEOUT_MS);
  if (health && health.version === ownVersion) return { kind: 'healthy', entry };
  if (health && health.version !== ownVersion) return { kind: 'stale-version', entry };
  return { kind: 'dead-or-unhealthy', entry };
}

/**
 * `<registryRoot>/.<name>.lock-target` — the file `proper-lockfile` locks
 * for the concurrent-ensure protocol (it marks the lock as a sibling
 * `<file>.lock` directory it manages itself). A stable, never-deleted file:
 * unlike the registry JSON, which this module removes and rewrites
 * repeatedly while ensuring, the lock target must exist continuously for
 * `proper-lockfile`'s `realpath` resolution.
 */
export function lockFilePath(registryRoot: string, name: DaemonName): string {
  return path.join(registryRoot, `.${name}.lock-target`);
}

/**
 * Acquires the concurrent-ensure protocol's inter-process lock (spec § 2)
 * via `proper-lockfile` — its staleness/compromise semantics are adopted
 * wholesale rather than re-implementing pid liveness checking on top (the
 * dependency razor: commodity locking is exactly where unforeseen edge
 * cases hide). Polls roughly every 250 ms for up to a 10 s budget; on
 * exhaustion (`ELOCKED`, meaning a live, non-stale holder never let go),
 * throws the pinned timeout error. Any other failure propagates as-is.
 */
async function acquireLock(registryRoot: string, name: DaemonName): Promise<() => Promise<void>> {
  await fsp.mkdir(registryRoot, { recursive: true });
  const target = lockFilePath(registryRoot, name);
  await fsp.writeFile(target, '', { flag: 'a' }); // create if missing; never truncates existing content
  const retries = Math.max(1, Math.floor(LOCK_WAIT_BUDGET_MS / LOCK_RETRY_INTERVAL_MS));
  try {
    return await properLockfile.lock(target, {
      stale: LOCK_STALE_MS,
      retries: {
        retries,
        minTimeout: LOCK_RETRY_INTERVAL_MS,
        maxTimeout: LOCK_RETRY_INTERVAL_MS,
        factor: 1,
      },
    });
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ELOCKED') {
      throw new Error(
        `timed out waiting for another process ensuring the ${name} emulator — remove ${target}.lock if stale.`,
      );
    }
    throw err;
  }
}

/**
 * Ensure the named daemon is running and healthy at this package's version,
 * starting or replacing it as needed (spec § 2 `daemon.ts`). Idempotent —
 * safe to call repeatedly, including across unrelated processes on the same
 * machine, and safe under concurrent callers across processes: the
 * observe→spawn→persist critical section is serialized per daemon name by
 * an inter-process lock (the "Concurrent-ensure protocol").
 *
 * `entry` is the resolved absolute path to the daemon program to spawn —
 * the CALLER resolves it (local-dev spec § 2's publish note). This module
 * used to resolve it itself via `import.meta.resolve('@internal/dev-emulators/…')`,
 * which only works in-repo: `@internal/*` are private workspace packages a
 * published npm consumer never receives. In-repo callers (including tests)
 * still resolve `@internal/dev-emulators/*-main` the same way; a published
 * consumer resolves its own public subpaths instead.
 */
export async function ensureDaemon(
  name: DaemonName,
  entry: string,
  opts: DaemonRootOptions = {},
): Promise<{ url: string }> {
  const registryRoot = opts.registryRoot ?? defaultRegistryRoot();
  const registryFile = registryFilePath(registryRoot, name);
  const healthPath = healthPathFor(name);
  const ownVersion = readOwnVersion();

  // Optimistic, unlocked fast path: the common case is "already running and
  // healthy", which needs no cross-process coordination at all.
  const quick = await observeExisting(registryFile, healthPath, ownVersion);
  if (quick.kind === 'healthy') {
    return { url: `http://127.0.0.1:${quick.entry.port}` };
  }

  const release = await acquireLock(registryRoot, name);
  try {
    // Re-read under the lock — the previous holder may have already
    // finished the job while we were waiting to acquire it.
    const observed = await observeExisting(registryFile, healthPath, ownVersion);
    if (observed.kind === 'healthy') {
      return { url: `http://127.0.0.1:${observed.entry.port}` };
    }

    let reusablePort: number | undefined;
    if (observed.kind === 'stale-version') {
      // This IS our daemon, just stale — replace it.
      reusablePort = observed.entry.port;
      await terminate(observed.entry.pid, TERMINATE_GRACE_MS);
      await fsp.rm(registryFile, { force: true });
    } else if (observed.kind === 'dead-or-unhealthy') {
      reusablePort = observed.entry.port;
      await fsp.rm(registryFile, { force: true });
    }

    // Port allocation happens inside the lock, so two daemons can never
    // claim one port. A FRESH allocation (no persisted port) has handed out
    // no endpoint yet, so it's safe to try up to MAX_FRESH_PORT_CANDIDATES
    // distinct ports if the daemon can't bind one; a persisted port never
    // moves — deploy state may already reference it as a frozen endpoint.
    const isFreshAllocation = reusablePort === undefined;
    const maxAttempts = isFreshAllocation ? MAX_FRESH_PORT_CANDIDATES : 1;
    let port = reusablePort ?? (await smallestUnused(await usedPorts(registryRoot), MIN_PORT));
    const stateDir = daemonStateDir(registryRoot, name);
    const logPath = daemonLogPath(registryRoot, name);
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.mkdir(path.dirname(logPath), { recursive: true });

    for (let attempt = 1; ; attempt++) {
      const child = spawnDaemonProcess(entry, port, stateDir, logPath);
      if (child.pid === undefined) {
        throw new Error(`failed to spawn the ${name} emulator — see ${logPath}.`);
      }

      await new StateFile<RegistryEntry>(registryFile).write({
        pid: child.pid,
        port,
        version: ownVersion,
        logPath,
      });

      const outcome = await awaitHealthy(
        child,
        port,
        healthPath,
        ownVersion,
        START_HEALTH_BUDGET_MS,
      );
      if (outcome.healthy) {
        return { url: `http://127.0.0.1:${port}` };
      }

      const canRetryNextPort =
        isFreshAllocation && outcome.exitedBeforeHealthy && attempt < maxAttempts;
      if (!canRetryNextPort) {
        // Never leave an unsupervised, never-healthy process running: a
        // spawn that didn't come up (a squatted port, a broken build) must
        // not leak, even though the happy-path child is deliberately
        // detached to outlive this call. Drop the registry entry too — it
        // would otherwise point at a pid we just killed.
        await terminate(child.pid, TERMINATE_GRACE_MS);
        await fsp.rm(registryFile, { force: true });
        throw new Error(`${name} emulator failed to start on port ${port} — see ${logPath}.`);
      }

      // Port taken at spawn on a fresh allocation: try the next free
      // candidate, still holding the lock. Never retry the exact port that
      // just failed (start the scan past it) and never re-persist a dead
      // entry that could mislead a concurrent reader.
      await fsp.rm(registryFile, { force: true });
      port = await smallestUnused(await usedPorts(registryRoot), port + 1);
    }
  } finally {
    await release();
  }
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
