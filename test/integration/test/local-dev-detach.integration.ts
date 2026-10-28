/**
 * `prisma dev --detach` against the local-dev fixture on real emulators in a
 * temporary emulators directory, run through the installed `prisma` host:
 *
 * 1. It exits 0 once every service answers, and the services keep answering
 *    after it exits.
 * 2. Stopping the app then stops them. The installed host does not mount
 *    `prisma dev stop` yet, so this calls the `devStop` operation of
 *    `@prisma/composer/control`, which that command renders.
 * 3. A detached run that fails before ready leaves nothing of the app
 *    running. The Compute emulator is restarted with a one-millisecond
 *    readiness timeout, so the first service fails after the converge has
 *    started the app's databases.
 *
 * The fixture's services are pushed to ports from 3200 up, so a process
 * binding a busy port such as 3000 cannot make a closed-port check fail.
 *
 * A standalone script, not a `bun test` file, for the reason given in
 * local-dev.integration.ts: output of processes started under the deploy
 * engine is lost when the root process is `bun test`.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Load, module } from '@prisma/composer';
import { DEV_DIR } from '@prisma/composer/config';
import { devStop } from '@prisma/composer/control';
import { prismaCloud } from '@prisma/composer-prisma-cloud/control';
import prismaConfig from '../prisma.config.ts';
import { prismaBinDir } from './spawn-prisma.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

const integrationDir = path.resolve(import.meta.dir, '..');
const fixtureEntry = path.join('test', 'fixtures', 'local-dev', 'module.ts');
const devDir = path.join(integrationDir, '.prisma-composer', 'dev');
const logDir = path.join(integrationDir, '.local-dev-detach-logs');
const CLI_BIN = path.join(prismaBinDir(integrationDir), 'prisma');
const EXIT_TIMEOUT_MS = 120_000;
const config = {
  value: prismaConfig.composer,
  file: path.join(integrationDir, 'prisma.config.ts'),
};
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-dev-detach-'));
const emulatorsDir = path.join(tempRoot, 'emulators');
const APP = 'localdevs4fixture';
/**
 * Where the fixture's services start. Port 3000 and the ports just above it
 * are the busiest on a development machine, and a port another process binds
 * after a stop would read as a service that was not stopped. Ports below this
 * one go to placeholder instances, which the Compute emulator keeps across
 * its restart in part 3.
 */
const FIRST_SERVICE_PORT = 3200;
let runCount = 0;

interface Endpoint {
  readonly address: string;
  readonly url: string;
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...process.env,
    PRISMA_COMPOSER_EMULATORS_DIR: emulatorsDir,
    LOCALDEV_FIXTURE_API_KEY: 'detach-proof',
    LOCALDEV_FIXTURE_GREETING: 'hello',
    ...extra,
  };
  delete result['PRISMA_WORKSPACE_ID'];
  delete result['PRISMA_SERVICE_TOKEN'];
  delete result['PRISMA_REGION'];
  return result;
}

/** Runs `prisma dev <fixture> --detach --fresh --json` to completion; returns its exit code and output. */
async function runDetached(
  runEnv: NodeJS.ProcessEnv,
): Promise<{ code: number | null; log: string }> {
  runCount += 1;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `run-${String(runCount)}.log`);
  const logFd = fs.openSync(logPath, 'w');
  const child = spawn(CLI_BIN, ['dev', '--entry', fixtureEntry, '--detach', '--fresh', '--json'], {
    cwd: integrationDir,
    env: runEnv,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`prisma dev --detach did not exit within ${String(EXIT_TIMEOUT_MS)}ms`));
    }, EXIT_TIMEOUT_MS);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, log: fs.readFileSync(logPath, 'utf8') };
}

/** The front door, from the `--json` run's `endpoint` frames. */
function frontDoor(log: string): readonly Endpoint[] {
  const endpoints: Endpoint[] = [];
  for (const line of log.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const frame = JSON.parse(line) as { kind?: string; name?: string; url?: string };
      if (frame.kind === 'endpoint' && frame.name !== undefined && frame.url !== undefined) {
        endpoints.push({ address: frame.name, url: frame.url });
      }
    } catch {
      // Converge output is interleaved with the frames.
    }
  }
  return endpoints;
}

function acceptsConnection(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** The ports the directory's record holds for the current app's services and databases. */
function recordedPorts(): readonly { readonly kind: string; readonly port: number }[] {
  const record = JSON.parse(
    fs.readFileSync(path.join(devDir, 'emulator-instances.json'), 'utf8'),
  ) as {
    current: string;
    apps: Record<string, { nodes: Record<string, { kind: string; port?: number }> }>;
  };
  const nodes = record.apps[record.current]?.nodes ?? {};
  return Object.values(nodes).flatMap(({ kind, port }) =>
    port === undefined ? [] : [{ kind, port }],
  );
}

/** Asserts the record holds a service and a database port, and that none of them accepts connections. */
async function assertNothingListens(when: string): Promise<void> {
  const ports = recordedPorts();
  for (const { kind, port } of ports) {
    if (kind !== 'service') continue;
    assert(
      port >= FIRST_SERVICE_PORT,
      `service port ${String(port)} is at or above ${String(FIRST_SERVICE_PORT)} ${when}`,
    );
  }
  const kinds = new Set(ports.map((p) => p.kind));
  assert(
    kinds.has('service') && kinds.has('database'),
    `the record holds service and database ports ${when} (got ${JSON.stringify(ports)})`,
  );
  for (const { kind, port } of ports) {
    assert(!(await acceptsConnection(port)), `${kind} port ${String(port)} is closed ${when}`);
  }
}

/** Starts the Compute emulator with an app that has no nodes, then fills every port below `port` with a placeholder instance. */
async function reserveServicePortsBelow(port: number): Promise<void> {
  const localTarget = prismaCloud().localTarget;
  assert(localTarget !== undefined, 'prismaCloud() has a local target');
  const target = await localTarget();
  await target.emulators?.({
    graph: Load(
      module('portskip', () => {}),
      { id: 'portskip' },
    ),
    container: await target.container.ensure({ appName: 'portskip', environment: 'dev' }),
    devDir: path.join(tempRoot, 'placeholders', DEV_DIR),
  });
  const { port: adminPort } = JSON.parse(
    fs.readFileSync(path.join(emulatorsDir, 'compute.json'), 'utf8'),
  ) as { port: number };
  for (let given = 0; given < port - 1; ) {
    const created = await fetch(`http://127.0.0.1:${String(adminPort)}/instances`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labels: { purpose: 'port-skip' } }),
    });
    if (!created.ok) {
      throw new Error(
        `creating a placeholder instance failed (${String(created.status)}): ${await created.text()}`,
      );
    }
    given = ((await created.json()) as { port: number }).port;
  }
}

async function main(): Promise<void> {
  console.log('local dev: prisma dev --detach against the local-dev fixture');
  fs.rmSync(path.join(integrationDir, '.prisma-composer'), { recursive: true, force: true });
  fs.rmSync(path.join(integrationDir, '.alchemy'), { recursive: true, force: true });

  process.env['PRISMA_COMPOSER_EMULATORS_DIR'] = emulatorsDir;
  await reserveServicePortsBelow(FIRST_SERVICE_PORT);

  // ——— 1. Ready, exit 0, still answering afterwards ———
  const detached = await runDetached(env());
  assert(detached.code === 0, `prisma dev --detach exits 0 (got ${String(detached.code)})`);
  const endpoints = frontDoor(detached.log);
  assert(
    endpoints
      .map((e) => e.address)
      .sort()
      .join(',') === `${APP}.bkg,${APP}.web`,
    `the front door lists bkg and web (got ${JSON.stringify(endpoints)})`,
  );
  for (const endpoint of endpoints) {
    const res = await fetch(endpoint.url);
    assert(res.status === 200, `${endpoint.address} answers after dev exited`);
  }
  console.log('[detach] PASS: exit 0 once ready, and every service answers after it exits');

  // ——— 2. Stopping the app stops them ———
  const stopped = await devStop({ config, cwd: integrationDir });
  assert(stopped.ok, `devStop succeeds (${stopped.ok ? '' : stopped.failure.message})`);
  await assertNothingListens('after stopping');
  console.log('[detach] PASS: stopping the app closes every service and database port');

  // ——— 3. A failure before ready leaves nothing running ———
  // The Compute emulator reads the timeout when it starts, so end it first.
  await stopEmulator('compute');
  const failed = await runDetached(env({ PRISMA_COMPOSER_SERVICE_READY_TIMEOUT_MS: '1' }));
  assert(failed.code !== 0, 'a detached run whose services never become ready exits non-zero');
  await assertNothingListens('after the failed detached run');
  console.log('[detach] PASS: a detached run that fails before ready leaves nothing running');

  console.log('PASS: local dev --detach');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ends an emulator and waits until its process has exited, so it writes nothing after this returns. */
async function stopEmulator(name: string): Promise<void> {
  const file = path.join(emulatorsDir, `${name}.json`);
  if (!fs.existsSync(file)) return;
  const { pid } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
  if (isAlive(pid)) process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  while (isAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(file, { force: true });
}

/** Deletes the app's instances, including its databases' data, through the target's own teardown; then ends the emulators. */
async function cleanUp(): Promise<void> {
  process.chdir(integrationDir);
  process.env['PRISMA_COMPOSER_EMULATORS_DIR'] = emulatorsDir;
  const localTarget = prismaCloud().localTarget;
  if (localTarget !== undefined) {
    const target = await localTarget();
    const container = await target.container.ensure({ appName: APP, environment: 'dev' });
    await target.teardown?.({ container, environment: 'dev' }).catch((error: unknown) => {
      console.error(`teardown failed: ${String(error)}`);
    });
  }
  for (const name of ['compute', 'buckets', 'postgres']) await stopEmulator(name);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    for (let i = 1; i <= runCount; i += 1) {
      const logPath = path.join(logDir, `run-${String(i)}.log`);
      console.error(`\n--- run-${String(i)}.log (tail) ---`);
      console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-60).join('\n'));
    }
    process.exitCode = 1;
  })
  .finally(cleanUp);
