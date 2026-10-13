/**
 * The directory's current app, read from its record alone — what
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
  { address: 'gateway', kind: 'service' },
  { address: 'catalog', kind: 'database' },
  { address: 'uploads', kind: 'bucket' },
];
const DAEMONS: readonly DaemonName[] = ['compute', 'postgres', 'buckets'];
const SERVING_BOOTSTRAP =
  "Bun.serve({ port: Number(process.env['PORT']), fetch: () => new Response('hello from gateway') });\n";
const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];

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
describe.skipIf(process.platform === 'win32')("the directory's current app", () => {
  let root: string;
  let registryRoot: string;
  let directories: string[];

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'target-current-'));
    registryRoot = path.join(root, 'emulators');
    process.env[EMULATORS_DIR_ENV] = registryRoot;
    for (const name of DAEMONS) {
      const entry = fileURLToPath(import.meta.resolve(`@internal/dev-emulators/${name}-main`));
      await ensureDaemon(name, entry, { registryRoot });
    }
    directories = [];
  });

  afterEach(async () => {
    for (const directory of directories) {
      const devDir = path.join(directory, '.prisma-composer', 'dev');
      await deleteAppInstances({ devDir, app: APP }).catch(() => undefined);
    }
    for (const name of DAEMONS) await stopDaemon(name, { registryRoot }).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
    else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
  });

  /** Runs the app's nodes from a new directory, as `prisma dev` leaves them: the service deployed and serving, the bucket with a key. */
  async function runApp(name: string): Promise<{ directory: string; devDir: string }> {
    const directory = path.join(root, name);
    directories.push(directory);
    const devDir = path.join(directory, '.prisma-composer', 'dev');
    await ensureAppInstances({ devDir, app: APP }, NODES);
    const nodes = (await readEmulatorInstances(directory))?.apps[APP]?.nodes ?? {};
    const gateway = nodes['gateway'];
    const uploads = nodes['uploads'];
    if (gateway?.kind !== 'service' || uploads === undefined) throw new Error('not recorded');
    const artifactDir = path.join(root, `${name}-artifact`);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'bootstrap.js'), SERVING_BOOTSTRAP);
    await computeClient().putDeployment(gateway.id, {
      artifactDir,
      artifactHash: 'v1',
      env: { PATH: process.env['PATH'] ?? '', PORT: String(gateway.port) },
    });
    await bucketsClient().putCredentials(uploads.id, `AKIA${name.toUpperCase()}`, 'secret');
    return { directory, devDir };
  }

  async function currentOf(devDir: string): Promise<LocalTargetCurrentApp> {
    const current = await localTargetDescriptor().current?.({ devDir });
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
    expect([...current.addresses].sort()).toEqual(['catalog', 'gateway', 'uploads']);

    const service = await urlOf(current, 'gateway');
    expect(await (await fetch(service)).text()).toBe('hello from gateway');

    const database = new pg.Client({ connectionString: await urlOf(current, 'catalog') });
    await database.connect();
    expect((await database.query('select 1 as one')).rows).toEqual([{ one: 1 }]);
    await database.end();

    const bucketUrl = new URL(await urlOf(current, 'uploads'));
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
    const { directory, devDir } = await runApp('a');
    const current = await currentOf(devDir);
    const nodes = (await readEmulatorInstances(directory))?.apps[APP]?.nodes ?? {};
    const gateway = nodes['gateway'];
    const catalog = nodes['catalog'];
    if (gateway?.kind !== 'service' || catalog?.kind !== 'database')
      throw new Error('not recorded');

    const stopped = await current.stop();

    expect([...stopped].sort((a, b) => a.address.localeCompare(b.address))).toEqual([
      { address: 'catalog', kind: 'database' },
      { address: 'gateway', kind: 'service' },
    ]);
    expect(await computeClient().getInstance(gateway.id)).toMatchObject({ status: 'stopped' });
    expect(await postgresClient().getInstance(catalog.id)).toMatchObject({ status: 'stopped' });
    expect(await acceptsConnection(gateway.port)).toBe(false);
    expect(await acceptsConnection(catalog.port)).toBe(false);
    expect(await current.locate('catalog')).toMatchObject({
      state: 'stopped',
      condition: 'stopped',
    });
  }, 90_000);

  test('stopping reports only the nodes whose emulator was running', async () => {
    const { devDir } = await runApp('a');
    await stopDaemon('compute', { registryRoot });

    const stopped = await (await currentOf(devDir)).stop();

    expect(stopped).toEqual([{ address: 'catalog', kind: 'database' }]);
  }, 90_000);

  test('stopping with an emulators directory that is not absolute fails with its code, and stops nothing', async () => {
    const { devDir } = await runApp('a');
    const current = await currentOf(devDir);
    process.env[EMULATORS_DIR_ENV] = 'relative/emulators';

    const stopping = current.stop();

    await expect(stopping).rejects.toMatchObject({ code: 'DEV.EMULATORS_DIR_INVALID' });
    process.env[EMULATORS_DIR_ENV] = registryRoot;
    expect(await current.locate('gateway')).toMatchObject({ state: 'running' });
  }, 90_000);

  test('a directory where `prisma dev` never ran has no current app', async () => {
    const devDir = path.join(root, 'never', '.prisma-composer', 'dev');

    expect(await localTargetDescriptor().current?.({ devDir })).toBeUndefined();
  });

  test('a node whose emulator is not running says so', async () => {
    const { devDir } = await runApp('a');
    await stopDaemon('buckets', { registryRoot });

    expect(await (await currentOf(devDir)).locate('uploads')).toEqual({
      address: 'uploads',
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
      const directoriesOf = emulator.instances.map((i) => i.labels['composer.directory']).sort();
      expect(directoriesOf).toEqual([a.directory, b.directory].sort());
      for (const instance of emulator.instances) {
        expect(instance.kind).toBe(emulator.kind);
        expect(instance.labels['composer.app']).toBe(APP);
      }
    }
  }, 90_000);
});
