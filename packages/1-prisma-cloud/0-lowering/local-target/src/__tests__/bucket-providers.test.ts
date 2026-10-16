/**
 * The local Bucket and BucketAccessKey providers against a real bucket
 * emulator in a temporary emulators directory: a Bucket is a bucket
 * instance, and its access key is registered on that instance, whose id is
 * the bucket's name on the S3 wire.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContainerInstance, LocalTargetProvidersInput } from '@internal/core/config';
import {
  bucketsClient,
  EMULATORS_DIR_ENV,
  ensureDaemon,
  stopDaemon,
} from '@internal/dev-emulators';
import { Bucket, BucketAccessKey } from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import { LocalBucketAccessKeyProvider, LocalBucketProvider } from '../bucket.ts';

const APP = 'bucket-providers-app';
const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];

const reconcileInput = (id: string, news: Record<string, unknown>) =>
  ({
    id,
    fqn: id,
    instanceId: id,
    news,
    olds: undefined,
    output: undefined,
    session: undefined as never,
    bindings: [],
  }) as never;

// Local dev is not supported on Windows, where the emulators cannot run.
describe.skipIf(process.platform === 'win32')('the local Bucket providers', () => {
  let root: string;
  let registryRoot: string;
  let input: LocalTargetProvidersInput;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-bucket-providers-'));
    registryRoot = path.join(root, 'emulators');
    process.env[EMULATORS_DIR_ENV] = registryRoot;
    const entry = fileURLToPath(import.meta.resolve('@internal/dev-emulators/buckets-main'));
    await ensureDaemon('buckets', entry, { registryRoot });
    const container: ContainerInstance = {
      input: { appName: APP, stage: undefined },
      serialize: () => 'x',
    };
    input = { container, devDir: path.join(root, 'project', '.prisma-composer', 'dev') };
  });

  afterEach(async () => {
    await stopDaemon('buckets', { registryRoot }).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
    else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
  });

  async function reconcileBucket(name: string): Promise<Bucket['Attributes']> {
    const service = await Effect.runPromise(
      Bucket.Provider.pipe(Effect.provide(LocalBucketProvider(input))),
    );
    return Effect.runPromise(service.reconcile(reconcileInput(name, { project: 'p', name })));
  }

  test('a Bucket creates a bucket instance once, with its data root in the project', async () => {
    const first = await reconcileBucket('uploads');
    const again = await reconcileBucket('uploads');

    expect(again.bucketId).toBe(first.bucketId);
    const instance = await bucketsClient().getInstance(first.bucketId);
    expect(instance?.dir).toBe(path.join(input.devDir, 'buckets', APP, 'uploads'));
    expect(instance?.labels['composer.address']).toBe('uploads');
  });

  test("a BucketAccessKey names the bucket's instance as the bucket on the S3 wire", async () => {
    const bucket = await reconcileBucket('uploads');
    const service = await Effect.runPromise(
      BucketAccessKey.Provider.pipe(Effect.provide(LocalBucketAccessKeyProvider(input))),
    );

    const key: BucketAccessKey['Attributes'] = await Effect.runPromise(
      service.reconcile(reconcileInput('key', { bucket, name: 'key' })),
    );

    expect(key.bucketName).toBe(bucket.bucketId);
    expect(key.endpoint).toBe(bucketsClient().baseUrl);
  });
});
