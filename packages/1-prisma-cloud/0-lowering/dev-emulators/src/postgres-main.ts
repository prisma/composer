/**
 * The Postgres emulator daemon (local-dev spec § 2 `postgres-main.ts`): a
 * small local counterpart of hosted Postgres, hosting `@prisma/dev`'s
 * `startPrismaDevServer()` — one named, persistent server per `Database`
 * resource, several servers in this one daemon process. Loopback
 * `node:http` JSON admin API; state under its `--state-dir`.
 *
 * `@prisma/dev` is imported dynamically from a CALLER-RESOLVED path (each
 * admin request that needs it carries `prismaDevModulePath`) so the app
 * owns its own Prisma version — this daemon has no `@prisma/dev` dependency
 * of its own.
 *
 * Runs as its own OS process, started by `daemon.ts`'s `ensureDaemon` via
 * `process.execPath <this file> --port <n> --state-dir <dir>`.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import getPort, { portNumbers } from 'get-port';
import { isPidAlive, readOwnVersion } from './daemon.ts';
import { instanceNameFor } from './instance-name.ts';
import { isValidSegment } from './segments.ts';
import { readJsonFile, StateFile } from './state-file.ts';

const MIN_DATABASE_PORT = 51_300;
const MAX_DATABASE_PORT = 65_535;
const APPS_STATE_MODE = 0o600;
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
  'local dev needs @prisma/dev for its local Postgres emulator — add "prisma" to your app\'s devDependencies.';

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
  readonly instanceName: string;
  readonly databasePort: number;
  readonly url: string;
}

interface AppRecord {
  databases: Record<string, DatabaseRecord>;
}

type AppsState = Record<string, AppRecord>;

function isDatabaseRecord(value: unknown): value is DatabaseRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'instanceName' in value &&
    typeof value.instanceName === 'string' &&
    'databasePort' in value &&
    typeof value.databasePort === 'number' &&
    'url' in value &&
    typeof value.url === 'string'
  );
}

function isAppRecord(value: unknown): value is AppRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'databases' in value &&
    typeof value.databases === 'object' &&
    value.databases !== null &&
    Object.values(value.databases).every(isDatabaseRecord)
  );
}

function isAppsState(value: unknown): value is AppsState {
  return typeof value === 'object' && value !== null && Object.values(value).every(isAppRecord);
}

interface DatabaseBody {
  readonly prismaDevModulePath: string;
}

function isDatabaseBody(value: unknown): value is DatabaseBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'prismaDevModulePath' in value &&
    typeof value.prismaDevModulePath === 'string'
  );
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

/** The port of a postgres connection URL, when it parses as one. */
function databasePortOf(connectionString: string): number | undefined {
  try {
    const port = Number(new URL(connectionString).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
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

/** A parsed-JSON value narrowed just enough to index into by string key — real narrowing, not a cast: the interface's own index signature is what makes bracket access legal. */
interface StringKeyedRecord {
  readonly [key: string]: unknown;
}

function isStringKeyedRecord(value: unknown): value is StringKeyedRecord {
  return typeof value === 'object' && value !== null;
}

interface PrismaDevInternalStateModule {
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
  readonly pid: number | undefined;
  readonly url: string | undefined;
  readonly databasePort: number | undefined;
}

function readServerStatus(status: unknown): ServerStatus {
  if (!isStringKeyedRecord(status)) {
    return { live: false, pid: undefined, url: undefined, databasePort: undefined };
  }
  const exports = status['exports'];
  const database = isStringKeyedRecord(exports) ? exports['database'] : undefined;
  const url = isStringKeyedRecord(database) ? database['connectionString'] : undefined;
  const pid = status['pid'];
  const databasePort = status['databasePort'];
  return {
    live: status['status'] === 'running' || status['status'] === 'starting_up',
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
    return { live: false, pid: undefined, url: undefined, databasePort: undefined };
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
  const appsJsonPath = path.join(stateDir, 'apps.json');
  const stateFile = new StateFile<AppsState>(appsJsonPath, APPS_STATE_MODE);

  let state: AppsState = {};
  // Live, in-process `@prisma/dev` server objects, keyed by instance name —
  // dropped whenever this process exits (including a version-skew replace
  // by `ensureDaemon`); `state` (persisted) is what survives, and a PUT is
  // what actually restarts a server from it.
  const runtimes = new Map<string, PrismaDevServer>();
  // Every OTHER port (server, shadow database, streams) a LIVE server in
  // this process is currently using — unlike `databasePort`, none of these
  // are part of this daemon's contract with its caller (only the
  // connection string is), so they need no persisted identity across a
  // restart, just uniqueness among servers live RIGHT NOW in this one
  // process (several servers share one daemon).
  /**
   * Server starts run ONE AT A TIME. `@prisma/dev`'s start is not
   * concurrency-safe within a process: two simultaneous calls pick their
   * ports without seeing each other and one fails with a port refusal
   * (verified directly — two concurrent starts with distinct, pinned
   * database ports fail; the same two started in sequence both succeed).
   * The daemon issues concurrent starts whenever an app converges more than
   * one database, which is what produced the port refusals, the retries
   * whose half-started servers held their own name's lock, and every
   * "already running" failure downstream of that.
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

  function getOrCreateApp(app: string): AppRecord {
    let appRec = state[app];
    if (!appRec) {
      appRec = { databases: {} };
      state[app] = appRec;
    }
    return appRec;
  }

  function usedDatabasePorts(): Set<number> {
    const ports = new Set<number>();
    for (const appRec of Object.values(state)) {
      for (const db of Object.values(appRec.databases)) ports.add(db.databasePort);
    }
    return ports;
  }

  async function smallestUnusedDatabasePort(
    min: number,
    alsoExclude: ReadonlySet<number> = new Set(),
  ): Promise<number> {
    return getPort({
      port: portNumbers(min, MAX_DATABASE_PORT),
      exclude: [...usedDatabasePorts(), ...alsoExclude],
    });
  }

  const inflightEnsures = new Map<string, Promise<{ url: string }>>();

  /** Concurrent PUTs for the same database coalesce onto one start — a second `startPrismaDevServer` for a name whose first start is still booting fails as "already running". */
  function ensureDatabase(
    app: string,
    id: string,
    prismaDevModulePath: string,
  ): Promise<{ url: string }> {
    const instanceName = instanceNameFor(app, id);
    const inflight = inflightEnsures.get(instanceName);
    if (inflight) return inflight;
    const run = ensureDatabaseSerialized(app, id, prismaDevModulePath, instanceName).finally(() => {
      inflightEnsures.delete(instanceName);
    });
    inflightEnsures.set(instanceName, run);
    return run;
  }

  async function ensureDatabaseSerialized(
    app: string,
    id: string,
    prismaDevModulePath: string,
    instanceName: string,
  ): Promise<{ url: string }> {
    const appRec = getOrCreateApp(app);
    const existingRecord = appRec.databases[id];

    // Already live in THIS process — idempotent, nothing to do.
    const runningServer = runtimes.get(instanceName);
    if (existingRecord && runningServer) {
      return { url: existingRecord.url };
    }

    // Resolved first: its failure carries the pinned "add prisma to your
    // devDependencies" message, which a caller with a bad path must see
    // rather than the internal-state resolver's own wording.
    const prismaDev = await importPrismaDev(prismaDevModulePath);

    // Reconcile with `@prisma/dev`'s own record BEFORE trying to start.
    // This daemon's state and that record can disagree — a daemon replaced
    // for version skew leaves its in-process servers' records claiming
    // "running" behind a dead pid, and a teardown that declined to delete
    // (see `deleteApp`) leaves a live one. Starting into either produces the
    // "already running" refusal; reading the record first turns both into
    // ordinary cases.
    const internalState = await importPrismaDevInternalState(prismaDevModulePath);
    const recorded = await serverStatusOf(internalState, instanceName);
    if (recorded.live && recorded.pid !== undefined && isPidAlive(recorded.pid)) {
      // A live server under our own name: the name is namespaced to this
      // app+database, so this IS the database being asked for. Adopt its
      // URL. (No handle to close it — `deleteApp` uses `killServer` for
      // exactly this case.)
      if (recorded.url !== undefined) {
        appRec.databases[id] = {
          id,
          instanceName,
          databasePort: recorded.databasePort ?? databasePortOf(recorded.url) ?? MIN_DATABASE_PORT,
          url: recorded.url,
        };
        schedulePersist();
        return { url: recorded.url };
      }
    } else if (recorded.live) {
      // Recorded live, but nothing is running — the owning process died
      // (daemon replacement, a crash). Clear the process record; `killServer`
      // never touches the persisted data, so the database survives.
      await internalState.killServer(instanceName).catch(() => undefined);
    }

    const isFreshAllocation = existingRecord === undefined;
    let dbPort =
      existingRecord?.databasePort ?? (await smallestUnusedDatabasePort(MIN_DATABASE_PORT));

    const conflicted = new Set<number>();
    let alreadyRunningRetries = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        // Only the DATABASE port is ours to pin (endpoints in deploy state
        // reference it). The http/shadow/streams listeners are internal to
        // `@prisma/dev`, and its own picker is the only one that consults
        // its registry of other servers — ours could not, which is what
        // produced the "belongs to another Prisma Dev server" refusals.
        const server = await serializeStart(() =>
          prismaDev.startPrismaDevServer({
            name: instanceName,
            databasePort: dbPort,
            persistenceMode: 'stateful',
          }),
        );
        const url = server.database.connectionString;
        runtimes.set(instanceName, server);
        appRec.databases[id] = { id, instanceName, databasePort: dbPort, url };
        schedulePersist();
        return { url };
      } catch (err) {
        if (isNameAlreadyTaken(err) && alreadyRunningRetries < MAX_ALREADY_RUNNING_RETRIES) {
          alreadyRunningRetries += 1;
          // The refusal means a live process holds this server's lock, but
          // the RECORD it holds can say three different things, and the
          // difference matters (observed on CI: the daemon had no record for
          // this database while its name was locked):
          //
          //  - a live record with a live owner: that server IS this database
          //    (the name is namespaced to this app+database) — adopt its URL;
          //  - a live record with a dead owner: a crashed owner's leftover —
          //    clear the process record (never the data) and start again;
          //  - NO live record at all: the lock is held by a holder that has
          //    not published its record yet, or one whose record was just
          //    removed while its lock lingers. Neither is resolvable by
          //    starting again immediately — the previous code did exactly
          //    that and burned every attempt in milliseconds. Wait for the
          //    holder to publish or release, then retry the start.
          for (let poll = 1; poll <= ALREADY_RUNNING_POLLS; poll += 1) {
            const now = await serverStatusOf(internalState, instanceName);
            if (now.live && now.pid !== undefined && isPidAlive(now.pid) && now.url !== undefined) {
              appRec.databases[id] = {
                id,
                instanceName,
                databasePort: now.databasePort ?? databasePortOf(now.url) ?? dbPort,
                url: now.url,
              };
              schedulePersist();
              return { url: now.url };
            }
            if (now.live && (now.pid === undefined || !isPidAlive(now.pid))) {
              await internalState.killServer(instanceName).catch(() => undefined);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, ALREADY_RUNNING_POLL_MS));
          }
          continue;
        }
        const conflictPort = portConflictOf(err, [dbPort]);
        // The aux listener ports are never persisted, so a refusal of one is
        // always retryable with fresh candidates. The DATABASE port is frozen
        // once a record exists (endpoints in deploy state reference it) —
        // only a fresh allocation may move it.
        const canRetryNextPort =
          conflictPort !== undefined &&
          attempt < MAX_FRESH_PORT_CANDIDATES &&
          (conflictPort !== dbPort || isFreshAllocation);
        if (!canRetryNextPort) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(
            `postgres emulator failed to start database "${instanceName}" on port ${String(dbPort)}: ${maskCredentials(firstLine(reason))}`,
          );
        }
        conflicted.add(conflictPort);
        if (conflictPort === dbPort) {
          dbPort = await smallestUnusedDatabasePort(dbPort + 1, conflicted);
        }
      }
    }
  }

  async function deleteApp(
    app: string,
    prismaDevModulePathHint: string | undefined,
  ): Promise<void> {
    const appRec = state[app];
    if (!appRec) return;
    const entries = Object.values(appRec.databases);

    // Closed one at a time, never concurrently: the servers run pglite's
    // native/WASM runtime in THIS process, and the daemon has died silently
    // (no JS error, no guard output — a native abort) during exactly this
    // teardown window under CI load. Sequential closes remove the only
    // concurrency we control there.
    for (const db of entries) {
      const server = runtimes.get(db.instanceName);
      if (server) {
        await server.close().catch(() => undefined);
        runtimes.delete(db.instanceName);
      }
    }

    // Deleting the persisted PGlite data needs SOME resolved `@prisma/dev`
    // module — the app that owns the databases being deleted is the same
    // app whose `prismaDevModulePath` every PUT for it already carried, so
    // any one of those already-observed paths works; DELETE itself carries
    // no body, so there is nothing more specific to prefer.
    if (entries.length > 0 && prismaDevModulePathHint) {
      const internalState = await importPrismaDevInternalState(prismaDevModulePathHint);
      for (const db of entries) {
        // A server this daemon adopted rather than started has no handle to
        // close, so stop it by its record first (`killServer` leaves data).
        // Never by OUR pid: `killServer` signals whatever pid the record
        // names, and a record naming this daemon would make it kill itself.
        if (!runtimes.has(db.instanceName)) {
          const owner = await serverStatusOf(internalState, db.instanceName);
          if (owner.pid !== process.pid) {
            await internalState.killServer(db.instanceName).catch(() => undefined);
          }
        }
        // `deleteServer`'s kill path targets the pid in the server's persisted
        // state — for an in-daemon server that pid is THIS DAEMON's own. The
        // close above marks the state stopped, but the write is asynchronous:
        // deleting while the state still says "running" makes the daemon kill
        // itself (observed on CI as the daemon dying silently mid-teardown).
        // Wait for the close to settle; if it never does, leave the data on
        // disk rather than die — the next --fresh gets another chance.
        const settled = await settledAfterClose(internalState, db.instanceName);
        if (!settled) {
          console.error(
            `postgres-main: server "${db.instanceName}" still reports running after close — leaving its persisted data in place instead of risking a self-kill.`,
          );
          continue;
        }
        await internalState.deleteServer(db.instanceName);
      }
    }

    delete state[app];
    schedulePersist();
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
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

  function databaseView(db: DatabaseRecord): unknown {
    return {
      id: db.id,
      url: db.url,
      instanceName: db.instanceName,
      databasePort: db.databasePort,
    };
  }

  /** The most recently observed `prismaDevModulePath` for any database of `app` — DELETE has no body of its own to carry one. */
  const recentPrismaDevModulePath = new Map<string, string>();
  function lastKnownPrismaDevModulePath(app: string): string | undefined {
    return recentPrismaDevModulePath.get(app);
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

      if (method === 'PUT' && segments.length === 4 && segments[2] === 'databases') {
        const id = segments[3];
        if (id === undefined || !isValidSegment(id)) return badSegment(res, id ?? '');
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          return text(res, 400, 'malformed JSON body');
        }
        if (!isDatabaseBody(parsed)) {
          return text(
            res,
            400,
            'malformed database body: expected { "prismaDevModulePath": string }',
          );
        }
        recentPrismaDevModulePath.set(app, parsed.prismaDevModulePath);
        const result = await ensureDatabase(app, id, parsed.prismaDevModulePath);
        return json(res, 200, result);
      }

      if (method === 'GET' && segments.length === 3 && segments[2] === 'databases') {
        const appRec = state[app];
        const list = appRec ? Object.values(appRec.databases).map(databaseView) : [];
        return json(res, 200, list);
      }

      if (method === 'DELETE' && segments.length === 2) {
        await deleteApp(app, lastKnownPrismaDevModulePath(app));
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
      res.end(err instanceof Error ? maskCredentials(err.message) : String(err));
    });
  });

  // Close every live `@prisma/dev` server cleanly before exiting — they own
  // real PGlite sockets and on-disk WAL state, unlike compute's spawned
  // children (a separate OS process the OS reclaims on its own) or
  // buckets' plain filesystem store.
  async function shutdown(): Promise<void> {
    for (const server of runtimes.values()) {
      await server.close().catch(() => undefined);
    }
    await stateFile.flush();
    server.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // This daemon hosts `@prisma/dev`'s runtime in-process, and a failed or
  // abandoned start attempt can leave background async work behind whose
  // eventual rejection would otherwise kill the process (bun and node both
  // exit on an unhandled rejection). A machine-shared daemon serving every
  // app's databases must not die because one attempt's debris rejected —
  // log it (the daemon's stdio is teed to its registry log) and keep
  // serving; every REQUEST path still reports its own errors as 500s.
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

  readJsonFile(appsJsonPath, isAppsState)
    .then((loaded) => {
      if (loaded) state = loaded;
      server.listen(port, '127.0.0.1', () => {
        console.log(`[dev-emulators] postgres-main listening on 127.0.0.1:${String(port)}`);
      });
    })
    .catch((err: unknown) => {
      console.error('postgres-main: failed to load state', err);
      process.exit(1);
    });
}

main();
