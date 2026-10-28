/**
 * `devUrl` and `devStop` from `@prisma/composer/control` against the real
 * Prisma Cloud target, through a real configuration: the target's own
 * `emulators` hook records the app in a temporary directory and starts real
 * emulators in a temporary emulators directory, then the operations find the
 * app from that directory alone. The service's deployment and the emulators'
 * registry use the emulators' documented wire protocol and files.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Load, module } from '@prisma/composer';
import type { ContainerInstance, LocalTargetDescriptor } from '@prisma/composer/config';
import { DEV_DIR } from '@prisma/composer/config';
import { devStop, devUrl } from '@prisma/composer/control';
import { prismaCloud } from '@prisma/composer-prisma-cloud/control';
import { EMULATORS_DIR_ENV } from '@prisma/composer-prisma-cloud/local-target';
import prismaConfig from '../prisma.config.ts';
import appModule from './fixtures/local-dev/module.ts';

const APP = 'devcurrentfixture';
const integrationDir = path.resolve(import.meta.dir, '..');
const config = {
  value: prismaConfig.composer,
  file: path.join(integrationDir, 'prisma.config.ts'),
};
const SERVING_BOOTSTRAP =
  "Bun.serve({ port: Number(process.env['PORT']), fetch: () => new Response('hello from web') });\n";

/**
 * Where this file's services start. Other test files run their own Compute
 * emulators at the same time, each giving ports from 3000, and a service
 * that answers on a port proves nothing about whose process it is. Ports
 * below this one go to placeholder instances, so this file's services never
 * share a port with theirs.
 */
const FIRST_SERVICE_PORT = 3100;

interface RecordedNode {
  readonly kind: string;
  readonly id: string;
  readonly port?: number;
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
describe.skipIf(process.platform === 'win32')('devUrl and devStop on the real target', () => {
  const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];
  const originalCwd = process.cwd();
  let root: string;
  let cwd: string;
  let emulatorsDir: string;
  let target: LocalTargetDescriptor;
  let container: ContainerInstance;
  let nodes: Readonly<Record<string, RecordedNode>>;

  function readRegistryPort(name: string): number {
    return JSON.parse(fs.readFileSync(path.join(emulatorsDir, `${name}.json`), 'utf8')).port;
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-dev-current-'));
    cwd = path.join(root, 'app');
    fs.mkdirSync(cwd);
    emulatorsDir = path.join(root, 'emulators');
    process.env[EMULATORS_DIR_ENV] = emulatorsDir;

    const localTarget = prismaCloud().localTarget;
    if (localTarget === undefined) throw new Error('prismaCloud() has no local target');
    target = await localTarget();
    container = await target.container.ensure({ appName: APP, environment: 'dev' });
    const devDir = path.join(cwd, DEV_DIR);

    // An app with no nodes starts the Compute emulator, so the placeholders can
    // take the ports below FIRST_SERVICE_PORT before the fixture's services are created.
    const placeholderApp = module('portskip', () => {});
    await target.emulators?.({
      graph: Load(placeholderApp, { id: 'portskip' }),
      container: await target.container.ensure({ appName: 'portskip', environment: 'dev' }),
      devDir: path.join(root, 'placeholders', DEV_DIR),
    });
    const computeAdmin = `http://127.0.0.1:${readRegistryPort('compute')}`;
    for (let port = 0; port < FIRST_SERVICE_PORT - 1; ) {
      const created = await fetch(`${computeAdmin}/instances`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ labels: { purpose: 'port-skip' } }),
      });
      if (!created.ok) {
        throw new Error(
          `creating a placeholder instance failed (${String(created.status)}): ${await created.text()}`,
        );
      }
      port = ((await created.json()) as { port: number }).port;
    }

    await target.emulators?.({ graph: Load(appModule, { id: APP }), container, devDir });

    const record = JSON.parse(
      fs.readFileSync(path.join(devDir, 'emulator-instances.json'), 'utf8'),
    ) as { apps: Record<string, { nodes: Record<string, RecordedNode> }> };
    nodes = record.apps[APP]?.nodes ?? {};
    const web = nodes[`${APP}.web`];
    if (web?.port === undefined) throw new Error('web is not recorded with a port');

    const artifactDir = path.join(root, 'web-artifact');
    fs.mkdirSync(artifactDir);
    fs.writeFileSync(path.join(artifactDir, 'bootstrap.js'), SERVING_BOOTSTRAP);
    const deployed = await fetch(`${computeAdmin}/instances/${web.id}/deployment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactDir,
        artifactHash: 'v1',
        env: { PATH: process.env['PATH'] ?? '', PORT: String(web.port) },
      }),
    });
    if (!deployed.ok) throw new Error(`deploying web failed: ${await deployed.text()}`);
  }, 120_000);

  afterAll(async () => {
    process.chdir(cwd);
    await target?.teardown?.({ container, environment: 'dev' }).catch(() => undefined);
    process.chdir(originalCwd);
    for (const name of ['compute', 'buckets', 'postgres']) {
      const file = path.join(emulatorsDir, `${name}.json`);
      if (!fs.existsSync(file)) continue;
      try {
        process.kill(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
    else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
  }, 60_000);

  test("devUrl gives the URL a service answers at, and a database's connection string", async () => {
    const web = await devUrl({ config, cwd, address: `${APP}.web` });
    const appdb = await devUrl({ config, cwd, address: `${APP}.appdb` });

    if (!web.ok) throw new Error(web.failure.message);
    expect(web.value).toMatchObject({ address: `${APP}.web`, kind: 'service', state: 'running' });
    expect(Number(new URL(web.value.url).port)).toBeGreaterThanOrEqual(FIRST_SERVICE_PORT);
    expect(await (await fetch(web.value.url)).text()).toBe('hello from web');
    if (!appdb.ok) throw new Error(appdb.failure.message);
    expect(appdb.value.url).toStartWith('postgres');
  }, 30_000);

  test('devStop stops the running service and the database server, and their ports close', async () => {
    const web = nodes[`${APP}.web`];
    const appdb = nodes[`${APP}.appdb`];
    if (web?.port === undefined || appdb?.port === undefined) throw new Error('not recorded');

    const result = await devStop({ config, cwd });

    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.app).toBe(APP);
    // bkg was never deployed, so it was not running and is not reported.
    expect([...result.value.stopped].sort((a, b) => a.address.localeCompare(b.address))).toEqual([
      { address: `${APP}.appdb`, kind: 'database' },
      { address: `${APP}.web`, kind: 'service' },
    ]);
    expect(await acceptsConnection(web.port)).toBe(false);
    expect(await acceptsConnection(appdb.port)).toBe(false);
    expect(await devUrl({ config, cwd, address: `${APP}.web` })).toMatchObject({
      ok: false,
      failure: { code: 'DEV.NOT_RUNNING' },
    });
    expect(await devStop({ config, cwd })).toMatchObject({ ok: true, value: { stopped: [] } });
  }, 60_000);
});
