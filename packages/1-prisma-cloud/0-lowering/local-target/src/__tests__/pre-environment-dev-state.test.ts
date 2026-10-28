/**
 * Upgrading a directory whose `.prisma-composer/dev/` was written before each
 * environment had its own folder: its state becomes the environment `dev`'s.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  bucketsClient,
  computeClient,
  type DaemonName,
  EMULATORS_DIR_ENV,
  ensureDaemon,
  postgresClient,
  stopDaemon,
} from '@internal/dev-emulators';
import { Client as PgClient } from 'pg';
import { ensureAppInstances } from '../app-instances.ts';
import { envStore, secretsStore } from '../dev-store.ts';
import {
  type AppScope,
  deleteAppInstances,
  EMULATOR_INSTANCES_FILE,
  readEmulatorInstances,
} from '../emulator-instances.ts';
import { movePreEnvironmentDevState } from '../pre-environment-dev-state.ts';
import { resolvePrismaDevModulePath } from '../prisma-dev-module.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/pre-environment-dev', import.meta.url));

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe('moving the folder', () => {
  let directory: string;
  let root: string;
  let dev: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-pre-environment-'));
    root = path.join(directory, '.prisma-composer', 'dev');
    dev = path.join(root, 'dev');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("moves the record, environment variables, secrets and bucket objects into dev's folder, and drops what is regenerated", async () => {
    fs.cpSync(FIXTURE, root, { recursive: true });

    movePreEnvironmentDevState(directory);

    expect(filesUnder(root)).toEqual(
      [
        path.join('dev', 'buckets', 'shop', 'uploads', 'kept.txt'),
        path.join('dev', EMULATOR_INSTANCES_FILE),
        path.join('dev', 'env.json'),
        path.join('dev', 'secrets.json'),
      ].sort(),
    );
    expect(await readEmulatorInstances(dev)).toEqual({
      apps: {
        shop: {
          nodes: {
            'shop.api': { kind: 'service', id: 'svc_0b6e2f4a91c3d758', port: 3000 },
            'shop.catalog': { kind: 'database', id: 'db_02c4e81f6a9b3d70', port: 51300 },
            'shop.uploads': { kind: 'bucket', id: 'bkt-77e1a4c90b2d5f36' },
          },
        },
      },
    });
    expect(await envStore(dev).read()).toEqual({
      COMPOSER_SHOP_API_CATALOG_URL: 'postgres://localhost:51300/catalog',
    });
    expect(await secretsStore(dev).read()).toEqual({
      OPENROUTER_API_KEY: 'local-placeholder-0123456789abcdef',
    });
  });

  test('a second run changes nothing', () => {
    fs.cpSync(FIXTURE, root, { recursive: true });
    movePreEnvironmentDevState(directory);
    const after = filesUnder(root);

    movePreEnvironmentDevState(directory);

    expect(filesUnder(root)).toEqual(after);
  });

  test('a folder with no record of its own, or no folder at all, is left alone', () => {
    movePreEnvironmentDevState(directory);
    expect(fs.existsSync(root)).toBe(false);

    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', EMULATOR_INSTANCES_FILE), '{}');
    movePreEnvironmentDevState(directory);
    expect(filesUnder(root)).toEqual([path.join('test', EMULATOR_INSTANCES_FILE)]);
  });

  test('when dev already has a record, the older one is not moved over it', () => {
    fs.cpSync(FIXTURE, root, { recursive: true });
    fs.mkdirSync(dev, { recursive: true });
    fs.writeFileSync(path.join(dev, EMULATOR_INSTANCES_FILE), '{"formatVersion":3,"apps":{}}');

    movePreEnvironmentDevState(directory);

    expect(fs.readFileSync(path.join(dev, EMULATOR_INSTANCES_FILE), 'utf8')).toBe(
      '{"formatVersion":3,"apps":{}}',
    );
    expect(fs.existsSync(path.join(root, EMULATOR_INSTANCES_FILE))).toBe(true);
  });
});

const APP = 'upgrade-app';
const DAEMONS: readonly DaemonName[] = ['compute', 'postgres', 'buckets'];
const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];

async function query(url: string, sql: string): Promise<unknown[]> {
  const pg = new PgClient({ connectionString: url });
  await pg.connect();
  try {
    return (await pg.query(sql)).rows;
  } finally {
    await pg.end().catch(() => undefined);
  }
}

// Local dev is not supported on Windows, where the emulators cannot run.
describe.skipIf(process.platform === 'win32')('the first run after the upgrade', () => {
  let tmp: string;
  let registryRoot: string;
  let directory: string;
  let scope: AppScope;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-pre-environment-run-'));
    registryRoot = path.join(tmp, 'emulators');
    process.env[EMULATORS_DIR_ENV] = registryRoot;
    for (const name of DAEMONS) {
      const entry = fileURLToPath(import.meta.resolve(`@internal/dev-emulators/${name}-main`));
      await ensureDaemon(name, entry, { registryRoot });
    }
    directory = path.join(tmp, 'project');
    scope = {
      devDir: path.join(directory, '.prisma-composer', 'dev', 'dev'),
      app: APP,
      environment: 'dev',
    };
  });

  afterEach(async () => {
    await deleteAppInstances(scope).catch(() => undefined);
    for (const name of DAEMONS) await stopDaemon(name, { registryRoot }).catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
    else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
  });

  /** The instances and folder the previous release left: a database with a row, a bucket with an object, and its record. */
  async function writePreviousRelease() {
    const root = path.join(directory, '.prisma-composer', 'dev');
    const labels = (address: string) => ({
      'composer.directory': directory,
      'composer.app': APP,
      'composer.address': address,
    });
    const bucketDir = path.join(root, 'buckets', APP, 'uploads');
    fs.mkdirSync(bucketDir, { recursive: true });
    fs.writeFileSync(path.join(bucketDir, 'kept.txt'), 'kept');
    const api = await computeClient().createInstance({ labels: labels(`${APP}.api`) });
    const catalog = await postgresClient().createInstance({
      labels: labels(`${APP}.catalog`),
      prismaDevModulePath: resolvePrismaDevModulePath(),
    });
    await query(catalog.url, "create table kept (v text); insert into kept values ('row')");
    await postgresClient().stopInstances([catalog.id]);
    const uploads = await bucketsClient().createInstance({
      labels: labels(`${APP}.uploads`),
      dir: bucketDir,
    });
    const nodes = {
      [`${APP}.api`]: { kind: 'service', id: api.id, port: api.port },
      [`${APP}.catalog`]: { kind: 'database', id: catalog.id, port: catalog.port },
      [`${APP}.uploads`]: { kind: 'bucket', id: uploads.id },
    };
    fs.writeFileSync(
      path.join(root, EMULATOR_INSTANCES_FILE),
      JSON.stringify({ formatVersion: 2, current: APP, apps: { [APP]: { nodes } } }),
    );
    return { api, catalog, uploads };
  }

  test("keeps the database with its data and port, and serves the bucket's objects from dev's folder", async () => {
    const before = await writePreviousRelease();

    movePreEnvironmentDevState(directory);
    const changes = await ensureAppInstances(scope, [
      { address: `${APP}.api`, kind: 'service' },
      { address: `${APP}.catalog`, kind: 'database' },
      { address: `${APP}.uploads`, kind: 'bucket' },
    ]);

    expect(changes).toEqual([]);
    const nodes = (await readEmulatorInstances(scope.devDir))?.apps[APP]?.nodes ?? {};
    expect(nodes[`${APP}.api`]).toEqual({
      kind: 'service',
      id: before.api.id,
      port: before.api.port,
    });
    expect(nodes[`${APP}.catalog`]).toMatchObject({
      id: before.catalog.id,
      port: before.catalog.port,
    });
    const catalog = await postgresClient().getInstance(before.catalog.id);
    expect(catalog?.status).toBe('running');
    expect(await query(catalog?.url ?? '', 'select v from kept')).toEqual([{ v: 'row' }]);

    const uploads = nodes[`${APP}.uploads`];
    if (uploads === undefined) throw new Error('the bucket is not recorded');
    const bucket = await bucketsClient().getInstance(uploads.id);
    expect(bucket?.dir).toBe(path.join(scope.devDir, 'buckets', APP, 'uploads'));
    await bucketsClient().putCredentials(uploads.id, 'AKIAUPGRADE', 'secret');
    const s3 = new S3Client({
      region: 'auto',
      endpoint: bucketsClient().baseUrl,
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKIAUPGRADE', secretAccessKey: 'secret' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 1,
    });
    const object = await s3.send(new GetObjectCommand({ Bucket: uploads.id, Key: 'kept.txt' }));
    expect(await object.Body?.transformToString()).toBe('kept');
  }, 120_000);
});
