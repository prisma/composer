/**
 * Databases and buckets through the directory's record, against real
 * Compute, Postgres and bucket emulators in a temporary emulators directory:
 * isolation between directories, stopping and resuming an app's databases
 * with their data, switching apps, re-creating a lost database, and
 * `--fresh`.
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
  selectApp,
  stopAppInstances,
} from '../emulator-instances.ts';

const APP = 'data-app';
const NODES: readonly AppNode[] = [
  { address: 'catalog', kind: 'database' },
  { address: 'uploads', kind: 'bucket' },
  { address: 'web', kind: 'compute' },
];
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

  function scopeIn(name: string, app = APP): AppScope & { readonly directory: string } {
    const directory = path.join(root, name);
    const scope = { directory, devDir: path.join(directory, '.prisma-composer', 'dev'), app };
    scopes.push(scope);
    return scope;
  }

  async function nodeOf(scope: AppScope & { readonly directory: string }, address: string) {
    const node: NodeInstance | undefined = (await readEmulatorInstances(scope.directory))?.apps[
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

  test("switching A → B → A stops A's databases and resumes them with their data and ports", async () => {
    const a = scopeIn('switch');
    const b = { ...a, app: 'other-app' };
    scopes.push(b);
    await selectApp(a);
    await ensureAppInstances(a, NODES);
    const before = await databaseOf(a);
    await query(before.url, "create table kept (v text); insert into kept values ('a')");
    const recordedA = (await readEmulatorInstances(a.directory))?.apps[APP];

    expect(await selectApp(b)).toBe(APP);
    expect((await databaseOf(a)).status).toBe('stopped');
    await ensureAppInstances(b, NODES);

    expect(await selectApp(a)).toBe('other-app');
    const changes = await ensureAppInstances(a, NODES);

    expect(changes).toEqual([]);
    expect((await readEmulatorInstances(a.directory))?.apps[APP]).toEqual(recordedA);
    const after = await databaseOf(a);
    expect(after).toMatchObject({ status: 'running', url: before.url });
    expect(await query(after.url, 'select v from kept')).toEqual([{ v: 'a' }]);
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
    expect((await readEmulatorInstances(scope.directory))?.apps[APP]).toBeUndefined();
  }, 120_000);
});
