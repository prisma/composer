/**
 * The Compute emulator daemon (local-dev spec § 2 `compute-main.ts`): a small
 * local counterpart of the platform's compute service. Holds service
 * instances under ids it generates, owns their child processes (spawned
 * `bun bootstrap.js` from a real packaged artifact), supervises them (crash
 * backoff, held after repeated fast crashes), and serves a loopback JSON
 * admin API plus per-instance log streaming. An instance's labels are its
 * creator's to read: they are stored and returned verbatim, never
 * interpreted.
 *
 * Runs as its own OS process, started by `daemon.ts`'s `ensureDaemon` via
 * `process.execPath <this file> --port <n> --state-dir <dir>`. Everything it
 * needs travels on argv and each request's own body — it reads no
 * environment variable of its own.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import getPort, { clearLockedPorts, portNumbers } from 'get-port';
import { readOwnVersion, SERVICE_READY_TIMEOUT_ENV } from './daemon.ts';
import { readJsonFile, StateFile } from './state-file.ts';

const MIN_SERVICE_PORT = 3000;
const MAX_SERVICE_PORT = 65_535;
const TERMINATE_GRACE_MS = 5000;
const STABLE_UPTIME_MS = 30_000;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const MAX_CONSECUTIVE_FAST_EXITS = 5;
const LOG_POLL_INTERVAL_MS = 100;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 50;
const READY_PROBE_TIMEOUT_MS = 1000;
const STATE_MODE = 0o600;

const BUN_NOT_FOUND_MESSAGE =
  'local dev runs services under bun — the Prisma Compute runtime — and `bun` was not found on PATH. Install it: https://bun.sh.';

type InstanceStatus = 'running' | 'backoff' | 'held' | 'stopped';

interface InstanceRecord {
  readonly id: string;
  readonly labels: Record<string, string>;
  /** Held from creation until the instance is deleted, running or stopped: a deployment's env carries it. */
  readonly port: number;
  status: InstanceStatus;
  pid?: number;
  lastExitCode?: number;
  artifactHash?: string;
  artifactDir?: string;
  env?: Record<string, string>;
  /** `false` when the service does not listen on its port: it is `running` once spawned. */
  listens?: boolean;
  readonly logPath: string;
}

interface InstancesState {
  instances: Record<string, InstanceRecord>;
}

const INSTANCE_ID_RE = /^svc_[0-9a-f]{16}$/;

function newInstanceId(): string {
  return `svc_${randomBytes(8).toString('hex')}`;
}

function isInstanceStatus(value: unknown): value is InstanceStatus {
  return value === 'running' || value === 'backoff' || value === 'held' || value === 'stopped';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

function isPort(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SERVICE_PORT
  );
}

function isOptional(value: object, key: string, check: (field: unknown) => boolean): boolean {
  return !(key in value) || Reflect.get(value, key) === undefined || check(Reflect.get(value, key));
}

function isInstanceRecord(value: unknown): value is InstanceRecord {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || typeof value.id !== 'string') return false;
  if (!('labels' in value) || !isStringRecord(value.labels)) return false;
  if (!('port' in value) || !isPort(value.port)) return false;
  if (!('status' in value) || !isInstanceStatus(value.status)) return false;
  if (!('logPath' in value) || typeof value.logPath !== 'string') return false;
  return (
    isOptional(value, 'pid', (v) => typeof v === 'number') &&
    isOptional(value, 'lastExitCode', (v) => typeof v === 'number') &&
    isOptional(value, 'artifactHash', (v) => typeof v === 'string') &&
    isOptional(value, 'artifactDir', (v) => typeof v === 'string') &&
    isOptional(value, 'env', isStringRecord) &&
    isOptional(value, 'listens', (v) => typeof v === 'boolean')
  );
}

function isInstancesState(value: unknown): value is InstancesState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'instances' in value &&
    typeof value.instances === 'object' &&
    value.instances !== null &&
    Object.values(value.instances).every(isInstanceRecord)
  );
}

interface CreateBody {
  readonly labels: Record<string, string>;
  readonly port?: number;
}

function isCreateBody(value: unknown): value is CreateBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'labels' in value &&
    isStringRecord(value.labels) &&
    isOptional(value, 'port', isPort)
  );
}

interface DeploymentBody {
  readonly artifactDir: string;
  readonly artifactHash: string;
  readonly env: Record<string, string>;
  readonly listens?: boolean;
}

function isDeploymentBody(value: unknown): value is DeploymentBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'artifactDir' in value &&
    typeof value.artifactDir === 'string' &&
    'artifactHash' in value &&
    typeof value.artifactHash === 'string' &&
    'env' in value &&
    isStringRecord(value.env) &&
    (!('listens' in value) || value.listens === undefined || typeof value.listens === 'boolean')
  );
}

interface IdsBody {
  readonly ids: readonly string[];
}

function isIdsBody(value: unknown): value is IdsBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ids' in value &&
    Array.isArray(value.ids) &&
    value.ids.every((id) => typeof id === 'string')
  );
}

/** Live, non-persisted bookkeeping for one instance — the child handle and its supervision counters. */
interface RuntimeInfo {
  child: ChildProcess | undefined;
  consecutiveFastExits: number;
  startedAt: number | undefined;
  stableTimer: NodeJS.Timeout | undefined;
  backoffTimer: NodeJS.Timeout | undefined;
  expectedExit: boolean;
  log: InstanceLog | undefined;
  /** The start in flight, until its child accepts connections or fails to. A newer start or a stop replaces or clears it. */
  start: InFlightStart | undefined;
  /** A stop still waiting for its child to exit. A start waits for it, so it never spawns beside a dying child. */
  stopping: Promise<void> | undefined;
  /** Set when the instance is being deleted: no start may spawn on this runtime again. */
  deleted: boolean;
}

interface InFlightStart {
  readonly token: object;
  readonly fresh: boolean;
  readonly result: Promise<SpawnResult>;
}

interface SpawnResult {
  readonly ok: boolean;
  readonly message?: string;
}

type ReadyOutcome =
  | { readonly kind: 'listening' }
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: 'timed-out' };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Append-only per-instance log file — child stdout/stderr plus `[emulator]` supervision lines. No rotation in v1. */
class InstanceLog {
  private fd: number | undefined;

  constructor(private readonly filePath: string) {}

  private ensureOpen(): number {
    if (this.fd === undefined) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.fd = fs.openSync(this.filePath, 'a');
    }
    return this.fd;
  }

  writeRaw(chunk: Buffer): void {
    fs.writeSync(this.ensureOpen(), chunk);
  }

  writeLine(line: string): void {
    fs.writeSync(this.ensureOpen(), `${line}\n`);
  }

  /** Empties the file — a fresh start begins a clean log; past sessions' and past deployments' output is not kept. */
  clear(): void {
    fs.ftruncateSync(this.ensureOpen(), 0);
  }

  /** Closes the fd if one was ever opened. Idempotent. */
  close(): void {
    if (this.fd === undefined) return;
    fs.closeSync(this.fd);
    this.fd = undefined;
  }
}

function parseArgs(argv: readonly string[]): {
  readonly port: number;
  readonly stateDir: string;
  readonly readyTimeoutMs: number;
} {
  let port: number | undefined;
  let stateDir: string | undefined;
  let readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[i + 1]);
    else if (argv[i] === '--state-dir') stateDir = argv[i + 1];
    else if (argv[i] === '--ready-timeout-ms') readyTimeoutMs = Number(argv[i + 1]);
  }
  if (port === undefined || Number.isNaN(port)) {
    throw new Error('compute-main: --port <n> is required');
  }
  if (stateDir === undefined) {
    throw new Error('compute-main: --state-dir <dir> is required');
  }
  if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
    throw new Error('compute-main: --ready-timeout-ms must be a positive number');
  }
  return { port, stateDir, readyTimeoutMs };
}

function acceptsConnection(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(READY_PROBE_TIMEOUT_MS);
    const settle = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}

/** Both loopback families: a service may bind IPv4 only, IPv6 only, or both, and `localhost` in its URL reaches either. */
async function acceptsLoopbackConnection(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([
    acceptsConnection(port, '127.0.0.1'),
    acceptsConnection(port, '::1'),
  ]);
  return v4 || v6;
}

/** Polls `port` until it accepts a connection, the child exits, or `timeoutMs` passes. */
async function waitUntilListening(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
): Promise<ReadyOutcome> {
  let exit: ReadyOutcome | undefined;
  child.once('exit', (code, signal) => {
    exit = { kind: 'exited', code, signal };
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exit) return exit;
    if (await acceptsLoopbackConnection(port)) return exit ?? { kind: 'listening' };
    if (Date.now() >= deadline) return exit ?? { kind: 'timed-out' };
    await sleep(READY_POLL_INTERVAL_MS);
  }
}

/** Resolves `bun` from THIS request's env PATH — never the daemon's own. POSIX-only (Windows is out of scope). */
function resolveBunOnPath(env: Readonly<Record<string, string>>): string | undefined {
  const pathVar = env['PATH'];
  if (!pathVar) return undefined;
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, 'bun');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function main(): void {
  const { port, stateDir, readyTimeoutMs } = parseArgs(process.argv.slice(2));
  const ownVersion = readOwnVersion();
  const statePath = path.join(stateDir, 'instances.json');
  const stateFile = new StateFile<InstancesState>(statePath, STATE_MODE);
  const logsDir = path.join(stateDir, 'logs');

  let state: InstancesState = { instances: {} };
  const runtimes = new Map<string, RuntimeInfo>();
  // Bumped every time a log file is cleared (a fresh start). A live
  // follower watches this rather than the file size, so it resets to the new
  // start reliably — even when the clear and the first new write both land
  // between two of its polls, which a size comparison alone would miss.
  const logGeneration = new Map<string, number>();

  function getRuntime(id: string): RuntimeInfo {
    let rt = runtimes.get(id);
    if (!rt) {
      rt = {
        child: undefined,
        consecutiveFastExits: 0,
        startedAt: undefined,
        stableTimer: undefined,
        backoffTimer: undefined,
        expectedExit: false,
        log: undefined,
        start: undefined,
        stopping: undefined,
        deleted: false,
      };
      runtimes.set(id, rt);
    }
    return rt;
  }

  function getLog(inst: InstanceRecord): InstanceLog {
    const rt = getRuntime(inst.id);
    if (!rt.log) rt.log = new InstanceLog(inst.logPath);
    return rt.log;
  }

  function schedulePersist(): void {
    void stateFile.write(state);
  }

  function clearStableTimer(rt: RuntimeInfo): void {
    if (rt.stableTimer) clearTimeout(rt.stableTimer);
    rt.stableTimer = undefined;
  }

  function clearBackoffTimer(rt: RuntimeInfo): void {
    if (rt.backoffTimer) clearTimeout(rt.backoffTimer);
    rt.backoffTimer = undefined;
  }

  function heldPorts(): Set<number> {
    return new Set(Object.values(state.instances).map((inst) => inst.port));
  }

  /**
   * The requested port when no instance holds it and it is bindable,
   * otherwise the smallest such port at or above `MIN_SERVICE_PORT`. Which
   * ports instances hold is ours; whether a candidate is actually bindable is
   * `get-port`'s (spec § 2's dependency razor).
   */
  async function allocatePort(requested: number | undefined): Promise<number> {
    const exclude = heldPorts();
    if (requested !== undefined && !exclude.has(requested)) {
      const given = await getPort({ port: requested, exclude });
      if (given === requested) return given;
    }
    return getPort({ port: portNumbers(MIN_SERVICE_PORT, MAX_SERVICE_PORT), exclude });
  }

  async function createInstance(body: CreateBody): Promise<InstanceRecord> {
    const id = newInstanceId();
    const inst: InstanceRecord = {
      id,
      labels: { ...body.labels },
      port: await allocatePort(body.port),
      status: 'stopped',
      logPath: path.join(logsDir, `${id}.log`),
    };
    state.instances[id] = inst;
    schedulePersist();
    return inst;
  }

  function waitForExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      child.once('exit', () => resolve());
    });
  }

  /** SIGTERM, wait up to `graceMs`, SIGKILL. Marks the exit as expected so supervision doesn't fire. */
  async function killChild(rt: RuntimeInfo, graceMs: number): Promise<void> {
    const child = rt.child;
    if (!child || child.pid === undefined) return;
    rt.expectedExit = true;
    const exited = waitForExit(child);
    child.kill('SIGTERM');
    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      exited.then(() => undefined),
      sleep(graceMs).then(() => timedOut),
    ]);
    if (result === timedOut) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  function handleChildExit(
    inst: InstanceRecord,
    rt: RuntimeInfo,
    child: ChildProcess,
    code: number | null,
  ): void {
    if (child !== rt.child) return;
    clearStableTimer(rt);
    rt.child = undefined;
    delete inst.pid;
    if (code !== null) inst.lastExitCode = code;

    if (rt.expectedExit) {
      rt.expectedExit = false;
      schedulePersist();
      return;
    }

    const uptime = rt.startedAt !== undefined ? Date.now() - rt.startedAt : 0;
    if (uptime >= STABLE_UPTIME_MS) rt.consecutiveFastExits = 0;
    const attemptNumber = rt.consecutiveFastExits;
    if (uptime < STABLE_UPTIME_MS) rt.consecutiveFastExits += 1;

    if (rt.consecutiveFastExits >= MAX_CONSECUTIVE_FAST_EXITS) {
      inst.status = 'held';
      schedulePersist();
      getLog(inst).writeLine(
        `[emulator] held after ${String(MAX_CONSECUTIVE_FAST_EXITS)} consecutive fast exits — send a new deployment to resume`,
      );
      return;
    }

    const delayMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attemptNumber);
    inst.status = 'backoff';
    schedulePersist();
    getLog(inst).writeLine(
      `[emulator] exited (code ${code === null ? 'null' : String(code)}) — restarting in ${String(delayMs / 1000)}s`,
    );
    rt.backoffTimer = setTimeout(() => {
      rt.backoffTimer = undefined;
      // A crash-backoff respawn — keep the crash trail this run has written.
      void spawnInstance(inst, rt, false);
    }, delayMs);
  }

  /** Records `run` as the instance's start in flight, replacing any earlier one. */
  function beginStart(
    rt: RuntimeInfo,
    fresh: boolean,
    run: (token: object) => Promise<SpawnResult>,
  ): Promise<SpawnResult> {
    const token = {};
    const result = run(token).finally(() => {
      if (rt.start?.token === token) rt.start = undefined;
    });
    rt.start = { token, fresh, result };
    return result;
  }

  /** Undefined while `token` is still the instance's start. Otherwise what that start reports: a newer start's result, or "stopped" after a stop or a delete. */
  function supersededOutcome(
    inst: InstanceRecord,
    rt: RuntimeInfo,
    token: object,
  ): Promise<SpawnResult> | undefined {
    if (!rt.deleted && rt.start?.token === token) return undefined;
    if (!rt.deleted && rt.start) return rt.start.result;
    return Promise.resolve({
      ok: false,
      message: `instance "${inst.id}" was stopped before it accepted connections`,
    });
  }

  /**
   * Spawns the instance's child and resolves once it accepts connections on
   * its port — only then is it `running`. A child that exits first, or never
   * listens within the readiness timeout, fails the start with a message
   * naming the instance and its log.
   */
  function spawnInstance(
    inst: InstanceRecord,
    rt: RuntimeInfo,
    /** A fresh start (a deployment or a session resume) begins a clean log; a crash-backoff respawn keeps the run's crash trail. */
    fresh: boolean,
  ): Promise<SpawnResult> {
    return beginStart(rt, fresh, (token) => spawnAndWaitUntilListening(inst, rt, fresh, token));
  }

  async function spawnAndWaitUntilListening(
    inst: InstanceRecord,
    rt: RuntimeInfo,
    fresh: boolean,
    token: object,
  ): Promise<SpawnResult> {
    const env = inst.env ?? {};
    const artifactDir = inst.artifactDir ?? '.';
    const bunPath = resolveBunOnPath(env);
    if (!bunPath) {
      inst.status = 'stopped';
      delete inst.pid;
      schedulePersist();
      return { ok: false, message: BUN_NOT_FOUND_MESSAGE };
    }

    const log = getLog(inst);
    if (fresh) {
      log.clear();
      logGeneration.set(inst.logPath, (logGeneration.get(inst.logPath) ?? 0) + 1);
    }
    const child = spawn(bunPath, ['bootstrap.js'], {
      cwd: artifactDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    rt.child = child;
    rt.expectedExit = false;
    rt.startedAt = Date.now();
    clearStableTimer(rt);
    rt.stableTimer = setTimeout(() => {
      rt.consecutiveFastExits = 0;
    }, STABLE_UPTIME_MS);

    child.stdout?.on('data', (chunk: Buffer) => log.writeRaw(chunk));
    child.stderr?.on('data', (chunk: Buffer) => log.writeRaw(chunk));
    child.on('exit', (code) => handleChildExit(inst, rt, child, code));
    if (child.pid !== undefined) inst.pid = child.pid;
    if (inst.listens === false) {
      inst.status = 'running';
      schedulePersist();
      return { ok: true };
    }
    schedulePersist();

    const port = String(inst.port);
    const outcome = await waitUntilListening(child, inst.port, readyTimeoutMs);
    const superseded = supersededOutcome(inst, rt, token);
    if (superseded) return superseded;
    const instance = `instance "${inst.id}"`;
    if (outcome.kind === 'exited') {
      const how =
        outcome.code !== null ? `code ${String(outcome.code)}` : (outcome.signal ?? 'no exit code');
      return {
        ok: false,
        message: `${instance} exited (${how}) before it accepted connections on its port ${port}. Its log: ${inst.logPath}`,
      };
    }
    if (outcome.kind === 'timed-out') {
      const seconds = String(readyTimeoutMs / 1000);
      const message = `${instance} did not accept connections on its port ${port} within ${seconds}s. Its log: ${inst.logPath}. If it needs longer to start, set ${SERVICE_READY_TIMEOUT_ENV} (milliseconds) and restart the compute emulator. If it never listens on its port, deploy it with listens: false.`;
      if (fresh) {
        log.writeLine(
          `[emulator] did not accept connections on port ${port} within ${seconds}s — stopped`,
        );
        await stopInstance(inst, rt);
      } else {
        log.writeLine(
          `[emulator] restart did not accept connections on port ${port} within ${seconds}s — held; send a new deployment to resume`,
        );
        await stopInstance(inst, rt, 'held');
      }
      return { ok: false, message };
    }
    inst.status = 'running';
    schedulePersist();
    return { ok: true };
  }

  async function stopInstance(
    inst: InstanceRecord,
    rt: RuntimeInfo,
    finalStatus: 'stopped' | 'held' = 'stopped',
  ): Promise<void> {
    rt.start = undefined;
    clearBackoffTimer(rt);
    clearStableTimer(rt);
    const stopping = killChild(rt, TERMINATE_GRACE_MS).then(() => {
      inst.status = finalStatus;
      delete inst.pid;
      schedulePersist();
    });
    rt.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (rt.stopping === stopping) rt.stopping = undefined;
    }
  }

  async function stopsFinished(rt: RuntimeInfo): Promise<void> {
    while (rt.stopping) await rt.stopping;
  }

  /**
   * The session-resume signal: Alchemy's no-op reconcile never fires a
   * deployment PUT, so nothing else restarts an instance a previous session
   * stopped. Reuses the exact deployment-PUT start rules — same spawn
   * path, same supervision reset, and an explicit resume clears `held`
   * the same way a deployment PUT does — but from the instance's already
   * STORED deployment, since no new one arrives with a start.
   */
  async function startInstance(inst: InstanceRecord): Promise<SpawnResult> {
    if (inst.artifactHash === undefined) return { ok: true }; // never deployed — nothing to start
    const rt = getRuntime(inst.id);
    if (rt.start) return rt.start.result;
    if (inst.status === 'running' && rt.stopping === undefined) return { ok: true }; // already up
    // A session resume is a fresh start — begin a clean log.
    return beginStart(rt, true, async (token) => {
      clearBackoffTimer(rt);
      await stopsFinished(rt);
      const superseded = supersededOutcome(inst, rt, token);
      if (superseded) return superseded;
      clearStableTimer(rt);
      rt.consecutiveFastExits = 0;
      return spawnAndWaitUntilListening(inst, rt, true, token);
    });
  }

  async function deleteInstance(inst: InstanceRecord): Promise<void> {
    const rt = getRuntime(inst.id);
    rt.deleted = true;
    await stopInstance(inst, rt);
    rt.log?.close();
    runtimes.delete(inst.id);
    delete state.instances[inst.id];
    schedulePersist();
    // get-port holds every port it returns for up to 30 seconds; the freed
    // port must be free again for an instance created right after.
    // `heldPorts()` already keeps other instances' ports out.
    clearLockedPorts();
    await fs.promises.rm(inst.logPath, { force: true });
  }

  // ——— HTTP plumbing ———

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  }

  function text(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  function noContent(res: http.ServerResponse): void {
    res.writeHead(204);
    res.end();
  }

  function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const raw = await readBody(req);
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return undefined;
    }
  }

  function instanceView(inst: InstanceRecord): unknown {
    return {
      id: inst.id,
      labels: inst.labels,
      port: inst.port,
      url: `http://localhost:${String(inst.port)}`,
      status: inst.status,
      ...(inst.pid !== undefined ? { pid: inst.pid } : {}),
      ...(inst.lastExitCode !== undefined ? { lastExitCode: inst.lastExitCode } : {}),
      ...(inst.artifactHash !== undefined ? { artifactHash: inst.artifactHash } : {}),
      logPath: inst.logPath,
    };
  }

  function envEquals(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
    if (!a) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => a[k] === b[k]);
  }

  async function handleDeployment(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    inst: InstanceRecord,
  ): Promise<void> {
    const body = await readJsonBody(req);
    if (!isDeploymentBody(body)) return text(res, 400, 'malformed deployment body');

    const rt = getRuntime(inst.id);
    const listens = body.listens ?? true;
    const changed =
      inst.artifactHash !== body.artifactHash ||
      !envEquals(inst.env, body.env) ||
      (inst.listens ?? true) !== listens;

    let result: SpawnResult;
    if (!changed && rt.start?.fresh === true) {
      // The same deployment is already starting: answer when it does.
      result = await rt.start.result;
    } else if (
      !changed &&
      rt.start === undefined &&
      rt.stopping === undefined &&
      inst.status === 'running'
    ) {
      // A true no-op: nothing about this instance's persisted record
      // changes, so nothing is mutated here either — nothing to persist.
      result = { ok: true };
    } else {
      inst.artifactHash = body.artifactHash;
      inst.env = body.env;
      inst.artifactDir = body.artifactDir;
      inst.listens = listens;
      clearBackoffTimer(rt);
      schedulePersist();
      // A new or changed deployment, or an instance that is not up: a fresh
      // start with a clean log, once the old process (if any) has exited.
      result = await beginStart(rt, true, async (token) => {
        await stopsFinished(rt);
        await killChild(rt, TERMINATE_GRACE_MS);
        const superseded = supersededOutcome(inst, rt, token);
        if (superseded) return superseded;
        inst.status = 'stopped';
        delete inst.pid;
        clearStableTimer(rt);
        rt.consecutiveFastExits = 0;
        return spawnAndWaitUntilListening(inst, rt, true, token);
      });
    }
    if (!result.ok) {
      return text(res, 500, result.message ?? 'failed to start the instance');
    }
    noContent(res);
  }

  /** Byte offset a follow should start at to show the last `tailLines` complete lines; `<= 0` (or an empty file) starts at the current end, no backlog. */
  function startOffsetForTail(logPath: string, tailLines: number): number {
    let size = 0;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      return 0;
    }
    if (tailLines <= 0 || size === 0) return size;
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      // Walk back from the end counting line boundaries; the byte after the
      // Nth newline from the end begins the last N lines. A trailing newline
      // terminates the final line and is not itself a boundary to count.
      let seen = 0;
      for (let i = size - 1; i >= 0; i -= 1) {
        if (buf[i] !== 0x0a) continue;
        if (i === size - 1) continue;
        seen += 1;
        if (seen === tailLines) return i + 1;
      }
      return 0;
    } finally {
      fs.closeSync(fd);
    }
  }

  function handleFollowLogs(res: http.ServerResponse, logPath: string, tailLines: number): void {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath)) fs.closeSync(fs.openSync(logPath, 'a'));

    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    // Start at the last `tailLines` complete lines, or at the current end when
    // none are asked for — a follow with no backlog must not replay the whole
    // (unrotated, session-spanning) file.
    let offset = startOffsetForTail(logPath, tailLines);
    let generation = logGeneration.get(logPath) ?? 0;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    const tick = (): void => {
      if (stopped) return;
      // A fresh start cleared the file — resume from its new beginning.
      // Watching the clear generation (not just a size decrease) catches it
      // even when the clear and the first new write both land between two
      // ticks.
      const currentGeneration = logGeneration.get(logPath) ?? 0;
      if (currentGeneration !== generation) {
        generation = currentGeneration;
        offset = 0;
      }
      let stat: fs.Stats | undefined;
      try {
        stat = fs.statSync(logPath);
      } catch {
        stat = undefined;
      }
      if (stat && stat.size < offset) offset = 0;
      if (stat && stat.size > offset) {
        const fd = fs.openSync(logPath, 'r');
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        res.write(buf);
      }
      if (!stopped) timer = setTimeout(tick, LOG_POLL_INTERVAL_MS);
    };
    tick();

    const stop = (): void => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    res.on('close', stop);
  }

  function handleLogs(url: URL, res: http.ServerResponse, inst: InstanceRecord): void {
    if (url.searchParams.get('follow') === '1') {
      const tailParam = url.searchParams.get('tail');
      const tailLines = tailParam === null ? 0 : Math.max(0, Number.parseInt(tailParam, 10) || 0);
      handleFollowLogs(res, inst.logPath, tailLines);
      return;
    }
    const content = fs.existsSync(inst.logPath) ? fs.readFileSync(inst.logPath) : Buffer.alloc(0);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(content);
  }

  /** The instances `ids` name, or the ids no instance has. */
  function instancesByIds(
    ids: readonly string[],
  ): { readonly found: InstanceRecord[] } | { readonly unknown: string[] } {
    const unknown = ids.filter((id) => state.instances[id] === undefined);
    if (unknown.length > 0) return { unknown };
    return { found: ids.flatMap((id) => state.instances[id] ?? []) };
  }

  function unknownInstances(res: http.ServerResponse, ids: readonly string[]): void {
    text(res, 404, `no such instance: ${ids.map((id) => `"${id}"`).join(', ')}`);
  }

  async function handleBulk(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    action: 'start' | 'stop',
  ): Promise<void> {
    const body = await readJsonBody(req);
    if (!isIdsBody(body)) return text(res, 400, 'malformed body: expected { "ids": string[] }');
    if (action === 'stop') {
      // An unknown instance runs nothing, so stopping it is already done.
      const known = body.ids.flatMap((id) => state.instances[id] ?? []);
      await Promise.all(known.map((inst) => stopInstance(inst, getRuntime(inst.id))));
      return noContent(res);
    }
    const selected = instancesByIds(body.ids);
    if ('unknown' in selected) return unknownInstances(res, selected.unknown);
    const results = await Promise.all(selected.found.map(startInstance));
    const failures = results.flatMap((r) => (r.ok ? [] : [r.message ?? 'failed to start']));
    if (failures.length > 0) return text(res, 500, failures.join('\n'));
    noContent(res);
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`);
    const method = req.method ?? 'GET';
    const segments = url.pathname
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));

    if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
      return json(res, 200, { version: ownVersion });
    }

    if (segments[0] !== 'instances') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (segments.length === 1) {
      if (method === 'GET') return json(res, 200, Object.values(state.instances).map(instanceView));
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!isCreateBody(body)) {
          return text(
            res,
            400,
            'malformed body: expected { "labels": Record<string, string>, "port"?: number }',
          );
        }
        return json(res, 201, instanceView(await createInstance(body)));
      }
    }

    if (method === 'POST' && segments.length === 2 && segments[1] === 'start') {
      return handleBulk(req, res, 'start');
    }
    if (method === 'POST' && segments.length === 2 && segments[1] === 'stop') {
      return handleBulk(req, res, 'stop');
    }

    const id = segments[1];
    if (id !== undefined && !INSTANCE_ID_RE.test(id)) {
      return text(res, 400, `invalid instance id "${id}"`);
    }
    const inst = id === undefined ? undefined : state.instances[id];

    if (method === 'DELETE' && segments.length === 2) {
      if (inst) await deleteInstance(inst);
      return noContent(res);
    }
    if (!inst) return unknownInstances(res, id === undefined ? [] : [id]);

    if (method === 'GET' && segments.length === 2) return json(res, 200, instanceView(inst));
    if (method === 'PUT' && segments.length === 3 && segments[2] === 'deployment') {
      return handleDeployment(req, res, inst);
    }
    if (method === 'GET' && segments.length === 3 && segments[2] === 'logs') {
      return handleLogs(url, res, inst);
    }

    res.writeHead(404);
    res.end();
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(err instanceof Error ? err.message : String(err));
    });
  });

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const kills: Promise<void>[] = [];
    for (const rt of runtimes.values()) {
      clearBackoffTimer(rt);
      clearStableTimer(rt);
      if (rt.child) kills.push(killChild(rt, TERMINATE_GRACE_MS));
    }
    await Promise.all(kills);
    // Wait for every already-queued state write to actually land on disk —
    // otherwise a SIGTERM racing an in-flight write (e.g. an ensureDaemon
    // version-skew restart) can silently lose it.
    await stateFile.flush();
    server.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  discardStateFromEarlierVersions(stateDir, statePath, logsDir)
    .then(() => readJsonFile(statePath, isInstancesState))
    .then((loaded) => {
      if (loaded) {
        // A fresh process has no live children to supervise. `held` is an
        // operator-visible signal and survives; `running`/`backoff` assumed a
        // child this process never spawned, so they reset to `stopped` — the
        // next deployment PUT always starts fresh (spec's "ALWAYS starts").
        for (const inst of Object.values(loaded.instances)) {
          if (inst.status === 'running' || inst.status === 'backoff') {
            inst.status = 'stopped';
            delete inst.pid;
          }
        }
        state = loaded;
      }
      // A single, unambiguous line into the daemon's own stdio log once
      // actually bound and accepting connections — the daemon's own
      // portable evidence that exactly one instance is listening (tests
      // count occurrences of this line rather than inspecting OS processes,
      // whose command-line rendering/flags differ across platforms).
      server.listen(port, '127.0.0.1', () => {
        console.log(`[dev-emulators] compute-main listening on 127.0.0.1:${String(port)}`);
      });
    })
    .catch((err: unknown) => {
      console.error('compute-main: failed to load state', err);
      process.exit(1);
    });
}

/**
 * Removes state files this version does not write, and log directories: an
 * earlier version kept its state in another JSON file and grouped its logs in
 * directories. Local dev state is never migrated across versions; those
 * instances are simply gone.
 */
async function discardStateFromEarlierVersions(
  stateDir: string,
  statePath: string,
  logsDir: string,
): Promise<void> {
  const stateFiles = await fs.promises.readdir(stateDir).catch(() => []);
  await Promise.all(
    stateFiles
      .map((name) => path.join(stateDir, name))
      .filter((file) => file.endsWith('.json') && file !== statePath)
      .map((file) => fs.promises.rm(file, { force: true })),
  );
  const logEntries = await fs.promises.readdir(logsDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    logEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => fs.promises.rm(path.join(logsDir, entry.name), { recursive: true })),
  );
}

main();
