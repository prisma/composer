import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import { ManagementClient } from '../client.ts';
import { call, callOptional, callVoid } from '../http.ts';

export interface BucketProps {
  /** The project that will own this bucket. */
  projectId: string;
  name: string;
  /** When set, the Branch this bucket is scoped to (named-stage deploys). */
  branchId?: string;
}

export interface BucketAttributes {
  id: string;
  name: string;
}

export type Bucket = Resource<'Prisma.Bucket', BucketProps, BucketAttributes>;

/** A Prisma **Object Store bucket** inside a project. */
export const Bucket = Resource<Bucket>('Prisma.Bucket');

export const BucketProvider = () =>
  Provider.effect(
    Bucket,
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      return {
        stables: ['id'],
        list: () => Effect.succeed<BucketAttributes[]>([]),
        reconcile: Effect.fn(function* ({ news, output }) {
          const observed = output?.id
            ? yield* callOptional(() =>
                client.GET('/v1/buckets/{bucketId}', {
                  params: { path: { bucketId: output.id } },
                }),
              )
            : undefined;
          if (observed) {
            return { id: observed.data.id, name: observed.data.name };
          }
          const created = yield* call(() =>
            client.POST('/v1/buckets', {
              body: {
                projectId: news.projectId,
                name: news.name,
                ...(news.branchId !== undefined ? { branchId: news.branchId } : {}),
              },
            }),
          );
          return { id: created.data.id, name: created.data.name };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Deletion cascades server-side: the Management API deletes the
          // bucket together with its objects and any remaining keys.
          yield* callVoid(() =>
            client.DELETE('/v1/buckets/{bucketId}', {
              params: { path: { bucketId: output.id } },
            }),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          const b = yield* callOptional(() =>
            client.GET('/v1/buckets/{bucketId}', {
              params: { path: { bucketId: output.id } },
            }),
          );
          return b ? { id: b.data.id, name: b.data.name } : undefined;
        }),
      };
    }),
  );
