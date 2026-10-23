/**
 * Upgrading a directory whose record has no format version, and so keys each
 * node by its address without the app name (`uploads`), to full addresses
 * (`shop.uploads`), with the bucket data folders where earlier releases put them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bucketsClient,
  computeClient,
  type DaemonName,
  EMULATORS_DIR_ENV,
  ensureDaemon,
  postgresClient,
  stopDaemon,
} from '@internal/dev-emulators';
import { bucketDataDir } from '../bucket.ts';
import {
  type AppScope,
  deleteAppInstances,
  EMULATOR_INSTANCES_FILE,
  type EmulatorInstances,
  ensureBucketInstance,
  ensureDatabaseInstance,
  ensureServiceInstance,
  type NodeInstance,
  readEmulatorInstances,
  selectApp,
} from '../emulator-instances.ts';
import { withFullAddressKeys } from '../legacy-address-keys.ts';
import { resolvePrismaDevModulePath } from '../prisma-dev-module.ts';

const service = (id: string): NodeInstance => ({ kind: 'service', id, port: 3000 });

describe('withFullAddressKeys', () => {
  test('puts the app name in front of every key, whatever the key looks like', () => {
    const record: EmulatorInstances = {
      current: 'shop',
      apps: {
        shop: {
          nodes: {
            api: service('a'),
            'auth.api': service('b'),
            // A child provisioned with the id `shop`, and a node `db` in a module `shop`.
            shop: service('c'),
            'shop.db': service('d'),
          },
        },
      },
    };

    expect(withFullAddressKeys(record)).toEqual({
      current: 'shop',
      apps: {
        shop: {
          nodes: {
            'shop.api': service('a'),
            'shop.auth.api': service('b'),
            'shop.shop': service('c'),
            'shop.shop.db': service('d'),
          },
        },
      },
    });
  });

  test('each app gets its own name in front', () => {
    const record = {
      current: 'shop',
      apps: {
        shop: { nodes: { api: service('s') } },
        blog: { nodes: { api: service('b') } },
      },
    };

    expect(withFullAddressKeys(record).apps).toEqual({
      shop: { nodes: { 'shop.api': service('s') } },
      blog: { nodes: { 'blog.api': service('b') } },
    });
  });
});

describe('the record format version', () => {
  let directory: string;
  let scope: AppScope;
  let recordFile: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-record-format-'));
    scope = { devDir: path.join(directory, '.prisma-composer', 'dev'), app: 'shop' };
    recordFile = path.join(scope.devDir, EMULATOR_INSTANCES_FILE);
    fs.mkdirSync(scope.devDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const write = (record: unknown) => fs.writeFileSync(recordFile, JSON.stringify(record));
  const onDisk = () => JSON.parse(fs.readFileSync(recordFile, 'utf8')) as unknown;

  test('a record without a version gets the app name in front of every key', async () => {
    write({
      current: 'shop',
      apps: { shop: { nodes: { api: service('a'), shop: service('c'), 'shop.db': service('d') } } },
    });

    expect(await readEmulatorInstances(directory)).toEqual({
      current: 'shop',
      apps: {
        shop: {
          nodes: {
            'shop.api': service('a'),
            'shop.shop': service('c'),
            'shop.shop.db': service('d'),
          },
        },
      },
    });
  });

  test('a record with the version is read as it is, even a key that looks like an old one', async () => {
    const nodes = { 'shop.api': service('a'), api: service('b') };
    write({ formatVersion: 2, current: 'shop', apps: { shop: { nodes } } });

    expect(await readEmulatorInstances(directory)).toEqual({
      current: 'shop',
      apps: { shop: { nodes } },
    });
  });

  test('the first write stores the version and the full keys, and the next leaves the file byte for byte', async () => {
    write({ current: 'shop', apps: { shop: { nodes: { shop: service('c') } } } });

    await selectApp(scope);

    expect(onDisk()).toEqual({
      formatVersion: 2,
      current: 'shop',
      apps: { shop: { nodes: { 'shop.shop': service('c') } } },
    });
    const first = fs.readFileSync(recordFile, 'utf8');
    await selectApp(scope);
    expect(fs.readFileSync(recordFile, 'utf8')).toBe(first);
  });

  test('a new directory starts with the version', async () => {
    await selectApp(scope);

    expect(onDisk()).toEqual({ formatVersion: 2, current: 'shop', apps: { shop: { nodes: {} } } });
  });
});

describe('bucketDataDir', () => {
  const scope: AppScope = { devDir: '/p/.prisma-composer/dev', app: 'shop' };

  test('names the folder by the address below the app', () => {
    expect(bucketDataDir(scope, 'shop.uploads')).toBe(
      path.join(scope.devDir, 'buckets', 'shop', 'uploads'),
    );
    expect(bucketDataDir(scope, 'shop.files.store')).toBe(
      path.join(scope.devDir, 'buckets', 'shop', 'files.store'),
    );
  });

  test('refuses an address outside the app', () => {
    expect(() => bucketDataDir(scope, 'blog.uploads')).toThrow(
      'bucket address "blog.uploads" is not inside the app "shop"',
    );
    expect(() => bucketDataDir(scope, 'uploads')).toThrow('is not inside the app "shop"');
  });
});

const APP = 'upgrade-app';
const DAEMONS: readonly DaemonName[] = ['compute', 'postgres', 'buckets'];
const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];

// Local dev is not supported on Windows, where the emulators cannot run.
describe.skipIf(process.platform === 'win32')('upgrading a directory from short keys', () => {
  let root: string;
  let registryRoot: string;
  let scope: AppScope;
  let recordFile: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-legacy-keys-'));
    registryRoot = path.join(root, 'emulators');
    process.env[EMULATORS_DIR_ENV] = registryRoot;
    for (const name of DAEMONS) {
      const entry = fileURLToPath(import.meta.resolve(`@internal/dev-emulators/${name}-main`));
      await ensureDaemon(name, entry, { registryRoot });
    }
    scope = { devDir: path.join(root, 'project', '.prisma-composer', 'dev'), app: APP };
    recordFile = path.join(scope.devDir, EMULATOR_INSTANCES_FILE);
  });

  afterEach(async () => {
    await deleteAppInstances(scope).catch(() => undefined);
    for (const name of DAEMONS) await stopDaemon(name, { registryRoot }).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
    else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
  });

  /** The instances, data folder and record an earlier release left behind. */
  async function writePreviousRelease() {
    const labels = (address: string) => ({
      'composer.directory': path.join(root, 'project'),
      'composer.app': APP,
      'composer.address': address,
    });
    const bucketDir = path.join(scope.devDir, 'buckets', APP, 'uploads');
    fs.mkdirSync(bucketDir, { recursive: true });
    fs.writeFileSync(path.join(bucketDir, 'kept.txt'), 'kept');
    const api = await computeClient().createInstance({ labels: labels('api') });
    const catalog = await postgresClient().createInstance({
      labels: labels('catalog'),
      prismaDevModulePath: resolvePrismaDevModulePath(),
    });
    const uploads = await bucketsClient().createInstance({
      labels: labels('uploads'),
      dir: bucketDir,
    });
    const nodes = {
      api: { kind: 'service', id: api.id, port: api.port },
      catalog: { kind: 'database', id: catalog.id, port: catalog.port },
      uploads: { kind: 'bucket', id: uploads.id },
    } as const;
    fs.writeFileSync(recordFile, JSON.stringify({ current: APP, apps: { [APP]: { nodes } } }));
    return { nodes, bucketDir };
  }

  /** What `prisma dev` does at the start of a run, before Alchemy. */
  async function runDev() {
    await selectApp(scope);
    const api = await ensureServiceInstance(scope, `${APP}.api`);
    const catalog = await ensureDatabaseInstance(
      scope,
      `${APP}.catalog`,
      resolvePrismaDevModulePath(),
    );
    const uploads = await ensureBucketInstance(
      scope,
      `${APP}.uploads`,
      bucketDataDir(scope, `${APP}.uploads`),
    );
    return {
      api: { id: api.instance.id, port: api.instance.port, portChange: api.portChange },
      catalog: {
        id: catalog.instance.id,
        port: catalog.instance.port,
        portChange: catalog.portChange,
      },
      uploads: { id: uploads.id, dir: uploads.dir },
    };
  }

  test('the first run reuses every instance and the bucket folder, and rewrites the keys', async () => {
    const { nodes, bucketDir } = await writePreviousRelease();

    const run = await runDev();

    expect(run).toEqual({
      api: { id: nodes.api.id, port: nodes.api.port, portChange: undefined },
      catalog: { id: nodes.catalog.id, port: nodes.catalog.port, portChange: undefined },
      uploads: { id: nodes.uploads.id, dir: bucketDir },
    });
    expect(fs.readFileSync(path.join(bucketDir, 'kept.txt'), 'utf8')).toBe('kept');
    expect(JSON.parse(fs.readFileSync(recordFile, 'utf8'))).toEqual({
      formatVersion: 2,
      current: APP,
      apps: {
        [APP]: {
          nodes: {
            [`${APP}.api`]: nodes.api,
            [`${APP}.catalog`]: nodes.catalog,
            [`${APP}.uploads`]: nodes.uploads,
          },
        },
      },
    });
  }, 120_000);

  test('a second run changes nothing', async () => {
    await writePreviousRelease();
    const first = await runDev();
    const onDisk = fs.readFileSync(recordFile, 'utf8');

    const second = await runDev();

    expect(second).toEqual(first);
    expect(fs.readFileSync(recordFile, 'utf8')).toBe(onDisk);
  }, 120_000);
});
