import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { ManagementClient } from '../client.ts';
import { call, callVoid } from '../http.ts';

export interface BucketKeyProps {
  /** The bucket this key grants access to. */
  bucketId: string;
  name: string;
  role: 'read_write';
}

export interface BucketKeyAttributes {
  id: string;
  /** Stored so `delete` can pass both path parameters. */
  bucketId: string;
  /**
   * The S3 access key ID. Stable across redeployments because the provider
   * carries `stables: ['id', ...]` and returns the persisted attributes on
   * every reconcile after creation.
   */
  accessKeyId: string;
  /**
   * The S3 secret. Returned only at creation and never echoed back, so it is
   * captured here (Redacted) and persisted in deploy state — the same pattern
   * Connection.ts uses for the Postgres connection string.
   */
  secretAccessKey: Redacted.Redacted<string>;
  /** The S3-compatible endpoint URL for this bucket's region. */
  endpoint: string;
  /**
   * The provider-side bucket name (e.g. `user-<id>`). S3 clients must use
   * THIS name as the bucket, not the friendly display name the user chose.
   */
  bucketName: string;
}

export type BucketKey = Resource<'PrismaComposer.BucketKey', BucketKeyProps, BucketKeyAttributes>;

/** A **bucket access key** for a Prisma Object Store bucket — yields the S3 credentials. */
export const BucketKey = Resource<BucketKey>('PrismaComposer.BucketKey', {
  aliases: ['Prisma.BucketKey'],
});

export const BucketKeyProvider = () =>
  Provider.effect(
    BucketKey,
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      return {
        stables: ['id', 'bucketId', 'secretAccessKey', 'accessKeyId', 'endpoint', 'bucketName'],
        list: () => Effect.succeed<BucketKeyAttributes[]>([]),
        reconcile: Effect.fn(function* ({ news, output }) {
          // The secret is only returned at creation; persisted state is authoritative.
          if (output?.id) return output;

          const created = yield* call(() =>
            client.POST('/v1/buckets/{bucketId}/keys', {
              params: { path: { bucketId: news.bucketId } },
              body: { name: news.name, role: news.role },
            }),
          );
          return {
            id: created.data.id,
            bucketId: news.bucketId,
            accessKeyId: created.data.accessKeyId,
            secretAccessKey: Redacted.make(created.data.secretAccessKey),
            endpoint: created.data.endpoint,
            bucketName: created.data.bucketName,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Bucket deletion revokes all remaining keys server-side, so this key
          // may already be gone when the bucket is destroyed first. callVoid
          // tolerates 404s.
          yield* callVoid(() =>
            client.DELETE('/v1/buckets/{bucketId}/keys/{keyId}', {
              params: { path: { bucketId: output.bucketId, keyId: output.id } },
            }),
          );
        }),
      };
    }),
  );
