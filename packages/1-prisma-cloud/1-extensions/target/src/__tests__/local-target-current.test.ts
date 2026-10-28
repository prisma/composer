/**
 * An app's local copy in one environment, read from its record alone — what
 * `prisma dev url` and `prisma dev stop` act on — and the emulator listing,
 * against real Compute, Postgres and bucket emulators in a temporary
 * emulators directory.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { LocalTargetCurrentApp } from '@internal/core/local-target';
import {
  bucketsClient,
  computeClient,
  type DaemonName,
  EMULATORS_DIR_ENV,
  ensureDaemon,
  listEmulators,
  postgresClient,
  stopDaemon,
} from '@internal/dev-emulators';
import {
  type AppNode,
  deleteAppInstances,
  ensureAppInstances,
  readEmulatorInstances,
} from '@internal/local-target';
import pg from 'pg';
import { localTargetDescriptor } from '../local-target/descriptor.ts';

const APP = 'current-app';
const NODES: readonly AppNode[] = [
  { address: 'current-app.gateway', kind: 'service' },
  { address: 'current-app.catalog', kind: 'database' },
  { address: 'current-app.uploads', kind: 'bucket' },
];
const DAEMONS: readonly DaemonName[] = ['compute', 'postgres', 'buckets'];
const SERVING_BOOTSTRAP =
  "Bun.serve({ port: Number(process.env['PORT']), fetch: () => new Response('hello from gateway') });\n";
const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];
/**
 * Where this file's services start. Other test files run their own Compute
 * emulators at the same time, each giving ports from 3000, and a service
 * that answers on a port proves nothing about whose process it is. Ports
 * below this one go to placeholder instances, so this file's services never
 * share a port with theirs.
 */
const FIRST_SERVICE_PORT = 3050;

async function reserveServicePortsBelow(port: number): Promise<void> {
  const client = computeClient();
  while ((await client.createInstance({ labels: { purpose: 'port-skip' } })).port < port - 1) {
    // each placeholder takes the lowest free port
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

// Local dev is not supported on Windows, where the emulators cannot run.
describe.skipIf(process.platform === 'win32')("an app's local copy in an environment", () => {
  let root: string;
  let registryRoot: string;
  let copies: { devDir: string; environment: string }[];

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'target-current-'));
    registryRoot = path.join(root, 'emulators');
    process.env[EMULATORS_DIR_ENV] = registryRoot;
    for (const name of DAEMONS) {
      const entry = fileURLToPath(import.meta.resolve(`@internal/dev-emulators/${name}-main`));
      await ensureDaemon(name, entry, { registryRoot });
    }
    await reserveServicePortsBelow(FIRST_SERVICE_PORT);
    copies = [];
  }, 60_000);

  afterEach(async () => {
    for (const { devDir, environment } of copies) {
      await deleteAppInstances({ devDir, app: APP, environment }).catch(() => undefined);
    }
    for (const name of DAEMONS) await stopDaemon(name, { registryRoot }).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
    else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
  });

  /** Runs the app's nodes from a new directory, as `prisma dev` leaves them: the service deployed and serving, the bucket with a key. */
  async function runApp(
    name: string,
    environment = 'dev',
  ): Promise<{ directory: string; devDir: string }> {
    const directory = path.join(root, name);
    const devDir = path.join(directory, '.prisma-composer', 'dev', environment);
    copies.push({ devDir, environment });
    await ensureAppInstances({ devDir, app: APP, environment }, NODES);
    const nodes = (await readEmulatorInstances(devDir))?.apps[APP]?.nodes ?? {};
    const gateway = nodes['current-app.gateway'];
    const uploads = nodes['current-app.uploads'];
    if (gateway?.kind !== 'service' || uploads === undefined) throw new Error('not recorded');
    const artifactDir = path.join(root, `${name}-${environment}-artifact`);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'bootstrap.js'), SERVING_BOOTSTRAP);
    await computeClient().putDeployment(gateway.id, {
      artifactDir,
      artifactHash: 'v1',
      env: { PATH: process.env['PATH'] ?? '', PORT: String(gateway.port) },
    });
    await bucketsClient().putCredentials(
      uploads.id,
      `AKIA${name.toUpperCase()}${environment === 'dev' ? '' : environment.toUpperCase()}`,
      'secret',
    );
    return { directory, devDir };
  }

  /** Redeploys the app's gateway with `source` as its bootstrap; resolves or rejects as the deployment does. */
  async function redeployGateway(
    devDir: string,
    source: string,
  ): Promise<{ readonly id: string; readonly port: number; readonly deployed: Promise<unknown> }> {
    const gateway = (await readEmulatorInstances(devDir))?.apps[APP]?.nodes['current-app.gateway'];
    if (gateway?.kind !== 'service') throw new Error('not recorded');
    const artifactDir = fs.mkdtempSync(path.join(root, 'redeploy-'));
    fs.writeFileSync(path.join(artifactDir, 'bootstrap.js'), source);
    const deployed = computeClient().putDeployment(gateway.id, {
      artifactDir,
      artifactHash: artifactDir,
      env: { PATH: process.env['PATH'] ?? '', PORT: String(gateway.port) },
    });
    return { id: gateway.id, port: gateway.port, deployed };
  }

  async function statusOf(id: string): Promise<string | undefined> {
    return (await computeClient().getInstance(id))?.status;
  }

  async function waitForStatus(id: string, status: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((await statusOf(id)) !== status) {
      if (Date.now() > deadline) throw new Error(`"${id}" never reached ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function currentOf(devDir: string, environment = 'dev'): Promise<LocalTargetCurrentApp> {
    const current = await localTargetDescriptor().current?.({ devDir, app: APP, environment });
    if (current === undefined) throw new Error('no current app');
    return current;
  }

  async function urlOf(current: LocalTargetCurrentApp, address: string): Promise<string> {
    const location = await current.locate(address);
    if (location?.emulator !== 'running' || location.url === undefined) {
      throw new Error(`"${address}" is not running`);
    }
    expect(location).toMatchObject({ state: 'running', condition: 'running' });
    return location.url;
  }

  test('gives a URL that answers for a service, a database and a bucket', async () => {
    const { devDir } = await runApp('a');
    const current = await currentOf(devDir);

    expect(current.app).toBe(APP);
    expect([...current.addresses].sort()).toEqual([
      'current-app.catalog',
      'current-app.gateway',
      'current-app.uploads',
    ]);

    const service = await urlOf(current, 'current-app.gateway');
    expect(Number(new URL(service).port)).toBeGreaterThanOrEqual(FIRST_SERVICE_PORT);
    expect(await (await fetch(service)).text()).toBe('hello from gateway');

    const database = new pg.Client({
      connectionString: await urlOf(current, 'current-app.catalog'),
    });
    await database.connect();
    expect((await database.query('select 1 as one')).rows).toEqual([{ one: 1 }]);
    await database.end();

    const bucketUrl = new URL(await urlOf(current, 'current-app.uploads'));
    const bucket = bucketUrl.pathname.slice(1);
    const s3 = new S3Client({
      region: 'auto',
      endpoint: bucketUrl.origin,
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKIAA', secretAccessKey: 'secret' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 1,
    });
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'hello.txt', Body: 'hi' }));
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    expect(listed.Contents?.map((o) => o.Key)).toEqual(['hello.txt']);
  }, 90_000);

  test("stopping leaves none of the app's processes or Postgres servers running", async () => {
    const { devDir } = await runApp('a');
    const current = await currentOf(devDir);
    const nodes = (await readEmulatorInstances(devDir))?.apps[APP]?.nodes ?? {};
    const gateway = nodes['current-app.gateway'];
    const catalog = nodes['current-app.catalog'];
    if (gateway?.kind !== 'service' || catalog?.kind !== 'database')
      throw new Error('not recorded');

    const stopped = await current.stop();

    expect([...stopped].sort((a, b) => a.address.localeCompare(b.address))).toEqual([
      { address: 'current-app.catalog', kind: 'database' },
      { address: 'current-app.gateway', kind: 'service' },
    ]);
    expect(await computeClient().getInstance(gateway.id)).toMatchObject({ status: 'stopped' });
    expect(await postgresClient().getInstance(catalog.id)).toMatchObject({ status: 'stopped' });
    expect(await acceptsConnection(gateway.port)).toBe(false);
    expect(await acceptsConnection(catalog.port)).toBe(false);
    expect(await current.locate('current-app.catalog')).toMatchObject({
      state: 'stopped',
      condition: 'stopped',
    });
  }, 90_000);

  test('stopping during a start in flight ends that start, and nothing is left listening', async () => {
    const { devDir } = await runApp('a');
    const slow = await redeployGateway(
      devDir,
      "setTimeout(() => Bun.serve({ port: Number(process.env['PORT']), fetch: () => new Response('late') }), 3000);\n",
    );
    const outcome = slow.deployed.then(
      () => 'deployed',
      (error: unknown) => String(error),
    );
    await new Promise((resolve) => setTimeout(resolve, 800));

    await (await currentOf(devDir)).stop();

    expect(await outcome).toContain('stopped before it accepted connections');
    expect(await statusOf(slow.id)).toBe('stopped');
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(await acceptsConnection(slow.port)).toBe(false);
  }, 90_000);

  test('a service waiting to be restarted after a crash is reported and stays stopped', async () => {
    const { devDir } = await runApp('a');
    const crashing = await redeployGateway(devDir, 'process.exit(1);\n');
    void crashing.deployed.catch(() => undefined);
    await waitForStatus(crashing.id, 'backoff', 10_000);

    const stopped = await (await currentOf(devDir)).stop();

    expect(stopped).toContainEqual({ address: 'current-app.gateway', kind: 'service' });
    expect(await statusOf(crashing.id)).toBe('stopped');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(await statusOf(crashing.id)).toBe('stopped');
  }, 90_000);

  test('a service held after repeated crashes is not reported and stays held', async () => {
    const { devDir } = await runApp('a');
    const crashing = await redeployGateway(devDir, 'process.exit(1);\n');
    void crashing.deployed.catch(() => undefined);
    await waitForStatus(crashing.id, 'held', 60_000);

    const stopped = await (await currentOf(devDir)).stop();

    expect(stopped).not.toContainEqual({ address: 'current-app.gateway', kind: 'service' });
    expect(stopped).toContainEqual({ address: 'current-app.catalog', kind: 'database' });
    expect(await statusOf(crashing.id)).toBe('held');
  }, 120_000);

  test('stopping again stops nothing and reports nothing', async () => {
    const { devDir } = await runApp('a');
    const current = await currentOf(devDir);
    await current.stop();

    expect(await current.stop()).toEqual([]);
  }, 90_000);

  test('stopping reports only the nodes whose emulator was running', async () => {
    const { devDir } = await runApp('a');
    await stopDaemon('compute', { registryRoot });

    const stopped = await (await currentOf(devDir)).stop();

    expect(stopped).toEqual([{ address: 'current-app.catalog', kind: 'database' }]);
  }, 90_000);

  test('stopping with an emulators directory that is not absolute fails with its code, and stops nothing', async () => {
    const { devDir } = await runApp('a');
    const current = await currentOf(devDir);
    process.env[EMULATORS_DIR_ENV] = 'relative/emulators';

    const stopping = current.stop();

    await expect(stopping).rejects.toMatchObject({ code: 'DEV.EMULATORS_DIR_INVALID' });
    process.env[EMULATORS_DIR_ENV] = registryRoot;
    expect(await current.locate('current-app.gateway')).toMatchObject({ state: 'running' });
  }, 90_000);

  test('an app never run in a directory, or in an environment, has no local copy there', async () => {
    const devDir = path.join(root, 'never', '.prisma-composer', 'dev', 'dev');
    expect(
      await localTargetDescriptor().current?.({ devDir, app: APP, environment: 'dev' }),
    ).toBeUndefined();

    const ran = await runApp('a');
    expect(
      await localTargetDescriptor().current?.({
        devDir: ran.devDir,
        app: 'other-app',
        environment: 'dev',
      }),
    ).toBeUndefined();
    const testDir = path.join(ran.directory, '.prisma-composer', 'dev', 'test');
    expect(
      await localTargetDescriptor().current?.({ devDir: testDir, app: APP, environment: 'test' }),
    ).toBeUndefined();
  }, 60_000);

  test('two environments of the app in one directory run at once, each at its own URLs', async () => {
    const inDev = await runApp('both');
    const inTest = await runApp('both', 'test');
    const devCopy = await currentOf(inDev.devDir);
    const testCopy = await currentOf(inTest.devDir, 'test');

    for (const address of ['current-app.gateway', 'current-app.catalog', 'current-app.uploads']) {
      expect(await urlOf(testCopy, address)).not.toBe(await urlOf(devCopy, address));
    }
    expect(await (await fetch(await urlOf(devCopy, 'current-app.gateway'))).text()).toBe(
      'hello from gateway',
    );
    expect(await (await fetch(await urlOf(testCopy, 'current-app.gateway'))).text()).toBe(
      'hello from gateway',
    );
  }, 90_000);

  test("stopping one environment's copy leaves the other running", async () => {
    const inDev = await runApp('stop-one');
    const inTest = await runApp('stop-one', 'test');

    const stopped = await (await currentOf(inTest.devDir, 'test')).stop();

    expect(stopped).toHaveLength(2);
    const devCopy = await currentOf(inDev.devDir);
    expect(await devCopy.locate('current-app.gateway')).toMatchObject({ state: 'running' });
    expect(await devCopy.locate('current-app.catalog')).toMatchObject({ state: 'running' });
    expect(
      await (await currentOf(inTest.devDir, 'test')).locate('current-app.gateway'),
    ).toMatchObject({
      state: 'stopped',
    });
  }, 90_000);

  test('a node whose emulator is not running says so', async () => {
    const { devDir } = await runApp('a');
    await stopDaemon('buckets', { registryRoot });

    expect(await (await currentOf(devDir)).locate('current-app.uploads')).toEqual({
      address: 'current-app.uploads',
      kind: 'bucket',
      emulator: 'not-running',
    });
  }, 60_000);

  test('the emulator listing shows the instances of two directories with their labels', async () => {
    const a = await runApp('a');
    const b = await runApp('b');

    const result = await listEmulators();

    if (!result.ok) throw new Error(result.failure.message);
    const { emulators } = result.value;
    expect(emulators.map((e) => [e.kind, e.running])).toEqual([
      ['service', true],
      ['database', true],
      ['bucket', true],
    ]);
    for (const emulator of emulators) {
      const instances = emulator.instances.filter((i) => i.labels['purpose'] !== 'port-skip');
      const directoriesOf = instances.map((i) => i.labels['composer.directory']).sort();
      expect(directoriesOf).toEqual([a.directory, b.directory].sort());
      for (const instance of instances) {
        expect(instance.kind).toBe(emulator.kind);
        expect(instance.labels['composer.app']).toBe(APP);
        expect(instance.labels['composer.environment']).toBe('dev');
      }
    }
  }, 90_000);
});
