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
import { readOwnVersion } from './daemon.ts';
import { instanceNameFor } from './instance-name.ts';
import { isValidSegment } from './segments.ts';
import { readJsonFile, StateFile } from './state-file.ts';

const MIN_DATABASE_PORT = 51_300;
const MAX_DATABASE_PORT = 65_535;
const APPS_STATE_MODE = 0o600;
/** Spec § 2 step 5's pattern, applied to a fresh database-port allocation. */
const MAX_FRESH_PORT_CANDIDATES = 5;

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
function isPortConflict(err: unknown, port: number): boolean {
  if (typeof err !== 'object' || err === null || !('port' in err)) return false;
  return err.port === port;
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
  deleteServer(name: string, debug?: boolean): Promise<void>;
}

function isPrismaDevInternalStateModule(value: unknown): value is PrismaDevInternalStateModule {
  return isStringKeyedRecord(value) && typeof value['deleteServer'] === 'function';
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
  const liveAuxPorts = new Set<number>();
  const auxPortsByInstance = new Map<string, readonly number[]>();

  function releaseAuxPorts(instanceName: string): void {
    for (const p of auxPortsByInstance.get(instanceName) ?? []) liveAuxPorts.delete(p);
    auxPortsByInstance.delete(instanceName);
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

  async function smallestUnusedDatabasePort(min: number): Promise<number> {
    return getPort({ port: portNumbers(min, MAX_DATABASE_PORT), exclude: usedDatabasePorts() });
  }

  /** Three fresh, mutually distinct ports for a server's own HTTP/shadow-database/streams listeners — never persisted, only unique right now. */
  async function allocateAuxPorts(excluding: ReadonlySet<number>): Promise<{
    readonly httpPort: number;
    readonly shadowDatabasePort: number;
    readonly streamsPort: number;
  }> {
    const taken = new Set([...usedDatabasePorts(), ...liveAuxPorts, ...excluding]);
    const httpPort = await getPort({
      port: portNumbers(MIN_DATABASE_PORT, MAX_DATABASE_PORT),
      exclude: taken,
    });
    taken.add(httpPort);
    const shadowDatabasePort = await getPort({
      port: portNumbers(MIN_DATABASE_PORT, MAX_DATABASE_PORT),
      exclude: taken,
    });
    taken.add(shadowDatabasePort);
    const streamsPort = await getPort({
      port: portNumbers(MIN_DATABASE_PORT, MAX_DATABASE_PORT),
      exclude: taken,
    });
    return { httpPort, shadowDatabasePort, streamsPort };
  }

  async function ensureDatabase(
    app: string,
    id: string,
    prismaDevModulePath: string,
  ): Promise<{ url: string }> {
    const appRec = getOrCreateApp(app);
    const instanceName = instanceNameFor(app, id);
    const existingRecord = appRec.databases[id];

    // Already live in THIS process — idempotent, nothing to do.
    const runningServer = runtimes.get(instanceName);
    if (existingRecord && runningServer) {
      return { url: existingRecord.url };
    }

    const prismaDev = await importPrismaDev(prismaDevModulePath);
    const isFreshAllocation = existingRecord === undefined;
    const maxAttempts = isFreshAllocation ? MAX_FRESH_PORT_CANDIDATES : 1;
    let dbPort =
      existingRecord?.databasePort ?? (await smallestUnusedDatabasePort(MIN_DATABASE_PORT));

    for (let attempt = 1; ; attempt++) {
      const aux = await allocateAuxPorts(new Set([dbPort]));
      try {
        const server = await prismaDev.startPrismaDevServer({
          name: instanceName,
          databasePort: dbPort,
          port: aux.httpPort,
          shadowDatabasePort: aux.shadowDatabasePort,
          streamsPort: aux.streamsPort,
          persistenceMode: 'stateful',
        });
        const url = server.database.connectionString;
        runtimes.set(instanceName, server);
        liveAuxPorts.add(aux.httpPort);
        liveAuxPorts.add(aux.shadowDatabasePort);
        liveAuxPorts.add(aux.streamsPort);
        auxPortsByInstance.set(instanceName, [
          aux.httpPort,
          aux.shadowDatabasePort,
          aux.streamsPort,
        ]);
        appRec.databases[id] = { id, instanceName, databasePort: dbPort, url };
        schedulePersist();
        return { url };
      } catch (err) {
        const canRetryNextPort =
          isFreshAllocation && isPortConflict(err, dbPort) && attempt < maxAttempts;
        if (!canRetryNextPort) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(
            `postgres emulator failed to start database "${instanceName}" on port ${String(dbPort)}: ${maskCredentials(firstLine(reason))}`,
          );
        }
        dbPort = await smallestUnusedDatabasePort(dbPort + 1);
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

    await Promise.all(
      entries.map(async (db) => {
        const server = runtimes.get(db.instanceName);
        if (server) {
          await server.close();
          runtimes.delete(db.instanceName);
          releaseAuxPorts(db.instanceName);
        }
      }),
    );

    // Deleting the persisted PGlite data needs SOME resolved `@prisma/dev`
    // module — the app that owns the databases being deleted is the same
    // app whose `prismaDevModulePath` every PUT for it already carried, so
    // any one of those already-observed paths works; DELETE itself carries
    // no body, so there is nothing more specific to prefer.
    if (entries.length > 0 && prismaDevModulePathHint) {
      const { deleteServer } = await importPrismaDevInternalState(prismaDevModulePathHint);
      await Promise.all(entries.map((db) => deleteServer(db.instanceName)));
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
    await Promise.all(
      [...runtimes.values()].map((server) => server.close().catch(() => undefined)),
    );
    await stateFile.flush();
    server.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

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
