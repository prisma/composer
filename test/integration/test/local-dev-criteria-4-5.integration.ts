/**
 * The plan-S5 proving script for acceptance criteria 4 and 5 (spec's
 * acceptance criteria list): drives the real `prisma-composer` binary
 * against the S4 fixture (`test/fixtures/local-dev/`), extended for this
 * proof with a bucket consumer flow on `web` and a secret/env-param on
 * `bkg` (module.ts's `apiKey`/`greeting` binding). Same pattern as
 * `local-dev-store.integration.ts` — a real child process, teed output,
 * bounded waits.
 *
 * Criterion 4 (bucket round-trip): PUT an object through the app's own
 * `/blobs/:key` route, confirm it lands as a plain file under
 * `.prisma-composer/dev/buckets/files/<key>`; drop a file directly into
 * that directory and GET it back through the app.
 *
 * Criterion 5 (value sourcing): with `LOCALDEV_FIXTURE_API_KEY` unset, the
 * pinned placeholder warning appears and the topology still serves; with
 * `LOCALDEV_FIXTURE_GREETING` (an `envParam`) unset, dev exits nonzero with
 * the pinned missing-env-param listing error naming it — checked in two
 * separate sessions, since the second failure happens in preflight, before
 * anything converges.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
const fixtureEntry = path.join('test', 'fixtures', 'local-dev', 'module.ts');
const devDir = path.join(integrationDir, '.prisma-composer', 'dev');
const logDir = path.join(integrationDir, '.local-dev-criteria-4-5-logs');
const CLI_BIN = path.join(integrationDir, 'node_modules', '.bin', 'prisma-composer');
const READY_TIMEOUT_MS = 90_000;
const EXIT_TIMEOUT_MS = 30_000;
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

function readLog(logPath: string): string {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
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
 * alone — the teed session logs (carrying the CLI's inherited `alchemy`
 * converge output inline) are on the runner, gone the moment the job ends.
 * Bounded, never throws.
 */
function dumpDiagnostics(): void {
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
  console.error('=== end diagnostics ===\n');
}

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

function baseEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['PRISMA_WORKSPACE_ID'];
  delete env['PRISMA_SERVICE_TOKEN'];
  delete env['PRISMA_REGION'];
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Starts `prisma-composer dev [--fresh]` against the fixture, teed to a log file. Does not wait for readiness — callers pick the wait strategy (ready vs. exit). */
function startDevRaw(
  env: NodeJS.ProcessEnv,
  opts: { readonly fresh?: boolean } = {},
): { child: ChildProcess; logPath: string } {
  sessionCount += 1;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `session-${sessionCount}.log`);
  const logFd = fs.openSync(logPath, 'w');
  const args = ['dev', fixtureEntry, ...(opts.fresh === true ? ['--fresh'] : [])];
  const child = spawn(CLI_BIN, args, {
    cwd: integrationDir,
    env,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  return { child, logPath };
}

async function startDevUntilReady(
  env: NodeJS.ProcessEnv,
  opts: { readonly fresh?: boolean } = {},
): Promise<DevSession> {
  const { child, logPath } = startDevRaw(env, opts);
  const endpoints = await waitForAsync(
    async () => parseFrontDoor(readLog(logPath)),
    READY_TIMEOUT_MS,
    500,
  );
  return { child, logPath, endpoints };
}

/** Waits for the process to exit on its own (the hard-error path never reaches "ready"). */
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

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

async function main(): Promise<void> {
  console.log(
    'local dev (S5 proving): criteria 4 (bucket) and 5 (placeholder/env-param) against the S4 fixture',
  );

  fs.rmSync(path.join(integrationDir, '.prisma-composer'), { recursive: true, force: true });
  fs.rmSync(path.join(integrationDir, '.alchemy'), { recursive: true, force: true });

  let session: DevSession | undefined;
  try {
    // ——— Criterion 5a: the secret is unset — a placeholder warning, topology still serves ———
    session = await startDevUntilReady(
      baseEnv({
        LOCALDEV_FIXTURE_API_KEY: undefined,
        LOCALDEV_FIXTURE_GREETING: 'hi-from-s5-proving',
      }),
    );
    console.log(`[proving] session 1 ready: ${JSON.stringify(session.endpoints)}`);
    const log1 = readLog(session.logPath);
    assert(
      log1.includes(
        '[dev] LOCALDEV_FIXTURE_API_KEY is not set in this shell — using a local placeholder. Anything that talks to the real service behind it will fail; everything else runs.',
      ),
      'the pinned placeholder warning must appear for the unset secret',
    );
    console.log('[proving] PASS criterion 5a: placeholder warning printed, topology still serves');

    // ——— Criterion 4: bucket round-trip through the app ———
    const web = session.endpoints.find((e) => e.address === 'web');
    assert(web !== undefined, 'the web service must appear in the front door');
    if (web === undefined) throw new Error('unreachable');

    const putRes = await waitForAsync(
      () =>
        fetch(`${web.url}/blobs/proving-key.txt`, {
          method: 'PUT',
          headers: { 'content-type': 'text/plain' },
          body: 'hello from the S5 bucket proof',
        }).then((r) => (r.status === 201 ? r : undefined)),
      15_000,
    );
    assertEqual(putRes.status, 201, 'PUT /blobs/proving-key.txt through the app');

    const objectPath = path.join(devDir, 'buckets', 'files', 'proving-key.txt');
    const onDisk = await waitForAsync(
      async () => (fs.existsSync(objectPath) ? fs.readFileSync(objectPath, 'utf8') : undefined),
      5_000,
      200,
    );
    assertEqual(onDisk, 'hello from the S5 bucket proof', 'the PUT object is a plain file on disk');
    console.log(`[proving] PASS criterion 4 (write direction): ${objectPath}`);

    // Drop a file directly into the bucket directory, read it back through the app.
    const droppedPath = path.join(devDir, 'buckets', 'files', 'dropped-key.txt');
    fs.writeFileSync(droppedPath, 'dropped straight onto disk');
    const getRes = await waitForAsync(
      () =>
        fetch(`${web.url}/blobs/dropped-key.txt`).then((r) => (r.status === 200 ? r : undefined)),
      10_000,
    );
    const getBody = await getRes.text();
    assertEqual(
      getBody,
      'dropped straight onto disk',
      'a file dropped on disk is readable back through the app',
    );
    console.log(
      '[proving] PASS criterion 4 (read direction): a dropped file is visible through the app',
    );

    await stopDev(session);
    console.log('[proving] session 1 stopped cleanly on SIGINT');

    // ——— Criterion 5b: the envParam is unset — a hard error naming it, nonzero exit ———
    const { child: child2, logPath: logPath2 } = startDevRaw(
      baseEnv({
        LOCALDEV_FIXTURE_API_KEY: 'a-real-looking-key',
        LOCALDEV_FIXTURE_GREETING: undefined,
      }),
    );
    const exitCode = await waitForExit(child2, EXIT_TIMEOUT_MS);
    const log2 = readLog(logPath2);
    assert(
      exitCode !== 0 && exitCode !== null,
      'dev must exit nonzero when a required envParam is unset',
    );
    assert(
      log2.includes(
        'local dev preflight failed — 1 env-sourced param(s) are not set in this shell:',
      ),
      'the pinned listing-error header must appear',
    );
    assert(
      /LOCALDEV_FIXTURE_GREETING\s+\(required by service "bkg"\)/.test(log2),
      'the error must name LOCALDEV_FIXTURE_GREETING and the service that requires it',
    );
    assert(
      log2.includes('Set each in the shell you run `prisma-composer dev` from.'),
      'the pinned fix instruction must appear',
    );
    console.log(
      `[proving] PASS criterion 5b: exit ${String(exitCode)}, pinned listing error naming LOCALDEV_FIXTURE_GREETING`,
    );

    console.log('PASS: local dev (S5 proving) — criteria 4 and 5');
  } finally {
    if (session !== undefined) {
      await stopDev(session).catch(() => undefined);
    }
    // Full app-scoped teardown through the CLI's own --fresh, exactly as
    // local-dev-store.integration.ts does — removes the postgres-main-hosted
    // server this fixture's `postgres({ name: 'appdb' })` created, the
    // emulators' app-scoped records, and the local state dir, never the
    // machine-global daemons. `--fresh` teardown runs BEFORE that session's
    // own (mandatory) converge, so a direct `dev.teardown` afterwards removes
    // what the cleanup session's converge itself just recreated.
    try {
      const cleanup = await startDevUntilReady(
        baseEnv({ LOCALDEV_FIXTURE_API_KEY: 'cleanup-key', LOCALDEV_FIXTURE_GREETING: 'cleanup' }),
        { fresh: true },
      );
      await stopDev(cleanup);
      const descriptor = prismaCloud();
      const dev = descriptor.localTarget === undefined ? undefined : await descriptor.localTarget();
      if (dev?.teardown !== undefined) {
        const container = await dev.container.ensure({
          appName: 'localdevs4fixture',
          stage: undefined,
        });
        await dev.teardown({ container, stage: undefined });
      }
    } catch (error) {
      console.error(
        `[proving] final cleanup did not complete cleanly: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const stray = spawnSync('pgrep', ['-f', `prisma-composer dev ${fixtureEntry}`]);
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
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    dumpDiagnostics();
    process.exitCode = 1;
  });
