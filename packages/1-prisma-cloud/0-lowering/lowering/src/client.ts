import { createManagementApiClient } from '@prisma/management-api-sdk';
import type * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { managementApiBaseUrl, PrismaCredentials } from './credentials.ts';

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
 * By default the base URL comes from `managementApiBaseUrl()` — the SAME
 * resolver upstream's providers use (see providers.ts), so `PRISMA_API_URL`
 * can never split the postgres family and the compute/bucket/state clients
 * across hosts. `apiOrigin` overrides it (tests point it at a fake).
 */
export const layer = (options?: {
  readonly apiOrigin?: string;
}): Layer.Layer<ManagementClient, Config.ConfigError | Error, PrismaCredentials> =>
  Layer.effect(
    ManagementClient,
    Effect.gen(function* () {
      const { token } = yield* PrismaCredentials;
      const baseUrl = options?.apiOrigin ?? (yield* managementApiBaseUrl());
      return createManagementApiClient({ token: Redacted.value(token), baseUrl });
    }),
  );
