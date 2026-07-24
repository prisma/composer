/**
 * The plan-S5 proving script (plan.md's S5 outcome; local-dev spec's
 * acceptance criteria 1, 2, 3, 6): drives the REAL, published
 * `prisma-composer` binary — `examples/store/node_modules/.bin/prisma-composer`
 * — as a real child process against `examples/store`, a real multi-module
 * app (four services, two Postgres-backed modules, cron), exactly as an
 * operator would run it. Every other integration script in this package
 * drives the pipeline's own functions directly; this one is deliberately at
 * arm's length — the CLI's argv parsing, its own SIGINT handling, its own
 * watch loop, and its own process lifetime are themselves what's under
 * test.
 *
 * Criteria proved here:
 *   1. Credential-free bring-up: PRISMA_WORKSPACE_ID/PRISMA_SERVICE_TOKEN/
 *      PRISMA_REGION are stripped from the child's env; the front door
 *      (`[dev] ready:` + one line per service) is parsed from real stdout;
 *      an HTTP round-trip against the storefront's URL succeeds.
 *   2. Rebuild restarts exactly one service: touching ONLY catalog's built
 *      artifact (so its hash moves, nothing else's) restarts `catalog.service`
 *      alone — every other service's pid is unchanged, including its own RPC
 *      consumers (`orders.service`, `cron.runner`) and everything unrelated
 *      (`storefront`, `cron.scheduler`). Run twice in a row against the same
 *      live session — this is the regression proof for the
 *      restart-amplification defect fixed in compute.ts's `materializeEnv`
 *      (see its `scopedEnv` doc comment): before that fix, the FIRST rebuild
 *      after a cold start restarted catalog's RPC consumers too, even though
 *      nothing about them had changed.
 *
 *      Attempt 1 drives the CLI's own real chokidar-based watch loop: the
 *      catalog build adapter declares `Bundle.watch: [runnable.source]` —
 *      the built artifact path itself (build.ts) — so touching
 *      `modules/catalog/dist/server.mjs` is exactly the file session 1's own
 *      running `prisma-composer dev` process is already watching. The script
 *      only touches the file and polls the compute emulator for the new pid
 *      — it never calls assemble or alchemy itself; the running process's
 *      own debounce, re-assemble, and re-converge are what's under test.
 *      Attempt 2 is the direct-converge variant kept as a fallback assertion:
 *      the artifact is touched, then the SAME dev stack file is re-converged
 *      directly with the real `alchemy` binary (matching
 *      local-dev.integration.ts's own pattern), bypassing the watch loop
 *      entirely — this re-hashes catalog's now-different bundle bytes and
 *      PUTs a fresh deployment for every service, letting the emulator's own
 *      (untouched) hash/env diffing decide which one(s) actually restart.
 *      Session 1's services are NEVER stopped in between (SIGINT is
 *      app-scoped and unconditionally restarts every service on the next
 *      redeploy — S3's own pinned "a stopped service always starts on
 *      redeploy" behavior — which would defeat this proof entirely).
 *   3. Postgres persistence: a row is written directly against the real
 *      local Postgres URL (read from the postgres-main daemon's own
 *      database listing — the daemon owns instance state, REVISED —
 *      operator review of #162; never through the app's own RPC surface —
 *      this is a storage-layer proof, not a business-logic one) before
 *      Ctrl-C; a second `dev` start reads it back (warm); `--fresh` wipes
 *      it.
 *   6. Warm restart: the second start's front-door ports match the first's
 *      exactly — no re-provisioning — AND an HTTP round-trip against the
 *      front door succeeds (the services genuinely serve after the resume;
 *      port-stability alone missed a live resume bug — spec § Acceptance).
 *
 * Not proved here (see the S5 report): criteria 4/5 (bucket, placeholder/
 * env-param) are proved against the S4 fixture instead — store declares
 * neither a bucket nor a secret/env-param.
 *
 * WHY THIS IS A STANDALONE SCRIPT, NOT bun:test: same reasoning as
 * local-dev.integration.ts — a detached grandchild a converge causes to
 * spawn (the emulator daemon programs) loses stdout under `bun test`'s own
 * process tree. Invoked by package.json's `test` script as a second
 * `bun run` step.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { containerEnv } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud } from '@prisma/composer-prisma-cloud/control';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    throw new Error(
      `assertion failed: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

const integrationDir = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(integrationDir, '..', '..');
const storeDir = path.join(repoRoot, 'examples', 'store');
// Deliberately OUTSIDE `.prisma-composer/dev` — `--fresh` recursively
// removes that whole directory (runDevTeardown), which would delete these
// logs mid-run otherwise.
const logDir = path.join(integrationDir, '.local-dev-store-proving-logs');
const CLI_BIN = path.join(storeDir, 'node_modules', '.bin', 'prisma-composer');
const READY_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

let sessionCount = 0;

interface Endpoint {
  readonly address: string;
  readonly url: string;
}

interface DevSession {
  readonly child: ChildProcess;
  readonly logPath: string;
  readonly endpoints: readonly Endpoint[];
}

function credentialFreeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['PRISMA_WORKSPACE_ID'];
  delete env['PRISMA_SERVICE_TOKEN'];
  delete env['PRISMA_REGION'];
  return env;
}

/** `~/.prisma-composer/emulators/` — the one real, machine-global root, same as `defaultRegistryRoot()` resolves. */
function emulatorRegistryRoot(): string {
  return path.join(os.homedir(), '.prisma-composer', 'emulators');
}

function tailOf(filePath: string, n = 60): string {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return `<could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}>`;
  }
  const lines = content.split('\n');
  return lines.slice(-n).join('\n');
}

/**
 * Everything a failure needs to be diagnosable from CI's own log output
 * alone — the teed session logs (which themselves carry the CLI's inherited
 * `alchemy` converge output inline) are on the runner, gone the moment the
 * job ends. Bounded, never throws.
 */
async function dumpDiagnostics(): Promise<void> {
  console.error('\n=== diagnostics ===');
  for (let i = 1; i <= sessionCount; i += 1) {
    const logPath = path.join(logDir, `session-${i}.log`);
    console.error(`\n--- session-${i}.log (tail) ---`);
    console.error(tailOf(logPath));
  }
  for (const name of ['compute', 'buckets', 'postgres'] as const) {
    console.error(`\n--- ${name} emulator log (tail) ---`);
    console.error(tailOf(path.join(emulatorRegistryRoot(), `${name}.log`)));
  }
  console.error(`\n--- postgres-main databases (app ${APP_NAME}) ---`);
  try {
    console.error(JSON.stringify(await listPostgresDatabases(), null, 2));
  } catch (error) {
    console.error(
      `<postgres-main listing unavailable: ${error instanceof Error ? error.message : String(error)}>`,
    );
  }
  console.error('=== end diagnostics ===\n');
}

function readLog(logPath: string): string {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

/** Parses the pinned front-door block out of the tee'd log: `[dev] ready:` then `[dev] <address>  <url>` lines, until a non-matching line. */
function parseFrontDoor(log: string): readonly Endpoint[] | undefined {
  const lines = log.split('\n');
  const readyAt = lines.findIndex((l) => l.trim() === '[dev] ready:');
  if (readyAt === -1) return undefined;
  const endpoints: Endpoint[] = [];
  for (let i = readyAt + 1; i < lines.length; i += 1) {
    const m = /^\[dev\] (\S+)\s\s(\S+)$/.exec(lines[i] ?? '');
    if (m === null) break;
    endpoints.push({ address: m[1] as string, url: m[2] as string });
  }
  return endpoints.length > 0 ? endpoints : undefined;
}

interface EmulatorRegistryEntry {
  readonly pid: number;
  readonly port: number;
}

function isRegistryEntry(value: unknown): value is EmulatorRegistryEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    'port' in value &&
    typeof value.port === 'number'
  );
}

/** The documented on-disk registry contract (spec § 2 daemon.ts) — read directly, same as local-dev.integration.ts. */
function readEmulatorEntry(name: 'compute' | 'postgres'): EmulatorRegistryEntry | undefined {
  const parsed = readJson(path.join(emulatorRegistryRoot(), `${name}.json`));
  return isRegistryEntry(parsed) ? parsed : undefined;
}

interface ServiceInfo {
  readonly address: string;
  readonly status: string;
  readonly pid?: number;
}

/** The documented Compute-emulator wire protocol (spec § 2 compute-main.ts) — plain fetch, never a typed client. */
async function listComputeServices(app: string): Promise<readonly ServiceInfo[]> {
  const entry = readEmulatorEntry('compute');
  if (entry === undefined) throw new Error('compute emulator registry entry not found');
  const res = await fetch(`http://127.0.0.1:${entry.port}/apps/${app}/services`);
  if (!res.ok) throw new Error(`compute emulator listServices failed: ${res.status}`);
  return (await res.json()) as ServiceInfo[];
}

interface PostgresDatabaseInfo {
  readonly instanceName: string;
  readonly url: string;
}

/** The documented postgres-emulator wire protocol (spec § 4, REVISED — operator review of #162: the daemon owns instance state, there is no dev-store postgres.json) — plain fetch, never the typed client. */
async function listPostgresDatabases(): Promise<readonly PostgresDatabaseInfo[]> {
  const entry = readEmulatorEntry('postgres');
  if (entry === undefined) throw new Error('postgres emulator registry entry not found');
  const res = await fetch(`http://127.0.0.1:${entry.port}/apps/${APP_NAME}/databases`);
  if (!res.ok) throw new Error(`postgres emulator listDatabases failed: ${res.status}`);
  return (await res.json()) as PostgresDatabaseInfo[];
}

/** Every address's pid, keyed by address — undefined for a stopped/absent service. */
async function pidsByAddress(app: string): Promise<Record<string, number | undefined>> {
  const services = await listComputeServices(app);
  return Object.fromEntries(services.map((s) => [s.address, s.pid]));
}

async function waitForAsync<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const result = await fn();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`waitFor: not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Starts `prisma-composer dev module.ts [--fresh]` as a real, teed child
 * process (stdout/stderr appended to a log FILE by raw fd — the same reason
 * local-dev.integration.ts avoids piped capture: nested grandchildren losing
 * output under some parent process trees). Bounded: the ready-wait itself is
 * the hang guard — nothing here can wait forever.
 */
async function startDev(fresh: boolean): Promise<DevSession> {
  sessionCount += 1;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `session-${sessionCount}.log`);
  const logFd = fs.openSync(logPath, 'w');
  const args = ['dev', 'module.ts', ...(fresh ? ['--fresh'] : [])];
  const child = spawn(CLI_BIN, args, {
    cwd: storeDir,
    env: credentialFreeEnv(),
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

  child.on('exit', (code, signal) => {
    // Visible in the log for post-mortem; the log file itself already
    // records everything the process printed before this.
    console.log(
      `[proving] session ${sessionCount} exited (code=${String(code)} signal=${String(signal)})`,
    );
  });

  const endpoints = await waitForAsync(
    async () => parseFrontDoor(readLog(logPath)),
    READY_TIMEOUT_MS,
    500,
  );
  return { child, logPath, endpoints };
}

/** SIGINT, then wait for the process to actually exit (bounded) — the pinned Ctrl-C contract: stop, exit 0, emulators survive. */
async function stopDev(session: DevSession): Promise<void> {
  if (session.child.exitCode !== null || session.child.signalCode !== null) return;
  session.child.kill('SIGINT');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`session did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGINT`));
    }, SHUTDOWN_TIMEOUT_MS);
    session.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readCatalogDbUrl(): Promise<string> {
  const databases = await listPostgresDatabases();
  const entry = databases.find((d) => d.instanceName === 'pcdev-store-catalog-database');
  assert(
    entry?.url !== undefined,
    'the postgres-main listing must carry a pcdev-store-catalog-database entry',
  );
  return entry.url;
}

/** Runs `bun`'s built-in SQL client against the real local Postgres URL — the storage layer, never the app's own RPC. */
/**
 * `prepare: false` — this script opens a fresh `Bun.SQL` client per call
 * against the same URL; Bun's prepared-statement cache is keyed by query
 * TEXT, and a rapid open/close/reopen cycle against the same connection
 * string can race the previous connection's prepare cleanup, surfacing as
 * `prepared statement "..." already exists` — confirmed live. This is a
 * storage-layer proof, not a prepared-statement-caching one, so caching is
 * simply off.
 */
async function withSql<T>(url: string, fn: (sql: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new Bun.SQL({ url, prepare: false });
  try {
    return await fn(sql);
  } finally {
    await sql.close();
  }
}

const PROVING_PRODUCT_ID = 'proving-row';
const APP_NAME = 'store';
const catalogDist = path.join(storeDir, 'modules', 'catalog', 'dist', 'server.mjs');
const DEV_STACK_FILE = path.join(storeDir, '.prisma-composer', 'dev', 'alchemy.run.ts');

/** Walks up from `startDir` looking for `node_modules/.bin/alchemy` — same as local-dev.integration.ts's own helper. */
function alchemyBin(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'alchemy');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error(`could not find node_modules/.bin/alchemy above ${startDir}`);
    dir = parent;
  }
}

/**
 * Touches ONLY catalog's built artifact (append a harmless comment — its
 * content hash moves, nothing else's does), re-runs the node build
 * adapter's OWN `assemble()` for catalog specifically (it copies the built
 * runnable into `.prisma-composer/artifacts/catalog.service/bundle/` —
 * touching the source alone does not move anything alchemy actually reads;
 * the copy must be refreshed), then re-converges the SAME dev stack file
 * session 1's own `prisma-composer dev` already wrote, directly with the
 * real `alchemy` binary — no CLI re-invocation, no SIGINT, session 1's
 * services stay running throughout. The stack file's `bundles` map needs no
 * edit: `assemble()`'s output directory is a deterministic function of the
 * address, so it already points at the freshly-copied bytes. Re-hashing
 * catalog's now-different bundle and PUTting a fresh deployment for every
 * service lets the emulator's own (untouched) hash/env diffing decide which
 * one(s) restart. Returns every service's pid AFTER the converge.
 */
const REAL_WATCH_TIMEOUT_MS = 30_000;

/**
 * Touches ONLY catalog's built artifact — the same file the running
 * `prisma-composer dev` process's own chokidar watch loop is already
 * watching (`Bundle.watch: [runnable.source]`, build.ts). This does not call
 * assemble or alchemy itself: the running process's own debounce (300ms),
 * re-assemble, and re-converge are what's being proved.
 *
 * Waits for the watch loop's OWN completion signal — run-dev.ts reprints the
 * front door (`[dev] ready:` + one line per service) after a successful
 * reconverge — rather than just for catalog.service's pid to move: the spec
 * re-runs assemble for EVERY service on a fire (not just the touched one),
 * so waiting on catalog's pid alone can return while the running process is
 * still mid-converge for other services, racing this script's own later use
 * of the same on-disk artifact directories (confirmed live: a direct
 * fallback reconverge started right after the pid-only wait hit "no
 * main.js/main.mjs found in bundle dir .../artifacts/storefront" — the real
 * process's own converge was still writing it). Bounded by
 * `REAL_WATCH_TIMEOUT_MS`.
 */
async function touchCatalogAndAwaitRealWatchLoop(
  session: DevSession,
  pidsBefore: Record<string, number | undefined>,
): Promise<Record<string, number | undefined>> {
  const beforeLineCount = readLog(session.logPath).split('\n').length;

  fs.appendFileSync(catalogDist, `\n// proving-script touch (real watch loop) ${Date.now()}\n`);

  await waitForAsync(async () => {
    const newLines = readLog(session.logPath).split('\n').slice(beforeLineCount);
    return parseFrontDoor(newLines.join('\n'));
  }, REAL_WATCH_TIMEOUT_MS);

  return waitForAsync(async () => {
    const pids = await pidsByAddress(APP_NAME);
    return pids['catalog.service'] !== undefined &&
      pids['catalog.service'] !== pidsBefore['catalog.service']
      ? pids
      : undefined;
  }, 15_000);
}

async function rebuildCatalogAndReconverge(): Promise<Record<string, number | undefined>> {
  fs.appendFileSync(catalogDist, `\n// proving-script touch ${Date.now()}\n`);

  const catalogServiceModule = path.join(storeDir, 'modules', 'catalog', 'src', 'service.ts');
  const buildDescriptor = nodeBuild().nodes['node'];
  assert(
    buildDescriptor !== undefined && buildDescriptor.kind === 'build',
    'nodeBuild() must declare a "node" build descriptor',
  );
  await buildDescriptor.assemble({
    build: {
      extension: '@prisma/composer/node',
      type: 'node',
      module: `file://${catalogServiceModule}`,
      entry: '../dist/server.mjs',
    },
    address: 'catalog.service',
    cwd: storeDir,
  });

  const descriptor = prismaCloud();
  if (descriptor.localTarget === undefined) throw new Error('no localTarget descriptor');
  const dev = await descriptor.localTarget();
  const container = await dev.container.ensure({ appName: APP_NAME, stage: undefined });
  const envVars = containerEnv(new Map([[descriptor.id, container]]));

  const result = spawnSync(
    alchemyBin(storeDir),
    ['deploy', path.relative(storeDir, DEV_STACK_FILE), '--yes', '--stage', 'dev'],
    { cwd: storeDir, stdio: 'inherit', env: { ...process.env, ...envVars } },
  );
  assert(
    result.status === 0,
    `re-converge (alchemy deploy) failed with status ${String(result.status)}`,
  );

  // The pid the emulator reports settles a moment after the converge
  // completes (the restarted child still needs to actually start).
  return waitForAsync(async () => {
    const pids = await pidsByAddress(APP_NAME);
    return pids['catalog.service'] !== undefined ? pids : undefined;
  }, 15_000);
}

async function main(): Promise<void> {
  console.log('local dev (S5 proving): examples/store via the real prisma-composer dev binary');

  fs.rmSync(path.join(storeDir, '.prisma-composer'), { recursive: true, force: true });
  fs.rmSync(path.join(storeDir, '.alchemy'), { recursive: true, force: true });

  let session: DevSession | undefined;
  try {
    // ——— Criterion 1: credential-free bring-up + HTTP round-trip ———
    session = await startDev(false);
    console.log(`[proving] session 1 ready: ${JSON.stringify(session.endpoints)}`);
    assert(
      session.endpoints.some((e) => e.address === 'storefront'),
      'the front door must list the storefront service',
    );
    const storefront = session.endpoints.find((e) => e.address === 'storefront');
    if (storefront === undefined) throw new Error('unreachable');
    const health = await waitForAsync(
      () => fetch(storefront.url).then((r) => (r.ok ? r : undefined)),
      15_000,
    );
    assertEqual(health.status, 200, 'the storefront HTTP round-trip');
    console.log('[proving] PASS criterion 1: credential-free bring-up + HTTP round-trip');

    const firstPortsByAddress = Object.fromEntries(
      session.endpoints.map((e) => [e.address, new URL(e.url).port]),
    );

    // ——— Criterion 2: rebuild restarts exactly one service ———
    // Regression proof for the restart-amplification defect: run it TWICE
    // against the SAME live session — the defect this fixes was specific to
    // the FIRST rebuild after a cold start (env.json's per-service snapshot
    // was complete only from the second converge onward), so a single
    // rebuild alone would not have caught it.
    const ADDRESSES = [
      'catalog.service',
      'storefront',
      'cron.runner',
      'orders.service',
      'cron.scheduler',
    ];
    const pidsBaseline = await waitForAsync(async () => {
      const pids = await pidsByAddress(APP_NAME);
      return ADDRESSES.every((a) => pids[a] !== undefined) ? pids : undefined;
    }, 15_000);

    const activeSession = session;
    assert(activeSession !== undefined, 'session 1 must be running before criterion 2');

    let pidsBefore = pidsBaseline;
    const RECONVERGE_STRATEGIES = [
      {
        label: 'real watch loop',
        run: (before: Record<string, number | undefined>) =>
          touchCatalogAndAwaitRealWatchLoop(activeSession, before),
      },
      { label: 'direct converge (fallback)', run: () => rebuildCatalogAndReconverge() },
    ] as const;
    for (const [index, strategy] of RECONVERGE_STRATEGIES.entries()) {
      const attempt = index + 1;
      const pidsAfter = await strategy.run(pidsBefore);
      assert(
        pidsAfter['catalog.service'] !== pidsBefore['catalog.service'],
        `criterion 2 (attempt ${attempt}, ${strategy.label}): catalog.service must restart (new pid)`,
      );
      for (const address of ['storefront', 'cron.runner', 'orders.service', 'cron.scheduler']) {
        assertEqual(
          pidsAfter[address],
          pidsBefore[address],
          `criterion 2 (attempt ${attempt}, ${strategy.label}): ${address}'s pid must NOT change — only catalog.service was rebuilt`,
        );
      }
      console.log(
        `[proving] PASS criterion 2 (attempt ${attempt}, ${strategy.label}): exactly catalog.service restarted, all four others unchanged`,
      );
      pidsBefore = pidsAfter;
    }

    // ——— Criterion 3 (write half): a row through the real local Postgres URL ———
    const dbUrl = await readCatalogDbUrl();
    await withSql(dbUrl, async (sql) => {
      // prisma-next's migration DDL folds the table name and single-word
      // columns to lowercase (unquoted identifiers); "priceCents" alone
      // stays quoted, mixed-case.
      await sql`insert into product (id, name, description, "priceCents")
                values (${PROVING_PRODUCT_ID}, 'Proving Row', 'S5 proving script', 100)
                on conflict (id) do update set name = excluded.name`;
    });
    console.log('[proving] wrote the proving row through the real local Postgres URL');

    // ——— Ctrl-C ———
    await stopDev(session);
    console.log('[proving] session 1 stopped cleanly on SIGINT');

    // ——— Criterion 3 (warm read) + criterion 6 (same ports) ———
    session = await startDev(false);
    console.log(`[proving] session 2 (warm) ready: ${JSON.stringify(session.endpoints)}`);
    const secondPortsByAddress = Object.fromEntries(
      session.endpoints.map((e) => [e.address, new URL(e.url).port]),
    );
    assertEqual(
      secondPortsByAddress,
      firstPortsByAddress,
      'criterion 6: warm restart keeps the same ports',
    );

    // The pinned half of criterion 6 (spec § Acceptance): after the warm
    // restart the services must GENUINELY SERVE, not merely be listed with
    // stable ports — a converge that diffs nothing starts nothing, so only
    // the attach step's startServices() resume makes this round-trip
    // succeed. Port stability alone let exactly that resume bug ship.
    const warmStorefront = session.endpoints.find((e) => e.address === 'storefront');
    assert(warmStorefront !== undefined, 'the warm front door must list the storefront service');
    const warmHealth = await waitForAsync(
      () => fetch(warmStorefront.url).then((r) => (r.ok ? r : undefined)),
      15_000,
    );
    assertEqual(
      warmHealth.status,
      200,
      'criterion 6: the HTTP round-trip succeeds after a warm restart (services resumed)',
    );

    const warmDbUrl = await readCatalogDbUrl();
    assertEqual(warmDbUrl, dbUrl, 'criterion 6: the Postgres URL is stable across a warm restart');
    const warmRow = await withSql(
      warmDbUrl,
      (sql) => sql`select name from product where id = ${PROVING_PRODUCT_ID}`,
    );
    assertEqual(
      (warmRow as unknown as { name: string }[])[0]?.name,
      'Proving Row',
      'criterion 3: the row survives a warm (non---fresh) restart',
    );
    console.log('[proving] PASS criterion 3 (warm): row survived a Ctrl-C restart');
    console.log(
      '[proving] PASS criterion 6: same ports, no re-provisioning, and a serving front door across a warm restart',
    );

    await stopDev(session);
    console.log('[proving] session 2 stopped cleanly on SIGINT');

    // ——— Criterion 3 (--fresh half): the instance and its data are gone ———
    session = await startDev(true);
    console.log(`[proving] session 3 (--fresh) ready: ${JSON.stringify(session.endpoints)}`);
    const freshDbUrl = await readCatalogDbUrl();
    // --fresh removes the app's postgres-main-hosted servers and their
    // persisted data (DELETE /apps/<app> on the daemon, runDevTeardown) and
    // recreates them on next provision — migrations reapply as part of THIS
    // SAME converge (PnMigration runs on every converge), so the "product"
    // table exists again by the time the front door prints; the proof is
    // that it's freshly migrated and EMPTY — the proving row from before
    // --fresh is gone.
    const freshRow = await withSql(
      freshDbUrl,
      (sql) => sql`select name from product where id = ${PROVING_PRODUCT_ID}`,
    );
    assertEqual(
      (freshRow as unknown as { name: string }[]).length,
      0,
      'criterion 3 (--fresh): the proving row must be gone from a fresh instance',
    );
    console.log('[proving] PASS criterion 3 (--fresh): the prior instance and its data are gone');

    console.log('PASS: local dev (S5 proving) — examples/store, criteria 1/2/3/6');
  } finally {
    if (session !== undefined) {
      await stopDev(session).catch(() => undefined);
    }
    // Final app-scoped teardown, mirroring local-dev.integration.ts: never
    // touch the machine-global emulator daemons, only this app's own
    // records. `--fresh` teardown only runs BEFORE that session's own
    // (mandatory) converge, never after — so `startDev(true)` + `stopDev`
    // alone still leaves the postgres-main-hosted servers THIS cleanup
    // session's own converge just recreated. Call `dev.teardown` directly
    // afterward to actually remove them (`--fresh` then Ctrl-C then
    // teardown leaves nothing running and no data behind for the next run).
    try {
      const cleanup = await startDev(true);
      await stopDev(cleanup);
      const descriptor = prismaCloud();
      const dev = descriptor.localTarget === undefined ? undefined : await descriptor.localTarget();
      if (dev?.teardown !== undefined) {
        const container = await dev.container.ensure({
          appName: APP_NAME,
          stage: undefined,
        });
        await dev.teardown({ container, stage: undefined });
      }
    } catch (error) {
      console.error(
        `[proving] final --fresh cleanup did not complete cleanly: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const stray = spawnSync('pgrep', ['-f', 'prisma-composer dev module.ts']);
    for (const line of (stray.stdout?.toString() ?? '').split('\n')) {
      const pid = Number(line.trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    await dumpDiagnostics();
    process.exitCode = 1;
  });
