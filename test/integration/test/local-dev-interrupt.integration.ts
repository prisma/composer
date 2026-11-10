/**
 * Ctrl-C ends a foreground `prisma dev` and stops the app's services, run
 * through the installed `prisma` host against the local-dev fixture on real
 * emulators in a temporary emulators directory.
 *
 * Ctrl-C in a terminal sends SIGINT to every process in the foreground
 * process group. Under `npm run` or `npx`, npm also forwards the SIGINT it
 * receives to `prisma`, so `prisma` gets two SIGINTs a few milliseconds
 * apart, and the CLI engine exits at once on the second. This test sends
 * exactly that: SIGINT to the group, then, once `prisma` has started
 * stopping, SIGINT to `prisma`. After `prisma`
 * exits, every service port is closed and every service process is gone.
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
import { prismaCloud } from '@prisma/composer-prisma-cloud/control';
import { prismaBinDir } from './spawn-prisma.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

const integrationDir = path.resolve(import.meta.dir, '..');
const fixtureEntry = path.join('test', 'fixtures', 'local-dev', 'module.ts');
const logDir = path.join(integrationDir, '.local-dev-interrupt-logs');
const logPath = path.join(logDir, 'session.log');
const CLI_BIN = path.join(prismaBinDir(integrationDir), 'prisma');
const READY_TIMEOUT_MS = 180_000;
const EXIT_TIMEOUT_MS = 60_000;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-dev-interrupt-'));
const emulatorsDir = path.join(tempRoot, 'emulators');
const APP = 'localdevs4fixture';
let sessionPid: number | undefined;

function env(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...process.env,
    PRISMA_COMPOSER_EMULATORS_DIR: emulatorsDir,
    LOCALDEV_FIXTURE_API_KEY: 'interrupt-proof',
    LOCALDEV_FIXTURE_GREETING: 'hello',
  };
  delete result['PRISMA_WORKSPACE_ID'];
  delete result['PRISMA_SERVICE_TOKEN'];
  delete result['PRISMA_REGION'];
  return result;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function sessionLog(): string {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

function isReady(log: string): boolean {
  return log.split('\n').some((line) => {
    if (!line.startsWith('{')) return false;
    try {
      const frame = JSON.parse(line) as { kind?: string; subject?: string; status?: string };
      return frame.kind === 'status' && frame.subject === 'dev' && frame.status === 'ready';
    } catch {
      return false;
    }
  });
}

async function waitUntil(
  done: () => boolean,
  timeoutMs: number,
  what: string,
  pollMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`${what} within ${String(timeoutMs)}ms`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

interface ServiceProcess {
  readonly port: number;
  readonly pid: number;
}

/** The running processes of the Compute emulator's instances, read from its documented `GET /instances`. */
async function serviceProcesses(): Promise<readonly ServiceProcess[]> {
  const { port } = JSON.parse(fs.readFileSync(path.join(emulatorsDir, 'compute.json'), 'utf8')) as {
    port: number;
  };
  const res = await fetch(`http://127.0.0.1:${String(port)}/instances`);
  const instances = (await res.json()) as { port: number; pid?: number }[];
  return instances.flatMap((i) => (i.pid === undefined ? [] : [{ port: i.port, pid: i.pid }]));
}

async function main(): Promise<void> {
  console.log('local dev: Ctrl-C ends prisma dev and stops the app');
  fs.rmSync(path.join(integrationDir, '.prisma-composer'), { recursive: true, force: true });
  fs.rmSync(path.join(integrationDir, '.alchemy'), { recursive: true, force: true });
  fs.mkdirSync(logDir, { recursive: true });

  const logFd = fs.openSync(logPath, 'w');
  // Its own process group, as a terminal gives the command it runs.
  const child = spawn(CLI_BIN, ['dev', '--entry', fixtureEntry, '--fresh', '--json'], {
    cwd: integrationDir,
    env: env(),
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  fs.closeSync(logFd);
  const pid = child.pid;
  assert(pid !== undefined, 'prisma dev started');
  sessionPid = pid;
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? null : 128)));
  });

  await waitUntil(() => isReady(sessionLog()), READY_TIMEOUT_MS, 'prisma dev was not ready');
  const services = await serviceProcesses();
  assert(services.length >= 2, `bkg and web run (got ${JSON.stringify(services)})`);
  for (const { port } of services) {
    assert(await acceptsConnection(port), `service port ${String(port)} answers before Ctrl-C`);
  }

  process.kill(-pid, 'SIGINT');
  // Two SIGINTs pending at once merge into one, so the second goes once the
  // first has been handled, as npm's forwarded one does.
  await waitUntil(
    () => sessionLog().includes('"kind":"step-started","step":"Stopping'),
    EXIT_TIMEOUT_MS,
    'prisma dev did not start stopping',
    5,
  );
  process.kill(pid, 'SIGINT');
  const code = await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('prisma dev did not exit')), EXIT_TIMEOUT_MS),
    ),
  ]);
  assert(code === 130, `prisma dev exits 130 (got ${String(code)})`);

  for (const service of services) {
    assert(!isAlive(service.pid), `service process ${String(service.pid)} is gone`);
    assert(
      !(await acceptsConnection(service.port)),
      `service port ${String(service.port)} is free`,
    );
  }
  console.log('PASS: Ctrl-C ends prisma dev and stops every service');
}

/** Ends a `prisma dev` that a failure left running, with every process in its group. */
async function endSession(): Promise<void> {
  if (sessionPid === undefined || !isAlive(sessionPid)) return;
  const group = -sessionPid;
  process.kill(group, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (isAlive(sessionPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isAlive(sessionPid)) process.kill(group, 'SIGKILL');
}

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
}

/** Ends a leftover session, deletes the app's instances through the target's own teardown, then ends the emulators. */
async function cleanUp(): Promise<void> {
  await endSession();
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
    console.error('\n--- session.log (tail) ---');
    console.error(sessionLog().split('\n').slice(-60).join('\n'));
    process.exitCode = 1;
  })
  .finally(cleanUp);
