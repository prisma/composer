/**
 * Local bucket-cluster providers (local-dev spec § 4): both `Bucket` and
 * `BucketKey` are clients of the machine-global bucket emulator — already up
 * by the time these run, since the extension's `dev.emulators` hook ensures
 * it before converge.
 */
import * as path from 'node:path';
import type { DevProvidersInput } from '@internal/core/config';
import { bucketsClient } from '@internal/dev-emulators';
import { mintKeyPair } from '@internal/s3-protocol';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { Bucket } from '../buckets/Bucket.ts';
import { BucketKey } from '../buckets/BucketKey.ts';
import { appNameOf } from './app-name.ts';

/** `Bucket` → registers `<app>--<news.name>` with the bucket emulator, backed by an in-project data root. */
export function LocalBucketProvider(
  input: DevProvidersInput,
): Layer.Layer<Provider.Provider<Bucket>> {
  const service: Provider.ProviderService<Bucket> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async () => {
          const app = appNameOf(input.container);
          const dir = path.join(input.devDir, 'buckets', news.name);
          await bucketsClient().putBucket(app, news.name, dir);
          return { id: news.name, name: news.name };
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
 * `BucketKey` → mint-once-stable (the same lifecycle as `ServiceKey`/
 * `S3Credentials`: reuse `output`'s pair when present, mint only on first
 * create) — but ALWAYS re-registers the (prior or fresh) pair with the
 * emulator, so a bucket emulator whose own state was wiped self-heals on the
 * next converge.
 */
export function LocalBucketKeyProvider(
  input: DevProvidersInput,
): Layer.Layer<Provider.Provider<BucketKey>> {
  const service: Provider.ProviderService<BucketKey> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news, output }) =>
      Effect.tryPromise({
        try: async () => {
          const app = appNameOf(input.container);
          const pair =
            output !== undefined
              ? {
                  accessKeyId: output.accessKeyId,
                  secretAccessKey: Redacted.value(output.secretAccessKey),
                }
              : mintKeyPair();
          const client = bucketsClient();
          await client.putCredentials(app, pair.accessKeyId, pair.secretAccessKey);
          return {
            id: news.name,
            bucketId: news.bucketId,
            accessKeyId: pair.accessKeyId,
            secretAccessKey: Redacted.make(pair.secretAccessKey),
            endpoint: client.baseUrl,
            bucketName: `${app}--${news.name}`,
          };
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
  };
  return Provider.effect(BucketKey, Effect.succeed(service));
}
