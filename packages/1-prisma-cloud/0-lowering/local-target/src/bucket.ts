/**
 * Local bucket-cluster providers (local-dev spec § 4): both `Bucket` and
 * `BucketAccessKey` are clients of the machine-global bucket emulator —
 * already up by the time these run, since the extension's
 * `localTarget.emulators` hook ensures it before converge.
 */
import * as path from 'node:path';
import type { LocalTargetProvidersInput } from '@internal/core/config';
import { type BucketInstanceInfo, bucketsClient } from '@internal/dev-emulators';
import { mintKeyPair } from '@internal/s3-protocol';
import { Bucket, BucketAccessKey } from 'alchemy/Prisma';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import * as Redacted from 'effect/Redacted';
import { appNameOf } from './app-name.ts';
import { type AppScope, directoryOf } from './emulator-instances.ts';
import { DEV_TIMESTAMP, projectIdOfInput } from './upstream-attributes.ts';

/** Upstream lets `name` default to the resource's logical ID; locally a bucket must have a concrete name to register under. */
const bucketNameOf = (news: { readonly name?: string | undefined }, id: string): string =>
  news.name ?? id;

/** Reads a bucket id from upstream's `bucket` input: a plain string or a resolved `Prisma.Bucket` attributes record. */
function bucketIdOfInput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Predicate.isObject(value) && typeof value['bucketId'] === 'string') {
    return value['bucketId'];
  }
  return 'local';
}

function labelsFor(scope: AppScope, address: string): Record<string, string> {
  return {
    'composer.directory': directoryOf(scope.devDir),
    'composer.app': scope.app,
    'composer.address': address,
  };
}

/**
 * Temporary: finds the bucket instance for `address` by the labels written
 * when it was created, and creates one when there is none. The directory's
 * record replaces this lookup.
 */
async function ensureBucketInstance(
  scope: AppScope,
  address: string,
  dir: string,
): Promise<BucketInstanceInfo> {
  const client = bucketsClient();
  const labels = labelsFor(scope, address);
  const existing = (await client.listInstances()).find((instance) =>
    Object.entries(labels).every(([key, value]) => instance.labels[key] === value),
  );
  return existing ?? client.createInstance({ labels, dir });
}

/** Temporary: deletes the bucket instances labelled with this directory and app. Their objects stay. */
export async function deleteBucketInstances(scope: AppScope): Promise<void> {
  const client = bucketsClient();
  const directory = directoryOf(scope.devDir);
  for (const instance of await client.listInstances()) {
    if (
      instance.labels['composer.directory'] === directory &&
      instance.labels['composer.app'] === scope.app
    ) {
      await client.deleteInstance(instance.id);
    }
  }
}

/** `Bucket` → a bucket instance on the bucket emulator, backed by an in-project data root. Its `bucketId` is the instance id, which is also its S3 bucket name. */
export function LocalBucketProvider(
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<Bucket>> {
  const service: Provider.ProviderService<Bucket> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news, id }) =>
      Effect.tryPromise({
        try: async () => {
          const name = bucketNameOf(news, id);
          const dir = path.join(input.devDir, 'buckets', name);
          const bucket = await ensureBucketInstance(
            { devDir: input.devDir, app: appNameOf(input.container) },
            name,
            dir,
          );
          return {
            bucketId: bucket.id,
            name,
            projectId: projectIdOfInput(news.project),
            createdAt: DEV_TIMESTAMP,
          };
        },
        catch: (cause) => cause,
      }),
    // Objects belong to the developer; only `--fresh` removes them.
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
  };
  return Provider.effect(Bucket, Effect.succeed(service));
}

/**
 * `BucketAccessKey` → mint-once-stable (the same lifecycle as `ServiceKey`/
 * `S3Credentials`: reuse `output`'s pair when present, mint only on first
 * create) — but ALWAYS re-registers the (prior or fresh) pair with the
 * emulator, so a bucket emulator whose own state was wiped self-heals on the
 * next converge.
 */
export function LocalBucketAccessKeyProvider(
  _input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<BucketAccessKey>> {
  const service: Provider.ProviderService<BucketAccessKey> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news, output, id }) =>
      Effect.tryPromise({
        try: async () => {
          const pair =
            output !== undefined
              ? {
                  accessKeyId: output.accessKeyId,
                  secretAccessKey: Redacted.value(output.secretAccessKey),
                }
              : mintKeyPair();
          const client = bucketsClient();
          const bucketId = bucketIdOfInput(news.bucket);
          await client.putCredentials(bucketId, pair.accessKeyId, pair.secretAccessKey);
          return {
            bucketAccessKeyId: news.name ?? id,
            bucketId,
            accessKeyId: pair.accessKeyId,
            secretAccessKey: Redacted.make(pair.secretAccessKey),
            endpoint: client.baseUrl,
            bucketName: bucketId,
          };
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
  };
  return Provider.effect(BucketAccessKey, Effect.succeed(service));
}
