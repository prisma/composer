import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import { ManagementClient } from '../client.ts';
import { call, callOptional, callVoid } from '../http.ts';

export type Region =
  | 'us-east-1'
  | 'us-west-1'
  | 'eu-west-3'
  | 'eu-central-1'
  | 'ap-northeast-1'
  | 'ap-southeast-1';

export interface DatabaseProps {
  /** The project that will own this database. */
  projectId: string;
  name: string;
  region: Region;
  isDefault?: boolean;
  /** When set, the Branch this database is attached to (named-stage deploys). */
  branchId?: string;
}

export interface DatabaseAttributes {
  id: string;
  name: string;
}

export type Database = Resource<'Prisma.Database', DatabaseProps, DatabaseAttributes>;

/** A Prisma **Postgres database** inside a project. */
export const Database = Resource<Database>('Prisma.Database');

export const DatabaseProvider = () =>
  Provider.effect(
    Database,
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      return {
        stables: ['id'],
        list: () => Effect.succeed([] as DatabaseAttributes[]),
        reconcile: Effect.fn(function* ({ news, output }) {
          const observed = output?.id
            ? yield* callOptional(() =>
                client.GET('/v1/databases/{databaseId}', {
                  params: { path: { databaseId: output.id } },
                }),
              )
            : undefined;
          let result: DatabaseAttributes;
          if (observed) {
            result = { id: observed.data.id, name: observed.data.name };
          } else {
            const created = yield* call(() =>
              client.POST('/v1/projects/{projectId}/databases', {
                params: { path: { projectId: news.projectId } },
                body: {
                  name: news.name,
                  region: news.region,
                  ...(news.isDefault !== undefined && { isDefault: news.isDefault }),
                },
              }),
            );
            result = { id: created.data.id, name: created.data.name };
          }

          if (news.branchId !== undefined) {
            const branchId = news.branchId;
            yield* call(() =>
              client.PATCH('/v1/databases/{databaseId}', {
                params: { path: { databaseId: result.id } },
                body: { branchId },
              }),
            );
          }

          return result;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* callVoid(() =>
            client.DELETE('/v1/databases/{databaseId}', {
              params: { path: { databaseId: output.id } },
            }),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          const d = yield* callOptional(() =>
            client.GET('/v1/databases/{databaseId}', {
              params: { path: { databaseId: output.id } },
            }),
          );
          return d ? { id: d.data.id, name: d.data.name } : undefined;
        }),
      };
    }),
  );
