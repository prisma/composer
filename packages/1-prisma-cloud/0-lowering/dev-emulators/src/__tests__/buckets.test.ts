/**
 * The bucket emulator (local-dev spec § 2 `buckets-main.ts`): `/_pcdev/`
 * admin, SigV4 round-trip via a real `@aws-sdk/client-s3`, multi-app
 * isolation (same bucket name, two apps, no collisions), 501 multipart, and
 * validation. Every test uses a temp `registryRoot` and stops the daemon it
 * started.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GetObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { bucketsClient } from '../client.ts';
import { ensureDaemon, stopDaemon } from '../daemon.ts';
import { ensureFreshDaemon, entryFor, tempDir } from './helpers.ts';

let registryRoot: string;
let daemonUrl: string;

beforeEach(async () => {
  registryRoot = tempDir('buckets-registry');
  const { url } = await ensureFreshDaemon('buckets', registryRoot);
  daemonUrl = url;
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

describe('bucket + credential admin', () => {
  test('PUT bucket registers the physical name and creates the directory; idempotent', async () => {
    const client = bucketsClient({ registryRoot });
    const dir = path.join(tempDir('bucket-data'), 'objects');

    await client.putBucket('myapp', 'uploads', dir);
    expect(fs.existsSync(dir)).toBe(true);

    // Second PUT with the same args is idempotent — no error, dir untouched.
    await client.putBucket('myapp', 'uploads', dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('DELETE app removes registrations and credentials but not the object directory', async () => {
    const client = bucketsClient({ registryRoot });
    const dir = path.join(tempDir('bucket-data'), 'objects');
    await client.putBucket('myapp', 'uploads', dir);
    await client.putCredentials('myapp', 'AKIADELETETEST', 'secret');
    fs.writeFileSync(path.join(dir, 'kept.txt'), 'still here');

    await client.deleteApp('myapp');

    // The registration is gone: a PUT through the S3 wire against the
    // physical bucket now hits an unknown bucket (put has no graceful
    // shape, so it throws — surfaced by the SDK as an error).
    const s3 = s3For('AKIADELETETEST', 'secret');
    await expect(
      s3.send(new PutObjectCommand({ Bucket: 'myapp--uploads', Key: 'x', Body: 'x' })),
    ).rejects.toThrow();

    // Objects already on disk are untouched — only `teardown`'s `fs.rm` owns them.
    expect(fs.existsSync(path.join(dir, 'kept.txt'))).toBe(true);
  });

  test('re-registering an accessKeyId already owned by a different app is rejected with 409, naming neither secret', async () => {
    const client = bucketsClient({ registryRoot });
    await client.putCredentials('myapp', 'AKIACONFLICT', 'myappsecret');

    const res = await fetch(`${daemonUrl}/_pcdev/apps/otherapp/credentials`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessKeyId: 'AKIACONFLICT', secretAccessKey: 'otherappsecret' }),
    });
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).not.toContain('myappsecret');
    expect(body).not.toContain('otherappsecret');

    // The SAME app re-registering (rotating the secret) still succeeds.
    await client.putCredentials('myapp', 'AKIACONFLICT', 'myappsecret-rotated');
    const dir = path.join(tempDir('bucket-data'), 'objects');
    await client.putBucket('myapp', 'uploads', dir);
    const s3 = s3For('AKIACONFLICT', 'myappsecret-rotated');
    await s3.send(new PutObjectCommand({ Bucket: 'myapp--uploads', Key: 'k', Body: 'x' }));
    expect(fs.existsSync(path.join(dir, 'k'))).toBe(true);
  });

  test('a credentials owning app round-trips across a daemon restart', async () => {
    const client = bucketsClient({ registryRoot });
    const dir = path.join(tempDir('bucket-data'), 'objects');
    await client.putBucket('myapp', 'uploads', dir);
    await client.putCredentials('myapp', 'AKIARESTART', 'restartsecret');

    await stopDaemon('buckets', { registryRoot });
    const restarted = await ensureDaemon('buckets', entryFor('buckets'), { registryRoot });
    daemonUrl = restarted.url;

    // The secret survived: the original app's own credential still works.
    const s3 = s3For('AKIARESTART', 'restartsecret');
    await s3.send(
      new PutObjectCommand({ Bucket: 'myapp--uploads', Key: 'k', Body: 'still owned by myapp' }),
    );
    expect(fs.existsSync(path.join(dir, 'k'))).toBe(true);

    // The OWNER survived too: a different app re-registering the same
    // accessKeyId still 409s, not a silent takeover.
    const res = await fetch(`${daemonUrl}/_pcdev/apps/otherapp/credentials`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessKeyId: 'AKIARESTART', secretAccessKey: 'stolen' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('SigV4 round-trip', () => {
  test('put + get round-trips real bytes through the filesystem', async () => {
    const client = bucketsClient({ registryRoot });
    const dir = path.join(tempDir('bucket-data'), 'objects');
    await client.putBucket('myapp', 'uploads', dir);
    await client.putCredentials('myapp', 'AKIAROUNDTRIP', 'roundtripsecret');

    const s3 = s3For('AKIAROUNDTRIP', 'roundtripsecret');
    await s3.send(
      new PutObjectCommand({
        Bucket: 'myapp--uploads',
        Key: 'hello.txt',
        Body: 'hello bucket emulator',
        ContentType: 'text/plain',
      }),
    );

    expect(fs.existsSync(path.join(dir, 'hello.txt'))).toBe(true);

    const got = await s3.send(new GetObjectCommand({ Bucket: 'myapp--uploads', Key: 'hello.txt' }));
    const body = await got.Body?.transformToString();
    expect(body).toBe('hello bucket emulator');
  });

  test('a wrong credential is rejected with a signature failure', async () => {
    const client = bucketsClient({ registryRoot });
    const dir = path.join(tempDir('bucket-data'), 'objects');
    await client.putBucket('myapp', 'uploads', dir);
    await client.putCredentials('myapp', 'AKIAREALKEY', 'realsecret');

    const s3 = s3For('AKIAREALKEY', 'wrong-secret');
    await expect(
      s3.send(new PutObjectCommand({ Bucket: 'myapp--uploads', Key: 'x', Body: 'x' })),
    ).rejects.toThrow();
  });

  test('SigV4 verifies against any of the bucket-owning apps OWN accepted credentials', async () => {
    const client = bucketsClient({ registryRoot });
    const dir = path.join(tempDir('bucket-data'), 'objects');
    await client.putBucket('myapp', 'uploads', dir);
    await client.putCredentials('myapp', 'AKIAFIRST', 'firstsecret');
    await client.putCredentials('myapp', 'AKIASECOND', 'secondsecret');

    const s3First = s3For('AKIAFIRST', 'firstsecret');
    await s3First.send(new PutObjectCommand({ Bucket: 'myapp--uploads', Key: 'a', Body: 'a' }));

    const s3Second = s3For('AKIASECOND', 'secondsecret');
    await s3Second.send(new PutObjectCommand({ Bucket: 'myapp--uploads', Key: 'b', Body: 'b' }));

    expect(fs.existsSync(path.join(dir, 'a'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'b'))).toBe(true);
  });
});

describe('multi-app isolation', () => {
  test('the same bucket name under two apps maps to distinct physical dirs, no collisions', async () => {
    const client = bucketsClient({ registryRoot });
    const dirOne = path.join(tempDir('bucket-data-one'), 'objects');
    const dirTwo = path.join(tempDir('bucket-data-two'), 'objects');
    await client.putBucket('tenant-one', 'data', dirOne);
    await client.putBucket('tenant-two', 'data', dirTwo);
    await client.putCredentials('tenant-one', 'AKIAONE', 'onesecret');
    await client.putCredentials('tenant-two', 'AKIATWO', 'twosecret');

    const s3One = s3For('AKIAONE', 'onesecret');
    const s3Two = s3For('AKIATWO', 'twosecret');

    await s3One.send(
      new PutObjectCommand({ Bucket: 'tenant-one--data', Key: 'k', Body: 'from tenant one' }),
    );
    await s3Two.send(
      new PutObjectCommand({ Bucket: 'tenant-two--data', Key: 'k', Body: 'from tenant two' }),
    );

    const gotOne = await s3One.send(new GetObjectCommand({ Bucket: 'tenant-one--data', Key: 'k' }));
    const gotTwo = await s3Two.send(new GetObjectCommand({ Bucket: 'tenant-two--data', Key: 'k' }));
    expect(await gotOne.Body?.transformToString()).toBe('from tenant one');
    expect(await gotTwo.Body?.transformToString()).toBe('from tenant two');

    expect(fs.readFileSync(path.join(dirOne, 'k'), 'utf8')).toBe('from tenant one');
    expect(fs.readFileSync(path.join(dirTwo, 'k'), 'utf8')).toBe('from tenant two');
  });

  test("app A's credential is rejected against app B's bucket exactly like a bad signature", async () => {
    const client = bucketsClient({ registryRoot });
    const dirTwo = path.join(tempDir('bucket-data-two'), 'objects');
    await client.putBucket('tenant-two', 'data', dirTwo);
    await client.putCredentials('tenant-one', 'AKIACROSSONE', 'onesecret');
    await client.putCredentials('tenant-two', 'AKIACROSSTWO', 'twosecret');

    // tenant-one's credential, CORRECTLY signed, targeting tenant-two's bucket.
    const s3CrossApp = s3For('AKIACROSSONE', 'onesecret');
    const crossAppUrl = await getSignedUrl(
      s3CrossApp,
      new PutObjectCommand({ Bucket: 'tenant-two--data', Key: 'x' }),
      { expiresIn: 900 },
    );
    const crossAppRes = await fetch(crossAppUrl, { method: 'PUT', body: 'x' });

    // tenant-two's OWN accessKeyId, but a wrong secret — a genuinely bad signature.
    const s3BadSig = s3For('AKIACROSSTWO', 'not-the-real-secret');
    const badSigUrl = await getSignedUrl(
      s3BadSig,
      new PutObjectCommand({ Bucket: 'tenant-two--data', Key: 'x' }),
      { expiresIn: 900 },
    );
    const badSigRes = await fetch(badSigUrl, { method: 'PUT', body: 'x' });

    expect(crossAppRes.status).toBe(403);
    expect(crossAppRes.status).toBe(badSigRes.status);
    expect(await crossAppRes.text()).toBe(await badSigRes.text());

    expect(fs.existsSync(path.join(dirTwo, 'x'))).toBe(false);
  });
});

describe('multipart uploads', () => {
  test('an initiate-multipart request is rejected with the pinned 501', async () => {
    const client = bucketsClient({ registryRoot });
    const dir = path.join(tempDir('bucket-data'), 'objects');
    await client.putBucket('myapp', 'uploads', dir);
    await client.putCredentials('myapp', 'AKIAMULTI', 'multisecret');

    const s3 = s3For('AKIAMULTI', 'multisecret');
    await expect(
      s3.send(new ListMultipartUploadsCommand({ Bucket: 'myapp--uploads' })),
    ).rejects.toThrow();

    // Confirm the actual wire response is exactly the pinned 501 + body
    // (the SDK's own error swallows status/body detail).
    const res = await fetch(`${daemonUrl}/myapp--uploads?uploads`);
    expect(res.status).toBe(501);
    expect(await res.text()).toBe(
      'multipart upload is not supported by the local dev bucket emulator yet',
    );
  });
});

describe('validation', () => {
  test('PUT bucket rejects an app segment with an uppercase letter, naming the segment', async () => {
    const res = await fetch(`${daemonUrl}/_pcdev/apps/BadApp/buckets/data`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: tempDir('bucket-invalid') }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('BadApp');
  });

  test('PUT bucket rejects a physical name over the 63-char cap, naming both parts and the cap', async () => {
    // Each of app/name individually satisfies the ≤63 path-segment rule, but
    // "<app>--<name>" (with its 2-char separator) exceeds the store's own
    // 63-char bucket-name cap — the SEPARATE check this endpoint applies.
    const app = 'a'.repeat(35);
    const name = 'b'.repeat(35);
    const res = await fetch(`${daemonUrl}/_pcdev/apps/${app}/buckets/${name}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: tempDir('bucket-invalid') }),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain(app);
    expect(body).toContain(name);
    expect(body).toContain('63');
  });

  test('health is available at both /health and /_pcdev/health', async () => {
    const plain = await fetch(`${daemonUrl}/health`);
    const admin = await fetch(`${daemonUrl}/_pcdev/health`);
    expect(plain.status).toBe(200);
    expect(admin.status).toBe(200);
  });
});
