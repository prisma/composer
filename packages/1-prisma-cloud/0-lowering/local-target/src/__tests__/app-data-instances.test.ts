/**
 * Databases and buckets through the directory's record, against real
 * Compute, Postgres and bucket emulators in a temporary emulators directory:
 * isolation between directories and between environments, stopping and
 * resuming an app's databases with their data, re-creating a lost database,
 * and `--fresh`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  bucketsClient,
  type DaemonName,
  EMULATORS_DIR_ENV,
  ensureDaemon,
  postgresClient,
  stopDaemon,
} from '@internal/dev-emulators';
import { Client as PgClient } from 'pg';
import { type AppNode, ensureAppInstances } from '../app-instances.ts';
import {
  type AppScope,
  deleteAppInstances,
  type NodeInstance,
  readEmulatorInstances,
  stopAppInstances,
} from '../emulator-instances.ts';

const APP = 'data-app';
function nodesOf(app: string): readonly AppNode[] {
  return [
    { address: `${app}.catalog`, kind: 'database' },
    { address: `${app}.uploads`, kind: 'bucket' },
    { address: `${app}.web`, kind: 'service' },
  ];
}
const NODES = nodesOf(APP);
const DAEMONS: readonly DaemonName[] = ['compute', 'postgres', 'buckets'];
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
describe.skipIf(process.platform === 'win32')('databases and buckets through the record', () => {
  let root: string;
  let registryRoot: string;
  let scopes: AppScope[];

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-app-data-'));
    registryRoot = path.join(root, 'emulators');
    process.env[EMULATORS_DIR_ENV] = registryRoot;
    for (const name of DAEMONS) {
      const entry = fileURLToPath(import.meta.resolve(`@internal/dev-emulators/${name}-main`));
      await ensureDaemon(name, entry, { registryRoot });
    }
    scopes = [];
  });

  afterEach(async () => {
    for (const scope of scopes) await deleteAppInstances(scope).catch(() => undefined);
    for (const name of DAEMONS) await stopDaemon(name, { registryRoot }).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
    else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
  });

  function scopeIn(
    name: string,
    app = APP,
    environment = 'dev',
  ): AppScope & { readonly directory: string } {
    const directory = path.join(root, name);
    const devDir = path.join(directory, '.prisma-composer', 'dev', environment);
    const scope = { directory, devDir, app, environment };
    scopes.push(scope);
    return scope;
  }

  /** The instance recorded for `<app>.<name>`. */
  async function nodeOf(scope: AppScope & { readonly directory: string }, name: string) {
    const address = `${scope.app}.${name}`;
    const node: NodeInstance | undefined = (await readEmulatorInstances(scope.devDir))?.apps[
      scope.app
    ]?.nodes[address];
    if (!node) throw new Error(`no instance recorded for "${address}"`);
    return node;
  }

  async function databaseOf(scope: AppScope & { readonly directory: string }) {
    const instance = await postgresClient().getInstance((await nodeOf(scope, 'catalog')).id);
    if (!instance) throw new Error('the recorded database is gone');
    return instance;
  }

  async function s3For(scope: AppScope & { readonly directory: string }, key: string) {
    const bucket = (await nodeOf(scope, 'uploads')).id;
    await bucketsClient().putCredentials(bucket, key, `${key}-secret`);
    const s3 = new S3Client({
      region: 'auto',
      endpoint: bucketsClient().baseUrl,
      forcePathStyle: true,
      credentials: { accessKeyId: key, secretAccessKey: `${key}-secret` },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 1,
    });
    return { s3, bucket };
  }

  test('two directories running the same app each see only their own rows and objects', async () => {
    const a = scopeIn('a');
    const b = scopeIn('b');
    await Promise.all([ensureAppInstances(a, NODES), ensureAppInstances(b, NODES)]);

    const dbA = await databaseOf(a);
    const dbB = await databaseOf(b);
    expect(dbA.id).not.toBe(dbB.id);
    expect(dbA.port).not.toBe(dbB.port);
    await query(dbA.url, "create table marker (v text); insert into marker values ('a')");
    await query(dbB.url, "create table marker (v text); insert into marker values ('b')");
    const s3A = await s3For(a, 'AKIADIRA');
    const s3B = await s3For(b, 'AKIADIRB');
    await s3A.s3.send(new PutObjectCommand({ Bucket: s3A.bucket, Key: 'only-a', Body: 'a' }));
    await s3B.s3.send(new PutObjectCommand({ Bucket: s3B.bucket, Key: 'only-b', Body: 'b' }));

    expect(await query(dbA.url, 'select v from marker')).toEqual([{ v: 'a' }]);
    expect(await query(dbB.url, 'select v from marker')).toEqual([{ v: 'b' }]);
    const listedA = await s3A.s3.send(new ListObjectsV2Command({ Bucket: s3A.bucket }));
    const listedB = await s3B.s3.send(new ListObjectsV2Command({ Bucket: s3B.bucket }));
    expect(listedA.Contents?.map((o) => o.Key)).toEqual(['only-a']);
    expect(listedB.Contents?.map((o) => o.Key)).toEqual(['only-b']);
  }, 120_000);

  test('when the app stops, its database server stops; the next start has the data on the same port', async () => {
    const scope = scopeIn('stop');
    await ensureAppInstances(scope, NODES);
    const before = await databaseOf(scope);
    await query(before.url, "create table kept (v text); insert into kept values ('row')");

    await stopAppInstances(scope);

    expect((await databaseOf(scope)).status).toBe('stopped');
    expect(await acceptsConnection(before.port)).toBe(false);

    await ensureAppInstances(scope, NODES);

    const after = await databaseOf(scope);
    expect(after).toMatchObject({ id: before.id, status: 'running', url: before.url });
    expect(await query(after.url, 'select v from kept')).toEqual([{ v: 'row' }]);
  }, 120_000);

  test('the same app in two environments of one directory has two databases and two buckets, running at once', async () => {
    const inDev = scopeIn('environments');
    const inTest = scopeIn('environments', APP, 'test');
    await ensureAppInstances(inDev, NODES);
    const devDb = await databaseOf(inDev);
    await query(devDb.url, "create table marker (v text); insert into marker values ('dev')");
    const devS3 = await s3For(inDev, 'AKIAENVDEV');
    await devS3.s3.send(new PutObjectCommand({ Bucket: devS3.bucket, Key: 'only-dev', Body: 'd' }));

    await ensureAppInstances(inTest, NODES);

    const testDb = await databaseOf(inTest);
    expect(testDb.id).not.toBe(devDb.id);
    expect(testDb.port).not.toBe(devDb.port);
    expect((await databaseOf(inDev)).status).toBe('running');
    expect(await query(testDb.url, "select to_regclass('marker') as reg")).toEqual([{ reg: null }]);
    expect(await query(devDb.url, 'select v from marker')).toEqual([{ v: 'dev' }]);
    const testS3 = await s3For(inTest, 'AKIAENVTEST');
    expect(testS3.bucket).not.toBe(devS3.bucket);
    const listed = await testS3.s3.send(new ListObjectsV2Command({ Bucket: testS3.bucket }));
    expect(listed.Contents ?? []).toEqual([]);
    expect(fs.existsSync(path.join(inDev.devDir, 'buckets', APP, 'uploads', 'only-dev'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(inTest.devDir, 'buckets', APP, 'uploads', 'only-dev'))).toBe(
      false,
    );
  }, 180_000);

  test("--fresh in one environment deletes only that environment's copy; the other keeps its data", async () => {
    const inDev = scopeIn('fresh-environment');
    const inTest = scopeIn('fresh-environment', APP, 'test');
    await ensureAppInstances(inDev, NODES);
    await ensureAppInstances(inTest, NODES);
    const devDb = await databaseOf(inDev);
    await query(devDb.url, "create table kept (v text); insert into kept values ('dev')");
    const testDatabase = await nodeOf(inTest, 'catalog');

    await deleteAppInstances(inTest);

    expect(await postgresClient().getInstance(testDatabase.id)).toBeUndefined();
    expect((await readEmulatorInstances(inTest.devDir))?.apps[APP]).toBeUndefined();
    expect(await databaseOf(inDev)).toMatchObject({ id: devDb.id, status: 'running' });
    expect(await query(devDb.url, 'select v from kept')).toEqual([{ v: 'dev' }]);
  }, 180_000);

  test('running a second app in the same environment stops nothing of the first', async () => {
    const first = scopeIn('two-apps');
    const second = scopeIn('two-apps', 'other-app');
    await ensureAppInstances(first, NODES);

    await ensureAppInstances(second, nodesOf(second.app));

    expect((await databaseOf(first)).status).toBe('running');
    expect((await databaseOf(second)).status).toBe('running');
  }, 180_000);

  test('a recorded database the emulator lost is created again, empty, on its remembered port', async () => {
    const scope = scopeIn('lost');
    await ensureAppInstances(scope, NODES);
    const before = await databaseOf(scope);
    await postgresClient().deleteInstance(before.id);

    const changes = await ensureAppInstances(scope, NODES);

    const after = await databaseOf(scope);
    expect(changes).toEqual([]);
    expect(after.id).not.toBe(before.id);
    expect(after.port).toBe(before.port);
    expect(await query(after.url, "select to_regclass('kept') as reg")).toEqual([{ reg: null }]);
  }, 120_000);

  test("--fresh deletes the app's database, bucket and service, and its entry", async () => {
    const scope = scopeIn('fresh');
    await ensureAppInstances(scope, NODES);
    const database = await nodeOf(scope, 'catalog');
    const bucket = await nodeOf(scope, 'uploads');

    await deleteAppInstances(scope);

    expect(await postgresClient().getInstance(database.id)).toBeUndefined();
    expect(await bucketsClient().getInstance(bucket.id)).toBeUndefined();
    expect((await readEmulatorInstances(scope.devDir))?.apps[APP]).toBeUndefined();
  }, 120_000);
});
