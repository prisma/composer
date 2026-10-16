/**
 * The bucket emulator (local-dev spec § 2 `buckets-main.ts`): bucket
 * instances keyed by ids the emulator generates, which are also their S3
 * bucket names; per-instance credentials; a SigV4 round-trip via a real
 * `@aws-sdk/client-s3`; isolation between buckets; 501 multipart; and
 * discarding an earlier version's state. Every test uses a temp
 * `registryRoot` and stops the daemon it started.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GetObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type BucketsClient, bucketsClient } from '../client.ts';
import { daemonStateDir, ensureDaemon, stopDaemon } from '../daemon.ts';
import { ensureFreshDaemon, entryFor, tempDir, waitFor } from './helpers.ts';

let registryRoot: string;
let daemonUrl: string;
let client: BucketsClient;

beforeEach(async () => {
  registryRoot = tempDir('buckets-registry');
  const { url } = await ensureFreshDaemon('buckets', registryRoot);
  daemonUrl = url;
  client = bucketsClient({ registryRoot });
});

afterEach(async () => {
  await stopDaemon('buckets', { registryRoot }).catch(() => undefined);
});

function s3For(accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: daemonUrl,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1,
  });
}

function dataDir(): string {
  return path.join(tempDir('bucket-data'), 'objects');
}

describe('bucket instances', () => {
  test('create makes the data root; list and get return the labels verbatim', async () => {
    const dir = dataDir();
    const labels = { 'composer.app': 'My App', note: 'any: /value' };

    const bucket = await client.createInstance({ labels, dir });

    expect(bucket.id).toMatch(/^bkt-[0-9a-f]{16}$/);
    expect(bucket).toEqual({ id: bucket.id, labels, dir });
    expect(fs.existsSync(dir)).toBe(true);
    expect(await client.listInstances()).toEqual([bucket]);
    expect(await client.getInstance(bucket.id)).toEqual(bucket);
    expect(await client.getInstance('bkt-0000000000000000')).toBeUndefined();
  });

  test('delete forgets the bucket and its credentials but leaves its objects', async () => {
    const dir = dataDir();
    const bucket = await client.createInstance({ labels: {}, dir });
    await client.putCredentials(bucket.id, 'AKIADELETETEST', 'secret');
    fs.writeFileSync(path.join(dir, 'kept.txt'), 'still here');

    await client.deleteInstance(bucket.id);

    expect(await client.getInstance(bucket.id)).toBeUndefined();
    await expect(
      s3For('AKIADELETETEST', 'secret').send(
        new PutObjectCommand({ Bucket: bucket.id, Key: 'x', Body: 'x' }),
      ),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'kept.txt'))).toBe(true);
    await client.deleteInstance(bucket.id);
  });

  test('a malformed instance id is rejected with 400', async () => {
    const res = await fetch(`${daemonUrl}/_pcdev/instances/uploads`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('"uploads"');
  });

  test('labels that are not all strings are rejected with 400', async () => {
    const res = await fetch(`${daemonUrl}/_pcdev/instances`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labels: { count: 1 }, dir: dataDir() }),
    });
    expect(res.status).toBe(400);
  });
});

describe('credentials', () => {
  test('an accessKeyId registered for another bucket is refused with 409, naming neither secret', async () => {
    const mine = await client.createInstance({ labels: {}, dir: dataDir() });
    const other = await client.createInstance({ labels: {}, dir: dataDir() });
    await client.putCredentials(mine.id, 'AKIACONFLICT', 'minesecret');

    const res = await fetch(`${daemonUrl}/_pcdev/instances/${other.id}/credentials`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessKeyId: 'AKIACONFLICT', secretAccessKey: 'othersecret' }),
    });
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).not.toContain('minesecret');
    expect(body).not.toContain('othersecret');

    // The same bucket rotating its secret still succeeds.
    await client.putCredentials(mine.id, 'AKIACONFLICT', 'minesecret-rotated');
    await s3For('AKIACONFLICT', 'minesecret-rotated').send(
      new PutObjectCommand({ Bucket: mine.id, Key: 'k', Body: 'x' }),
    );
    expect(fs.existsSync(path.join(mine.dir, 'k'))).toBe(true);
  });

  test('buckets and their credentials survive an emulator restart', async () => {
    const bucket = await client.createInstance({ labels: { note: 'kept' }, dir: dataDir() });
    await client.putCredentials(bucket.id, 'AKIARESTART', 'restartsecret');

    await stopDaemon('buckets', { registryRoot });
    const restarted = await ensureDaemon('buckets', entryFor('buckets'), { registryRoot });
    daemonUrl = restarted.url;

    expect(await bucketsClient({ registryRoot }).getInstance(bucket.id)).toEqual(bucket);
    await s3For('AKIARESTART', 'restartsecret').send(
      new PutObjectCommand({ Bucket: bucket.id, Key: 'k', Body: 'still owned' }),
    );
    expect(fs.existsSync(path.join(bucket.dir, 'k'))).toBe(true);
  });
});

describe('SigV4 round-trip', () => {
  test('put + get round-trips real bytes through the data root', async () => {
    const bucket = await client.createInstance({ labels: {}, dir: dataDir() });
    await client.putCredentials(bucket.id, 'AKIAROUNDTRIP', 'roundtripsecret');
    const s3 = s3For('AKIAROUNDTRIP', 'roundtripsecret');

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket.id,
        Key: 'hello.txt',
        Body: 'hello bucket emulator',
        ContentType: 'text/plain',
      }),
    );

    expect(fs.existsSync(path.join(bucket.dir, 'hello.txt'))).toBe(true);
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket.id, Key: 'hello.txt' }));
    expect(await got.Body?.transformToString()).toBe('hello bucket emulator');
  });

  test('a wrong secret is rejected with a signature failure', async () => {
    const bucket = await client.createInstance({ labels: {}, dir: dataDir() });
    await client.putCredentials(bucket.id, 'AKIAREALKEY', 'realsecret');

    await expect(
      s3For('AKIAREALKEY', 'wrong-secret').send(
        new PutObjectCommand({ Bucket: bucket.id, Key: 'x', Body: 'x' }),
      ),
    ).rejects.toThrow();
  });

  test('any of a bucket’s own credentials verifies', async () => {
    const bucket = await client.createInstance({ labels: {}, dir: dataDir() });
    await client.putCredentials(bucket.id, 'AKIAFIRST', 'firstsecret');
    await client.putCredentials(bucket.id, 'AKIASECOND', 'secondsecret');

    await s3For('AKIAFIRST', 'firstsecret').send(
      new PutObjectCommand({ Bucket: bucket.id, Key: 'a', Body: 'a' }),
    );
    await s3For('AKIASECOND', 'secondsecret').send(
      new PutObjectCommand({ Bucket: bucket.id, Key: 'b', Body: 'b' }),
    );

    expect(fs.existsSync(path.join(bucket.dir, 'a'))).toBe(true);
    expect(fs.existsSync(path.join(bucket.dir, 'b'))).toBe(true);
  });
});

describe('isolation between buckets with the same labels', () => {
  const labels = { 'composer.app': 'same-app', 'composer.address': 'uploads' };

  test('each keeps its own objects in its own data root', async () => {
    const one = await client.createInstance({ labels, dir: dataDir() });
    const two = await client.createInstance({ labels, dir: dataDir() });
    await client.putCredentials(one.id, 'AKIAONE', 'onesecret');
    await client.putCredentials(two.id, 'AKIATWO', 'twosecret');
    const s3One = s3For('AKIAONE', 'onesecret');
    const s3Two = s3For('AKIATWO', 'twosecret');

    await s3One.send(new PutObjectCommand({ Bucket: one.id, Key: 'k', Body: 'from one' }));
    await s3Two.send(new PutObjectCommand({ Bucket: two.id, Key: 'k', Body: 'from two' }));

    const gotOne = await s3One.send(new GetObjectCommand({ Bucket: one.id, Key: 'k' }));
    const gotTwo = await s3Two.send(new GetObjectCommand({ Bucket: two.id, Key: 'k' }));
    expect(await gotOne.Body?.transformToString()).toBe('from one');
    expect(await gotTwo.Body?.transformToString()).toBe('from two');
    expect(fs.readFileSync(path.join(one.dir, 'k'), 'utf8')).toBe('from one');
    expect(fs.readFileSync(path.join(two.dir, 'k'), 'utf8')).toBe('from two');
  });

  test("one bucket's credential is rejected against another exactly like a bad signature", async () => {
    const one = await client.createInstance({ labels, dir: dataDir() });
    const two = await client.createInstance({ labels, dir: dataDir() });
    await client.putCredentials(one.id, 'AKIACROSSONE', 'onesecret');
    await client.putCredentials(two.id, 'AKIACROSSTWO', 'twosecret');

    // One's credential, CORRECTLY signed, targeting two's bucket.
    const crossUrl = await getSignedUrl(
      s3For('AKIACROSSONE', 'onesecret'),
      new PutObjectCommand({ Bucket: two.id, Key: 'x' }),
      { expiresIn: 900 },
    );
    const crossRes = await fetch(crossUrl, { method: 'PUT', body: 'x' });
    // Two's OWN accessKeyId with a wrong secret — a genuinely bad signature.
    const badSigUrl = await getSignedUrl(
      s3For('AKIACROSSTWO', 'not-the-real-secret'),
      new PutObjectCommand({ Bucket: two.id, Key: 'x' }),
      { expiresIn: 900 },
    );
    const badSigRes = await fetch(badSigUrl, { method: 'PUT', body: 'x' });

    expect(crossRes.status).toBe(403);
    expect(crossRes.status).toBe(badSigRes.status);
    expect(await crossRes.text()).toBe(await badSigRes.text());
    expect(fs.existsSync(path.join(two.dir, 'x'))).toBe(false);
  });
});

describe('multipart uploads', () => {
  test('an initiate-multipart request is rejected with the pinned 501', async () => {
    const bucket = await client.createInstance({ labels: {}, dir: dataDir() });
    await client.putCredentials(bucket.id, 'AKIAMULTI', 'multisecret');

    await expect(
      s3For('AKIAMULTI', 'multisecret').send(
        new ListMultipartUploadsCommand({ Bucket: bucket.id }),
      ),
    ).rejects.toThrow();
    const res = await fetch(`${daemonUrl}/${bucket.id}?uploads`);
    expect(res.status).toBe(501);
    expect(await res.text()).toBe(
      'multipart upload is not supported by the local dev bucket emulator yet',
    );
  });
});

describe('health', () => {
  test('health is available at both /health and /_pcdev/health', async () => {
    expect((await fetch(`${daemonUrl}/health`)).status).toBe(200);
    expect((await fetch(`${daemonUrl}/_pcdev/health`)).status).toBe(200);
  });
});

describe('state written by an earlier version', () => {
  test('is discarded on load', async () => {
    await stopDaemon('buckets', { registryRoot });
    const stateDir = daemonStateDir(registryRoot, 'buckets');
    fs.rmSync(path.join(stateDir, 'instances.json'), { force: true });
    fs.writeFileSync(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        buckets: { 'legacy--data': { app: 'legacy', name: 'data', dir: dataDir() } },
        credentials: { AKIALEGACY: { app: 'legacy', secretAccessKey: 's' } },
      }),
    );

    await ensureDaemon('buckets', entryFor('buckets'), { registryRoot });

    expect(await bucketsClient({ registryRoot }).listInstances()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'state.json'))).toBe(false);
  });
});

/**
 * The emulator never interprets Composer's data: an app name, a node address
 * or a directory reaches it only as label values and as the data root it is
 * given, which it stores verbatim.
 */
describe('the emulator never interprets Composer data', () => {
  test('labels and the data root are stored verbatim, and nothing else carries their values', async () => {
    const directory = path.join(tempDir('marker-project'), 'zzdirectorymarker');
    const dir = path.join(directory, '.prisma-composer', 'dev', 'buckets', 'zzaddressmarker');
    const labels = {
      'composer.directory': directory,
      'composer.app': 'zzappmarker',
      'composer.address': 'zzaddressmarker',
    };
    const bucket = await client.createInstance({ labels, dir });
    await client.putCredentials(bucket.id, 'AKIAMARKER', 'secret');

    const stateDir = daemonStateDir(registryRoot, 'buckets');
    const statePath = path.join(stateDir, 'instances.json');
    await waitFor(() => fs.existsSync(statePath), 5000);
    const state: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const record: unknown = Reflect.get(Reflect.get(state as object, 'instances'), bucket.id);
    expect(record).toMatchObject({ labels, dir });

    const opaque = (key: string, value: unknown) =>
      key === 'labels' || key === 'dir' ? undefined : value;
    const listed = JSON.stringify(await client.listInstances(), opaque);
    for (const marker of ['zzdirectorymarker', 'zzappmarker', 'zzaddressmarker']) {
      expect(JSON.stringify(state, opaque)).not.toContain(marker);
      expect(listed).not.toContain(marker);
      for (const file of fs.readdirSync(stateDir, { recursive: true })) {
        expect(String(file)).not.toContain(marker);
      }
    }
  });

  test("the emulator's code names no app, address, directory or Composer concept", () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../buckets-main.ts', import.meta.url)),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/\b(apps?|appName|address(es)?|directory|composer)\b/i);
  });
});
