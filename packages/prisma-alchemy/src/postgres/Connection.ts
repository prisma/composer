import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { ManagementClient } from '../client.ts';
import { call, callVoid } from '../http.ts';

export interface ConnectionProps {
  /** The database this connection targets. */
  databaseId: string;
  name: string;
}

export interface ConnectionAttributes {
  id: string;
  /**
   * The Postgres connection string. Returned only at creation and never
   * echoed back, so it is captured here (Redacted) and persisted in state.
   */
  connectionString: Redacted.Redacted<string>;
}

export type Connection = Resource<'Prisma.Connection', ConnectionProps, ConnectionAttributes>;

/** A **connection** to a Prisma Postgres database — yields the connection string. */
export const Connection = Resource<Connection>('Prisma.Connection');

export const ConnectionProvider = () =>
  Provider.effect(
    Connection,
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      return {
        stables: ['id', 'connectionString'],
        list: () => Effect.succeed([] as ConnectionAttributes[]),
        reconcile: Effect.fn(function* ({ news, output }) {
          // The secret is only returned at creation; cached state is authoritative.
          if (output?.id) return output;

          const created = yield* call(() =>
            client.POST('/v1/databases/{databaseId}/connections', {
              params: { path: { databaseId: news.databaseId } },
              body: { name: news.name },
            }),
          );
          return {
            id: created.data.id,
            connectionString: Redacted.make(created.data.url),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* callVoid(() =>
            client.DELETE('/v1/connections/{id}', {
              params: { path: { id: output.id } },
            }),
          );
        }),
      };
    }),
  );
