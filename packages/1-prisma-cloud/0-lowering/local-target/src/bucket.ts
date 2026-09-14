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

/** `Bucket` → registers `<app>--<name>` with the bucket emulator, backed by an in-project data root. */
export function LocalBucketProvider(
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<Bucket>> {
  const service: Provider.ProviderService<Bucket> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news, id }) =>
      Effect.tryPromise({
        try: async () => {
          const app = appNameOf(input.container);
          const name = bucketNameOf(news, id);
          const dir = path.join(input.devDir, 'buckets', name);
          await bucketsClient().putBucket(app, name, dir);
          return {
            bucketId: name,
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
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<BucketAccessKey>> {
  const service: Provider.ProviderService<BucketAccessKey> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news, output, id }) =>
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
          const bucketId = bucketIdOfInput(news.bucket);
          return {
            bucketAccessKeyId: news.name ?? id,
            bucketId,
            accessKeyId: pair.accessKeyId,
            secretAccessKey: Redacted.make(pair.secretAccessKey),
            endpoint: client.baseUrl,
            bucketName: `${app}--${bucketId}`,
          };
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
  };
  return Provider.effect(BucketAccessKey, Effect.succeed(service));
}
