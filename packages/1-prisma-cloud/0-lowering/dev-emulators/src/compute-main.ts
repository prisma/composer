/**
 * The Compute emulator daemon (local-dev spec § 2 `compute-main.ts`): a small
 * local counterpart of the platform's compute service. Owns service child
 * processes (spawned `bun bootstrap.js` from a real packaged artifact),
 * supervises them (crash backoff, held after repeated fast crashes), and
 * serves a loopback JSON admin API plus per-service log streaming.
 *
 * Runs as its own OS process, started by `daemon.ts`'s `ensureDaemon` via
 * `process.execPath <this file> --port <n> --state-dir <dir>`. Everything it
 * needs travels on argv and each request's own body — it reads no
 * environment variable of its own.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import getPort, { portNumbers } from 'get-port';
import { readOwnVersion } from './daemon.ts';
import { isValidSegment } from './segments.ts';
import { readJsonFile, StateFile } from './state-file.ts';

const MIN_SERVICE_PORT = 3000;
const MAX_SERVICE_PORT = 65_535;
const TERMINATE_GRACE_MS = 5000;
const STABLE_UPTIME_MS = 30_000;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const MAX_CONSECUTIVE_FAST_EXITS = 5;
const LOG_POLL_INTERVAL_MS = 100;
const APPS_STATE_MODE = 0o600;

const BUN_NOT_FOUND_MESSAGE =
  'local dev runs services under bun — the Prisma Compute runtime — and `bun` was not found on PATH. Install it: https://bun.sh.';

type ServiceStatus = 'running' | 'backoff' | 'held' | 'stopped';

interface ServiceRecord {
  id: string;
  address: string;
  port: number;
  status: ServiceStatus;
  pid?: number;
  lastExitCode?: number;
  artifactHash?: string;
  artifactDir?: string;
  env?: Record<string, string>;
  readonly logPath: string;
}

interface AppRecord {
  services: Record<string, ServiceRecord>;
}

type AppsState = Record<string, AppRecord>;

function isServiceStatus(value: unknown): value is ServiceStatus {
  return value === 'running' || value === 'backoff' || value === 'held' || value === 'stopped';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

function isServiceRecord(value: unknown): value is ServiceRecord {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || typeof value.id !== 'string') return false;
  if (!('address' in value) || typeof value.address !== 'string') return false;
  if (!('port' in value) || typeof value.port !== 'number') return false;
  if (!('status' in value) || !isServiceStatus(value.status)) return false;
  if (!('logPath' in value) || typeof value.logPath !== 'string') return false;
  if ('pid' in value && value.pid !== undefined && typeof value.pid !== 'number') return false;
  if (
    'lastExitCode' in value &&
    value.lastExitCode !== undefined &&
    typeof value.lastExitCode !== 'number'
  ) {
    return false;
  }
  if (
    'artifactHash' in value &&
    value.artifactHash !== undefined &&
    typeof value.artifactHash !== 'string'
  ) {
    return false;
  }
  if (
    'artifactDir' in value &&
    value.artifactDir !== undefined &&
    typeof value.artifactDir !== 'string'
  ) {
    return false;
  }
  if ('env' in value && value.env !== undefined && !isStringRecord(value.env)) return false;
  return true;
}

function isAppRecord(value: unknown): value is AppRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'services' in value &&
    typeof value.services === 'object' &&
    value.services !== null &&
    Object.values(value.services).every(isServiceRecord)
  );
}

function isAppsState(value: unknown): value is AppsState {
  return typeof value === 'object' && value !== null && Object.values(value).every(isAppRecord);
}

interface DeploymentBody {
  readonly address: string;
  readonly artifactDir: string;
  readonly artifactHash: string;
  readonly env: Record<string, string>;
  readonly port: number;
}

function isDeploymentBody(value: unknown): value is DeploymentBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'address' in value &&
    typeof value.address === 'string' &&
    'artifactDir' in value &&
    typeof value.artifactDir === 'string' &&
    'artifactHash' in value &&
    typeof value.artifactHash === 'string' &&
    'env' in value &&
    isStringRecord(value.env) &&
    'port' in value &&
    typeof value.port === 'number'
  );
}

/** Live, non-persisted bookkeeping for one service — the child handle and its supervision counters. */
interface RuntimeInfo {
  child: ChildProcess | undefined;
  consecutiveFastExits: number;
  startedAt: number | undefined;
  stableTimer: NodeJS.Timeout | undefined;
  backoffTimer: NodeJS.Timeout | undefined;
  expectedExit: boolean;
  log: ServiceLog | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Append-only per-service log file — child stdout/stderr plus `[emulator]` supervision lines. No rotation in v1. */
class ServiceLog {
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

  /** Closes the fd if one was ever opened. Idempotent. */
  close(): void {
    if (this.fd === undefined) return;
    fs.closeSync(this.fd);
    this.fd = undefined;
  }
}

function parseArgs(argv: readonly string[]): { readonly port: number; readonly stateDir: string } {
  let port: number | undefined;
  let stateDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[i + 1]);
    else if (argv[i] === '--state-dir') stateDir = argv[i + 1];
  }
  if (port === undefined || Number.isNaN(port)) {
    throw new Error('compute-main: --port <n> is required');
  }
  if (stateDir === undefined) {
    throw new Error('compute-main: --state-dir <dir> is required');
  }
  return { port, stateDir };
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
  const { port, stateDir } = parseArgs(process.argv.slice(2));
  const ownVersion = readOwnVersion();
  const appsJsonPath = path.join(stateDir, 'apps.json');
  const stateFile = new StateFile<AppsState>(appsJsonPath, APPS_STATE_MODE);

  let state: AppsState = {};
  const runtimes = new Map<string, RuntimeInfo>();

  function runtimeKey(app: string, id: string): string {
    return `${app}/${id}`;
  }

  function getRuntime(app: string, id: string): RuntimeInfo {
    const key = runtimeKey(app, id);
    let rt = runtimes.get(key);
    if (!rt) {
      rt = {
        child: undefined,
        consecutiveFastExits: 0,
        startedAt: undefined,
        stableTimer: undefined,
        backoffTimer: undefined,
        expectedExit: false,
        log: undefined,
      };
      runtimes.set(key, rt);
    }
    return rt;
  }

  function serviceLogPath(app: string, id: string): string {
    return path.join(stateDir, 'logs', app, `${id}.log`);
  }

  function getLog(app: string, id: string, logPath: string): ServiceLog {
    const rt = getRuntime(app, id);
    if (!rt.log) rt.log = new ServiceLog(logPath);
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

  function usedServicePorts(): Set<number> {
    const ports = new Set<number>();
    for (const app of Object.values(state)) {
      for (const svc of Object.values(app.services)) ports.add(svc.port);
    }
    return ports;
  }

  /**
   * The smallest genuinely free port at or above `MIN_SERVICE_PORT`,
   * excluding this daemon's own persisted allocations — persistence and
   * the range policy stay ours; whether a candidate is actually bindable
   * is `get-port`'s (spec § 2's dependency razor).
   */
  async function smallestUnusedServicePort(): Promise<number> {
    return getPort({
      port: portNumbers(MIN_SERVICE_PORT, MAX_SERVICE_PORT),
      exclude: usedServicePorts(),
    });
  }

  async function getOrCreateService(app: string, id: string): Promise<ServiceRecord> {
    let appRec = state[app];
    if (!appRec) {
      appRec = { services: {} };
      state[app] = appRec;
    }
    let svc = appRec.services[id];
    if (svc) return svc;
    svc = {
      id,
      address: id,
      port: await smallestUnusedServicePort(),
      status: 'stopped',
      logPath: serviceLogPath(app, id),
    };
    appRec.services[id] = svc;
    schedulePersist();
    return svc;
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
    app: string,
    id: string,
    svc: ServiceRecord,
    rt: RuntimeInfo,
    code: number | null,
  ): void {
    clearStableTimer(rt);
    rt.child = undefined;
    delete svc.pid;
    if (code !== null) svc.lastExitCode = code;

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
      svc.status = 'held';
      schedulePersist();
      getLog(app, id, svc.logPath).writeLine(
        `[emulator] held after ${String(MAX_CONSECUTIVE_FAST_EXITS)} consecutive fast exits — send a new deployment to resume`,
      );
      return;
    }

    const delayMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attemptNumber);
    svc.status = 'backoff';
    schedulePersist();
    getLog(app, id, svc.logPath).writeLine(
      `[emulator] exited (code ${code === null ? 'null' : String(code)}) — restarting in ${String(delayMs / 1000)}s`,
    );
    rt.backoffTimer = setTimeout(() => {
      rt.backoffTimer = undefined;
      void spawnService(app, id, svc, rt);
    }, delayMs);
  }

  interface SpawnResult {
    readonly ok: boolean;
    readonly message?: string;
  }

  async function spawnService(
    app: string,
    id: string,
    svc: ServiceRecord,
    rt: RuntimeInfo,
  ): Promise<SpawnResult> {
    const env = svc.env ?? {};
    const artifactDir = svc.artifactDir ?? '.';
    const bunPath = resolveBunOnPath(env);
    if (!bunPath) {
      svc.status = 'stopped';
      delete svc.pid;
      schedulePersist();
      return { ok: false, message: BUN_NOT_FOUND_MESSAGE };
    }

    const log = getLog(app, id, svc.logPath);
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
    child.on('exit', (code) => handleChildExit(app, id, svc, rt, code));

    svc.status = 'running';
    if (child.pid !== undefined) svc.pid = child.pid;
    schedulePersist();
    return { ok: true };
  }

  async function stopService(svc: ServiceRecord, rt: RuntimeInfo): Promise<void> {
    clearBackoffTimer(rt);
    clearStableTimer(rt);
    await killChild(rt, TERMINATE_GRACE_MS);
    svc.status = 'stopped';
    delete svc.pid;
    schedulePersist();
  }

  /**
   * The session-resume signal: Alchemy's no-op reconcile never fires a
   * deployment PUT, so nothing else restarts a service a previous session
   * stopped. Reuses the exact deployment-PUT start rules — same spawn
   * path, same supervision reset, and an explicit resume clears `held`
   * the same way a deployment PUT does — but from the service's already
   * STORED deployment spec, since no new one arrives with a start.
   */
  async function startService(app: string, id: string, svc: ServiceRecord): Promise<void> {
    if (svc.artifactHash === undefined) return; // never deployed — nothing to start
    if (svc.status === 'running') return; // idempotent — already up
    const rt = getRuntime(app, id);
    clearBackoffTimer(rt);
    clearStableTimer(rt);
    rt.consecutiveFastExits = 0;
    await spawnService(app, id, svc, rt);
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

  function badSegment(res: http.ServerResponse, segment: string): void {
    text(
      res,
      400,
      `invalid path segment "${segment}": must match /^[a-z0-9][a-z0-9-]*$/ and be at most 63 characters`,
    );
  }

  function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function serviceView(svc: ServiceRecord): unknown {
    return {
      id: svc.id,
      address: svc.address,
      port: svc.port,
      url: `http://localhost:${String(svc.port)}`,
      status: svc.status,
      ...(svc.pid !== undefined ? { pid: svc.pid } : {}),
      ...(svc.lastExitCode !== undefined ? { lastExitCode: svc.lastExitCode } : {}),
      ...(svc.artifactHash !== undefined ? { artifactHash: svc.artifactHash } : {}),
      logPath: svc.logPath,
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
    app: string,
    id: string,
  ): Promise<void> {
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return text(res, 400, 'malformed JSON body');
    }
    if (!isDeploymentBody(parsed)) return text(res, 400, 'malformed deployment body');

    const svc = await getOrCreateService(app, id);
    const rt = getRuntime(app, id);

    const changed = svc.artifactHash !== parsed.artifactHash || !envEquals(svc.env, parsed.env);

    if (svc.status === 'running') {
      if (!changed) {
        // A true no-op: nothing about this service's persisted record
        // changes, so nothing is mutated here either — nothing to persist.
        res.writeHead(204);
        res.end();
        return;
      }
      await killChild(rt, TERMINATE_GRACE_MS);
    } else {
      clearBackoffTimer(rt);
    }

    svc.address = parsed.address;
    svc.port = parsed.port;
    clearStableTimer(rt);
    rt.consecutiveFastExits = 0;
    svc.artifactHash = parsed.artifactHash;
    svc.env = parsed.env;
    svc.artifactDir = parsed.artifactDir;
    schedulePersist();

    const result = await spawnService(app, id, svc, rt);
    if (!result.ok) {
      return text(res, 500, result.message ?? 'failed to start the service');
    }
    res.writeHead(204);
    res.end();
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
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    const tick = (): void => {
      if (stopped) return;
      let stat: fs.Stats | undefined;
      try {
        stat = fs.statSync(logPath);
      } catch {
        stat = undefined;
      }
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

    if (segments[0] === 'apps' && segments.length >= 2) {
      const app = segments[1];
      if (app === undefined || !isValidSegment(app)) return badSegment(res, app ?? '');

      if (method === 'PUT' && segments.length === 4 && segments[2] === 'services') {
        const id = segments[3];
        if (id === undefined || !isValidSegment(id)) return badSegment(res, id ?? '');
        const svc = await getOrCreateService(app, id);
        return json(res, 200, { port: svc.port, url: `http://localhost:${String(svc.port)}` });
      }

      if (
        method === 'PUT' &&
        segments.length === 5 &&
        segments[2] === 'services' &&
        segments[4] === 'deployment'
      ) {
        const id = segments[3];
        if (id === undefined || !isValidSegment(id)) return badSegment(res, id ?? '');
        return handleDeployment(req, res, app, id);
      }

      if (method === 'GET' && segments.length === 3 && segments[2] === 'services') {
        const appRec = state[app];
        const list = appRec ? Object.values(appRec.services).map(serviceView) : [];
        return json(res, 200, list);
      }

      if (
        method === 'GET' &&
        segments.length === 5 &&
        segments[2] === 'services' &&
        segments[4] === 'logs'
      ) {
        const id = segments[3];
        if (id === undefined || !isValidSegment(id)) return badSegment(res, id ?? '');
        const svc = state[app]?.services[id];
        if (!svc) return text(res, 404, `no such service "${id}" in app "${app}"`);
        if (url.searchParams.get('follow') === '1') {
          const tailParam = url.searchParams.get('tail');
          const tailLines =
            tailParam === null ? 0 : Math.max(0, Number.parseInt(tailParam, 10) || 0);
          handleFollowLogs(res, svc.logPath, tailLines);
          return;
        }
        const content = fs.existsSync(svc.logPath) ? fs.readFileSync(svc.logPath) : Buffer.alloc(0);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(content);
        return;
      }

      if (method === 'POST' && segments.length === 3 && segments[2] === 'stop') {
        const appRec = state[app];
        if (appRec) {
          await Promise.all(
            Object.entries(appRec.services).map(([id, svc]) =>
              stopService(svc, getRuntime(app, id)),
            ),
          );
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === 'POST' && segments.length === 3 && segments[2] === 'start') {
        const appRec = state[app];
        if (appRec) {
          await Promise.all(
            Object.entries(appRec.services).map(([id, svc]) => startService(app, id, svc)),
          );
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === 'DELETE' && segments.length === 2) {
        const appRec = state[app];
        if (appRec) {
          await Promise.all(
            Object.entries(appRec.services).map(([id, svc]) =>
              stopService(svc, getRuntime(app, id)),
            ),
          );
          for (const id of Object.keys(appRec.services)) {
            const key = runtimeKey(app, id);
            runtimes.get(key)?.log?.close();
            runtimes.delete(key);
          }
          delete state[app];
          schedulePersist();
        }
        await fs.promises.rm(path.join(stateDir, 'logs', app), { recursive: true, force: true });
        res.writeHead(204);
        res.end();
        return;
      }
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

  readJsonFile(appsJsonPath, isAppsState)
    .then((loaded) => {
      if (loaded) {
        // A fresh process has no live children to supervise. `held` is an
        // operator-visible signal and survives; `running`/`backoff` assumed a
        // child this process never spawned, so they reset to `stopped` — the
        // next deployment PUT always starts fresh (spec's "ALWAYS starts").
        for (const appRec of Object.values(loaded)) {
          for (const svc of Object.values(appRec.services)) {
            if (svc.status === 'running' || svc.status === 'backoff') {
              svc.status = 'stopped';
              delete svc.pid;
            }
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

main();
