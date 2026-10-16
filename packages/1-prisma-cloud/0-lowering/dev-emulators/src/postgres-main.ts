/**
 * The Postgres emulator daemon (local-dev spec § 2 `postgres-main.ts`): a
 * small local counterpart of hosted Postgres, hosting `@prisma/dev`'s
 * `startPrismaDevServer()` — one named, persistent server per database
 * instance, several servers in this one daemon process. Instances are keyed
 * by ids this daemon generates; a server is named after its instance's id,
 * and `@prisma/dev` keeps its data under that name in its own data
 * directory. Labels are stored and returned verbatim, never interpreted.
 * Stopping an instance shuts its server down and keeps its data and port.
 * Loopback `node:http` JSON admin API; state under its `--state-dir`.
 *
 * `@prisma/dev` is imported dynamically from a CALLER-RESOLVED path (each
 * admin request that needs it carries `prismaDevModulePath`): the local
 * target resolves it from Composer's own `@prisma/composer-prisma-cloud`
 * installation, which declares the version — this daemon has no
 * `@prisma/dev` dependency of its own.
 *
 * Runs as its own OS process, started by `daemon.ts`'s `ensureDaemon` via
 * `process.execPath <this file> --port <n> --state-dir <dir>`.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import getPort, { clearLockedPorts, portNumbers } from 'get-port';
import { isPidAlive, readOwnVersion } from './daemon.ts';
import {
  isStringKeyedRecord,
  portOfUrl,
  type RegistryScanHost,
  registryClaimedPorts,
} from './prisma-dev-registry.ts';
import { readJsonFile, StateFile } from './state-file.ts';

const MIN_DATABASE_PORT = 51_300;
const MAX_DATABASE_PORT = 65_535;
const STATE_MODE = 0o600;
/** Spec § 2 step 5's pattern, applied to a fresh database-port allocation. */
const MAX_FRESH_PORT_CANDIDATES = 5;
/**
 * A name refused as "already running" is retried a few times, each attempt
 * first waiting out the holder: a cold server boot takes seconds, and a
 * crashed holder's lock is only released once proper-lockfile's ~10s stale
 * threshold passes. Bounded so a genuinely stuck name still fails visibly
 * inside the dev command's own startup budget.
 */
const MAX_ALREADY_RUNNING_RETRIES = 2;
const ALREADY_RUNNING_POLLS = 24;
const ALREADY_RUNNING_POLL_MS = 500;

const NOT_INSTALLED_MESSAGE =
  'local dev needs @prisma/dev for its local Postgres emulator, and the given module path did not load; reinstall your dependencies.';

// The behavior contract's no-value-logging rule, applied to embedded
// diagnostics too (spec's diagnostics rule) — masks a connection URL's
// credential wherever server error text might echo one back.
function maskCredentials(text: string): string {
  return text.replace(/:\/\/([^:@/\s]+):[^@/\s]+@/g, '://$1:***@');
}

// A dynamic `import()` failure's message can include the importer's own
// (internal, irrelevant) path on top of the target path; keep only the
// first line, which is where Node/bun put the actual "cannot find X" text.
function firstLine(text: string): string {
  return (text.split('\n')[0] ?? text).trim();
}

interface DatabaseRecord {
  readonly id: string;
  readonly labels: Record<string, string>;
  /** The `@prisma/dev` server's name, which also names its data directory. */
  readonly serverName: string;
  /** Held from creation until the instance is deleted, running or stopped: dependents' environments carry the URL. */
  readonly port: number;
  url: string;
  /** Where the client resolved `@prisma/dev`; every later start and the delete load it from here. */
  prismaDevModulePath: string;
}

interface InstancesState {
  instances: Record<string, DatabaseRecord>;
  /** `@prisma/dev` servers an earlier version of this emulator created, whose data is deleted once a request brings a `@prisma/dev` module to delete it with. */
  discardedServers: string[];
}

const INSTANCE_ID_RE = /^db_[0-9a-f]{16}$/;

function newInstanceId(): string {
  return `db_${randomBytes(8).toString('hex')}`;
}

function serverNameFor(id: string): string {
  return `pcdev-${id}`;
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
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_DATABASE_PORT
  );
}

function isDatabaseRecord(value: unknown): value is DatabaseRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'labels' in value &&
    isStringRecord(value.labels) &&
    'serverName' in value &&
    typeof value.serverName === 'string' &&
    'port' in value &&
    isPort(value.port) &&
    'url' in value &&
    typeof value.url === 'string' &&
    'prismaDevModulePath' in value &&
    typeof value.prismaDevModulePath === 'string'
  );
}

function isInstancesState(value: unknown): value is InstancesState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'instances' in value &&
    typeof value.instances === 'object' &&
    value.instances !== null &&
    Object.values(value.instances).every(isDatabaseRecord) &&
    'discardedServers' in value &&
    Array.isArray(value.discardedServers) &&
    value.discardedServers.every((name) => typeof name === 'string')
  );
}

interface CreateBody {
  readonly labels: Record<string, string>;
  readonly port?: number;
  readonly prismaDevModulePath: string;
}

function isCreateBody(value: unknown): value is CreateBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'labels' in value &&
    isStringRecord(value.labels) &&
    (!('port' in value) || value.port === undefined || isPort(value.port)) &&
    'prismaDevModulePath' in value &&
    typeof value.prismaDevModulePath === 'string'
  );
}

interface StartBody {
  readonly ids: readonly string[];
  readonly prismaDevModulePath: string;
}

function isStartBody(value: unknown): value is StartBody {
  return (
    isIdsBody(value) &&
    'prismaDevModulePath' in value &&
    typeof value.prismaDevModulePath === 'string'
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

/** Every `@prisma/dev` server name an earlier version's state file lists; an unreadable file lists none. */
function serverNamesInEarlierState(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isStringKeyedRecord(parsed)) return [];
  return Object.values(parsed).flatMap((group) => {
    const databases = isStringKeyedRecord(group) ? group['databases'] : undefined;
    if (!isStringKeyedRecord(databases)) return [];
    return Object.values(databases).flatMap((db) => {
      const name = isStringKeyedRecord(db) ? db['instanceName'] : undefined;
      return typeof name === 'string' ? [name] : [];
    });
  });
}

// --- `@prisma/dev`, resolved from the caller-given path -------------------

interface PrismaDevServer {
  close(): Promise<void>;
  readonly database: { readonly connectionString: string };
}

interface PrismaDevServerOptions {
  readonly name?: string;
  readonly databasePort?: number;
  readonly port?: number;
  readonly shadowDatabasePort?: number;
  readonly streamsPort?: number;
  readonly persistenceMode?: 'stateless' | 'stateful';
}

interface PrismaDevModule {
  startPrismaDevServer(options?: PrismaDevServerOptions): Promise<PrismaDevServer>;
}

function isPrismaDevModule(value: unknown): value is PrismaDevModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'startPrismaDevServer' in value &&
    typeof value.startPrismaDevServer === 'function'
  );
}

/**
 * `@prisma/dev` exports a `PortNotAvailableError` class with a `readonly
 * port: number`, but the daemon dynamically imports the module from a
 * caller-given path while the class identity checked here would come from
 * whatever module graph THIS file's own bundle produced — two separate
 * instantiations of the same logical class, so `instanceof` doesn't match
 * across them (confirmed empirically: a real port conflict's `err
 * instanceof mod.PortNotAvailableError` is `false` even though the error IS
 * the port-conflict one). Duck-typing the documented shape — a `port`
 * number matching the candidate we just tried — is what actually survives
 * that boundary.
 */
/**
 * The port a start refusal is about, when it is one of THIS attempt's ports.
 * Duck-typed (`instanceof` fails across the dynamic-import boundary): every
 * `@prisma/dev` port refusal — not-available, requested-twice, and
 * belongs-to-another-server (its registry can claim a port no bind probe
 * sees) — carries the offending port as `.port`, and any of the four ports
 * we requested (database + the three aux listeners) can be the one refused.
 */
function portConflictOf(err: unknown, ports: readonly number[]): number | undefined {
  if (typeof err !== 'object' || err === null || !('port' in err)) return undefined;
  const port = err.port;
  return typeof port === 'number' && ports.includes(port) ? port : undefined;
}

function isNameAlreadyTaken(err: unknown): boolean {
  return (
    isStringKeyedRecord(err) &&
    (err['name'] === 'ServerAlreadyRunningError' || err['name'] === 'ServerStateAlreadyExistsError')
  );
}

/**
 * A dynamic `import()` failure's own message routinely names a SECOND path
 * (e.g. bun's "Cannot find module '<target>' from '<importer>'") — the
 * importer half is this daemon's own internal location, not anything the
 * caller gave us, and has no business in a response body. Rather than try
 * to scrub an arbitrary underlying message for every runtime's own error
 * phrasing, the resolution-failure case names only what the caller
 * supplied — the pinned message plus the given `prismaDevModulePath`, and
 * nothing else. (A DIFFERENT case — a module that resolves fine but whose
 * `startPrismaDevServer()` call itself fails — still surfaces its
 * underlying text verbatim, credential-masked, per spec § 2.)
 */
async function importPrismaDev(prismaDevModulePath: string): Promise<PrismaDevModule> {
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(prismaDevModulePath).href);
  } catch {
    throw new Error(`${NOT_INSTALLED_MESSAGE} (could not resolve "${prismaDevModulePath}")`);
  }
  if (!isPrismaDevModule(mod)) {
    throw new Error(
      `${NOT_INSTALLED_MESSAGE} ("${prismaDevModulePath}" is not a @prisma/dev module)`,
    );
  }
  return mod;
}

interface PrismaDevInternalStateModule extends RegistryScanHost {
  /** Removes the server's persisted state AND its PGlite data. */
  deleteServer(name: string, debug?: boolean): Promise<void>;
  /** Stops the process behind a server's recorded state, leaving its data. */
  killServer(name: string, debug?: boolean): Promise<unknown>;
  /** The server's recorded state — see `ServerStatus` for the fields this daemon reads. */
  getServerStatus(name: string, opts?: unknown): Promise<unknown>;
}

function isPrismaDevInternalStateModule(value: unknown): value is PrismaDevInternalStateModule {
  return (
    isStringKeyedRecord(value) &&
    typeof value['deleteServer'] === 'function' &&
    typeof value['killServer'] === 'function' &&
    typeof value['getServerStatus'] === 'function'
  );
}

/**
 * What `getServerStatus(name)` reports, narrowed to the fields this daemon
 * uses. Verified live against `@prisma/dev`: while a server is up it reports
 * `status: "running"` with the owning process's `pid` and the full
 * `exports.database.connectionString`; after `close()` the same call reports
 * `status: "not_running"` with the record otherwise intact.
 *
 * This is how the daemon learns about a server it does not itself hold — the
 * "already running" error's own `server` accessor resolves to a `ServerState`
 * with no `database` field at all (verified: its own properties are
 * `databaseDumpPath`, `exports`, `experimental`, `pgliteDataDirPath`,
 * `close`, `writeServerDump`), so reading status is both simpler and correct.
 */
interface ServerStatus {
  readonly live: boolean;
  /** False only when the record affirmatively does not exist (`no_such_server`) — an unreadable status counts as existing, so nothing that deletes acts on a misread. */
  readonly recordExists: boolean;
  readonly pid: number | undefined;
  readonly url: string | undefined;
  readonly databasePort: number | undefined;
}

function readServerStatus(status: unknown): ServerStatus {
  if (!isStringKeyedRecord(status)) {
    return {
      live: false,
      recordExists: true,
      pid: undefined,
      url: undefined,
      databasePort: undefined,
    };
  }
  const exports = status['exports'];
  const database = isStringKeyedRecord(exports) ? exports['database'] : undefined;
  const url = isStringKeyedRecord(database) ? database['connectionString'] : undefined;
  const pid = status['pid'];
  const databasePort = status['databasePort'];
  return {
    live: status['status'] === 'running' || status['status'] === 'starting_up',
    recordExists: status['status'] !== 'no_such_server',
    pid: typeof pid === 'number' ? pid : undefined,
    url: typeof url === 'string' ? url : undefined,
    databasePort: typeof databasePort === 'number' ? databasePort : undefined,
  };
}

async function serverStatusOf(
  internalState: PrismaDevInternalStateModule,
  instanceName: string,
): Promise<ServerStatus> {
  try {
    return readServerStatus(await internalState.getServerStatus(instanceName));
  } catch {
    return {
      live: false,
      recordExists: true,
      pid: undefined,
      url: undefined,
      databasePort: undefined,
    };
  }
}

const CLOSE_SETTLE_ATTEMPTS = 40;
const CLOSE_SETTLE_DELAY_MS = 250;

/** True once the named server's persisted state no longer claims it is live — the precondition for `deleteServer`, whose kill path targets the pid in that state, which for an in-daemon server is THIS DAEMON's own pid. */
async function settledAfterClose(
  internalState: PrismaDevInternalStateModule,
  instanceName: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= CLOSE_SETTLE_ATTEMPTS; attempt += 1) {
    const live = (await serverStatusOf(internalState, instanceName)).live;
    if (!live) return true;
    if (attempt < CLOSE_SETTLE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_SETTLE_DELAY_MS));
    }
  }
  return false;
}

/**
 * `@prisma/dev`'s own package.json declares `./internal/state`, whose
 * `deleteServer(name)` actually removes a stateful server's persisted PGlite
 * data — `startPrismaDevServer`'s public surface only starts/closes a live
 * server, never deletes what a closed one left on disk. Resolved by reading
 * the SAME package's own `exports` map (walked up from the caller-given
 * entry path to find `@prisma/dev`'s `package.json`), never by guessing at
 * `dist/` file layout.
 */
async function importPrismaDevInternalState(
  prismaDevModulePath: string,
): Promise<PrismaDevInternalStateModule> {
  let dir = path.dirname(prismaDevModulePath);
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (
        isStringKeyedRecord(pkg) &&
        pkg['name'] === '@prisma/dev' &&
        isStringKeyedRecord(pkg['exports'])
      ) {
        const entry = pkg['exports']['./internal/state'];
        const target = resolveExportTarget(entry);
        if (target === undefined) {
          throw new Error(
            `"@prisma/dev" at "${dir}" does not declare an "./internal/state" export — cannot delete its persisted database data.`,
          );
        }
        const mod: unknown = await import(pathToFileURL(path.join(dir, target)).href);
        if (isPrismaDevInternalStateModule(mod)) return mod;
        throw new Error(
          `"@prisma/dev"'s "./internal/state" export at "${dir}" has no deleteServer.`,
        );
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `could not find "@prisma/dev"'s package.json above "${prismaDevModulePath}".`,
      );
    }
    dir = parent;
  }
}

function resolveExportTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (!isStringKeyedRecord(entry)) return undefined;
  const nested = entry['import'] ?? entry['require'] ?? entry['default'];
  if (typeof nested === 'string') return nested;
  if (isStringKeyedRecord(nested)) {
    const def = nested['default'];
    if (typeof def === 'string') return def;
  }
  return undefined;
}

// --- daemon -----------------------------------------------------------

function parseArgs(argv: readonly string[]): { readonly port: number; readonly stateDir: string } {
  let port: number | undefined;
  let stateDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[i + 1]);
    else if (argv[i] === '--state-dir') stateDir = argv[i + 1];
  }
  if (port === undefined || Number.isNaN(port)) {
    throw new Error('postgres-main: --port <n> is required');
  }
  if (stateDir === undefined) {
    throw new Error('postgres-main: --state-dir <dir> is required');
  }
  return { port, stateDir };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function main(): void {
  const { port, stateDir } = parseArgs(process.argv.slice(2));
  const ownVersion = readOwnVersion();
  const statePath = path.join(stateDir, 'instances.json');
  const stateFile = new StateFile<InstancesState>(statePath, STATE_MODE);

  let state: InstancesState = { instances: {}, discardedServers: [] };
  // Live, in-process `@prisma/dev` server objects, keyed by instance id —
  // dropped whenever this process exits (including a version-skew replace
  // by `ensureDaemon`); `state` (persisted) is what survives, and a start is
  // what actually brings a server back from it.
  const runtimes = new Map<string, PrismaDevServer>();
  /** Instances whose server another live process holds: running, but with no handle in this one. */
  const adopted = new Set<string>();
  /**
   * Server starts run ONE AT A TIME. `@prisma/dev`'s start is not
   * concurrency-safe within a process: two simultaneous calls pick their
   * ports without seeing each other and one fails with a port refusal
   * (verified directly — two concurrent starts with distinct, pinned
   * database ports fail; the same two started in sequence both succeed).
   */
  let startQueue: Promise<unknown> = Promise.resolve();
  function serializeStart<T>(run: () => Promise<T>): Promise<T> {
    const next = startQueue.then(run, run);
    startQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function schedulePersist(): void {
    void stateFile.write(state);
  }

  function heldPorts(): Set<number> {
    return new Set(Object.values(state.instances).map((db) => db.port));
  }

  async function smallestUnusedPort(exclude: ReadonlySet<number>): Promise<number> {
    return getPort({
      port: portNumbers(MIN_DATABASE_PORT, MAX_DATABASE_PORT),
      exclude: [...heldPorts(), ...exclude],
    });
  }

  /** The requested port when no instance or record holds it and it is bindable; otherwise the smallest such port in the database range. */
  async function allocatePort(
    requested: number | undefined,
    exclude: ReadonlySet<number>,
  ): Promise<number> {
    const held = heldPorts();
    if (requested !== undefined && !held.has(requested) && !exclude.has(requested)) {
      const given = await getPort({ port: requested, exclude: [...held, ...exclude] });
      if (given === requested) return given;
    }
    return smallestUnusedPort(exclude);
  }

  /** In-flight starts and stops per instance, so a stop, a start or a delete never overlaps another on the same server. */
  const inflight = new Map<string, Promise<unknown>>();
  function exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    const prior = inflight.get(id) ?? Promise.resolve();
    const next = prior.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    inflight.set(id, settled);
    void settled.then(() => {
      if (inflight.get(id) === settled) inflight.delete(id);
    });
    return next;
  }

  /**
   * Names whose `startPrismaDevServer` call failed in THIS process for any
   * reason other than "already running". `@prisma/dev` acquires the name's
   * lock before it validates the requested ports, and a failure after that
   * point (a port refusal) propagates WITHOUT releasing the lock — so the
   * very next start of the same name in this process is refused as "already
   * running" by a holder that is this daemon's own dead attempt, and no
   * amount of waiting frees it. Membership here is what makes deleting that
   * lock provably safe: a name this process leaked cannot have been
   * acquired by anyone else since (the leak never releases).
   */
  const leakedStartNames = new Set<string>();

  /**
   * Starts the server for `serverName`. A fresh allocation picks its port
   * (preferring `requestedPort`) inside the serialized section and may move
   * to another port on a refusal; a start of an existing instance is pinned
   * to its port, because dependents' environments carry its URL.
   */
  async function startServer(opts: {
    readonly serverName: string;
    readonly prismaDevModulePath: string;
    readonly pinnedPort?: number;
    readonly requestedPort?: number;
  }): Promise<{ readonly url: string; readonly port: number; readonly server?: PrismaDevServer }> {
    const { serverName, prismaDevModulePath } = opts;
    // Resolved first: its failure carries the pinned "reinstall" message,
    // which a caller with a bad path must see rather than the internal-state
    // resolver's own wording.
    const prismaDev = await importPrismaDev(prismaDevModulePath);

    // Reconcile with `@prisma/dev`'s own record BEFORE trying to start. A
    // daemon replaced for version skew leaves its in-process servers'
    // records claiming "running" behind a dead pid; starting into that
    // produces the "already running" refusal.
    const internalState = await importPrismaDevInternalState(prismaDevModulePath);
    await discardEarlierServers(internalState);
    const recorded = await serverStatusOf(internalState, serverName);
    if (recorded.live && recorded.pid !== undefined && isPidAlive(recorded.pid)) {
      // A live server under this instance's own name in another process:
      // it IS this database. Adopt its URL.
      if (recorded.url !== undefined) {
        return {
          url: recorded.url,
          port: recorded.databasePort ?? portOfUrl(recorded.url) ?? opts.pinnedPort ?? 0,
        };
      }
    } else if (recorded.live) {
      // Recorded live, but nothing is running — the owning process died.
      // Clear the process record; `killServer` never touches the data.
      await internalState.killServer(serverName).catch(() => undefined);
    }

    const isFreshAllocation = opts.pinnedPort === undefined;
    let dbPort = opts.pinnedPort ?? 0;
    const conflicted = new Set<number>();
    let alreadyRunningRetries = 0;
    let blindRetries = 0;
    for (let attempt = 1; ; attempt++) {
      // ALL FOUR ports are ours to pick. `@prisma/dev`'s own picker consults
      // only its record registry, never the OS, so under concurrent processes
      // it walks onto a port another process has bound but not yet recorded.
      // Our pick both OS-probes (getPort) and excludes every recorded claim,
      // and a refusal of any of the four carries the port, which the retry
      // below turns into fresh candidates. Picks happen inside the
      // serialized section, together with the start they feed.
      const auxPorts: number[] = [];
      try {
        const server = await serializeStart(async () => {
          const registryPorts = await registryClaimedPorts(internalState, serverName);
          if (isFreshAllocation) {
            dbPort = await allocatePort(
              attempt === 1 ? opts.requestedPort : undefined,
              new Set([...registryPorts, ...conflicted]),
            );
          }
          const auxExclude = new Set([...registryPorts, ...conflicted, dbPort]);
          const pickAux = async (): Promise<number> => {
            const picked = await smallestUnusedPort(auxExclude);
            auxExclude.add(picked);
            auxPorts.push(picked);
            return picked;
          };
          const httpPort = await pickAux();
          const shadowPort = await pickAux();
          const streamsPort = await pickAux();
          return prismaDev.startPrismaDevServer({
            name: serverName,
            databasePort: dbPort,
            port: httpPort,
            shadowDatabasePort: shadowPort,
            streamsPort,
            persistenceMode: 'stateful',
          });
        });
        leakedStartNames.delete(serverName);
        return { url: server.database.connectionString, port: dbPort, server };
      } catch (err) {
        if (isNameAlreadyTaken(err) && alreadyRunningRetries < MAX_ALREADY_RUNNING_RETRIES) {
          alreadyRunningRetries += 1;
          // A refusal on a name THIS process leaked with no record behind it
          // is not a foreign holder to wait for: delete the orphaned state
          // (no record, so no data) to free the lock, and retry.
          if (leakedStartNames.has(serverName)) {
            const now = await serverStatusOf(internalState, serverName);
            if (!now.recordExists) {
              await internalState.deleteServer(serverName).catch(() => undefined);
              continue;
            }
          }
          // A live record with a live owner is this database: adopt it. A
          // live record with a dead owner is a crashed owner's leftover:
          // clear it and start again. No live record: wait for the holder to
          // publish or release, then retry.
          for (let poll = 1; poll <= ALREADY_RUNNING_POLLS; poll += 1) {
            const now = await serverStatusOf(internalState, serverName);
            if (now.live && now.pid !== undefined && isPidAlive(now.pid) && now.url !== undefined) {
              return { url: now.url, port: now.databasePort ?? portOfUrl(now.url) ?? dbPort };
            }
            if (now.live && (now.pid === undefined || !isPidAlive(now.pid))) {
              await internalState.killServer(serverName).catch(() => undefined);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, ALREADY_RUNNING_POLL_MS));
          }
          continue;
        }
        if (!isNameAlreadyTaken(err)) leakedStartNames.add(serverName);
        const conflictPort = portConflictOf(err, [dbPort, ...auxPorts]);
        // The aux ports are never persisted, so a refusal of one is always
        // retryable. The database port is pinned once the instance exists.
        const canRetryNextPort =
          conflictPort !== undefined &&
          attempt < MAX_FRESH_PORT_CANDIDATES &&
          (conflictPort !== dbPort || isFreshAllocation);
        if (!canRetryNextPort) {
          // A failure that names no port can still be a transient bind race
          // ("Is port X in use?" text, no `.port`); every attempt picks fresh
          // aux candidates, so trying again is meaningful, a bounded number
          // of times.
          if (conflictPort === undefined && !isNameAlreadyTaken(err) && blindRetries < 2) {
            blindRetries += 1;
            continue;
          }
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(
            `postgres emulator failed to start database "${serverName}" on port ${String(dbPort)}: ${maskCredentials(firstLine(reason))}`,
          );
        }
        conflicted.add(conflictPort);
      }
    }
  }

  /**
   * Deletes the data of servers an earlier version of this emulator created,
   * once a request brings a `@prisma/dev` module to do it with. Best effort:
   * a server another live process still serves, or one whose delete fails,
   * is tried again on the next request.
   */
  let discarding: Promise<void> | undefined;
  function discardEarlierServers(internalState: PrismaDevInternalStateModule): Promise<void> {
    if (state.discardedServers.length === 0) return Promise.resolve();
    discarding ??= deleteEarlierServers(internalState).finally(() => {
      discarding = undefined;
    });
    return discarding;
  }

  async function deleteEarlierServers(internalState: PrismaDevInternalStateModule): Promise<void> {
    const remaining: string[] = [];
    for (const name of state.discardedServers) {
      try {
        const owner = await serverStatusOf(internalState, name);
        if (owner.live && owner.pid !== undefined && isPidAlive(owner.pid)) {
          // Another process still serves it — under the old names, another
          // emulators directory could. Signalling that pid would end every
          // server it hosts, so leave this one for a later request.
          remaining.push(name);
          continue;
        }
        if (owner.live) await internalState.killServer(name).catch(() => undefined);
        await internalState.deleteServer(name);
      } catch (err) {
        console.error(
          `postgres-main: could not delete the data of "${name}", left by an earlier version: ${err instanceof Error ? err.message : String(err)}`,
        );
        remaining.push(name);
      }
    }
    state.discardedServers = remaining;
    schedulePersist();
  }

  async function createInstance(body: CreateBody): Promise<DatabaseRecord> {
    const id = newInstanceId();
    const serverName = serverNameFor(id);
    let started: Awaited<ReturnType<typeof startServer>>;
    try {
      started = await startServer({
        serverName,
        prismaDevModulePath: body.prismaDevModulePath,
        ...(body.port !== undefined ? { requestedPort: body.port } : {}),
      });
    } catch (err) {
      await discardFailedServer(serverName, body.prismaDevModulePath);
      throw err;
    }
    const record: DatabaseRecord = {
      id,
      labels: { ...body.labels },
      serverName,
      port: started.port,
      url: started.url,
      prismaDevModulePath: body.prismaDevModulePath,
    };
    if (started.server) runtimes.set(id, started.server);
    else adopted.add(id);
    state.instances[id] = record;
    // Written before the create is acknowledged: an id the caller records
    // must survive the daemon dying right after, or its data would be left
    // under a name no state lists.
    await stateFile.write(state);
    return record;
  }

  /**
   * A failed create records no instance, so nothing will use its server name
   * again. A start that failed after `@prisma/dev` took the name's lock leaves
   * the name's directory behind with no record; remove it.
   */
  async function discardFailedServer(serverName: string, prismaDevModulePath: string) {
    if (!leakedStartNames.has(serverName)) return;
    try {
      const internalState = await importPrismaDevInternalState(prismaDevModulePath);
      if (!(await serverStatusOf(internalState, serverName)).recordExists) {
        await internalState.deleteServer(serverName);
      }
      leakedStartNames.delete(serverName);
    } catch {
      // Best effort: the directory holds no data.
    }
  }

  function isRunning(id: string): boolean {
    return runtimes.has(id) || adopted.has(id);
  }

  function startInstance(db: DatabaseRecord, prismaDevModulePath: string): Promise<void> {
    return exclusive(db.id, async () => {
      db.prismaDevModulePath = prismaDevModulePath;
      if (isRunning(db.id)) return;
      const started = await startServer({
        serverName: db.serverName,
        prismaDevModulePath,
        pinnedPort: db.port,
      });
      db.url = started.url;
      if (started.server) runtimes.set(db.id, started.server);
      else adopted.add(db.id);
      schedulePersist();
    });
  }

  /** Shuts the server down and keeps its data. */
  async function closeServer(db: DatabaseRecord): Promise<void> {
    const server = runtimes.get(db.id);
    if (server) {
      await server.close().catch(() => undefined);
      runtimes.delete(db.id);
      return;
    }
    if (!adopted.has(db.id)) return;
    // A server another process holds has no handle here: stop it by its
    // record (`killServer` leaves the data). Never by OUR pid — `killServer`
    // signals whatever pid the record names.
    const internalState = await importPrismaDevInternalState(db.prismaDevModulePath);
    const owner = await serverStatusOf(internalState, db.serverName);
    if (owner.pid !== process.pid) {
      await internalState.killServer(db.serverName).catch(() => undefined);
    }
    adopted.delete(db.id);
  }

  function stopInstance(db: DatabaseRecord): Promise<void> {
    return exclusive(db.id, () => closeServer(db));
  }

  /** `prismaDevModulePath` is the caller's: the one the database was last started with may since have been removed. */
  function deleteInstance(
    db: DatabaseRecord,
    prismaDevModulePath: string | undefined,
  ): Promise<void> {
    return exclusive(db.id, async () => {
      if (prismaDevModulePath !== undefined) db.prismaDevModulePath = prismaDevModulePath;
      await closeServer(db);
      const internalState = await importPrismaDevInternalState(db.prismaDevModulePath);
      // `deleteServer`'s kill path targets the pid in the server's persisted
      // state — for an in-daemon server that pid is THIS DAEMON's own. The
      // close marks the state stopped, but the write is asynchronous: deleting
      // while it still says "running" makes the daemon kill itself. Wait for
      // the close to settle; if it never does, leave the data on disk rather
      // than die.
      if (await settledAfterClose(internalState, db.serverName)) {
        await internalState.deleteServer(db.serverName);
      } else {
        console.error(
          `postgres-main: server "${db.serverName}" still reports running after close — leaving its persisted data in place instead of risking a self-kill.`,
        );
      }
      delete state.instances[db.id];
      // Written before the delete is acknowledged, so a daemon that dies
      // right after never brings the database back.
      await stateFile.write(state);
      // get-port holds every port it returns for up to 30 seconds; the freed
      // port must be free again for a database created right after.
      clearLockedPorts();
    });
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function text(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  function noContent(res: http.ServerResponse): void {
    res.writeHead(204);
    res.end();
  }

  async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const raw = await readBody(req);
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return undefined;
    }
  }

  function instanceView(db: DatabaseRecord): unknown {
    return {
      id: db.id,
      labels: db.labels,
      port: db.port,
      url: db.url,
      status: isRunning(db.id) ? 'running' : 'stopped',
    };
  }

  function unknownInstances(res: http.ServerResponse, ids: readonly string[]): void {
    text(res, 404, `no such instance: ${ids.map((id) => `"${id}"`).join(', ')}`);
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
            'malformed body: expected { "labels": Record<string, string>, "port"?: number, "prismaDevModulePath": string }',
          );
        }
        return json(res, 201, instanceView(await createInstance(body)));
      }
    }

    if (method === 'POST' && segments.length === 2 && segments[1] === 'start') {
      const body = await readJsonBody(req);
      if (!isStartBody(body)) {
        return text(
          res,
          400,
          'malformed body: expected { "ids": string[], "prismaDevModulePath": string }',
        );
      }
      const unknown = body.ids.filter((id) => state.instances[id] === undefined);
      if (unknown.length > 0) return unknownInstances(res, unknown);
      for (const id of body.ids) {
        const db = state.instances[id];
        if (db) await startInstance(db, body.prismaDevModulePath);
      }
      return noContent(res);
    }

    if (method === 'POST' && segments.length === 2 && segments[1] === 'stop') {
      const body = await readJsonBody(req);
      if (!isIdsBody(body)) return text(res, 400, 'malformed body: expected { "ids": string[] }');
      // An unknown instance runs nothing, so stopping it is already done.
      for (const id of body.ids) {
        const db = state.instances[id];
        if (db) await stopInstance(db);
      }
      return noContent(res);
    }

    const id = segments[1];
    if (id !== undefined && !INSTANCE_ID_RE.test(id)) {
      return text(res, 400, `invalid instance id "${id}"`);
    }
    const db = id === undefined ? undefined : state.instances[id];

    if (method === 'DELETE' && segments.length === 2) {
      const body = await readJsonBody(req);
      const modulePath = isStringKeyedRecord(body) ? body['prismaDevModulePath'] : undefined;
      if (db) await deleteInstance(db, typeof modulePath === 'string' ? modulePath : undefined);
      return noContent(res);
    }
    if (!db) return unknownInstances(res, id === undefined ? [] : [id]);
    if (method === 'GET' && segments.length === 2) return json(res, 200, instanceView(db));

    res.writeHead(404);
    res.end();
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(err instanceof Error ? maskCredentials(err.message) : String(err));
    });
  });

  // Close every live `@prisma/dev` server cleanly before exiting — they own
  // real PGlite sockets and on-disk WAL state.
  async function shutdown(): Promise<void> {
    for (const live of runtimes.values()) {
      await live.close().catch(() => undefined);
    }
    await stateFile.flush();
    server.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // This daemon hosts `@prisma/dev`'s runtime in-process, and a failed or
  // abandoned start attempt can leave background async work behind whose
  // eventual rejection would otherwise kill the process. A machine-shared
  // daemon must not die because one attempt's debris rejected — log it and
  // keep serving; every REQUEST path still reports its own errors as 500s.
  process.on('unhandledRejection', (reason) => {
    console.error(
      'postgres-main: unhandled rejection from background work:',
      reason instanceof Error ? maskCredentials(reason.stack ?? reason.message) : reason,
    );
  });
  process.on('uncaughtException', (err) => {
    console.error(
      'postgres-main: uncaught exception from background work:',
      err instanceof Error ? maskCredentials(err.stack ?? err.message) : err,
    );
  });

  loadState(stateDir, statePath)
    .then((loaded) => {
      state = loaded;
      schedulePersist();
      server.listen(port, '127.0.0.1', () => {
        console.log(`[dev-emulators] postgres-main listening on 127.0.0.1:${String(port)}`);
      });
    })
    .catch((err: unknown) => {
      console.error('postgres-main: failed to load state', err);
      process.exit(1);
    });
}

/**
 * This version's state, plus the servers named in any other JSON state file
 * in the state directory, which an earlier version wrote; those files are
 * removed. Local dev state is never migrated; the servers' data is deleted
 * on the first request that can (see `discardEarlierServers`).
 */
async function loadState(stateDir: string, statePath: string): Promise<InstancesState> {
  const loaded = (await readJsonFile(statePath, isInstancesState)) ?? {
    instances: {},
    discardedServers: [],
  };
  const files = await fs.promises.readdir(stateDir).catch(() => []);
  for (const file of files.map((name) => path.join(stateDir, name))) {
    if (!file.endsWith('.json') || file === statePath) continue;
    const earlier = await fs.promises.readFile(file, 'utf8').catch(() => '');
    const names = serverNamesInEarlierState(earlier);
    loaded.discardedServers = [...new Set([...loaded.discardedServers, ...names])];
    await fs.promises.rm(file, { force: true });
  }
  return loaded;
}

main();
