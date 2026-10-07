import { type ManagementApiClient, ManagementClient, providers } from '@internal/lowering';
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

interface DatabaseIdentityProps {
  readonly databaseId: string;
  readonly logicalId: string;
}

export type DatabaseIdentity = Resource<
  'PrismaCloud.DatabaseIdentity',
  DatabaseIdentityProps,
  DatabaseIdentityProps
>;
export const DatabaseIdentity = Resource<DatabaseIdentity>('PrismaCloud.DatabaseIdentity');

export function databaseIdentityProviderService(
  client: ManagementApiClient,
): Provider.ProviderService<DatabaseIdentity> {
  return {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async () => {
          const { error } = await client.PATCH('/v1/databases/{databaseId}', {
            params: { path: { databaseId: news.databaseId } },
            body: { logicalId: news.logicalId },
          });
          if (error)
            throw new Error(
              `Could not bind database ${news.databaseId} to topology node ${news.logicalId}: ${JSON.stringify(error)}`,
            );
          return { databaseId: news.databaseId, logicalId: news.logicalId };
        },
        catch: (error) => error,
      }),
    // The database owns its binding and removes it with the database.
    delete: () => Effect.void,
  };
}

/** Binds the authored topology identity after the database's branch attachment. */
export const DatabaseIdentityProvider = () =>
  Provider.effect(
    DatabaseIdentity,
    Effect.gen(function* () {
      return databaseIdentityProviderService(yield* ManagementClient);
    }),
  ).pipe(Layer.provide(providers()));
