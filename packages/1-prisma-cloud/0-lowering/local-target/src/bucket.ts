/**
 * Local bucket-cluster providers (local-dev spec § 4): both `Bucket` and
 * `BucketAccessKey` are clients of the machine-global bucket emulator —
 * already up by the time these run, since the extension's
 * `localTarget.emulators` hook ensures it before converge.
 */
import * as path from 'node:path';
import type { LocalTargetProvidersInput } from '@internal/core/config';
import { bucketsClient } from '@internal/dev-emulators';
import { mintKeyPair } from '@internal/s3-protocol';
import { Bucket, BucketAccessKey } from 'alchemy/Prisma';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import * as Redacted from 'effect/Redacted';
import { appNameOf } from './app-name.ts';
import {
  type AppScope,
  ensureBucketInstance,
  recordedInstanceId,
  recordKeyOf,
} from './emulator-instances.ts';
import { DEV_TIMESTAMP, projectIdOfInput } from './upstream-attributes.ts';

/** Reads a bucket id from upstream's `bucket` input: a plain string or a resolved `Prisma.Bucket` attributes record. */
function bucketIdOfInput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Predicate.isObject(value) && typeof value['bucketId'] === 'string') {
    return value['bucketId'];
  }
  return 'local';
}

export const BUCKETS_DIR = 'buckets';

/** Where a bucket's objects live: in the project's dev directory, under its app, so `--fresh` removes them with the app. */
export function bucketDataDir(scope: AppScope, name: string): string {
  return path.join(scope.devDir, BUCKETS_DIR, scope.app, name);
}

function appScopeOf(input: LocalTargetProvidersInput): AppScope {
  return { devDir: input.devDir, app: appNameOf(input.container) };
}

/**
 * `Bucket` → the bucket instance the directory's record names for the
 * resource, created when there is none, over an in-project data root. Its
 * `bucketId` is the instance id, which is also its S3 bucket name. A Bucket
 * whose recorded instance changed is updated, so its access key is
 * registered on the new instance.
 */
export function LocalBucketProvider(
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<Bucket>> {
  const service: Provider.ProviderService<Bucket> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news, id }) =>
      Effect.tryPromise({
        try: async () => {
          const name = recordKeyOf('bucket', id, news.name);
          const bucket = await ensureBucketInstance(
            appScopeOf(input),
            name,
            bucketDataDir(appScopeOf(input), name),
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
    diff: ({ output }) =>
      Effect.tryPromise({
        try: async () => {
          if (output === undefined) return undefined;
          const recorded = await recordedInstanceId(appScopeOf(input), output.name);
          return recorded === output.bucketId ? undefined : { action: 'update' as const };
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
