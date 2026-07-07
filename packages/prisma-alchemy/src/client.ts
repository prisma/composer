import { createManagementApiClient } from '@prisma/management-api-sdk';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { PrismaCredentials } from './credentials.ts';

export type ManagementApiClient = ReturnType<typeof createManagementApiClient>;

/**
 * The typed Prisma Management API client, built once from the resolved
 * credentials. Providers yield this in their outer Effect and call it inside
 * `reconcile` / `delete`.
 */
export class ManagementClient extends Context.Service<ManagementClient, ManagementApiClient>()(
  'PrismaManagementClient',
) {}

export const layer = (): Layer.Layer<ManagementClient, never, PrismaCredentials> =>
  Layer.effect(
    ManagementClient,
    Effect.gen(function* () {
      const { token } = yield* PrismaCredentials;
      return createManagementApiClient({ token: Redacted.value(token) });
    }),
  );
