/**
 * The dev session's attachment, against real Compute and Postgres emulators
 * in a temporary emulators directory: ending `prisma dev` stops the app's
 * database servers as well as its services, keeping their data and ports,
 * and `readLogs` returns each service's last lines without following.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeClient,
  type DaemonName,
  EMULATORS_DIR_ENV,
  ensureDaemon,
  postgresClient,
  stopDaemon,
} from '@internal/dev-emulators';
import {
  deleteAppInstances,
  ensureAppInstances,
  readEmulatorInstances,
} from '@internal/local-target';
import { PrismaCloudContainer } from '../container.ts';
import { devAttach } from '../local-target/attach.ts';

const APP = 'attach-app';
const DAEMONS: readonly DaemonName[] = ['compute', 'postgres'];
const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];

function localContainer(): PrismaCloudContainer {
  return new PrismaCloudContainer(
    { appName: APP, stage: undefined },
    'local',
    undefined,
    undefined,
    true,
  );
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

// Local dev is not supported on Windows, where the emulators cannot run.
describe.skipIf(process.platform === 'win32')("the dev session's stop", () => {
  let root: string;
  let registryRoot: string;
  let directory: string;
  let devDir: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'target-attach-'));
    registryRoot = path.join(root, 'emulators');
    process.env[EMULATORS_DIR_ENV] = registryRoot;
    for (const name of DAEMONS) {
      const entry = fileURLToPath(import.meta.resolve(`@internal/dev-emulators/${name}-main`));
      await ensureDaemon(name, entry, { registryRoot });
    }
    directory = path.join(root, 'project');
    devDir = path.join(directory, '.prisma-composer', 'dev');
  });

  afterEach(async () => {
    await deleteAppInstances({ devDir, app: APP }).catch(() => undefined);
    for (const name of DAEMONS) await stopDaemon(name, { registryRoot }).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
    else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
  });

  test("stops the app's database servers and keeps their ports", async () => {
    await ensureAppInstances({ devDir, app: APP }, [{ address: 'catalog', kind: 'database' }]);
    const recorded = (await readEmulatorInstances(directory))?.apps[APP]?.nodes['catalog'];
    if (recorded?.kind !== 'database') throw new Error('no database recorded');
    expect(await acceptsConnection(recorded.port)).toBe(true);
    await (await devAttach({ container: localContainer(), devDir })).stopApp();

    expect(await postgresClient().getInstance(recorded.id)).toMatchObject({
      status: 'stopped',
      port: recorded.port,
    });
    expect(await acceptsConnection(recorded.port)).toBe(false);
  }, 60_000);

  test("readLogs returns each service's last lines, labelled with its address", async () => {
    await ensureAppInstances({ devDir, app: APP }, [{ address: 'api', kind: 'service' }]);
    const recorded = (await readEmulatorInstances(directory))?.apps[APP]?.nodes['api'];
    if (recorded?.kind !== 'service') throw new Error('no service recorded');
    const artifactDir = path.join(root, 'artifact');
    fs.mkdirSync(artifactDir);
    fs.writeFileSync(
      path.join(artifactDir, 'bootstrap.js'),
      "for (let i = 1; i <= 5; i++) console.log('line-' + i);\n" +
        "Bun.serve({ port: Number(process.env['PORT']), fetch: () => new Response('ok') });\n",
    );
    const PATH = process.env['PATH'];
    if (PATH === undefined) throw new Error('PATH is not set in this shell');
    await computeClient().putDeployment(recorded.id, {
      artifactDir,
      artifactHash: 'logs',
      env: { PATH, PORT: String(recorded.port) },
    });
    const attachment = await devAttach({ container: localContainer(), devDir });
    if (attachment.readLogs === undefined) throw new Error('the attachment has no readLogs');
    const readLogs = attachment.readLogs;
    const deadline = Date.now() + 5000;
    while (!(await readLogs({ tail: 1 })).some(({ line }) => line === 'line-5')) {
      if (Date.now() > deadline) throw new Error('the service never logged line-5');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(await readLogs({ tail: 2 })).toEqual([
      { service: 'api', line: 'line-4' },
      { service: 'api', line: 'line-5' },
    ]);
    expect(await readLogs({ tail: 0 })).toEqual([]);
  }, 60_000);
});
