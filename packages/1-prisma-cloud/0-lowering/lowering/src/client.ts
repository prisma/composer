import { createManagementApiClient } from '@prisma/management-api-sdk';
import type * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import {
  deploySourceHeaders,
  fromEnv,
  PrismaCredentials,
  tokenClientOrigin,
} from './credentials.ts';

export type ManagementApiClient = ReturnType<typeof createManagementApiClient>;

/**
 * The typed Prisma Management API client, built once from the resolved
 * credentials. Providers yield this in their outer Effect and call it inside
 * `reconcile` / `delete`.
 */
export class ManagementClient extends Context.Service<ManagementClient, ManagementApiClient>()(
  'PrismaManagementClient',
) {}

/**
 * A client built from the resolved token, on `apiOrigin`, or on
 * `tokenClientOrigin()` when none is given.
 */
export const layer = (options?: {
  readonly apiOrigin?: string;
}): Layer.Layer<ManagementClient, Config.ConfigError | Error, PrismaCredentials> =>
  Layer.effect(
    ManagementClient,
    Effect.gen(function* () {
      const { token } = yield* PrismaCredentials;
      const baseUrl = options?.apiOrigin ?? (yield* tokenClientOrigin());
      return createManagementApiClient({
        token: Redacted.value(token),
        baseUrl,
        headers: deploySourceHeaders(),
      });
    }),
  );

/** The caller's already-authenticated client, or one built from `PRISMA_SERVICE_TOKEN` on `apiOrigin` when the caller supplies none. */
export const suppliedOrFromEnv = (
  supplied: ManagementApiClient | undefined,
  apiOrigin: string,
): Layer.Layer<ManagementClient, Config.ConfigError | Error> =>
  supplied === undefined
    ? layer({ apiOrigin }).pipe(Layer.provide(fromEnv()))
    : Layer.succeed(ManagementClient, supplied);
